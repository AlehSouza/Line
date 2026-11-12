//! Rotas REST em /api (mesmos caminhos, corpos e respostas do servidor antigo).
use crate::errors::*;
use crate::gateway::VoiceFilter;
use crate::model::*;
use crate::store::{ChannelPatch, FriendRequest, ProfilePatch, Q, ServerPatch};
use crate::validate::{self, body};
use crate::{App, VERSION, auth};
use axum::body::Bytes;
use axum::extract::{FromRequestParts, Path, Query, State};
use axum::http::request::Parts;
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde_json::json;
use socketioxide::layer::SocketIoLayer;
use std::collections::HashMap;
use std::sync::Arc;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::cors::{AllowHeaders, AllowOrigin, CorsLayer};

type S = State<Arc<App>>;
type Res = ApiResult<Response>;

fn ok<T: serde::Serialize>(v: T) -> Res {
    Ok(Json(v).into_response())
}
fn created<T: serde::Serialize>(v: T) -> Res {
    Ok((StatusCode::CREATED, Json(v)).into_response())
}
fn no_content() -> Res {
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Usuário autenticado pelo header `Authorization: Bearer <token>` (401 se não houver).
pub struct Me(pub String);

impl FromRequestParts<Arc<App>> for Me {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, app: &Arc<App>) -> Result<Self, ApiError> {
        let token = parts
            .headers
            .get("authorization")
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .ok_or_else(unauthorized)?;
        let user_id = app.tokens.verify(token).ok_or_else(unauthorized)?;
        if app.store.q().self_user(&user_id).is_none() {
            return Err(unauthorized());
        }
        Ok(Me(user_id))
    }
}

pub fn router(app: Arc<App>, socket_layer: SocketIoLayer) -> Router {
    let api = Router::new()
        .route("/auth/register", post(register))
        .route("/auth/login", post(login))
        .route("/users/@me", get(get_me).patch(update_me))
        .route("/users/{id}", get(get_user))
        .route("/servers", get(list_servers).post(create_server))
        .route("/servers/discover", get(discover))
        .route(
            "/servers/{id}",
            get(get_server).patch(update_server).delete(delete_server),
        )
        .route("/servers/{id}/invite/reset", post(reset_invite))
        .route("/servers/{id}/leave", post(leave_server))
        .route(
            "/servers/{id}/members/{user_id}",
            axum::routing::delete(kick_member),
        )
        .route("/servers/{id}/join", post(join_public))
        .route("/servers/{id}/channels", post(create_channel))
        .route("/servers/{id}/categories", post(create_category))
        .route("/invites/{code}", get(get_invite).post(accept_invite))
        .route(
            "/categories/{id}",
            axum::routing::patch(rename_category).delete(delete_category),
        )
        .route(
            "/channels/{id}",
            get(get_channel)
                .patch(update_channel)
                .delete(delete_channel),
        )
        .route(
            "/channels/{id}/messages",
            get(list_messages).post(send_message),
        )
        .route(
            "/messages/{id}",
            axum::routing::patch(edit_message).delete(delete_message),
        )
        .route("/dms", get(list_dms).post(open_dm))
        .route("/dms/{id}/leave", post(leave_dm))
        .route("/friends", get(list_friends).post(add_friend))
        .route(
            "/friends/{user_id}",
            put(accept_friend).delete(remove_friend),
        );

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::mirror_request())
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
        ])
        .allow_headers(AllowHeaders::mirror_request())
        .allow_credentials(true);

    Router::new()
        .route(
            "/api/health",
            get(|| async { Json(json!({ "ok": true, "name": "line", "version": VERSION })) }),
        )
        .nest("/api", api)
        .fallback(|| async { not_found("Rota") })
        .with_state(app)
        .layer(socket_layer)
        .layer(cors)
        .layer(CatchPanicLayer::custom(|_| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "Erro interno do servidor",
            )
            .into_response()
        }))
}

// ---------- auth ----------

async fn register(State(app): S, b: Bytes) -> Res {
    let input = body::<validate::Register>(&b)?.check()?;
    if app.store.q().user_by_username(&input.username).is_some() {
        return Err(conflict("Esse nome de usuário já está em uso"));
    }
    // scrypt é pesado de propósito: roda fora das threads de rede.
    let password = input.password.clone();
    let hash = tokio::task::spawn_blocking(move || auth::hash_password(&password))
        .await
        .expect("scrypt");
    let user = {
        let q = app.store.q();
        if q.user_by_username(&input.username).is_some() {
            return Err(conflict("Esse nome de usuário já está em uso"));
        }
        q.create_user(
            &input.username,
            input.display_name.as_deref().unwrap_or(&input.username),
            &hash,
        )
    };
    created(AuthResponse {
        token: app.tokens.sign(&user.public.id),
        user,
    })
}

async fn login(State(app): S, b: Bytes) -> Res {
    let input = body::<validate::Login>(&b)?.check()?;
    let invalid = || {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "Usuário ou senha incorretos",
        )
    };
    let row = app
        .store
        .q()
        .user_by_username(&input.username)
        .ok_or_else(invalid)?;
    let (password, stored) = (input.password, row.password_hash.clone());
    let valid = tokio::task::spawn_blocking(move || auth::verify_password(&password, &stored))
        .await
        .unwrap_or(false);
    if !valid {
        return Err(invalid());
    }
    let user = app.store.q().to_self_user(&row);
    ok(AuthResponse {
        token: app.tokens.sign(&row.id),
        user,
    })
}

// ---------- usuários ----------

async fn get_me(State(app): S, Me(me): Me) -> Res {
    ok(app.store.q().self_user(&me))
}

async fn update_me(State(app): S, Me(me): Me, b: Bytes) -> Res {
    let p = body::<validate::UpdateProfile>(&b)?.check()?;
    let q = app.store.q();
    let user = q.update_user(
        &me,
        ProfilePatch {
            display_name: p.display_name,
            bio: p.bio,
            avatar_color: p.avatar_color,
            custom_status: p.custom_status,
            status: p.status,
        },
    );
    app.to_user(&me, "self:update", &user);
    if let Some(public) = q.public_user(&me) {
        app.to_users(&q.audience_of(&me), "user:update", &public);
    }
    app.broadcast_presence(&q, &me);
    ok(user)
}

async fn get_user(State(app): S, Me(_): Me, Path(id): Path<String>) -> Res {
    ok(app
        .store
        .q()
        .public_user(&id)
        .ok_or_else(|| not_found("Usuário"))?)
}

// ---------- servidores ----------

fn require_member(q: &Q, server_id: &str, user_id: &str) -> ApiResult<Server> {
    match q.server(server_id) {
        Some(s) if q.is_member(server_id, user_id) => Ok(s),
        _ => Err(not_found("Servidor")),
    }
}

// Fase 1: só o dono gerencia. Cargos e permissões chegam na fase 3.
fn require_owner(q: &Q, server_id: &str, user_id: &str) -> ApiResult<Server> {
    let server = require_member(q, server_id, user_id)?;
    if server.owner_id != user_id {
        return Err(forbidden("Só o dono do servidor pode fazer isso"));
    }
    Ok(server)
}

async fn list_servers(State(app): S, Me(me): Me) -> Res {
    ok(app.store.q().servers_of(&me))
}

async fn discover(State(app): S, Me(me): Me, Query(qs): Query<HashMap<String, String>>) -> Res {
    let query: String = qs
        .get("q")
        .map(|s| s.chars().take(100).collect())
        .unwrap_or_default();
    ok(app.store.q().discover_servers(&me, &query))
}

async fn create_server(State(app): S, Me(me): Me, b: Bytes) -> Res {
    let input = body::<validate::CreateServer>(&b)?.check()?;
    let server = app.store.q().create_server(
        &me,
        &input.name,
        input.description.as_deref().unwrap_or(""),
        input.is_public.unwrap_or(false),
    );
    app.join_server(&me, &server.id);
    app.to_user(&me, "server:create", &server);
    created(server)
}

async fn get_server(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    let server = require_member(&q, &id, &me)?;
    ok(ServerDetail {
        categories: q.categories(&server.id),
        channels: q.channels(&server.id),
        members: q.members(&server.id),
        server,
    })
}

async fn update_server(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let q = app.store.q();
    require_owner(&q, &id, &me)?;
    let p = body::<validate::UpdateServer>(&b)?.check()?;
    let server = q.update_server(
        &id,
        ServerPatch {
            name: p.name,
            description: p.description,
            is_public: p.is_public,
            icon_color: p.icon_color,
        },
    );
    app.to_server(&server.id, "server:update", &server);
    ok(server)
}

async fn delete_server(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    let server = require_owner(&q, &id, &me)?;
    app.drop_voice(
        &q,
        VoiceFilter {
            server_id: Some(&server.id),
            ..Default::default()
        },
    );
    app.to_server(&server.id, "server:delete", &json!({ "id": server.id }));
    app.close_server_room(&server.id);
    q.delete_server(&server.id);
    no_content()
}

async fn reset_invite(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    require_owner(&q, &id, &me)?;
    let server = q.reset_invite(&id);
    app.to_server(&server.id, "server:update", &server);
    ok(server)
}

fn remove_from_server(app: &App, q: &Q, server_id: &str, user_id: &str) {
    app.drop_voice(
        q,
        VoiceFilter {
            server_id: Some(server_id),
            user_id: Some(user_id),
            ..Default::default()
        },
    );
    q.remove_member(server_id, user_id);
    app.leave_server(user_id, server_id);
    app.to_user(user_id, "server:delete", &json!({ "id": server_id }));
    app.to_server(
        server_id,
        "member:remove",
        &json!({ "serverId": server_id, "userId": user_id }),
    );
}

async fn leave_server(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    let server = require_member(&q, &id, &me)?;
    if server.owner_id == me {
        return Err(bad_request("O dono não pode sair; exclua o servidor"));
    }
    remove_from_server(&app, &q, &server.id, &me);
    no_content()
}

async fn kick_member(State(app): S, Me(me): Me, Path((id, target)): Path<(String, String)>) -> Res {
    let q = app.store.q();
    let server = require_owner(&q, &id, &me)?;
    if target == me {
        return Err(bad_request("Você não pode expulsar a si mesmo"));
    }
    if !q.is_member(&server.id, &target) {
        return Err(not_found("Membro"));
    }
    remove_from_server(&app, &q, &server.id, &target);
    no_content()
}

// ----- convites -----

async fn get_invite(State(app): S, Me(_): Me, Path(code): Path<String>) -> Res {
    ok(app
        .store
        .q()
        .server_by_invite(&code)
        .ok_or_else(|| not_found("Convite"))?)
}

async fn accept_invite(State(app): S, Me(me): Me, Path(code): Path<String>) -> Res {
    let q = app.store.q();
    let server = q
        .server_by_invite(&code)
        .ok_or_else(|| not_found("Convite"))?;
    ok(join(&app, &q, &me, server))
}

async fn join_public(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    let server = q
        .server(&id)
        .filter(|s| s.is_public)
        .ok_or_else(|| not_found("Servidor"))?;
    ok(join(&app, &q, &me, server))
}

fn join(app: &App, q: &Q, me: &str, server: Server) -> Server {
    if q.is_member(&server.id, me) {
        return server;
    }
    let member = q.add_member(&server.id, me);
    app.to_server(&server.id, "member:add", &member);
    app.join_server(me, &server.id);
    let fresh = q.server(&server.id).unwrap_or(server);
    app.to_user(me, "server:create", &fresh);
    app.broadcast_presence(q, me);
    fresh
}

// ----- canais e categorias -----

async fn create_channel(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let q = app.store.q();
    require_owner(&q, &id, &me)?;
    let input = body::<validate::CreateChannel>(&b)?.check()?;
    let category_id = input.category_id.flatten();
    if let Some(cat) = &category_id
        && q.category(cat).is_none_or(|c| c.server_id != id)
    {
        return Err(not_found("Categoria"));
    }
    let channel = q.create_channel(
        &id,
        &input.name,
        input.kind.as_deref().unwrap_or("text"),
        category_id.as_deref(),
        input.topic.as_deref().unwrap_or(""),
    );
    app.to_server(&id, "channel:create", &channel);
    created(channel)
}

async fn create_category(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let q = app.store.q();
    require_owner(&q, &id, &me)?;
    let input = body::<validate::CreateCategory>(&b)?.check()?;
    let category = q.create_category(&id, &input.name);
    app.to_server(&id, "category:create", &category);
    created(category)
}

async fn rename_category(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let q = app.store.q();
    let category = q.category(&id).ok_or_else(|| not_found("Categoria"))?;
    require_owner(&q, &category.server_id, &me)?;
    let input = body::<validate::CreateCategory>(&b)?.check()?;
    let updated = q.rename_category(&category.id, &input.name);
    app.to_server(&category.server_id, "category:update", &updated);
    ok(updated)
}

async fn delete_category(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    let category = q.category(&id).ok_or_else(|| not_found("Categoria"))?;
    require_owner(&q, &category.server_id, &me)?;
    // Os canais da categoria ficam "soltos" (ON DELETE SET NULL).
    let affected: Vec<String> = q
        .channels(&category.server_id)
        .into_iter()
        .filter(|c| c.category_id.as_deref() == Some(category.id.as_str()))
        .map(|c| c.id)
        .collect();
    q.delete_category(&category.id);
    app.to_server(
        &category.server_id,
        "category:delete",
        &json!({ "id": category.id, "serverId": category.server_id }),
    );
    for id in affected {
        if let Some(c) = q.channel(&id) {
            app.to_server(&category.server_id, "channel:update", &c);
        }
    }
    no_content()
}

fn require_access(q: &Q, channel_id: &str, user_id: &str) -> ApiResult<Channel> {
    match q.channel(channel_id) {
        Some(c) if q.can_access(user_id, channel_id) => Ok(c),
        _ => Err(not_found("Canal")),
    }
}

fn require_channel_manager(q: &Q, channel_id: &str, user_id: &str) -> ApiResult<(Channel, String)> {
    let channel = require_access(q, channel_id, user_id)?;
    let Some(server_id) = channel.server_id.clone() else {
        return Err(bad_request("Use as rotas de DM para conversas privadas"));
    };
    if q.server(&server_id).is_none_or(|s| s.owner_id != user_id) {
        return Err(forbidden("Só o dono do servidor pode gerenciar canais"));
    }
    Ok((channel, server_id))
}

async fn get_channel(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    ok(require_access(&app.store.q(), &id, &me)?)
}

async fn update_channel(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let q = app.store.q();
    let (channel, server_id) = require_channel_manager(&q, &id, &me)?;
    let p = body::<validate::UpdateChannel>(&b)?.check()?;
    if let Some(Some(cat)) = &p.category_id
        && q.category(cat).is_none_or(|c| c.server_id != server_id)
    {
        return Err(not_found("Categoria"));
    }
    let updated = q.update_channel(
        &channel.id,
        ChannelPatch {
            name: p.name,
            topic: p.topic,
            category_id: p.category_id,
            position: p.position.map(i64::from),
        },
    );
    app.to_server(&server_id, "channel:update", &updated);
    ok(updated)
}

async fn delete_channel(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    let (channel, server_id) = require_channel_manager(&q, &id, &me)?;
    app.drop_voice(
        &q,
        VoiceFilter {
            channel_id: Some(&channel.id),
            ..Default::default()
        },
    );
    q.delete_channel(&channel.id);
    app.to_server(
        &server_id,
        "channel:delete",
        &json!({ "id": channel.id, "serverId": server_id }),
    );
    no_content()
}

// ----- mensagens -----

async fn list_messages(
    State(app): S,
    Me(me): Me,
    Path(id): Path<String>,
    Query(qs): Query<HashMap<String, String>>,
) -> Res {
    let q = app.store.q();
    let channel = require_access(&q, &id, &me)?;
    let limit = qs
        .get("limit")
        .and_then(|l| l.parse::<f64>().ok())
        .filter(|l| *l != 0.0 && l.is_finite())
        .unwrap_or(50.0);
    let limit = limit.clamp(1.0, 100.0) as i64;
    let before = qs.get("before").filter(|b| !b.is_empty());
    ok(q.messages(&channel.id, before.map(|s| s.as_str()), limit))
}

async fn send_message(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let q = app.store.q();
    let channel = require_access(&q, &id, &me)?;
    if channel.kind == "voice" {
        return Err(bad_request("Canais de voz não aceitam mensagens de texto"));
    }
    let input = body::<validate::SendMessage>(&b)?.check()?;
    let message = q.create_message(&channel.id, &me, &input.content);
    app.to_channel(&q, &channel.id, "message:create", &message);
    created(message)
}

async fn edit_message(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let q = app.store.q();
    let message = q
        .message(&id)
        .filter(|m| q.can_access(&me, &m.channel_id))
        .ok_or_else(|| not_found("Mensagem"))?;
    if message.author.id != me {
        return Err(forbidden("Você só pode editar suas próprias mensagens"));
    }
    let input = body::<validate::SendMessage>(&b)?.check()?;
    let updated = q.edit_message(&message.id, &input.content);
    app.to_channel(&q, &message.channel_id, "message:update", &updated);
    ok(updated)
}

async fn delete_message(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    let message = q
        .message(&id)
        .filter(|m| q.can_access(&me, &m.channel_id))
        .ok_or_else(|| not_found("Mensagem"))?;
    let channel = q
        .channel(&message.channel_id)
        .ok_or_else(|| not_found("Mensagem"))?;
    let is_server_owner = channel
        .server_id
        .as_deref()
        .and_then(|s| q.server(s))
        .is_some_and(|s| s.owner_id == me);
    if message.author.id != me && !is_server_owner {
        return Err(forbidden("Você não pode apagar esta mensagem"));
    }
    q.delete_message(&message.id);
    app.to_channel(
        &q,
        &channel.id,
        "message:delete",
        &json!({ "id": message.id, "channelId": channel.id }),
    );
    no_content()
}

// ---------- DMs ----------

async fn list_dms(State(app): S, Me(me): Me) -> Res {
    ok(app.store.q().dms_of(&me))
}

/// Abre (ou reaproveita) uma DM. Aceita ids ou nomes de usuário.
async fn open_dm(State(app): S, Me(me): Me, b: Bytes) -> Res {
    let input = body::<validate::CreateDm>(&b)?.check()?;
    let q = app.store.q();
    let mut ids: Vec<String> = Vec::new();
    for r in &input.user_ids {
        let id = q
            .public_user(r)
            .map(|u| u.id)
            .or_else(|| q.user_by_username(&r.to_lowercase()).map(|u| u.id))
            .ok_or_else(|| not_found(&format!("Usuário \"{r}\"")))?;
        if id != me && !ids.contains(&id) {
            ids.push(id);
        }
    }
    if ids.is_empty() {
        return Err(bad_request("Escolha pelo menos uma outra pessoa"));
    }
    if ids.len() == 1
        && let Some(existing) = q.find_direct_dm(&me, &ids[0])
    {
        return ok(existing);
    }
    let channel = q.create_dm(&me, &ids, input.name.as_deref());
    app.to_users(&q.recipient_ids(&channel.id), "channel:create", &channel);
    created(channel)
}

/// Sai de um grupo. DMs 1:1 não são apagadas.
async fn leave_dm(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    let channel = q
        .channel(&id)
        .filter(|c| c.kind == "group_dm" && q.recipient_ids(&c.id).contains(&me))
        .ok_or_else(|| not_found("Grupo"))?;
    app.drop_voice(
        &q,
        VoiceFilter {
            channel_id: Some(&channel.id),
            user_id: Some(&me),
            ..Default::default()
        },
    );
    q.leave_group_dm(&channel.id, &me);
    app.to_user(
        &me,
        "channel:delete",
        &json!({ "id": channel.id, "serverId": null }),
    );
    if let Some(updated) = q.channel(&channel.id) {
        app.to_users(&q.recipient_ids(&channel.id), "channel:update", &updated);
    }
    no_content()
}

// ---------- amizades ----------

fn notify_both(app: &App, q: &Q, a: &str, b: &str) {
    if let Some(f) = q.friend(a, b) {
        app.to_user(a, "friend:update", &f);
    }
    if let Some(f) = q.friend(b, a) {
        app.to_user(b, "friend:update", &f);
    }
}

async fn list_friends(State(app): S, Me(me): Me) -> Res {
    ok(app.store.q().friends(&me))
}

async fn add_friend(State(app): S, Me(me): Me, b: Bytes) -> Res {
    let input = body::<validate::FriendRequest>(&b)?.check()?;
    let q = app.store.q();
    let target = q
        .user_by_username(&input.username)
        .ok_or_else(|| not_found("Usuário"))?;
    if target.id == me {
        return Err(bad_request("Você não pode adicionar a si mesmo"));
    }
    let result = q.request_friend(&me, &target.id);
    if matches!(result, FriendRequest::Exists) {
        return Err(conflict("Vocês já são amigos ou o pedido já foi enviado"));
    }
    notify_both(&app, &q, &me, &target.id);
    if matches!(result, FriendRequest::Accepted) {
        app.broadcast_presence(&q, &me);
        app.broadcast_presence(&q, &target.id);
    }
    created(q.friend(&me, &target.id))
}

async fn accept_friend(State(app): S, Me(me): Me, Path(other): Path<String>) -> Res {
    let q = app.store.q();
    if !q.accept_friend(&me, &other) {
        return Err(not_found("Pedido de amizade"));
    }
    notify_both(&app, &q, &me, &other);
    ok(q.friend(&me, &other))
}

async fn remove_friend(State(app): S, Me(me): Me, Path(other): Path<String>) -> Res {
    let q = app.store.q();
    if !q.remove_friend(&me, &other) {
        return Err(not_found("Amizade"));
    }
    app.to_user(&me, "friend:remove", &json!({ "userId": other }));
    app.to_user(&other, "friend:remove", &json!({ "userId": me }));
    no_content()
}

//! Painel administrador (backoffice.useline.tech, projeto apps/admin): estatísticas, usuários, servidores, denúncias e
//! bug reports. Tudo em /api/admin/*, só para as contas em ADMIN_USERS, com limite de pedidos.
//! Também fica aqui o envio de denúncias e bug reports pelo app (POST /api/reports).
use crate::App;
use crate::errors::*;
use crate::gateway::VoiceFilter;
use crate::ids::now_iso;
use crate::routes::{Me, client_ip, remove_from_server};
use crate::store::{BAN_FOREVER, NewReport, lock};
use axum::body::Bytes;
use axum::extract::{FromRequestParts, Path, Query, State};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;

type S = State<Arc<App>>;
type Res = ApiResult<Response>;

fn ok<T: serde::Serialize>(v: T) -> Res {
    Ok(Json(v).into_response())
}

fn too_many() -> ApiError {
    ApiError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "RATE_LIMITED",
        "Muitos pedidos. Espere um pouco e tente de novo.",
    )
}

/// Conta admin autenticada. Quem não é admin recebe 403, e todo pedido conta no limite por IP.
pub struct Admin(pub String);

impl FromRequestParts<Arc<App>> for Admin {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, app: &Arc<App>) -> Result<Self, ApiError> {
        let ip = client_ip(&parts.headers).unwrap_or_else(|| "direto".into());
        if !app.admin_requests.allow(&ip) {
            return Err(too_many());
        }
        let Me(me) = Me::from_request_parts(parts, app).await?;
        if !app.is_admin(&me) {
            tracing::warn!("painel admin: acesso negado para {me} ({ip})");
            return Err(forbidden("Acesso restrito ao administrador"));
        }
        Ok(Admin(me))
    }
}

pub fn router() -> Router<Arc<App>> {
    Router::new()
        .route("/admin/login", post(panel_login))
        .route("/admin/gate", get(gate))
        .route("/admin/logout", post(panel_logout))
        .route("/admin/admins", get(list_admins))
        .route(
            "/admin/admins/{id}",
            axum::routing::put(add_admin).delete(remove_admin),
        )
        .route("/admin/me", get(admin_me))
        .route("/admin/stats", get(stats))
        .route("/admin/users", get(users))
        .route("/admin/users/{id}", get(user).delete(delete_user))
        .route("/admin/users/{id}/ban", post(ban_user).delete(unban_user))
        .route("/admin/users/{id}/logout", post(logout_user))
        .route("/admin/users/{id}/messages", delete(delete_user_messages))
        .route("/admin/servers", get(servers))
        .route("/admin/servers/{id}", get(server).delete(delete_server))
        .route(
            "/admin/servers/{id}/suspend",
            axum::routing::put(suspend_server).delete(unsuspend_server),
        )
        .route("/admin/messages/{id}", delete(delete_message))
        .route("/admin/reports", get(reports))
        .route("/admin/reports/{id}", patch(update_report))
        .route("/admin/log", get(log))
        .route("/reports", post(create_report))
}

fn qs_offset(qs: &HashMap<String, String>) -> i64 {
    qs.get("offset").and_then(|o| o.parse().ok()).unwrap_or(0)
}

async fn admin_me(State(app): S, Admin(me): Admin) -> Res {
    let mut user = serde_json::to_value(app.store.q().self_user(&me)).unwrap_or_default();
    user["owner"] = json!(app.is_owner(&me));
    ok(user)
}

// ---------- entrada no painel ----------

/// Cookie que libera as páginas do painel (o Caddy pergunta para /api/admin/gate antes de
/// entregar qualquer arquivo que não seja a tela de login). Só vale no subdomínio do painel.
const GATE_COOKIE: &str = "line_admin";

/// Para onde vai quem entrou mas não é admin: o app.
fn app_url() -> String {
    std::env::var("APP_URL").unwrap_or_else(|_| "https://useline.tech/app/".into())
}

fn gate_cookie(token: &str, max_age: i64) -> String {
    format!("{GATE_COOKIE}={token}; Path=/; Max-Age={max_age}; HttpOnly; Secure; SameSite=Strict")
}

fn cookie_value(parts: &axum::http::HeaderMap, name: &str) -> Option<String> {
    parts
        .get_all(axum::http::header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PanelLogin {
    username: Option<String>,
    password: Option<String>,
    /// Código de uso único da volta do "Entrar com Google".
    google_code: Option<String>,
}

/// Login do painel: confere a conta e, se for admin, entrega o token e o cookie das páginas.
/// Quem não é admin recebe 403 com o endereço do app para onde ir.
async fn panel_login(State(app): S, headers: axum::http::HeaderMap, b: Bytes) -> Res {
    let ip = client_ip(&headers).unwrap_or_else(|| "direto".into());
    if !app.admin_requests.allow(&ip) {
        return Err(too_many());
    }
    let input: PanelLogin =
        serde_json::from_slice(&b).map_err(|_| validation("Dados inválidos"))?;
    let user_id = if let Some(code) = input.google_code.as_deref().filter(|c| !c.is_empty()) {
        let google = app
            .google
            .as_ref()
            .ok_or_else(|| validation("Login com Google indisponível."))?;
        google
            .take_code(code.trim(), None, true)
            .ok_or_else(|| validation("Esse login expirou. Tente entrar com o Google de novo."))?
    } else {
        let (Some(username), Some(password)) = (input.username, input.password) else {
            return Err(validation("Preencha usuário e senha"));
        };
        crate::routes::check_login(&app, &headers, &username, password).await?
    };
    crate::routes::suspended(&app, &user_id)?;
    if !app.is_admin(&user_id) {
        tracing::warn!("painel admin: login de quem não é admin ({user_id}, {ip})");
        return Ok((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "not_admin", "message": "Acesso restrito.", "redirect": app_url() })),
        )
            .into_response());
    }
    let token = app.tokens.sign(&user_id);
    let mut res = Json(json!({ "token": token })).into_response();
    if let Ok(v) = gate_cookie(&token, 60 * 60 * 24 * 30).parse() {
        res.headers_mut().insert(axum::http::header::SET_COOKIE, v);
    }
    Ok(res)
}

/// Porteiro das páginas do painel (forward_auth do Caddy): admin passa; quem entrou e não é
/// admin vai para o app; quem não entrou vai para a tela de login.
async fn gate(State(app): S, headers: axum::http::HeaderMap) -> Response {
    let ip = client_ip(&headers).unwrap_or_else(|| "direto".into());
    let go = |to: String| (StatusCode::FOUND, [(axum::http::header::LOCATION, to)]).into_response();
    if !app.admin_requests.allow(&ip) {
        return too_many().into_response();
    }
    match cookie_value(&headers, GATE_COOKIE).and_then(|t| app.user_from_token(&t)) {
        Some(id) if app.is_admin(&id) => StatusCode::NO_CONTENT.into_response(),
        Some(id) => {
            tracing::warn!("painel admin: página pedida por quem não é admin ({id}, {ip})");
            go(app_url())
        }
        None => go("/login.html".into()),
    }
}

async fn panel_logout() -> Response {
    let mut res = StatusCode::NO_CONTENT.into_response();
    if let Ok(v) = gate_cookie("", 0).parse() {
        res.headers_mut().insert(axum::http::header::SET_COOKIE, v);
    }
    res
}

// ---------- admins ----------

async fn list_admins(State(app): S, Admin(_): Admin) -> Res {
    ok(app.store.q().admin_accounts(&app.admins))
}

fn require_owner(app: &App, me: &str) -> ApiResult<()> {
    if app.is_owner(me) {
        Ok(())
    } else {
        Err(forbidden(
            "Só o dono do painel pode mudar os administradores",
        ))
    }
}

/// Torna admin: `id` pode ser o id ou o @usuário.
async fn add_admin(State(app): S, Admin(me): Admin, Path(id): Path<String>) -> Res {
    require_owner(&app, &me)?;
    let q = app.store.q();
    let name = id.trim().trim_start_matches('@');
    let row = q
        .user_row(name)
        .or_else(|| q.user_by_username(name))
        .ok_or_else(|| not_found("Usuário"))?;
    if row.bot_server_id.is_some() || q.ban_of(&row.id).is_some() {
        return Err(bad_request("Essa conta não pode ser admin"));
    }
    q.set_admin_flag(&row.id, true);
    q.log_admin(&me, "add_admin", &row.id, &row.username);
    ok(json!({ "id": row.id, "username": row.username }))
}

async fn remove_admin(State(app): S, Admin(me): Admin, Path(id): Path<String>) -> Res {
    require_owner(&app, &me)?;
    if app.is_owner(&id) {
        return Err(bad_request("O dono do painel fica em /etc/line/admin.env"));
    }
    let q = app.store.q();
    q.set_admin_flag(&id, false);
    q.log_admin(&me, "remove_admin", &id, "");
    drop(q);
    // Derruba as sessões abertas no painel.
    app.store.q().revoke_sessions(&id);
    app.disconnect_user(&id);
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn stats(State(app): S, Admin(_): Admin) -> Res {
    let online = lock(&app.store.presence).online_ids();
    let voice = lock(&app.voice).all();
    let q = app.store.q();
    let mut stats = q.admin_stats();
    // Quem está em chamada agora, agrupado por canal.
    let mut calls: HashMap<String, Vec<String>> = HashMap::new();
    for v in &voice {
        calls
            .entry(v.state.channel_id.clone())
            .or_default()
            .push(v.state.user_id.clone());
    }
    let live: Vec<Value> = calls
        .into_iter()
        .map(|(channel_id, users)| {
            let channel = q.channel(&channel_id);
            let server = channel
                .as_ref()
                .and_then(|c| c.server_id.as_deref())
                .and_then(|s| q.server(s));
            json!({
                "channelId": channel_id,
                "channelName": channel.as_ref().map(|c| c.name.clone()),
                "kind": channel.as_ref().map(|c| c.kind.clone()),
                "serverName": server.map(|s| s.name),
                "users": users.iter().filter_map(|u| q.public_user(u)).collect::<Vec<_>>(),
            })
        })
        .collect();
    let playing = lock(&app.music).playing_count();
    if let Some(obj) = stats.as_object_mut() {
        obj.insert("online".into(), json!(online.len()));
        obj.insert("inCall".into(), json!(voice.len()));
        obj.insert("liveCalls".into(), json!(live));
        obj.insert("musicPlaying".into(), json!(playing));
        obj.insert("version".into(), json!(crate::VERSION));
    }
    ok(stats)
}

async fn users(State(app): S, Admin(_): Admin, Query(qs): Query<HashMap<String, String>>) -> Res {
    let online = lock(&app.store.presence).online_ids();
    let q = app.store.q();
    let mut list = q.admin_users(
        qs.get("q").map(|s| s.as_str()).unwrap_or(""),
        qs.get("filter").map(|s| s.as_str()).unwrap_or("all"),
        &online,
        qs_offset(&qs),
    );
    for u in &mut list {
        let id = u["id"].as_str().unwrap_or_default().to_string();
        let presence = q.presence_of(&id, u["status"].as_str().unwrap_or("online"));
        u["online"] = json!(online.contains(&id));
        u["presence"] = json!(presence);
        // Não usar app.is_admin aqui: ele pega o banco de novo e o `q` acima já segura a trava
        // (com 1 vCPU isso congelava o servidor inteiro).
        u["admin"] = json!(app.is_owner(&id) || q.admin_flag(&id));
    }
    ok(list)
}

async fn user(State(app): S, Admin(_): Admin, Path(id): Path<String>) -> Res {
    let online = lock(&app.store.presence).online_ids().contains(&id);
    let in_call = lock(&app.voice)
        .get(&id)
        .map(|v| v.state.channel_id.clone());
    let mut u = app
        .store
        .q()
        .admin_user(&id)
        .ok_or_else(|| not_found("Usuário"))?;
    u["online"] = json!(online);
    u["inCall"] = json!(in_call);
    u["admin"] = json!(app.is_admin(&id));
    ok(u)
}

/// Não deixa o admin suspender/apagar a si mesmo, outro admin ou um bot.
fn target_user(app: &App, me: &str, id: &str) -> ApiResult<()> {
    if id == me || app.is_admin(id) {
        return Err(forbidden(
            "Não dá para fazer isso com uma conta de administrador",
        ));
    }
    let q = app.store.q();
    let row = q.user_row(id).ok_or_else(|| not_found("Usuário"))?;
    if row.bot_server_id.is_some() {
        return Err(bad_request("Essa conta é um bot de música"));
    }
    Ok(())
}

/// Tira a pessoa de tudo que está aberto agora: voz, conexões em tempo real e sessões.
pub(crate) fn kick_out(app: &App, id: &str) {
    let q = app.store.q();
    app.drop_voice(
        &q,
        VoiceFilter {
            user_id: Some(id),
            ..Default::default()
        },
    );
    q.revoke_sessions(id);
    drop(q);
    app.disconnect_user(id);
}

#[derive(Deserialize)]
struct BanInput {
    /// Dias de suspensão; vazio ou 0 = para sempre.
    days: Option<f64>,
    #[serde(default)]
    reason: String,
}

async fn ban_user(State(app): S, Admin(me): Admin, Path(id): Path<String>, b: Bytes) -> Res {
    target_user(&app, &me, &id)?;
    let input: BanInput = serde_json::from_slice(&b).map_err(|_| validation("Dados inválidos"))?;
    let reason: String = input.reason.trim().chars().take(500).collect();
    let until = match input.days.filter(|d| *d > 0.0) {
        Some(d) => (chrono::Utc::now()
            + chrono::Duration::minutes((d.min(3650.0) * 24.0 * 60.0) as i64))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string(),
        None => BAN_FOREVER.to_string(),
    };
    {
        let q = app.store.q();
        q.set_ban(&id, Some(&until), &reason);
        let label = if until == BAN_FOREVER {
            "para sempre".to_string()
        } else {
            format!("até {until}")
        };
        q.log_admin(&me, "ban", &id, &format!("{label}; {reason}"));
    }
    kick_out(&app, &id);
    ok(json!({ "bannedUntil": until }))
}

async fn unban_user(State(app): S, Admin(me): Admin, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    q.user_row(&id).ok_or_else(|| not_found("Usuário"))?;
    q.set_ban(&id, None, "");
    q.log_admin(&me, "unban", &id, "");
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn logout_user(State(app): S, Admin(me): Admin, Path(id): Path<String>) -> Res {
    app.store
        .q()
        .user_row(&id)
        .ok_or_else(|| not_found("Usuário"))?;
    kick_out(&app, &id);
    app.store.q().log_admin(&me, "logout", &id, "");
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Apaga todas as mensagens da conta (spam) e avisa os canais.
fn wipe_messages(app: &App, id: &str) -> usize {
    let q = app.store.q();
    let list = q.message_ids_by_author(id);
    let n = q.delete_messages_by_author(id);
    for (message_id, channel_id) in &list {
        app.to_channel(
            &q,
            channel_id,
            "message:delete",
            &json!({ "id": message_id, "channelId": channel_id }),
        );
    }
    n
}

async fn delete_user_messages(State(app): S, Admin(me): Admin, Path(id): Path<String>) -> Res {
    target_user(&app, &me, &id)?;
    let n = wipe_messages(&app, &id);
    app.store
        .q()
        .log_admin(&me, "delete_messages", &id, &format!("{n} mensagens"));
    app.sweep_uploads();
    ok(json!({ "deleted": n }))
}

#[derive(Deserialize, Default)]
struct DeleteUserInput {
    #[serde(default, rename = "deleteMessages")]
    delete_messages: bool,
}

/// "Apagar conta": sai dos servidores (os dela continuam até o admin apagar), perde os dados
/// pessoais e fica suspensa para sempre.
async fn delete_user(State(app): S, Admin(me): Admin, Path(id): Path<String>, b: Bytes) -> Res {
    target_user(&app, &me, &id)?;
    let input: DeleteUserInput = if b.is_empty() {
        Default::default()
    } else {
        serde_json::from_slice(&b).unwrap_or_default()
    };
    kick_out(&app, &id);
    let n = if input.delete_messages {
        wipe_messages(&app, &id)
    } else {
        0
    };
    {
        let q = app.store.q();
        for server_id in q.server_ids_of(&id) {
            if q.server(&server_id).is_some_and(|s| s.owner_id != id) {
                remove_from_server(&app, &q, &server_id, &id);
            }
        }
        q.anonymize_user(&id);
        if let Some(user) = q.public_user(&id) {
            app.to_users(&q.audience_of(&id), "user:update", &user);
        }
        q.log_admin(&me, "delete_user", &id, &format!("{n} mensagens apagadas"));
    }
    app.sweep_uploads();
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Quantos membros do servidor estão conectados agora (mesma conta do "online" do painel).
fn online_in(
    q: &crate::store::Q<'_>,
    online: &std::collections::HashSet<String>,
    server_id: &str,
) -> usize {
    q.member_ids(server_id)
        .iter()
        .filter(|id| online.contains(*id))
        .count()
}

async fn servers(State(app): S, Admin(_): Admin, Query(qs): Query<HashMap<String, String>>) -> Res {
    let online: std::collections::HashSet<String> =
        lock(&app.store.presence).online_ids().into_iter().collect();
    let q = app.store.q();
    let mut list = q.admin_servers(
        qs.get("q").map(|s| s.as_str()).unwrap_or(""),
        qs_offset(&qs),
    );
    for s in &mut list {
        let id = s["id"].as_str().unwrap_or_default().to_string();
        s["onlineCount"] = json!(online_in(&q, &online, &id));
    }
    ok(list)
}

async fn server(State(app): S, Admin(_): Admin, Path(id): Path<String>) -> Res {
    let online: std::collections::HashSet<String> =
        lock(&app.store.presence).online_ids().into_iter().collect();
    let q = app.store.q();
    let mut server = q.admin_server(&id).ok_or_else(|| not_found("Servidor"))?;
    server["onlineCount"] = json!(online_in(&q, &online, &id));
    ok(server)
}

async fn delete_server(State(app): S, Admin(me): Admin, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    let server = q.server(&id).ok_or_else(|| not_found("Servidor"))?;
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
    q.log_admin(&me, "delete_server", &server.id, &server.name);
    drop(q);
    app.sweep_uploads();
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Suspende o servidor: guarda tudo, mas derruba a voz e bloqueia mensagens/voz para todos.
async fn suspend_server(State(app): S, Admin(me): Admin, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    let server = q.server(&id).ok_or_else(|| not_found("Servidor"))?;
    app.drop_voice(
        &q,
        VoiceFilter {
            server_id: Some(&server.id),
            ..Default::default()
        },
    );
    q.set_server_suspended(&server.id, true);
    q.log_admin(&me, "suspend_server", &server.id, &server.name);
    if let Some(s) = q.server(&server.id) {
        app.server_updated(&q, &s);
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn unsuspend_server(State(app): S, Admin(me): Admin, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    let server = q.server(&id).ok_or_else(|| not_found("Servidor"))?;
    q.set_server_suspended(&server.id, false);
    q.log_admin(&me, "unsuspend_server", &server.id, &server.name);
    if let Some(s) = q.server(&server.id) {
        app.server_updated(&q, &s);
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn delete_message(State(app): S, Admin(me): Admin, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    let message = q.message(&id).ok_or_else(|| not_found("Mensagem"))?;
    let files = q.attachment_ids_of_message(&message.id);
    q.delete_message(&message.id);
    app.remove_upload_files(&files);
    app.to_channel(
        &q,
        &message.channel_id,
        "message:delete",
        &json!({ "id": message.id, "channelId": message.channel_id }),
    );
    q.log_admin(
        &me,
        "delete_message",
        &message.id,
        &message.content.chars().take(200).collect::<String>(),
    );
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn reports(State(app): S, Admin(_): Admin, Query(qs): Query<HashMap<String, String>>) -> Res {
    ok(app.store.q().admin_reports(
        qs.get("kind").map(|s| s.as_str()),
        qs.get("status").map(|s| s.as_str()),
        qs_offset(&qs),
    ))
}

#[derive(Deserialize)]
struct ReportPatch {
    status: String,
    note: Option<String>,
}

async fn update_report(State(app): S, Admin(me): Admin, Path(id): Path<String>, b: Bytes) -> Res {
    let input: ReportPatch =
        serde_json::from_slice(&b).map_err(|_| validation("Dados inválidos"))?;
    if !matches!(input.status.as_str(), "open" | "resolved" | "dismissed") {
        return Err(validation("Status inválido"));
    }
    let note = input
        .note
        .map(|n| n.trim().chars().take(1000).collect::<String>());
    let q = app.store.q();
    if !q.update_report(&id, &input.status, note.as_deref(), &me) {
        return Err(not_found("Denúncia"));
    }
    q.log_admin(&me, "report", &id, &input.status);
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn log(State(app): S, Admin(_): Admin, Query(qs): Query<HashMap<String, String>>) -> Res {
    ok(app.store.q().admin_log(qs_offset(&qs)))
}

// ---------- envio pelo app ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportInput {
    /// bug | idea | user | message
    kind: String,
    target_user_id: Option<String>,
    message_id: Option<String>,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    details: String,
    #[serde(default)]
    platform: String,
    #[serde(default)]
    version: String,
    /// Ids de anexos de imagem já enviados por POST /api/attachments (até 5).
    #[serde(default)]
    images: Vec<String>,
}

fn clip(s: &str, n: usize) -> String {
    s.trim().chars().take(n).collect()
}

/// Denúncia de usuário/mensagem ou bug report/sugestão. Até 10 por hora e 30 por dia por conta.
async fn create_report(State(app): S, Me(me): Me, b: Bytes) -> Res {
    let input: ReportInput =
        serde_json::from_slice(&b).map_err(|_| validation("Dados inválidos"))?;
    if !matches!(input.kind.as_str(), "bug" | "idea" | "user" | "message") {
        return Err(validation("Tipo inválido"));
    }
    // Prints: até 5 no bug report/sugestão e 3 na denúncia de usuário.
    let max_images = if input.kind == "user" { 3 } else { 5 };
    if input.images.len() > max_images {
        return Err(validation(format!("Mande no máximo {max_images} imagens.")));
    }
    let details = clip(&input.details, 4000);
    let reason = clip(&input.reason, 100);
    if matches!(input.kind.as_str(), "bug" | "idea") && details.chars().count() < 5 {
        return Err(validation("Conte um pouco mais (pelo menos 5 letras)."));
    }
    if app.store.q().reports_today(&me) >= 30 || !app.report_requests.allow(&me) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "Você já mandou muitos relatos agora. Tente de novo mais tarde.",
        ));
    }
    let q = app.store.q();
    let (mut target, mut channel_id, mut server_id, mut content) =
        (input.target_user_id.clone(), None, None, None);
    let mut message_id = None;
    let mut snapshot: Option<Value> = None;
    let mut evidence: Vec<crate::model::Attachment> = vec![];
    match input.kind.as_str() {
        "message" => {
            // Só dá para denunciar mensagem que a pessoa consegue ver; guarda uma cópia do texto
            // (a mensagem pode ser apagada depois).
            let m = input
                .message_id
                .as_deref()
                .and_then(|id| q.message(id))
                .filter(|m| q.can_access(&me, &m.channel_id))
                .ok_or_else(|| not_found("Mensagem"))?;
            let names: Vec<&str> = m.attachments.iter().map(|a| a.filename.as_str()).collect();
            let mut text = m.content.clone();
            if !names.is_empty() {
                text.push_str(&format!("\n[anexos: {}]", names.join(", ")));
            }
            content = Some(clip(&text, 4000));
            target = Some(m.author.id.clone());
            channel_id = Some(m.channel_id.clone());
            let channel = q.channel(&m.channel_id);
            server_id = channel.as_ref().and_then(|c| c.server_id.clone());
            let server = server_id.as_deref().and_then(|s| q.server(s));
            // Contexto para o julgamento: até 5 mensagens antes e 5 depois no mesmo canal/conversa
            // (só aparece no painel admin).
            let brief = |x: &crate::model::Message| {
                json!({
                    "id": x.id,
                    "content": x.content,
                    "createdAt": x.created_at,
                    "editedAt": x.edited_at,
                    "author": { "id": x.author.id, "username": x.author.username, "displayName": x.author.display_name },
                    "attachments": x.attachments.iter().map(|a| json!({ "filename": a.filename })).collect::<Vec<_>>(),
                })
            };
            let before: Vec<Value> = q
                .messages(&m.channel_id, Some(&m.id), 5)
                .iter()
                .map(brief)
                .collect();
            let after: Vec<Value> = q
                .messages_after(&m.channel_id, &m.id, 5)
                .iter()
                .map(brief)
                .collect();
            snapshot = Some(json!({
                "before": before,
                "after": after,
                "id": m.id,
                "content": m.content,
                "createdAt": m.created_at,
                "editedAt": m.edited_at,
                "author": { "id": m.author.id, "username": m.author.username, "displayName": m.author.display_name },
                "channel": channel.as_ref().map(|c| json!({ "id": c.id, "name": c.name, "type": c.kind })),
                "server": server.as_ref().map(|s| json!({ "id": s.id, "name": s.name })),
                "attachments": m.attachments.iter().map(|a| json!({ "filename": a.filename, "contentType": a.content_type, "size": a.size })).collect::<Vec<_>>(),
                "reportedAt": now_iso(),
            }));
            evidence = m.attachments.clone();
            message_id = Some(m.id);
        }
        "user" => {
            let t = target
                .as_deref()
                .and_then(|id| q.user_row(id))
                .ok_or_else(|| not_found("Usuário"))?;
            if t.id == me {
                return Err(bad_request("Você não pode denunciar a si mesmo"));
            }
        }
        _ => target = None,
    }
    if target.as_deref() == Some(me.as_str()) {
        return Err(bad_request("Você não pode denunciar a si mesmo"));
    }
    let id = q.create_report(NewReport {
        kind: &input.kind,
        reporter_id: &me,
        target_user_id: target.as_deref(),
        message_id: message_id.as_deref(),
        channel_id: channel_id.as_deref(),
        server_id: server_id.as_deref(),
        message_content: content.as_deref(),
        reason: &reason,
        details: &details,
        platform: &clip(&input.platform, 60),
        version: &clip(&input.version, 40),
        images: if matches!(input.kind.as_str(), "bug" | "idea" | "user") {
            &input.images
        } else {
            &[]
        },
    });
    // Prova que não some: cópia dos arquivos da mensagem (até 10 e 100 MB), que ficam mesmo se
    // a mensagem for apagada.
    if let Some(snap) = snapshot {
        let mut copies = vec![];
        let mut total = 0i64;
        for a in evidence.iter().take(10) {
            total += a.size;
            if total > 100 * 1024 * 1024 {
                break;
            }
            let new = crate::ids::new_id();
            if std::fs::copy(app.uploads_dir.join(&a.id), app.uploads_dir.join(&new)).is_ok() {
                q.create_attachment(
                    &new,
                    target.as_deref().unwrap_or(&me),
                    &a.filename,
                    &a.content_type,
                    a.size,
                );
                copies.push(new);
            }
        }
        q.set_report_evidence(&id, &snap.to_string(), &copies);
    }
    Ok((
        StatusCode::CREATED,
        Json(json!({ "id": id, "createdAt": now_iso() })),
    )
        .into_response())
}

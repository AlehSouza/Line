//! Rotas REST em /api (mesmos caminhos, corpos e respostas do servidor antigo).
use crate::errors::*;
use crate::gateway::VoiceFilter;
use crate::model::*;
use crate::perms::{self, has};
use crate::store::{
    ChannelAccess, ChannelPatch, FriendRequest, ProfilePatch, Q, RolePatch, SearchFilter,
    SearchScope, ServerPatch,
};
use crate::validate::{self, body};
use crate::{App, VERSION, auth};
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Request};
use axum::extract::{FromRequestParts, Path, Query, State};
use axum::http::HeaderMap;
use axum::http::request::Parts;
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use futures_util::StreamExt;
use serde_json::json;
use socketioxide::layer::SocketIoLayer;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tower::ServiceExt;
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
        let user_id = app.user_from_token(token).ok_or_else(unauthorized)?;
        Ok(Me(user_id))
    }
}

pub fn router(app: Arc<App>, socket_layer: SocketIoLayer) -> Router {
    let api = Router::new()
        .route("/auth/register", post(register))
        .route("/auth/config", get(auth_config))
        .route("/auth/captcha", get(captcha_page))
        .route("/auth/login", post(login))
        .route("/auth/forgot", post(forgot_password))
        .route("/auth/reset", post(reset_password))
        .route("/auth/reset/info", get(reset_info))
        .route("/auth/google/start", get(google_start))
        .route("/auth/google/callback", get(google_callback))
        .route("/auth/google/finish", post(google_finish))
        .route("/users/@me", get(get_me).patch(update_me))
        .route("/users/@me/servers/order", put(reorder_my_servers))
        .route("/users/@me/account", patch(update_account))
        .route("/users/@me/deactivate", post(deactivate_me))
        .route("/users/@me/delete", post(delete_me))
        .route("/users/@me/password", post(change_password))
        .route("/users/@me/code", post(send_email_code))
        .route("/users/@me/password/link", post(send_reset_link))
        .route("/users/@me/games", get(my_games).patch(update_my_game))
        .route(
            "/users/@me/activity-settings",
            get(get_activity_settings).put(put_activity_settings),
        )
        .route("/servers/{id}/activities", get(server_activities))
        .route("/users/{id}", get(get_user))
        .route("/users/{id}/mutual", get(get_mutual))
        .route("/search", get(search))
        .route("/gifs", get(search_gifs))
        .route("/embeds", get(get_embed))
        .route("/media", get(get_media))
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
            axum::routing::delete(kick_member).patch(update_member),
        )
        .route("/servers/{id}/join", post(join_public))
        .route("/servers/{id}/channels", post(create_channel))
        .route("/servers/{id}/layout", put(set_layout))
        .route("/servers/{id}/notes", put(set_notes))
        .route("/channels/{id}/events", get(list_events).post(create_event))
        .route("/events/{id}", patch(update_event).delete(delete_event))
        .route("/events/{id}/rsvp", put(rsvp_event))
        .route("/servers/{id}/roles", get(list_roles).post(create_role))
        .route("/servers/{id}/roles/order", put(reorder_roles))
        .route(
            "/servers/{id}/members/{user_id}/roles/{role_id}",
            put(add_member_role).delete(remove_member_role),
        )
        .route(
            "/roles/{id}",
            axum::routing::patch(update_role).delete(delete_role),
        )
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
        .route(
            "/channels/{id}/threads",
            get(list_threads).post(create_thread),
        )
        .route("/channels/{id}/audience", get(channel_audience))
        .route("/servers/{id}/card", get(server_card))
        .route("/channels/{id}/polls", post(create_poll))
        .route("/channels/{id}/music/play", post(music_play))
        .route(
            "/servers/{id}/music/bot",
            get(get_music_bot).patch(update_music_bot),
        )
        .route(
            "/servers/{id}/agent/replies",
            get(get_bot_replies).put(set_bot_replies),
        )
        .route(
            "/servers/{id}/music/settings",
            get(get_music_settings).patch(update_music_settings),
        )
        .route("/messages/{id}/poll/votes", post(vote_poll))
        .route("/messages/{id}/pin", put(pin_message).delete(unpin_message))
        .route("/channels/{id}/pins", get(list_pins))
        .route(
            "/messages/{id}/reactions/{emoji}",
            put(add_reaction).delete(remove_reaction),
        )
        .route(
            "/attachments",
            post(upload_attachment).layer(DefaultBodyLimit::max(MAX_UPLOAD)),
        )
        .route("/attachments/{id}/{name}", get(serve_attachment))
        .route(
            "/attachments/{id}/reactions/{emoji}",
            put(add_attachment_reaction).delete(remove_attachment_reaction),
        )
        .route("/voice/ice", get(ice_servers))
        .route("/soundboard", get(list_my_sounds))
        .route("/servers/{id}/sounds", post(create_sound))
        .route(
            "/servers/{id}/sounds/{sound_id}",
            patch(update_sound).delete(delete_sound),
        )
        .route("/dms", get(list_dms).post(open_dm))
        .route("/dms/{id}/leave", post(leave_dm))
        .route("/friends", get(list_friends).post(add_friend))
        .route(
            "/friends/{user_id}",
            put(accept_friend).delete(remove_friend),
        )
        .route(
            "/friends/{user_id}/block",
            put(block_user).delete(unblock_user),
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

    STARTED.get_or_init(std::time::Instant::now);
    Router::new()
        .route(
            "/api/health",
            get(|| async { Json(json!({ "ok": true, "name": "line", "version": VERSION })) }),
        )
        .route("/api/status", get(public_status))
        .nest(
            "/api",
            api.merge(crate::admin::router())
                .merge(crate::profile::router())
                .merge(crate::notify::router())
                .merge(crate::saved::router())
                .merge(crate::forward::router()),
        )
        .fallback(web_fallback)
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

/// O que a tela de login precisa saber antes do cadastro (ex.: chave pública do captcha).
async fn auth_config(State(app): S) -> Res {
    Ok(Json(json!({
        "turnstileSiteKey": app.turnstile.as_ref().map(|t| t.site_key.clone()),
        "passwordReset": app.mailer.is_some(),
        "google": app.google.is_some(),
    }))
    .into_response())
}

/// Página do captcha servida pelo próprio domínio: o app desktop (origem tauri.localhost, que a
/// Cloudflare não aceita) a abre num iframe e recebe o token por postMessage.
async fn captcha_page(State(app): S) -> Res {
    let Some(t) = &app.turnstile else {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "CAPTCHA_DISABLED",
            "Captcha desativado.",
        ));
    };
    let key = serde_json::to_string(&t.site_key).unwrap_or_default();
    let html = format!(
        r##"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>html,body{{margin:0;background:transparent;overflow:hidden}}body{{display:flex;justify-content:center}}</style>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=go" async defer></script>
<script>
function send(token){{parent.postMessage({{type:"line-captcha",token:token}},"*")}}
function go(){{turnstile.render("#w",{{sitekey:{key},theme:"dark",language:"pt-br",
callback:send,"expired-callback":function(){{send("")}},"error-callback":function(){{send("")}}}})}}
</script></head><body><div id="w"></div></body></html>"##
    );
    Ok((
        [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
        .into_response())
}

/// GIFs do GIPHY: `?q=` busca, sem `q` devolve os em alta.
async fn search_gifs(State(app): S, Me(_me): Me, Query(qs): Query<HashMap<String, String>>) -> Res {
    let Some(giphy) = &app.giphy else {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "GIFS_DISABLED",
            "GIFs indisponíveis neste servidor.",
        ));
    };
    let q: String = qs
        .get("q")
        .map(|s| s.trim().chars().take(50).collect())
        .unwrap_or_default();
    let offset = qs
        .get("offset")
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0)
        .min(4900);
    match giphy.search(&q, offset).await {
        Ok(list) => Ok(Json(list).into_response()),
        Err(err) => {
            tracing::warn!("GIPHY indisponível: {err}");
            Err(ApiError::new(
                StatusCode::BAD_GATEWAY,
                "GIFS_UNAVAILABLE",
                "Não deu para carregar os GIFs agora.",
            ))
        }
    }
}

/// Preview de um link do chat. Sem preview possível, devolve `null`.
async fn get_embed(State(app): S, Me(_me): Me, Query(qs): Query<HashMap<String, String>>) -> Res {
    let url = qs.get("url").map(|s| s.trim()).unwrap_or_default();
    if url.len() > 2048 || !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_URL",
            "Link inválido.",
        ));
    }
    Ok(Json(app.embeds.get(url).await).into_response())
}

/// Imagem/vídeo de outro site, arrastado para o chat: o servidor baixa e devolve os bytes.
async fn get_media(State(app): S, Me(me): Me, Query(qs): Query<HashMap<String, String>>) -> Res {
    let url = qs.get("url").map(|s| s.trim()).unwrap_or_default();
    if url.len() > 4096 || !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_URL",
            "Link inválido.",
        ));
    }
    // Cada download pode ocupar até 50 MB de memória: limita por usuário e no total.
    let busy = || {
        ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "Muitos arquivos de uma vez. Espere um pouco e tente de novo.",
        )
    };
    if !app.media_requests.allow(&me) {
        return Err(busy());
    }
    let Ok(_slot) = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        app.media_slots.acquire(),
    )
    .await
    else {
        return Err(busy());
    };
    match crate::embeds::fetch_media(url).await {
        Ok((ctype, bytes)) => {
            Ok(([(axum::http::header::CONTENT_TYPE, ctype)], bytes).into_response())
        }
        Err(msg) => Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "MEDIA_UNAVAILABLE",
            msg,
        )),
    }
}

/// IP de quem chamou, como o Caddy informa. Sem o cabeçalho (acesso direto, testes), não limita.
pub(crate) fn client_ip(headers: &HeaderMap) -> Option<String> {
    let v = headers.get("x-forwarded-for")?.to_str().ok()?;
    v.split(',')
        .next()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

async fn register(State(app): S, headers: HeaderMap, b: Bytes) -> Res {
    let input = body::<validate::Register>(&b)?.check()?;
    let ip = client_ip(&headers);
    if let Some(turnstile) = &app.turnstile {
        let token = input.captcha_token.as_deref().unwrap_or_default();
        if token.is_empty() || !turnstile.verify(token, ip.as_deref()).await {
            return Err(validation("Confirme que você não é um robô."));
        }
    }
    if ip.as_deref().is_some_and(|ip| !app.signups.allow(ip)) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "Muitas contas criadas daqui. Tente de novo mais tarde.",
        ));
    }
    if app.store.q().user_by_username(&input.username).is_some() {
        return Err(conflict("Esse nome de usuário já está em uso"));
    }
    if input
        .email
        .as_deref()
        .is_some_and(|e| app.store.q().email_in_use(e))
    {
        return Err(conflict("Esse email já tem uma conta"));
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
        if input.email.as_deref().is_some_and(|e| q.email_in_use(e)) {
            return Err(conflict("Esse email já tem uma conta"));
        }
        q.create_user(
            &input.username,
            input.email.as_deref(),
            input.display_name.as_deref().unwrap_or(&input.username),
            &hash,
        )
    };
    created(AuthResponse {
        token: app.tokens.sign(&user.public.id),
        user,
    })
}

async fn login(State(app): S, headers: HeaderMap, b: Bytes) -> Res {
    let input = body::<validate::Login>(&b)?.check()?;
    let user_id = check_login(&app, &headers, &input.username, input.password).await?;
    suspended(&app, &user_id)?;
    app.store.q().set_deactivated(&user_id, false);
    let user = app.store.q().self_user(&user_id).ok_or_else(unauthorized)?;
    ok(AuthResponse {
        token: app.tokens.sign(&user_id),
        user,
    })
}

/// Confere usuário e senha (com o limite contra força bruta) e devolve o id da conta.
pub(crate) async fn check_login(
    app: &App,
    headers: &HeaderMap,
    username: &str,
    password: String,
) -> ApiResult<String> {
    let invalid = || {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "Usuário ou senha incorretos",
        )
    };
    // Contra força bruta: muitas senhas erradas seguidas bloqueiam por 15 minutos
    // (por IP e por conta).
    let ip = client_ip(headers);
    let user_key = username.trim().to_lowercase();
    if ip
        .as_deref()
        .is_some_and(|ip| app.login_fails_ip.blocked(ip))
        || app.login_fails_user.blocked(&user_key)
    {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "Muitas tentativas de login. Espere 15 minutos e tente de novo.",
        ));
    }
    let fail = || {
        if let Some(ip) = ip.as_deref() {
            app.login_fails_ip.hit(ip);
        }
        app.login_fails_user.hit(&user_key);
        invalid()
    };
    let Some(row) = app.store.q().user_by_username(username) else {
        return Err(fail());
    };
    let stored = row.password_hash.clone();
    let valid = tokio::task::spawn_blocking(move || auth::verify_password(&password, &stored))
        .await
        .unwrap_or(false);
    if !valid {
        return Err(fail());
    }
    Ok(row.id)
}

/// Conta suspensa pelo admin: o login avisa até quando e o motivo.
pub(crate) fn suspended(app: &App, user_id: &str) -> ApiResult<()> {
    let Some((until, reason)) = app.store.q().ban_of(user_id) else {
        return Ok(());
    };
    let when = if until.as_str() >= crate::store::BAN_FOREVER {
        "Sua conta foi suspensa.".to_string()
    } else {
        let br = chrono::DateTime::parse_from_rfc3339(&until)
            .map(|d| {
                (d.with_timezone(&chrono::Utc) - chrono::Duration::hours(3))
                    .format("%d/%m/%Y às %H:%M")
                    .to_string()
            })
            .unwrap_or(until);
        format!("Sua conta está suspensa até {br}.")
    };
    let why = if reason.is_empty() {
        String::new()
    } else {
        format!(" Motivo: {reason}")
    };
    Err(ApiError::new(
        StatusCode::FORBIDDEN,
        "ACCOUNT_SUSPENDED",
        format!("{when}{why}"),
    ))
}

fn google_disabled() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "GOOGLE_DISABLED",
        "Login com Google indisponível.",
    )
}

/// Valor de um cookie do pedido.
fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(axum::http::header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_string())
}

fn redirect(url: &str) -> Response {
    (
        StatusCode::FOUND,
        [(axum::http::header::LOCATION, url.to_string())],
    )
        .into_response()
}

/// Começo do "Entrar com Google": `?port=N` quando é o app desktop (que escuta em 127.0.0.1:N).
async fn google_start(
    State(app): S,
    headers: HeaderMap,
    Query(qs): Query<HashMap<String, String>>,
) -> Res {
    let google = app.google.as_ref().ok_or_else(google_disabled)?;
    let target = match qs.get("port").and_then(|p| p.parse::<u16>().ok()) {
        Some(port) if port >= 1024 => crate::google::Target::Desktop(port),
        _ if qs.contains_key("admin") => crate::google::Target::Admin,
        _ => crate::google::Target::Web,
    };
    // Reaproveita o cookie se já existir (duas abas fazendo login ao mesmo tempo continuam valendo).
    let nonce = cookie(&headers, crate::google::COOKIE)
        .filter(|n| {
            n.len() == 43
                && n.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
        .unwrap_or_else(crate::google::new_nonce);
    let mut res = redirect(&google.authorize_url(target, &nonce));
    if let Ok(v) = google.cookie_header(&nonce).parse() {
        res.headers_mut().insert(axum::http::header::SET_COOKIE, v);
    }
    Ok(res)
}

/// Volta do Google: acha a conta (pelo Google ou pelo email verificado) ou cria uma nova.
async fn google_callback(
    State(app): S,
    headers: HeaderMap,
    Query(qs): Query<HashMap<String, String>>,
) -> Res {
    let google = app.google.as_ref().ok_or_else(google_disabled)?;
    let nonce = cookie(&headers, crate::google::COOKIE);
    let Some(target) = qs
        .get("state")
        .and_then(|s| google.take_state(s, nonce.as_deref()))
    else {
        return Err(validation(
            "Esse login expirou. Tente entrar com o Google de novo.",
        ));
    };
    let fail = |msg: &str| Ok(redirect(&google.return_url(target, Err(msg))));
    let Some(code) = qs.get("code") else {
        return fail("Login com Google cancelado.");
    };
    let profile = match google.profile(code).await {
        Ok(p) => p,
        Err(err) => {
            tracing::warn!("Google OAuth falhou: {err}");
            return fail("Não deu para falar com o Google agora. Tente de novo.");
        }
    };
    let email = profile
        .email
        .as_deref()
        .filter(|_| profile.email_verified)
        .map(|e| e.trim().to_lowercase());
    let user_id = {
        let q = app.store.q();
        if let Some(u) = q.user_by_google(&profile.sub) {
            u.id
        } else if let Some(u) = email.as_deref().and_then(|e| q.user_by_email(e)) {
            // O cadastro com senha não confirma o email. Se ele não foi confirmado, quem criou a
            // conta pode não ser o dono do email: o Google prova que é, então a senha antiga
            // deixa de valer e todas as sessões abertas caem.
            if !q.email_verified(&u.id) {
                q.set_password_hash(&u.id, "google");
                q.revoke_sessions(&u.id);
                app.disconnect_user(&u.id);
            }
            q.set_google_id(&u.id, &profile.sub);
            q.set_email_verified(&u.id);
            u.id
        } else {
            let Some(email) = email else {
                return fail("Sua conta do Google não tem um email verificado.");
            };
            let base = crate::google::username_base(&profile);
            let mut username = base.clone();
            let mut n = 1;
            while q.user_by_username(&username).is_some() {
                n += 1;
                username = format!("{base}{n}");
            }
            let display = profile
                .name
                .as_deref()
                .map(|n| n.trim().chars().take(32).collect::<String>())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| username.clone());
            // Sem senha: o hash "google" nunca confere. Dá para criar uma pelo "Esqueci minha senha".
            let user = q.create_user(&username, Some(&email), &display, "google");
            q.set_google_id(&user.public.id, &profile.sub);
            q.set_email_verified(&user.public.id);
            user.public.id
        }
    };
    let web_nonce =
        matches!(target, crate::google::Target::Web).then(|| nonce.clone().unwrap_or_default());
    let code = google.issue_code(user_id, web_nonce);
    Ok(redirect(&google.return_url(target, Ok(&code))))
}

#[derive(serde::Deserialize)]
struct GoogleFinish {
    code: String,
    /// true quando quem troca o código é o app desktop (que recebeu o código pelo 127.0.0.1).
    #[serde(default)]
    desktop: bool,
}

/// Troca o código de uso único do callback pelo token do Line.
async fn google_finish(State(app): S, headers: HeaderMap, b: Bytes) -> Res {
    let google = app.google.as_ref().ok_or_else(google_disabled)?;
    let input: GoogleFinish =
        serde_json::from_slice(&b).map_err(|_| validation("Código inválido"))?;
    let user_id = google
        .take_code(
            input.code.trim(),
            cookie(&headers, crate::google::COOKIE).as_deref(),
            input.desktop,
        )
        .ok_or_else(|| validation("Esse login expirou. Tente entrar com o Google de novo."))?;
    suspended(&app, &user_id)?;
    app.store.q().set_deactivated(&user_id, false);
    let user = app
        .store
        .q()
        .self_user(&user_id)
        .ok_or_else(|| validation("Conta não encontrada"))?;
    ok(AuthResponse {
        token: app.tokens.sign(&user_id),
        user,
    })
}

/// Hash do token de recuperação: no banco só fica o SHA-256, nunca o token do link.
fn reset_token_hash(token: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Validade do link de recuperação.
const RESET_MINUTES: i64 = 30;

/// "Esqueci minha senha": manda um link por email. Responde igual exista ou não a conta,
/// para não revelar quais emails estão cadastrados.
async fn forgot_password(State(app): S, headers: HeaderMap, b: Bytes) -> Res {
    let input = body::<validate::ForgotPassword>(&b)?.check()?;
    let Some(_) = &app.mailer else {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "RESET_DISABLED",
            "A recuperação de senha ainda não está disponível.",
        ));
    };
    if client_ip(&headers).is_some_and(|ip| !app.resets.allow(&ip)) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "Muitos pedidos daqui. Tente de novo mais tarde.",
        ));
    }
    let found = {
        let q = app.store.q();
        q.user_by_email(&input.email)
            .filter(|u| !q.reset_requested_recently(&u.id, 60))
    };
    if let Some(user) = found {
        issue_reset_link(
            &app,
            &user.id,
            input.email.clone(),
            user.display_name.clone(),
        );
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Cria um token de recuperação e manda o link por email em segundo plano.
fn issue_reset_link(app: &Arc<App>, user_id: &str, email: String, name: String) {
    use base64::Engine;
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    app.store
        .q()
        .create_password_reset(user_id, &reset_token_hash(&token), RESET_MINUTES);
    let app = app.clone();
    tokio::spawn(async move {
        if let Some(mailer) = &app.mailer {
            let link = format!("{}/?reset={token}", mailer.app_url);
            mailer.send_password_reset(&email, &name, &link).await;
        }
    });
}

/// "Redefinir senha" nas configurações: manda o link para o email da própria conta
/// (serve também para conta do Google, que não tem senha).
async fn send_reset_link(State(app): S, Me(me): Me) -> Res {
    if app.mailer.is_none() {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "RESET_DISABLED",
            "O envio de email ainda não está disponível.",
        ));
    }
    let (email, name) = {
        let q = app.store.q();
        let user = q
            .user_row(&me)
            .ok_or_else(|| validation("Conta não encontrada"))?;
        let Some(email) = user.email.clone().filter(|e| !e.is_empty()) else {
            return Err(validation("Sua conta não tem email cadastrado."));
        };
        if q.reset_requested_recently(&me, 60) {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "RATE_LIMITED",
                "Espere um minuto para pedir outro link.",
            ));
        }
        (email, user.display_name)
    };
    issue_reset_link(&app, &me, email.clone(), name);
    ok(json!({ "email": email }))
}

/// Dono do link de recuperação, para a página mostrar "Redefinindo senha de ...".
async fn reset_info(State(app): S, Query(qs): Query<HashMap<String, String>>) -> Res {
    let token = qs.get("token").map(String::as_str).unwrap_or_default();
    if token.is_empty() || token.len() > 128 {
        return Err(validation("Link de recuperação inválido"));
    }
    let q = app.store.q();
    let user = q
        .password_reset_user(&reset_token_hash(token))
        .and_then(|id| q.public_user(&id))
        .ok_or_else(|| validation("Esse link expirou ou já foi usado. Peça um novo."))?;
    ok(json!({
        "username": user.username,
        "displayName": user.display_name,
        "avatarUrl": user.avatar_url,
        "avatarColor": user.avatar_color,
    }))
}

/// Define a senha nova a partir do token do email (vale uma vez, por 30 minutos).
async fn reset_password(State(app): S, b: Bytes) -> Res {
    let input = body::<validate::ResetPassword>(&b)?.check()?;
    let token_hash = reset_token_hash(&input.token);
    let expired = || validation("Esse link expirou ou já foi usado. Peça um novo.");
    let user_id = app
        .store
        .q()
        .password_reset_user(&token_hash)
        .ok_or_else(expired)?;
    let password = input.new_password;
    let hash = tokio::task::spawn_blocking(move || auth::hash_password(&password))
        .await
        .expect("scrypt");
    let q = app.store.q();
    if !q.consume_password_reset(&token_hash) {
        return Err(expired());
    }
    q.set_password_hash(&user_id, &hash);
    // O link chegou no email: ele está confirmado. Quem estava logado com a senha antiga cai.
    q.set_email_verified(&user_id);
    q.revoke_sessions(&user_id);
    app.disconnect_user(&user_id);
    let username = q.user_row(&user_id).map(|u| u.username).unwrap_or_default();
    ok(json!({ "username": username }))
}

// ---------- usuários ----------

// ---------- atividade de jogos ----------

async fn my_games(State(app): S, Me(me): Me) -> Res {
    let q = app.store.q();
    let current = crate::store::lock(&app.playing.0)
        .get(&me)
        .map(|(n, _, _)| n.clone());
    ok(json!({ "current": current, "games": q.user_games(&me), "covers": app.igdb.is_some() }))
}

#[derive(serde::Deserialize)]
struct GamePatch {
    name: String,
    hidden: Option<bool>,
    #[serde(default)]
    remove: bool,
}

async fn update_my_game(State(app): S, Me(me): Me, b: Bytes) -> Res {
    let p: GamePatch = serde_json::from_slice(&b).map_err(|_| validation("Dados inválidos"))?;
    let q = app.store.q();
    if p.remove {
        q.remove_game(&me, &p.name);
    } else if let Some(h) = p.hidden {
        if !q.set_game_hidden(&me, &p.name, h) {
            return Err(not_found("Jogo"));
        }
    }
    app.broadcast_activity(&q, &me);
    ok(json!({ "games": q.user_games(&me) }))
}

fn activity_settings_json(q: &Q, me: &str) -> serde_json::Value {
    let s = q.activity_settings(me);
    json!({ "share": s.share, "scope": s.scope, "hiddenServers": s.hidden_servers })
}

async fn get_activity_settings(State(app): S, Me(me): Me) -> Res {
    ok(activity_settings_json(&app.store.q(), &me))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivitySettingsInput {
    share: bool,
    scope: String,
    #[serde(default)]
    hidden_servers: Vec<String>,
}

async fn put_activity_settings(State(app): S, Me(me): Me, b: Bytes) -> Res {
    let p: ActivitySettingsInput =
        serde_json::from_slice(&b).map_err(|_| validation("Dados inválidos"))?;
    if !matches!(p.scope.as_str(), "all" | "small" | "none") {
        return Err(validation("Opção inválida"));
    }
    let q = app.store.q();
    let mine = q.server_ids_of(&me);
    let hidden: Vec<String> = p
        .hidden_servers
        .into_iter()
        .filter(|s| mine.contains(s))
        .collect();
    q.set_activity_settings(
        &me,
        &crate::store::activity::ActivitySettings {
            share: p.share,
            scope: p.scope,
            hidden_servers: hidden,
        },
    );
    app.broadcast_activity(&q, &me);
    ok(activity_settings_json(&q, &me))
}

async fn server_activities(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    require_member(&q, &id, &me)?;
    ok(app.server_activities(&q, &me, &id))
}

async fn get_me(State(app): S, Me(me): Me) -> Res {
    ok(app.store.q().self_user(&me))
}

/// Confere a senha atual (scrypt fora das threads de rede).
async fn check_password(app: &App, me: &str, password: String) -> ApiResult<()> {
    let stored = app
        .store
        .q()
        .user_row(me)
        .map(|r| r.password_hash)
        .unwrap_or_default();
    let valid = tokio::task::spawn_blocking(move || auth::verify_password(&password, &stored))
        .await
        .unwrap_or(false);
    if valid {
        Ok(())
    } else {
        Err(validation("Senha atual incorreta"))
    }
}

/// Validade do código enviado por email nas configurações.
const CODE_MINUTES: i64 = 15;
/// Sem 0/O e 1/I para não confundir na hora de digitar.
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// Hash do código de confirmação. Fica na mesma tabela dos links de recuperação,
/// mas preso ao usuário (o mesmo código de outra conta não confere).
fn email_code_hash(me: &str, code: &str) -> String {
    reset_token_hash(&format!("code:{me}:{}", code.trim().to_uppercase()))
}

/// Envia um código de 6 caracteres para o email da conta. Serve para trocar senha, @ ou email
/// sem a senha atual (ex.: conta criada pelo Google, que não tem senha).
async fn send_email_code(State(app): S, Me(me): Me) -> Res {
    if app.mailer.is_none() {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "RESET_DISABLED",
            "O envio de email ainda não está disponível.",
        ));
    }
    let code: String = {
        use rand::Rng;
        let mut rng = rand::rng();
        (0..6)
            .map(|_| CODE_ALPHABET[rng.random_range(0..CODE_ALPHABET.len())] as char)
            .collect()
    };
    let (email, name) = {
        let q = app.store.q();
        let user = q
            .user_row(&me)
            .ok_or_else(|| validation("Conta não encontrada"))?;
        let Some(email) = user.email.clone().filter(|e| !e.is_empty()) else {
            return Err(validation("Sua conta não tem email cadastrado."));
        };
        if q.reset_requested_recently(&me, 60) {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "RATE_LIMITED",
                "Espere um minuto para pedir outro código.",
            ));
        }
        q.create_password_reset(&me, &email_code_hash(&me, &code), CODE_MINUTES);
        (email, user.display_name)
    };
    let app = app.clone();
    tokio::spawn(async move {
        if let Some(mailer) = &app.mailer {
            mailer.send_code(&email, &name, &code).await;
        }
    });
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Confere a senha atual ou o código do email. Com o código, devolve o hash dele para o
/// handler gastar só quando a alteração der certo.
async fn check_identity(
    app: &App,
    me: &str,
    password: String,
    code: &str,
) -> ApiResult<Option<String>> {
    if code.trim().is_empty() {
        check_password(app, me, password).await?;
        return Ok(None);
    }
    let wrong = || validation("Código incorreto ou expirado. Peça um novo.");
    if app.code_tries.blocked(me) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "Muitas tentativas. Peça um novo código daqui a pouco.",
        ));
    }
    let hash = email_code_hash(me, code);
    if app.store.q().password_reset_user(&hash).as_deref() != Some(me) {
        app.code_tries.hit(me);
        return Err(wrong());
    }
    Ok(Some(hash))
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ConfirmInput {
    password: String,
    code: String,
}

/// Confere senha (ou código do email, para conta do Google) e gasta o código.
async fn confirm_me(app: &App, me: &str, b: &Bytes) -> ApiResult<()> {
    let input: ConfirmInput = serde_json::from_slice(b).unwrap_or_default();
    if let Some(hash) = check_identity(app, me, input.password, &input.code).await?
        && !app.store.q().consume_password_reset(&hash)
    {
        return Err(validation("Código incorreto ou expirado. Peça um novo."));
    }
    Ok(())
}

/// "Desativar conta": sai de tudo agora; ao entrar de novo a conta volta ao normal.
async fn deactivate_me(State(app): S, Me(me): Me, b: Bytes) -> Res {
    confirm_me(&app, &me, &b).await?;
    app.store.q().set_deactivated(&me, true);
    crate::admin::kick_out(&app, &me);
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// "Excluir conta": permanente. Quem é dono de servidor precisa transferir ou apagar antes.
async fn delete_me(State(app): S, Me(me): Me, b: Bytes) -> Res {
    {
        let q = app.store.q();
        let owned: Vec<String> = q
            .server_ids_of(&me)
            .into_iter()
            .filter_map(|id| q.server(&id).filter(|s| s.owner_id == me).map(|s| s.name))
            .collect();
        if !owned.is_empty() {
            return Err(validation(&format!(
                "Você é dono de {}. Transfira ou apague antes de excluir a conta.",
                owned.join(", ")
            )));
        }
    }
    confirm_me(&app, &me, &b).await?;
    crate::admin::kick_out(&app, &me);
    {
        let q = app.store.q();
        for server_id in q.server_ids_of(&me) {
            remove_from_server(&app, &q, &server_id, &me);
        }
        q.anonymize_user(&me);
        if let Some(user) = q.public_user(&me) {
            app.to_users(&q.audience_of(&me), "user:update", &user);
        }
    }
    app.sweep_uploads();
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn update_account(State(app): S, Me(me): Me, b: Bytes) -> Res {
    let input = body::<validate::UpdateAccount>(&b)?.check()?;
    let code_hash = check_identity(&app, &me, input.current_password.clone(), &input.code).await?;
    let q = app.store.q();
    if let Some(name) = &input.username
        && q.user_by_username(name).is_some_and(|u| u.id != me)
    {
        return Err(conflict("Esse nome de usuário já está em uso"));
    }
    if let Some(Some(email)) = &input.email
        && q.user_row(&me).and_then(|u| u.email).as_deref() != Some(email.as_str())
        && q.email_in_use(email)
    {
        return Err(conflict("Esse email já tem uma conta"));
    }
    if let Some(hash) = &code_hash {
        if !q.consume_password_reset(hash) {
            return Err(validation("Código incorreto ou expirado. Peça um novo."));
        }
    }
    if let Some(name) = &input.username {
        q.set_username(&me, name);
    }
    if let Some(email) = &input.email {
        q.set_email(&me, email.as_deref());
    }
    let user = q
        .self_user(&me)
        .ok_or_else(|| validation("Conta não encontrada"))?;
    app.to_user(&me, "self:update", &user);
    if let Some(public) = q.public_user(&me) {
        app.to_users(&q.audience_of(&me), "user:update", &public);
    }
    ok(user)
}

async fn change_password(State(app): S, Me(me): Me, b: Bytes) -> Res {
    let input = body::<validate::ChangePassword>(&b)?.check()?;
    let code_hash = check_identity(&app, &me, input.current_password, &input.code).await?;
    let password = input.new_password;
    let hash = tokio::task::spawn_blocking(move || auth::hash_password(&password))
        .await
        .expect("scrypt");
    // Senha nova: todas as sessões abertas (outros aparelhos, token roubado) caem.
    // Quem trocou recebe um token novo e reconecta com ele.
    {
        let q = app.store.q();
        if let Some(code_hash) = &code_hash {
            if !q.consume_password_reset(code_hash) {
                return Err(validation("Código incorreto ou expirado. Peça um novo."));
            }
            // O código chegou no email: ele está confirmado.
            q.set_email_verified(&me);
        }
        q.set_password_hash(&me, &hash);
        q.revoke_sessions(&me);
    }
    app.disconnect_user(&me);
    ok(json!({ "token": app.tokens.sign(&me) }))
}

async fn update_me(State(app): S, Me(me): Me, b: Bytes) -> Res {
    let p = body::<validate::UpdateProfile>(&b)?.check()?;
    let q = app.store.q();
    for id in [&p.avatar_id, &p.banner_id].into_iter().flatten().flatten() {
        if !q.own_image(&me, id) {
            return Err(bad_request("Imagem inválida"));
        }
    }
    if let Some(Some(server_id)) = &p.tag_server_id
        && !q
            .server(server_id)
            .is_some_and(|s| !s.tag.is_empty() && q.is_member(server_id, &me))
    {
        return Err(bad_request("Esse servidor não tem tag"));
    }
    if let Some(date) = &p.birth_date {
        q.set_birth_date(&me, date.as_deref());
    }
    if let Some(on) = p.blur_sensitive {
        q.set_blur_sensitive(&me, on);
    }
    let user = q.update_user(
        &me,
        ProfilePatch {
            display_name: p.display_name,
            bio: p.bio,
            avatar_color: p.avatar_color,
            custom_status: p.custom_status,
            status_until: p.status.as_ref().and(p.status_minutes).map(|m| {
                (chrono::Utc::now() + chrono::Duration::minutes(m))
                    .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                    .to_string()
            }),
            status: p.status,
            pronouns: p.pronouns,
            thought: p.thought,
            avatar_id: p.avatar_id,
            banner_id: p.banner_id,
            tag_server_id: p.tag_server_id,
            ..Default::default()
        },
    );
    app.to_user(&me, "self:update", &user);
    if let Some(public) = q.public_user(&me) {
        app.to_users(&q.audience_of(&me), "user:update", &public);
    }
    app.broadcast_presence(&q, &me);
    ok(user)
}

/// Ordem dos servidores na barra lateral (só para mim).
async fn reorder_my_servers(State(app): S, Me(me): Me, b: Bytes) -> Res {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Order {
        server_ids: Vec<String>,
    }
    let input = body::<Order>(&b)?;
    if input.server_ids.len() > 500 {
        return Err(bad_request("Lista grande demais"));
    }
    app.store.q().reorder_my_servers(&me, &input.server_ids);
    no_content()
}

async fn get_user(State(app): S, Me(_): Me, Path(id): Path<String>) -> Res {
    ok(app
        .store
        .q()
        .public_user(&id)
        .ok_or_else(|| not_found("Usuário"))?)
}

/// Busca de mensagens: `server` ou `channel`, mais `q`, `author`, `in`, `mentions` e `has`.
async fn search(State(app): S, Me(me): Me, Query(qs): Query<HashMap<String, String>>) -> Res {
    let q = app.store.q();
    let get = |k: &str| {
        qs.get(k)
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(100).collect::<String>())
    };
    let scope = if let Some(server) = get("server") {
        if !q.is_member(&server, &me) {
            return Err(not_found("Servidor"));
        }
        SearchScope::Server(server)
    } else if let Some(channel) = get("channel") {
        SearchScope::Channel(require_access(&q, &channel, &me)?.id)
    } else {
        return Err(bad_request("Diga onde buscar"));
    };
    let user = |name: Option<String>| -> ApiResult<Option<String>> {
        match name {
            None => Ok(None),
            Some(n) => Ok(Some(
                q.user_by_username(&n.trim_start_matches('@').to_lowercase())
                    .ok_or_else(|| not_found(&format!("Usuário \"{n}\"")))?
                    .id,
            )),
        }
    };
    let hidden = match &scope {
        SearchScope::Server(id) => q.hidden_channel_ids(id, &me),
        SearchScope::Channel(_) => Vec::new(),
    };
    let filter = SearchFilter {
        hidden,
        text: get("q").unwrap_or_default(),
        author_id: user(get("author"))?,
        channel_id: get("in"),
        mentions: get("mentions").map(|m| m.trim_start_matches('@').to_lowercase()),
        has: get("has"),
    };
    let offset = qs
        .get("offset")
        .and_then(|o| o.parse::<i64>().ok())
        .unwrap_or(0)
        .min(10_000);
    ok(q.search_messages(&scope, &filter, offset))
}

/// Amigos e servidores em comum com outra pessoa (cartão de perfil).
async fn get_mutual(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    q.public_user(&id).ok_or_else(|| not_found("Usuário"))?;
    let theirs: std::collections::HashSet<String> = q
        .friends(&id)
        .into_iter()
        .filter(|f| f.state == "friends")
        .map(|f| f.user.id)
        .collect();
    let friends: Vec<PublicUser> = q
        .friends(&me)
        .into_iter()
        .filter(|f| f.state == "friends" && theirs.contains(&f.user.id))
        .map(|f| f.user)
        .collect();
    let their_servers: std::collections::HashSet<String> =
        q.server_ids_of(&id).into_iter().collect();
    let servers: Vec<Server> = q
        .servers_of(&me)
        .into_iter()
        .filter(|s| their_servers.contains(&s.id))
        .collect();
    Ok(Json(json!({ "friends": friends, "servers": servers })).into_response())
}

// ---------- servidores ----------

fn require_member(q: &Q, server_id: &str, user_id: &str) -> ApiResult<Server> {
    match q.server(server_id) {
        Some(s) if q.is_member(server_id, user_id) => Ok(s),
        _ => Err(not_found("Servidor")),
    }
}

fn require_owner(q: &Q, server_id: &str, user_id: &str) -> ApiResult<Server> {
    let server = require_member(q, server_id, user_id)?;
    if server.owner_id != user_id {
        return Err(forbidden("Só o dono do servidor pode fazer isso"));
    }
    Ok(server)
}

/// Membro com a permissão `flag` (dono e administradores sempre passam).
pub(crate) fn require_perm(q: &Q, server_id: &str, user_id: &str, flag: i64) -> ApiResult<Server> {
    let server = require_member(q, server_id, user_id)?;
    if !has(q.permissions(server_id, user_id), flag) {
        return Err(forbidden("Você não tem permissão para fazer isso"));
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
    let channels: Vec<_> = q
        .channels(&server.id)
        .into_iter()
        .filter(|c| q.can_access(&me, &c.id))
        .collect();
    // Categoria sem nenhum canal visível some (menos para quem gerencia canais).
    let manage = has(q.permissions(&server.id, &me), perms::MANAGE_CHANNELS);
    let categories = q
        .categories(&server.id)
        .into_iter()
        .filter(|cat| q.can_see_category(&me, &cat.id))
        .filter(|cat| {
            manage
                || channels
                    .iter()
                    .any(|c| c.category_id.as_deref() == Some(cat.id.as_str()))
        })
        .collect();
    ok(ServerDetail {
        roles: q.roles(&server.id),
        categories,
        channels,
        members: q.members(&server.id),
        server: q.for_viewer(server, &me),
    })
}

async fn update_server(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let q = app.store.q();
    require_perm(&q, &id, &me, perms::MANAGE_SERVER)?;
    let p = body::<validate::UpdateServer>(&b)?.check()?;
    if let Some(show) = p.show_owner_badge {
        if q.server(&id).is_none_or(|s| s.owner_id != me) {
            return Err(forbidden(
                "Só o dono do servidor pode mudar o emblema de dono",
            ));
        }
        q.set_show_owner_badge(&id, show);
    }
    if let Some(level) = &p.nsfw_level {
        q.set_server_nsfw_level(&id, level);
    }
    let before_tag = q
        .server(&id)
        .map(|s| (s.tag, s.tag_icon, s.tag_style, s.icon_url))
        .unwrap_or_default();
    for img in [&p.icon_id, &p.banner_id].into_iter().flatten().flatten() {
        if !q.own_image(&me, img) {
            return Err(bad_request("Imagem inválida"));
        }
    }
    let server = q.update_server(
        &id,
        ServerPatch {
            name: p.name,
            description: p.description,
            is_public: p.is_public,
            icon_color: p.icon_color,
            tag: p.tag,
            tag_icon: p.tag_icon,
            tag_style: p.tag_style.map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    v.to_string()
                }
            }),
            icon_id: p.icon_id,
            banner_id: p.banner_id,
        },
    );
    app.server_updated(&q, &server);
    if before_tag
        != (
            server.tag.clone(),
            server.tag_icon.clone(),
            server.tag_style.clone(),
            server.icon_url.clone(),
        )
    {
        // Quem exibe a tag precisa aparecer com a nova (ou sem nenhuma).
        for user_id in q.tag_users(&id) {
            if let Some(public) = q.public_user(&user_id) {
                let mut to = q.audience_of(&user_id);
                to.push(user_id.clone());
                app.to_users(&to, "user:update", &public);
            }
        }
    }
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
    drop(q);
    app.sweep_uploads();
    no_content()
}

async fn reset_invite(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    require_perm(&q, &id, &me, perms::MANAGE_SERVER)?;
    let server = q.reset_invite(&id);
    app.server_updated(&q, &server);
    ok(server)
}

pub(crate) fn remove_from_server(app: &App, q: &Q, server_id: &str, user_id: &str) {
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
    let server = require_perm(&q, &id, &me, perms::KICK_MEMBERS)?;
    if target == me {
        return Err(bad_request("Você não pode expulsar a si mesmo"));
    }
    if !q.is_member(&server.id, &target) {
        return Err(not_found("Membro"));
    }
    if target == server.owner_id
        || q.top_position(&server.id, &target) >= q.top_position(&server.id, &me)
    {
        return Err(forbidden(
            "Você só pode expulsar quem tem cargos abaixo do seu",
        ));
    }
    remove_from_server(&app, &q, &server.id, &target);
    no_content()
}

/// Apelido no servidor: o próprio com "Alterar apelido"; o dos outros (abaixo do seu cargo)
/// com "Gerenciar apelidos".
async fn update_member(
    State(app): S,
    Me(me): Me,
    Path((id, target)): Path<(String, String)>,
    b: Bytes,
) -> Res {
    let q = app.store.q();
    let server = require_member(&q, &id, &me)?;
    let target = if target == "@me" { me.clone() } else { target };
    if !q.is_member(&id, &target) {
        return Err(not_found("Membro"));
    }
    let nickname = body::<validate::UpdateMember>(&b)?.check()?;
    let p = q.permissions(&id, &me);
    if target == me {
        if !has(p, perms::CHANGE_NICKNAME) && !has(p, perms::MANAGE_NICKNAMES) {
            return Err(forbidden("Você não tem permissão para mudar seu apelido"));
        }
    } else if !has(p, perms::MANAGE_NICKNAMES)
        || target == server.owner_id
        || q.top_position(&id, &target) >= q.top_position(&id, &me)
    {
        return Err(forbidden("Você não pode mudar o apelido dessa pessoa"));
    }
    q.set_nickname(&id, &target, nickname.as_deref());
    let member = q.member(&id, &target).ok_or_else(|| not_found("Membro"))?;
    app.to_server(&id, "member:update", &member);
    ok(member)
}

// ----- cargos -----

/// Quem tem "Gerenciar cargos" só mexe em cargos abaixo do seu cargo mais alto e só dá
/// permissões que já tem.
fn require_role_manager(q: &Q, server_id: &str, me: &str) -> ApiResult<(i64, i64)> {
    require_perm(q, server_id, me, perms::MANAGE_ROLES)?;
    Ok((q.permissions(server_id, me), q.top_position(server_id, me)))
}

fn editable_role(q: &Q, role_id: &str, me: &str) -> ApiResult<(i64, Role)> {
    let role = q.role(role_id).ok_or_else(|| not_found("Cargo"))?;
    let (p, top) = require_role_manager(q, &role.server_id, me)?;
    if role.id != role.server_id && role.position >= top {
        return Err(forbidden(
            "Você só pode mexer em cargos abaixo do seu cargo mais alto",
        ));
    }
    Ok((p, role))
}

fn check_grant(mine: i64, before: i64, after: i64) -> ApiResult<()> {
    // Só pode ligar ou desligar permissões que a própria pessoa tem.
    if (before ^ after) & !mine & perms::ALL != 0 {
        return Err(forbidden(
            "Você não pode dar ou tirar permissões que não tem",
        ));
    }
    Ok(())
}

fn roles_changed(app: &App, q: &Q, server_id: &str) {
    app.to_server(
        server_id,
        "roles:update",
        &json!({ "serverId": server_id, "roles": q.roles(server_id) }),
    );
}

/// Canais que cada pessoa não enxerga no servidor, para comparar antes e depois de mexer em cargos.
fn hidden_snapshot(q: &Q, server_id: &str, users: &[String]) -> Vec<(String, Vec<String>)> {
    users
        .iter()
        .map(|u| (u.clone(), q.hidden_channel_ids(server_id, u)))
        .collect()
}

/// Depois de mudar cargos/permissões: quem passou a ver um canal recebe channel:create e
/// quem deixou de ver recebe channel:delete, sem precisar recarregar o app.
fn sync_visibility(app: &App, q: &Q, server_id: &str, before: Vec<(String, Vec<String>)>) {
    for (user, was_hidden) in before {
        let now_hidden = q.hidden_channel_ids(server_id, &user);
        let to = [user];
        for id in was_hidden.iter().filter(|c| !now_hidden.contains(c)) {
            if let Some(c) = q.channel(id) {
                app.to_users(&to, "channel:create", &c);
            }
        }
        for id in now_hidden.iter().filter(|c| !was_hidden.contains(c)) {
            app.to_users(
                &to,
                "channel:delete",
                &json!({ "id": id, "serverId": server_id }),
            );
        }
    }
}

async fn list_roles(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    require_member(&q, &id, &me)?;
    ok(q.roles(&id))
}

async fn create_role(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let q = app.store.q();
    let (mine, _) = require_role_manager(&q, &id, &me)?;
    let input = body::<validate::CreateRole>(&b)?.check()?;
    let permissions = input.permissions.unwrap_or(0) & perms::ALL;
    check_grant(mine, 0, permissions)?;
    if q.roles(&id).len() >= 250 {
        return Err(bad_request("Limite de 250 cargos por servidor"));
    }
    let role = q.create_role(
        &id,
        input.name.as_deref().unwrap_or("novo cargo"),
        input.color.flatten().as_deref(),
        permissions,
        input.mentionable.unwrap_or(false),
        input.hoist.unwrap_or(false),
    );
    roles_changed(&app, &q, &id);
    created(role)
}

async fn update_role(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let q = app.store.q();
    let (mine, role) = editable_role(&q, &id, &me)?;
    let input = body::<validate::UpdateRole>(&b)?.check()?;
    let is_everyone = role.id == role.server_id;
    if is_everyone && (input.name.is_some() || input.color.is_some()) {
        return Err(bad_request("O @everyone só muda as permissões"));
    }
    let permissions = input.permissions.map(|p| p & perms::ALL);
    if let Some(p) = permissions {
        check_grant(mine, role.permissions, p)?;
    }
    let server_id = role.server_id.clone();
    let before = permissions
        .is_some_and(|p| p != role.permissions)
        .then(|| hidden_snapshot(&q, &server_id, &q.member_ids(&server_id)))
        .unwrap_or_default();
    let updated = q.update_role(
        &role.id,
        RolePatch {
            name: input.name,
            color: input.color,
            permissions,
            mentionable: input.mentionable,
            hoist: input.hoist,
        },
    );
    roles_changed(&app, &q, &server_id);
    sync_visibility(&app, &q, &server_id, before);
    ok(updated)
}

async fn delete_role(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    let (_, role) = editable_role(&q, &id, &me)?;
    if role.id == role.server_id {
        return Err(bad_request("O @everyone não pode ser excluído"));
    }
    let holders = q.role_member_ids(&role.id);
    let before = hidden_snapshot(&q, &role.server_id, &holders);
    q.delete_role(&role.id);
    roles_changed(&app, &q, &role.server_id);
    for u in &holders {
        if let Some(m) = q.member(&role.server_id, u) {
            app.to_server(&role.server_id, "member:update", &m);
        }
    }
    sync_visibility(&app, &q, &role.server_id, before);
    no_content()
}

async fn reorder_roles(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let q = app.store.q();
    let (_, top) = require_role_manager(&q, &id, &me)?;
    let input = body::<validate::ReorderRoles>(&b)?;
    let current: Vec<Role> = q.roles(&id).into_iter().filter(|r| r.id != id).collect();
    let mut wanted = input.role_ids.clone();
    wanted.dedup();
    let same_set = wanted.len() == current.len() && current.iter().all(|r| wanted.contains(&r.id));
    if !same_set {
        return Err(bad_request("Mande a lista completa de cargos"));
    }
    let n = wanted.len() as i64;
    for (i, rid) in wanted.iter().enumerate() {
        let new_pos = n - i as i64;
        let old = current
            .iter()
            .find(|r| &r.id == rid)
            .map(|r| r.position)
            .unwrap_or(0);
        if old != new_pos && (old >= top || new_pos >= top) {
            return Err(forbidden(
                "Você só pode mover cargos abaixo do seu cargo mais alto",
            ));
        }
    }
    q.reorder_roles(&id, &wanted);
    roles_changed(&app, &q, &id);
    ok(q.roles(&id))
}

async fn set_member_role(
    app: &App,
    me: &str,
    server_id: &str,
    user_id: &str,
    role_id: &str,
    on: bool,
) -> Res {
    let q = app.store.q();
    let (_, role) = editable_role(&q, role_id, me)?;
    if role.server_id != server_id || role.id == role.server_id {
        return Err(not_found("Cargo"));
    }
    if !q.is_member(server_id, user_id) {
        return Err(not_found("Membro"));
    }
    let before = hidden_snapshot(&q, server_id, &[user_id.to_string()]);
    q.set_member_role(server_id, user_id, &role.id, on);
    let member = q
        .member(server_id, user_id)
        .ok_or_else(|| not_found("Membro"))?;
    app.to_server(server_id, "member:update", &member);
    roles_changed(app, &q, server_id);
    sync_visibility(app, &q, server_id, before);
    ok(member)
}

async fn add_member_role(
    State(app): S,
    Me(me): Me,
    Path((id, user, role)): Path<(String, String, String)>,
) -> Res {
    set_member_role(&app, &me, &id, &user, &role, true).await
}

async fn remove_member_role(
    State(app): S,
    Me(me): Me,
    Path((id, user, role)): Path<(String, String, String)>,
) -> Res {
    set_member_role(&app, &me, &id, &user, &role, false).await
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
    if server.suspended {
        return server;
    }
    if q.is_member(&server.id, me) {
        return server;
    }
    let member = q.add_member(&server.id, me);
    app.to_server(&server.id, "member:add", &member);
    app.join_server(me, &server.id);
    let fresh = q.for_viewer(q.server(&server.id).unwrap_or(server), me);
    app.to_user(me, "server:create", &fresh);
    app.broadcast_presence(q, me);
    fresh
}

// ----- canais e categorias -----

async fn create_channel(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let q = app.store.q();
    require_perm(&q, &id, &me, perms::MANAGE_CHANNELS)?;
    let input = body::<validate::CreateChannel>(&b)?.check()?;
    let category_id = input.category_id.flatten();
    if let Some(cat) = &category_id
        && q.category(cat).is_none_or(|c| c.server_id != id)
    {
        return Err(not_found("Categoria"));
    }
    let private_members: Option<Vec<String>> = input.is_private.unwrap_or(false).then(|| {
        let mut ids: Vec<String> = input
            .member_ids
            .unwrap_or_default()
            .into_iter()
            .filter(|u| q.is_member(&id, u))
            .collect();
        ids.sort();
        ids.dedup();
        ids
    });
    let mut private_roles: Vec<String> = input
        .role_ids
        .unwrap_or_default()
        .into_iter()
        .filter(|r| *r != id && q.role(r).is_some_and(|role| role.server_id == id))
        .collect();
    private_roles.sort();
    private_roles.dedup();
    let channel = q.create_channel_ex(
        &id,
        &input.name,
        input.kind.as_deref().unwrap_or("text"),
        category_id.as_deref(),
        input.topic.as_deref().unwrap_or(""),
        private_members.as_deref(),
        &private_roles,
    );
    app.to_channel(&q, &channel.id, "channel:create", &channel);
    created(channel)
}

async fn create_category(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let q = app.store.q();
    require_perm(&q, &id, &me, perms::MANAGE_CHANNELS)?;
    let input = body::<validate::CreateCategory>(&b)?.check()?;
    let private_roles: Option<Vec<String>> = input.is_private.unwrap_or(false).then(|| {
        let mut ids: Vec<String> = input
            .role_ids
            .unwrap_or_default()
            .into_iter()
            .filter(|r| *r != id && q.role(r).is_some_and(|role| role.server_id == id))
            .collect();
        ids.sort();
        ids.dedup();
        ids
    });
    let category = q.create_category_ex(&id, &input.name, private_roles.as_deref());
    to_category(&app, &q, &category, "category:create");
    created(category)
}

/// Evento de categoria só para quem a enxerga (categoria privada não vaza o nome).
fn to_category(app: &App, q: &Q, category: &Category, event: &str) {
    match q.category_audience(&category.id) {
        Some(ids) => app.to_users(&ids, event, category),
        None => app.to_server(&category.server_id, event, category),
    }
}

/// Notas e Atualizações: mostrar/esconder a categoria e cada canal base.
/// Corpo: { categoryVisible?: bool, channels?: { [id]: bool } }. Escondido = só dono e admins veem.
async fn set_notes(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let v: serde_json::Value = body(&b)?;
    let q = app.store.q();
    require_perm(&q, &id, &me, perms::MANAGE_SERVER)?;
    let cat = q
        .categories(&id)
        .into_iter()
        .find(|c| c.base)
        .ok_or_else(|| not_found("Categoria"))?;
    let chans: Vec<String> = q
        .channels(&id)
        .into_iter()
        .filter(|c| !c.base.is_empty())
        .map(|c| c.id)
        .collect();
    let members = q.member_ids(&id);
    let see_cat = |q: &Q| -> Vec<String> {
        members
            .iter()
            .filter(|u| q.can_see_category(u, &cat.id))
            .cloned()
            .collect()
    };
    let see = |q: &Q, cid: &str| -> Vec<String> {
        members
            .iter()
            .filter(|u| q.can_access(u, cid))
            .cloned()
            .collect()
    };
    let before_cat = see_cat(&q);
    let before: Vec<Vec<String>> = chans.iter().map(|c| see(&q, c)).collect();
    if let Some(vis) = v.get("categoryVisible").and_then(|x| x.as_bool()) {
        q.set_base_visible("category", &cat.id, vis);
    }
    if let Some(map) = v.get("channels").and_then(|x| x.as_object()) {
        for (cid, vis) in map {
            if let Some(vis) = vis.as_bool()
                && chans.contains(cid)
            {
                q.set_base_visible("channel", cid, vis);
            }
        }
    }
    let fresh = q.category(&cat.id).ok_or_else(|| not_found("Categoria"))?;
    let after_cat = see_cat(&q);
    let lost: Vec<String> = before_cat
        .iter()
        .filter(|u| !after_cat.contains(u))
        .cloned()
        .collect();
    let gained: Vec<String> = after_cat
        .iter()
        .filter(|u| !before_cat.contains(u))
        .cloned()
        .collect();
    app.to_users(
        &lost,
        "category:delete",
        &json!({ "id": cat.id, "serverId": id }),
    );
    app.to_users(&gained, "category:create", &fresh);
    app.to_users(&after_cat, "category:update", &fresh);
    for (cid, before) in chans.iter().zip(before) {
        let Some(c) = q.channel(cid) else { continue };
        let after = see(&q, cid);
        let lost: Vec<String> = before
            .iter()
            .filter(|u| !after.contains(u))
            .cloned()
            .collect();
        let gained: Vec<String> = after
            .iter()
            .filter(|u| !before.contains(u))
            .cloned()
            .collect();
        app.to_users(
            &lost,
            "channel:delete",
            &json!({ "id": cid, "serverId": id }),
        );
        app.to_users(&gained, "channel:create", &c);
        app.to_users(&after, "channel:update", &c);
    }
    no_content()
}

/// Arrastar e soltar na lista de canais: nova ordem das categorias e dos canais (e a
/// categoria de cada canal). Quem não enxerga um canal/categoria não o manda; os que
/// ficaram de fora mantêm o lugar e os mandados se reorganizam nos lugares que ocupavam.
async fn set_layout(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let q = app.store.q();
    require_perm(&q, &id, &me, perms::MANAGE_CHANNELS)?;
    let input = body::<validate::ChannelLayout>(&b)?;
    if input.category_ids.len() > 500 || input.channels.len() > 1000 {
        return Err(validation("Canais demais"));
    }

    let cats = q.categories(&id);
    let mut seen = std::collections::HashSet::new();
    let wanted_cats: Vec<String> = input
        .category_ids
        .into_iter()
        .filter(|c| {
            cats.iter().any(|k| &k.id == c) && q.can_see_category(&me, c) && seen.insert(c.clone())
        })
        .collect();
    let mut next_cat = wanted_cats.iter();
    let cat_order: Vec<String> = cats
        .iter()
        .map(|k| {
            if wanted_cats.contains(&k.id) {
                next_cat.next().cloned().unwrap_or_else(|| k.id.clone())
            } else {
                k.id.clone()
            }
        })
        .collect();

    let chans: Vec<Channel> = q
        .channels(&id)
        .into_iter()
        .filter(|c| c.kind != "thread")
        .collect();
    let mut seen = std::collections::HashSet::new();
    let wanted: Vec<(String, Option<String>)> = input
        .channels
        .into_iter()
        .filter(|c| {
            chans.iter().any(|k| k.id == c.id)
                && c.category_id
                    .as_ref()
                    .is_none_or(|cat| cats.iter().any(|k| &k.id == cat))
                && q.can_access(&me, &c.id)
                && seen.insert(c.id.clone())
        })
        .map(|c| (c.id, c.category_id))
        .collect();
    let mut next = wanted.iter();
    let order: Vec<(String, Option<String>)> = chans
        .iter()
        .map(|k| {
            if wanted.iter().any(|(w, _)| *w == k.id) {
                next.next()
                    .cloned()
                    .unwrap_or_else(|| (k.id.clone(), k.category_id.clone()))
            } else {
                (k.id.clone(), k.category_id.clone())
            }
        })
        .collect();

    // Quem via cada canal que muda de categoria (categoria privada muda quem vê).
    let members = q.member_ids(&id);
    let moved: Vec<(String, Vec<String>)> = order
        .iter()
        .filter(|(cid, cat)| chans.iter().any(|k| &k.id == cid && &k.category_id != cat))
        .map(|(cid, _)| {
            let before = members
                .iter()
                .filter(|u| q.can_access(u, cid))
                .cloned()
                .collect();
            (cid.clone(), before)
        })
        .collect();

    q.set_layout(&cat_order, &order);

    for (i, cid) in cat_order.iter().enumerate() {
        if let Some(k) = cats.iter().find(|k| &k.id == cid)
            && k.position != i as i64
            && let Some(fresh) = q.category(cid)
        {
            to_category(&app, &q, &fresh, "category:update");
        }
    }
    for (i, (cid, cat)) in order.iter().enumerate() {
        let Some(old) = chans.iter().find(|k| &k.id == cid) else {
            continue;
        };
        if old.position == i as i64 && &old.category_id == cat {
            continue;
        }
        let Some(fresh) = q.channel(cid) else {
            continue;
        };
        if let Some((_, before)) = moved.iter().find(|(m, _)| m == cid) {
            let lost: Vec<String> = before
                .iter()
                .filter(|u| !q.can_access(u, cid))
                .cloned()
                .collect();
            let gained: Vec<String> = members
                .iter()
                .filter(|u| !before.contains(u) && q.can_access(u, cid))
                .cloned()
                .collect();
            for t in q.threads_of(cid).iter().map(|t| &t.id).chain([cid]) {
                app.to_users(&lost, "channel:delete", &json!({ "id": t, "serverId": id }));
            }
            app.to_users(&gained, "channel:create", &fresh);
        }
        app.to_channel(&q, cid, "channel:update", &fresh);
    }
    no_content()
}

async fn rename_category(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let q = app.store.q();
    let category = q.category(&id).ok_or_else(|| not_found("Categoria"))?;
    require_perm(&q, &category.server_id, &me, perms::MANAGE_CHANNELS)?;
    let input = body::<validate::CreateCategory>(&b)?.check()?;
    let updated = q.rename_category(&category.id, &input.name);
    to_category(&app, &q, &updated, "category:update");
    ok(updated)
}

async fn delete_category(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    let category = q.category(&id).ok_or_else(|| not_found("Categoria"))?;
    require_perm(&q, &category.server_id, &me, perms::MANAGE_CHANNELS)?;
    if category.base {
        return Err(bad_request(
            "A categoria Notas e Atualizações não pode ser excluída. Dá para escondê-la nas configurações do servidor.",
        ));
    }
    // Os canais que ainda estão na categoria são excluídos junto com ela.
    let affected: Vec<Channel> = q
        .channels(&category.server_id)
        .into_iter()
        .filter(|c| c.category_id.as_deref() == Some(category.id.as_str()) && c.base.is_empty())
        .collect();
    for c in &affected {
        remove_channel(&app, &q, c, &category.server_id);
    }
    q.delete_category(&category.id);
    app.to_server(
        &category.server_id,
        "category:delete",
        &json!({ "id": category.id, "serverId": category.server_id }),
    );
    // Canais de Notas e Atualizações nunca são excluídos: se estavam aqui, ficam soltos.
    for c in q.channels(&category.server_id) {
        if !c.base.is_empty() && c.category_id.is_none() {
            app.to_channel(&q, &c.id, "channel:update", &c);
        }
    }
    drop(q);
    if !affected.is_empty() {
        app.sweep_uploads();
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
    let thread_owner =
        channel.kind == "thread" && matches!(&channel.owner_id, Some(Some(o)) if o == user_id);
    if !thread_owner && !has(q.permissions(&server_id, user_id), perms::MANAGE_CHANNELS) {
        return Err(forbidden("Você não tem permissão para gerenciar canais"));
    }
    Ok((channel, server_id))
}

/// Quem enxerga o canal (para a lista de membros ao lado): null = todos os membros do servidor.
async fn channel_audience(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    require_access(&q, &id, &me)?;
    ok(json!({ "userIds": q.private_audience(&id) }))
}

/// Cartão do servidor (clique na tag): completo se for público ou se eu for membro;
/// senão só a foto e o banner, marcado como privado.
async fn server_card(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    let server = q.server(&id).ok_or_else(|| not_found("Servidor"))?;
    let member = q.is_member(&id, &me);
    if !server.is_public && !member {
        return ok(
            json!({ "id": server.id, "private": true, "iconUrl": server.icon_url, "bannerUrl": server.banner_url }),
        );
    }
    let online = q
        .ids(
            "SELECT user_id FROM members WHERE server_id = ?",
            [id.as_str()],
        )
        .iter()
        .filter(|u| q.public_user(u).is_some_and(|p| p.presence != "offline"))
        .count();
    ok(json!({
        "id": server.id,
        "private": false,
        "member": member,
        "name": server.name,
        "description": server.description,
        "iconUrl": server.icon_url,
        "bannerUrl": server.banner_url,
        "tag": server.tag,
        "tagIcon": server.tag_icon,
        "tagStyle": server.tag_style,
        "memberCount": server.member_count,
        "onlineCount": online,
        "createdAt": server.created_at,
    }))
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
    // Quem vê / quem interage: só canal de texto ou voz do servidor (não thread).
    let access = match &p.access {
        Some(a) if channel.kind == "text" || channel.kind == "voice" => {
            let clean_users = |ids: &[String]| {
                let mut v: Vec<String> = ids
                    .iter()
                    .filter(|u| q.is_member(&server_id, u))
                    .cloned()
                    .collect();
                v.sort();
                v.dedup();
                v
            };
            let clean_roles = |ids: &[String], allow_everyone: bool| {
                let mut v: Vec<String> = ids
                    .iter()
                    .filter(|r| {
                        (allow_everyone || **r != server_id)
                            && q.role(r).is_some_and(|role| role.server_id == server_id)
                    })
                    .cloned()
                    .collect();
                v.sort();
                v.dedup();
                v
            };
            Some(ChannelAccess {
                private: a
                    .is_private
                    .then(|| (clean_users(&a.member_ids), clean_roles(&a.role_ids, false))),
                interact: a.interact_restricted.then(|| {
                    (
                        clean_users(&a.interact_member_ids),
                        clean_roles(&a.interact_role_ids, true),
                    )
                }),
            })
        }
        Some(_) => return Err(bad_request("Esse canal não tem permissões próprias")),
        None => None,
    };
    let moving = access.is_some()
        || p.category_id
            .as_ref()
            .is_some_and(|c| *c != channel.category_id);
    let before = moving.then(|| q.member_ids(&server_id)).unwrap_or_default();
    let before: Vec<String> = before
        .into_iter()
        .filter(|u| q.can_access(u, &channel.id))
        .collect();
    if let Some(on) = p.nsfw
        && (channel.kind == "text" || channel.kind == "voice")
    {
        q.set_channel_nsfw(&channel.id, on);
    }
    let updated = q.update_channel(
        &channel.id,
        ChannelPatch {
            name: p
                .name
                .as_deref()
                .map(|n| validate::channel_name_for(&channel.kind, n))
                .transpose()?,
            topic: p.topic,
            category_id: p.category_id,
            position: p.position.map(i64::from),
        },
    );
    let updated = match &access {
        Some(a) => q.set_channel_access(&updated.id, a),
        None => updated,
    };
    if moving {
        // Mudou de categoria: quem perdeu acesso (categoria privada) recebe a remoção,
        // quem ganhou recebe o canal como novo.
        let lost: Vec<String> = before
            .iter()
            .filter(|u| !q.can_access(u, &updated.id))
            .cloned()
            .collect();
        let gained: Vec<String> = q
            .member_ids(&server_id)
            .into_iter()
            .filter(|u| !before.contains(u) && q.can_access(u, &updated.id))
            .collect();
        for t in q
            .threads_of(&updated.id)
            .iter()
            .map(|t| &t.id)
            .chain([&updated.id])
        {
            app.to_users(
                &lost,
                "channel:delete",
                &json!({ "id": t, "serverId": server_id }),
            );
        }
        app.to_users(&gained, "channel:create", &updated);
    }
    app.to_channel(&q, &updated.id, "channel:update", &updated);
    ok(updated)
}

/// Exclui um canal de servidor (com as threads dele) e avisa quem o via.
fn remove_channel(app: &App, q: &Q, channel: &Channel, server_id: &str) {
    app.drop_voice(
        q,
        VoiceFilter {
            channel_id: Some(&channel.id),
            ..Default::default()
        },
    );
    let threads = q.threads_of(&channel.id);
    let audience = q.private_audience(&channel.id);
    q.delete_channel(&channel.id);
    for c in threads.iter().map(|t| &t.id).chain([&channel.id]) {
        let payload = json!({ "id": c, "serverId": server_id });
        match &audience {
            Some(ids) => app.to_users(ids, "channel:delete", &payload),
            None => app.to_server(server_id, "channel:delete", &payload),
        }
    }
    if let Some(Some(mid)) = &channel.thread_message_id
        && let Some(starter) = q.message(mid)
    {
        if starter.deleted {
            // Sem a thread, a mensagem excluída não tem mais por que ficar.
            q.delete_message(&starter.id);
            app.to_channel(
                q,
                &starter.channel_id,
                "message:delete",
                &json!({ "id": starter.id, "channelId": starter.channel_id }),
            );
        } else {
            app.to_channel(q, &starter.channel_id, "message:update", &starter);
        }
    }
}

async fn delete_channel(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    let (channel, server_id) = require_channel_manager(&q, &id, &me)?;
    if !channel.base.is_empty() {
        return Err(bad_request(
            "Canais de Notas e Atualizações não podem ser excluídos. Dá para escondê-los nas configurações do servidor.",
        ));
    }
    remove_channel(&app, &q, &channel, &server_id);
    drop(q);
    app.sweep_uploads();
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
    if let Some(around) = qs.get("around").filter(|a| !a.is_empty()) {
        return ok(q.messages_around(&channel.id, around));
    }
    let before = qs.get("before").filter(|b| !b.is_empty());
    ok(q.messages(&channel.id, before.map(|s| s.as_str()), limit))
}

async fn send_message(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let q = app.store.q();
    let channel = require_access(&q, &id, &me)?;
    if channel.kind == "voice" {
        return Err(bad_request("Canais de voz não aceitam mensagens de texto"));
    }
    if channel.kind == "dm"
        && q.recipient_ids(&channel.id)
            .iter()
            .any(|u| u != &me && q.is_blocked(&me, u))
    {
        return Err(bad_request(
            "Não é possível mandar mensagem para essa pessoa",
        ));
    }
    let mut input = body::<validate::SendMessage>(&b)?.check()?;
    if let Some(server_id) = &channel.server_id {
        let _ = server_id;
        let p = q.channel_permissions(&me, &channel.id);
        if !has(p, perms::SEND_MESSAGES) {
            return Err(forbidden(
                "Você não tem permissão para enviar mensagens aqui",
            ));
        }
        if !input.attachment_ids.is_empty() && !has(p, perms::ATTACH_FILES) {
            return Err(forbidden(
                "Você não tem permissão para anexar arquivos aqui",
            ));
        }
    }
    // Tira repetidos mantendo a ordem em que a pessoa anexou.
    let mut seen = std::collections::HashSet::new();
    input.attachment_ids.retain(|a| seen.insert(a.clone()));
    if q.pending_attachments(&me, &input.attachment_ids) != input.attachment_ids.len() {
        return Err(bad_request("Anexo inválido ou já usado"));
    }
    let message = q.create_message_flagged(
        &channel.id,
        &me,
        &input.content,
        &input.attachment_ids,
        &input.requires,
        &input.spoiler_ids,
        &input.nsfw_ids,
    );
    // Quem manda a mensagem leu o canal até ela.
    q.ack(&me, &channel.id, &message.id);
    app.to_channel(&q, &channel.id, "message:create", &message);
    if channel.kind == "thread" {
        refresh_thread_starter(&app, &q, &channel);
    }
    if let Some(server_id) = &channel.server_id
        && has(q.channel_permissions(&me, &channel.id), perms::USE_AGENT)
    {
        let text = input.content.trim();
        let lower = text.to_lowercase();
        if lower == "/hoje" || lower.starts_with("/hoje ") {
            // /hoje [cidade]: o agente responde com data, feriado, tempo e curiosidade (busca na rede).
            let city: String = text
                .chars()
                .skip(5)
                .collect::<String>()
                .trim()
                .chars()
                .take(60)
                .collect();
            let (app2, server_id, channel_id) =
                (app.clone(), server_id.clone(), channel.id.clone());
            tokio::spawn(async move {
                let reply = crate::today::report(&city).await;
                let q = app2.store.q();
                app2.bot_say(&q, &server_id, &channel_id, &reply, &[]);
            });
        } else {
            app.smart_reply(&q, server_id, &channel.id, &me, &input.content);
        }
    }
    created(message)
}

/// `/play <link>` digitado no chat de um servidor.
async fn music_play(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let url: serde_json::Value =
        serde_json::from_slice(&b).map_err(|_| bad_request("Corpo inválido"))?;
    let raw = url
        .get("url")
        .and_then(|u| u.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if raw.is_empty() || raw.chars().count() > 300 {
        return Err(bad_request("Use /play [link ou nome da música]"));
    }
    let link = reqwest::Url::parse(&raw)
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https"));
    {
        let q = app.store.q();
        let channel = require_access(&q, &id, &me)?;
        let Some(server_id) = channel.server_id.clone() else {
            return Err(bad_request("O bot de música só funciona em servidores"));
        };
        if !matches!(channel.kind.as_str(), "text" | "thread") {
            return Err(bad_request("Use o /play num canal de texto"));
        }
        let _ = &server_id;
        let p = q.channel_permissions(&me, &channel.id);
        if !has(p, perms::SEND_MESSAGES) {
            return Err(forbidden(
                "Você não tem permissão para enviar mensagens aqui",
            ));
        }
        if !has(p, perms::USE_AGENT) {
            return Err(forbidden("Você não tem permissão para chamar o agente"));
        }
    }
    // Link do YouTube toca direto; qualquer outro texto vira busca no YouTube (primeiro resultado).
    // Link com &list= (ou /playlist?list=): enfileira a playlist, começando pelo vídeo do link se houver.
    if let Some(u) = &link {
        let host = u
            .host_str()
            .unwrap_or("")
            .trim_start_matches("www.")
            .trim_start_matches("m.");
        let list = u
            .query_pairs()
            .find(|(k, _)| k == "list")
            .map(|(_, v)| v.into_owned());
        let list = list.filter(|l| {
            matches!(host, "youtube.com" | "music.youtube.com" | "youtu.be")
                && (2..=64).contains(&l.len())
                && l.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        });
        if let Some(list) = list {
            let start = crate::embeds::youtube_id(u);
            if let Some(items) = crate::music::playlist(&list, start.as_deref()).await {
                crate::music::play_items(&app, &me, &id, items, true)
                    .map_err(|e| bad_request(&e))?;
                log_music(&app, &me, &id);
                return no_content();
            }
            if start.is_none() {
                return Err(bad_request(
                    "Não consegui abrir essa playlist. Ela pode ser privada.",
                ));
            }
        }
    }
    let video = match link {
        Some(u) => crate::embeds::youtube_id(&u)
            .ok_or_else(|| bad_request("Esse link não é do YouTube"))?,
        None => crate::music::search(&raw)
            .await
            .ok_or_else(|| bad_request("Não achei nenhum vídeo no YouTube com esse nome"))?,
    };
    crate::music::play(&app, &me, &id, video)
        .await
        .map_err(|e| bad_request(&e))?;
    log_music(&app, &me, &id);
    no_content()
}

/// Conta o /play para o painel admin.
fn log_music(app: &App, me: &str, channel_id: &str) {
    let q = app.store.q();
    let server_id = q.channel(channel_id).and_then(|c| c.server_id);
    q.log_activity("music_play", me, server_id.as_deref());
}

static STARTED: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// Página useline.tech/status: só números gerais (sem nomes), cada trava pega e solta sozinha.
async fn public_status(State(app): S) -> Res {
    let started = *STARTED.get_or_init(std::time::Instant::now);
    let online = crate::store::lock(&app.store.presence).online_ids().len();
    let in_call = crate::store::lock(&app.voice).all().len();
    let playing = crate::store::lock(&app.music).playing_count();
    let t = std::time::Instant::now();
    let db_ok = app
        .store
        .q()
        .ids("SELECT id FROM servers LIMIT 1", [])
        .len()
        <= 1;
    // (consulta mínima: se o banco travar, esta resposta nem chega e a página mostra fora do ar)
    let db_ms = t.elapsed().as_secs_f64() * 1000.0;
    ok(json!({
        "ok": db_ok,
        "version": VERSION,
        "uptimeSeconds": started.elapsed().as_secs(),
        "online": online,
        "inCall": in_call,
        "musicPlaying": playing,
        "dbMs": (db_ms * 10.0).round() / 10.0,
    }))
}

async fn get_music_bot(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    require_member(&q, &id, &me)?;
    let bot = app.music_bot(&q, &id).ok_or_else(|| not_found("Bot"))?;
    ok(bot)
}

/// Perfil do bot de música (Configurações do servidor → Integrações → Música).
async fn update_music_bot(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let p = body::<validate::UpdateProfile>(&b)?.check()?;
    let q = app.store.q();
    require_perm(&q, &id, &me, perms::MANAGE_AGENT)?;
    for img in [&p.avatar_id, &p.banner_id].into_iter().flatten().flatten() {
        if !q.own_image(&me, img) {
            return Err(bad_request("Imagem inválida"));
        }
    }
    let bot = app.music_bot(&q, &id).ok_or_else(|| not_found("Bot"))?;
    q.update_user(
        &bot.id,
        ProfilePatch {
            display_name: p.display_name,
            bio: p.bio,
            avatar_color: p.avatar_color,
            custom_status: p.custom_status,
            status: p.status,
            status_until: None,
            pronouns: p.pronouns,
            thought: p.thought,
            avatar_id: p.avatar_id,
            banner_id: p.banner_id,
            tag_server_id: None,
            bot_name_color: p.bot_name_color,
            bot_tag_color: p.bot_tag_color,
            bot_tag_text: p.bot_tag_text,
            bot_ring_color: p.bot_ring_color,
            bot_now_playing: p.bot_now_playing,
            bot_command_notes: p
                .bot_command_notes
                .map(|n| serde_json::to_string(&n).unwrap_or_else(|_| "{}".into())),
        },
    );
    let bot = q.public_user(&bot.id).ok_or_else(|| not_found("Bot"))?;
    app.to_server(&id, "user:update", &bot);
    ok(bot)
}

async fn get_bot_replies(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    require_perm(&q, &id, &me, perms::MANAGE_AGENT)?;
    ok(q.bot_replies(&id))
}

/// Respostas inteligentes do agente (Configurações do servidor → Agente → Respostas inteligentes).
/// Troca a lista inteira: até 100 itens [{q, a}].
async fn set_bot_replies(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let v: serde_json::Value =
        serde_json::from_slice(&b).map_err(|_| bad_request("Corpo inválido"))?;
    let items = v.as_array().ok_or_else(|| validation("Lista inválida"))?;
    if items.len() > 100 {
        return Err(validation("No máximo 100 respostas"));
    }
    let q = app.store.q();
    require_perm(&q, &id, &me, perms::MANAGE_AGENT)?;
    // Mídias que já estavam salvas continuam valendo mesmo que outra pessoa tenha enviado.
    let current: std::collections::HashSet<String> = q
        .bot_replies(&id)
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|i| {
            i.get("media")
                .and_then(|m| m.as_array())
                .cloned()
                .unwrap_or_default()
        })
        .filter_map(|m| m.get("id").and_then(|x| x.as_str()).map(String::from))
        .collect();
    let mut clean = vec![];
    for item in items {
        let question = item.get("q").and_then(|x| x.as_str()).unwrap_or("").trim();
        let answer = item.get("a").and_then(|x| x.as_str()).unwrap_or("").trim();
        let media_ids: Vec<String> = item
            .get("media")
            .and_then(|m| m.as_array())
            .into_iter()
            .flatten()
            .filter_map(|m| {
                m.get("id")
                    .and_then(|x| x.as_str())
                    .or_else(|| m.as_str())
                    .map(String::from)
            })
            .collect();
        if question.is_empty() && answer.is_empty() && media_ids.is_empty() {
            continue;
        }
        if question.is_empty() || (answer.is_empty() && media_ids.is_empty()) {
            return Err(validation(
                "Preencha a pergunta e a resposta (texto, imagem ou vídeo)",
            ));
        }
        if question.chars().count() > 200 || answer.chars().count() > 2000 {
            return Err(validation("Pergunta até 200 letras e resposta até 2000"));
        }
        if media_ids.len() > 4 {
            return Err(validation("No máximo 4 imagens ou vídeos por resposta"));
        }
        let mut media = vec![];
        for mid in &media_ids {
            let a = q
                .loose_media(mid, &me, current.contains(mid))
                .ok_or_else(|| validation("Imagem ou vídeo inválido"))?;
            media.push(json!({ "id": a.id, "filename": a.filename, "contentType": a.content_type, "url": a.url }));
        }
        clean.push(json!({ "q": question, "a": answer, "media": media }));
    }
    let list = serde_json::Value::Array(clean);
    q.set_bot_replies(&id, &list);
    ok(list)
}

fn music_settings_json(q: &Q, server_id: &str) -> serde_json::Value {
    json!({
        "idleMessage": q.music_idle_message(server_id),
        "defaultIdleMessage": crate::music::DEFAULT_IDLE_MESSAGE,
    })
}

async fn get_music_settings(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    require_member(&q, &id, &me)?;
    ok(music_settings_json(&q, &id))
}

/// Configurações do bot de música (por enquanto, a frase de quando a fila acaba).
async fn update_music_settings(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let v: serde_json::Value = body(&b)?;
    let q = app.store.q();
    require_perm(&q, &id, &me, perms::MANAGE_AGENT)?;
    if let Some(m) = v.get("idleMessage") {
        let m = m
            .as_str()
            .ok_or_else(|| bad_request("Mensagem inválida"))?
            .trim();
        if m.chars().count() > 300 {
            return Err(bad_request("A mensagem pode ter até 300 caracteres"));
        }
        q.set_music_idle_message(&id, m);
    }
    ok(music_settings_json(&q, &id))
}

async fn create_poll(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let input = body::<validate::CreatePoll>(&b)?.check()?;
    let q = app.store.q();
    let channel = require_access(&q, &id, &me)?;
    if channel.kind == "voice" {
        return Err(bad_request("Canais de voz não aceitam mensagens de texto"));
    }
    let p = q.channel_permissions(&me, &channel.id);
    if !has(p, perms::SEND_MESSAGES) {
        return Err(forbidden(
            "Você não tem permissão para enviar mensagens aqui",
        ));
    }
    if !has(p, perms::CREATE_POLLS) {
        return Err(forbidden("Você não tem permissão para criar enquetes aqui"));
    }
    let created_msg = q.create_message(&channel.id, &me, "", &[], &[]);
    q.create_poll(
        &created_msg.id,
        &input.question,
        &input.options,
        input.multi,
    );
    let message = q.message(&created_msg.id).unwrap_or(created_msg);
    app.to_channel(&q, &channel.id, "message:create", &message);
    if channel.kind == "thread" {
        refresh_thread_starter(&app, &q, &channel);
    }
    created(message)
}

async fn vote_poll(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let input = body::<validate::Vote>(&b)?;
    let q = app.store.q();
    let message = q
        .message(&id)
        .ok_or_else(|| bad_request("Mensagem não encontrada"))?;
    require_access(&q, &message.channel_id, &me)?;
    if !q.toggle_vote(&id, &input.option_id, &me) {
        return Err(bad_request("Opção inválida"));
    }
    let message = q.message(&id).unwrap_or(message);
    app.to_channel(&q, &message.channel_id, "message:update", &message);
    ok(message)
}

/// Máximo de emojis diferentes numa mensagem.
const MAX_REACTION_KINDS: i64 = 20;

async fn add_reaction(State(app): S, Me(me): Me, Path((id, emoji)): Path<(String, String)>) -> Res {
    let emoji = validate::reaction_emoji(&emoji)?;
    let q = app.store.q();
    let message = q
        .message(&id)
        .filter(|m| !m.deleted)
        .ok_or_else(|| bad_request("Mensagem não encontrada"))?;
    require_access(&q, &message.channel_id, &me)?;
    // Sem "Adicionar reações" só dá para entrar numa reação que já existe.
    if !q.has_reaction_emoji(&id, &emoji)
        && !has(
            q.channel_permissions(&me, &message.channel_id),
            perms::ADD_REACTIONS,
        )
    {
        return Err(forbidden("Você não tem permissão para adicionar reações"));
    }
    if !q.has_reaction_emoji(&id, &emoji) && q.reaction_kinds(&id) >= MAX_REACTION_KINDS {
        return Err(bad_request("Essa mensagem já tem reações demais"));
    }
    if !q.add_reaction(&id, &me, &emoji) {
        return ok(message);
    }
    let message = q.message(&id).unwrap_or(message);
    app.to_channel(&q, &message.channel_id, "message:update", &message);
    ok(message)
}

async fn remove_reaction(
    State(app): S,
    Me(me): Me,
    Path((id, emoji)): Path<(String, String)>,
) -> Res {
    let q = app.store.q();
    let message = q
        .message(&id)
        .ok_or_else(|| bad_request("Mensagem não encontrada"))?;
    require_access(&q, &message.channel_id, &me)?;
    if !q.remove_reaction(&id, &me, &emoji) {
        return ok(message);
    }
    let message = q.message(&id).unwrap_or(message);
    app.to_channel(&q, &message.channel_id, "message:update", &message);
    ok(message)
}

async fn add_attachment_reaction(
    State(app): S,
    Me(me): Me,
    Path((id, emoji)): Path<(String, String)>,
) -> Res {
    set_attachment_reaction(&app, &me, &id, emoji, true)
}

async fn remove_attachment_reaction(
    State(app): S,
    Me(me): Me,
    Path((id, emoji)): Path<(String, String)>,
) -> Res {
    set_attachment_reaction(&app, &me, &id, emoji, false)
}

/// Reação numa mídia só da mensagem (mesmas regras das reações na mensagem).
fn set_attachment_reaction(app: &App, me: &str, id: &str, emoji: String, on: bool) -> Res {
    let q = app.store.q();
    let message = q
        .attachment_message_id(&id)
        .and_then(|mid| q.message(&mid))
        .filter(|m| !m.deleted)
        .ok_or_else(|| bad_request("Mensagem não encontrada"))?;
    require_access(&q, &message.channel_id, &me)?;
    if on {
        let emoji = validate::reaction_emoji(&emoji)?;
        let (kinds, exists) = q.attachment_reaction_info(&id, &emoji);
        if !exists
            && !has(
                q.channel_permissions(&me, &message.channel_id),
                perms::ADD_REACTIONS,
            )
        {
            return Err(forbidden("Você não tem permissão para adicionar reações"));
        }
        if !exists && kinds >= MAX_REACTION_KINDS {
            return Err(bad_request("Essa mídia já tem reações demais"));
        }
        if !q.set_attachment_reaction(&id, &me, &emoji, true) {
            return ok(message);
        }
    } else if !q.set_attachment_reaction(&id, &me, &emoji, false) {
        return ok(message);
    }
    let message = q.message(&message.id).unwrap_or(message);
    app.to_channel(&q, &message.channel_id, "message:update", &message);
    ok(message)
}

/// Atualiza o contador de respostas mostrado embaixo da mensagem que abriu a thread.
pub(crate) fn refresh_thread_starter(app: &App, q: &Q, thread: &Channel) {
    let Some(Some(mid)) = &thread.thread_message_id else {
        return;
    };
    if let Some(starter) = q.message(mid) {
        app.to_channel(q, &starter.channel_id, "message:update", &starter);
    }
    if let (Some(_), Some(t)) = (&thread.server_id, q.channel(&thread.id)) {
        app.to_channel(q, &t.id, "channel:update", &t);
    }
}

// ----- threads -----

async fn list_threads(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    let channel = require_access(&q, &id, &me)?;
    ok(q.threads_of(&channel.id))
}

async fn create_thread(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let q = app.store.q();
    let parent = require_access(&q, &id, &me)?;
    if parent.kind != "text" {
        return Err(bad_request(
            "Threads só podem ser criadas em canais de texto",
        ));
    }
    if !has(
        q.channel_permissions(&me, &parent.id),
        perms::CREATE_THREADS,
    ) {
        return Err(forbidden("Você não tem permissão para criar threads"));
    }
    let input = body::<validate::CreateThread>(&b)?.check()?;
    if let Some(mid) = &input.message_id {
        if q.message(mid).is_none_or(|m| m.channel_id != parent.id) {
            return Err(not_found("Mensagem"));
        }
    }
    // A mídia precisa ser da própria mensagem; senão é ignorada.
    let attachment_id = input.attachment_id.as_deref().filter(|aid| {
        input.message_id.is_some() && q.attachment_message_id(aid) == input.message_id
    });
    // Uma thread por mensagem inteira e uma por mídia dela.
    if let Some(mid) = &input.message_id
        && q.thread_for_message(mid, attachment_id).is_some()
    {
        return Err(conflict(if attachment_id.is_some() {
            "Essa mídia já tem uma thread"
        } else {
            "Essa mensagem já tem uma thread"
        }));
    }
    let thread = q.create_thread(
        &parent,
        &me,
        &input.name,
        input.message_id.as_deref(),
        attachment_id,
    );
    if thread.server_id.is_some() {
        app.to_channel(&q, &thread.id, "channel:create", &thread);
    }
    if let Some(mid) = &input.message_id
        && let Some(starter) = q.message(mid)
    {
        app.to_channel(&q, &parent.id, "message:update", &starter);
    }
    created(thread)
}

// ----- anexos -----

const MAX_UPLOAD: usize = 100 * 1024 * 1024;

/// Recebe o arquivo cru no corpo (nome no cabeçalho `x-filename`) e grava em disco.
async fn upload_attachment(State(app): S, Me(me): Me, headers: HeaderMap, body: Body) -> Res {
    let filename = headers
        .get("x-filename")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .map(|n| sanitize_filename(&n))
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "arquivo".into());
    let content_type = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<mime::Mime>().ok())
        .filter(|m| *m != mime::APPLICATION_OCTET_STREAM)
        .unwrap_or_else(|| mime_guess(&filename));

    // Cota diária por usuário, para ninguém encher o disco do servidor.
    let quota_left = app
        .upload_quota
        .max
        .saturating_sub(app.upload_quota.used(&me));
    let over_quota = || {
        ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "UPLOAD_QUOTA",
            "Você chegou no limite de envios de hoje (2 GB). Tente de novo amanhã.",
        )
    };
    if quota_left == 0 {
        return Err(over_quota());
    }
    let id = crate::ids::attachment_id();
    tokio::fs::create_dir_all(&app.uploads_dir)
        .await
        .map_err(|_| internal("Não deu para salvar o arquivo"))?;
    let path = app.uploads_dir.join(&id);
    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|_| internal("Não deu para salvar o arquivo"))?;
    let mut size: usize = 0;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(_) => {
                drop(file);
                let _ = tokio::fs::remove_file(&path).await;
                return Err(ApiError::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "too_large",
                    "Arquivo grande demais (máximo 100 MB)",
                ));
            }
        };
        size += chunk.len();
        if size as u64 > quota_left {
            drop(file);
            let _ = tokio::fs::remove_file(&path).await;
            return Err(over_quota());
        }
        if file.write_all(&chunk).await.is_err() {
            drop(file);
            let _ = tokio::fs::remove_file(&path).await;
            return Err(internal("Não deu para salvar o arquivo"));
        }
    }
    let _ = file.flush().await;
    if size == 0 {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(validation("Arquivo vazio"));
    }
    app.upload_quota.add(&me, size as u64);
    // Largura/altura medidas pelo app (só para reservar espaço na tela).
    let dim = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|n| (1..=20000).contains(n))
    };
    let dims = dim("x-width").zip(dim("x-height"));
    let attachment = app.store.q().create_attachment_sized(
        &id,
        &me,
        &filename,
        content_type.essence_str(),
        size as i64,
        dims,
    );
    created(attachment)
}

/// Entrega o arquivo (com suporte a Range, para vídeos). O id longo e aleatório faz
/// as vezes de senha, assim <img> e <video> funcionam sem cabeçalho de login.
async fn serve_attachment(
    State(app): S,
    Path((id, _name)): Path<(String, String)>,
    req: Request,
) -> Result<Response, ApiError> {
    let attachment = app
        .store
        .q()
        .attachment(&id)
        .ok_or_else(|| not_found("Arquivo"))?;
    let mime: mime::Mime = attachment
        .content_type
        .parse()
        .unwrap_or(mime::APPLICATION_OCTET_STREAM);
    // Só tipos que o navegador mostra com segurança abrem inline; o resto vira download.
    let inline = matches!(mime.type_(), mime::IMAGE | mime::VIDEO | mime::AUDIO)
        && mime.subtype() != mime::SVG;
    let served_as = if inline || mime.type_() == mime::TEXT {
        if mime.type_() == mime::TEXT {
            mime::TEXT_PLAIN_UTF_8
        } else {
            mime
        }
    } else {
        mime::APPLICATION_OCTET_STREAM
    };
    let svc = tower_http::services::ServeFile::new_with_mime(app.uploads_dir.join(&id), &served_as);
    let mut res = svc
        .oneshot(req)
        .await
        .map_err(|_| not_found("Arquivo"))?
        .map(Body::new);
    let h = res.headers_mut();
    h.insert("x-content-type-options", "nosniff".parse().unwrap());
    h.insert(
        "cache-control",
        "private, max-age=31536000, immutable".parse().unwrap(),
    );
    if !inline
        && let Ok(v) = format!(
            "attachment; filename*=UTF-8''{}",
            url_encode(&attachment.filename)
        )
        .parse()
    {
        h.insert("content-disposition", v);
    }
    Ok(res)
}

fn internal(message: &str) -> ApiError {
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message)
}

fn sanitize_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_string();
    cleaned.chars().take(180).collect()
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Some(v) = std::str::from_utf8(&b[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn mime_guess(filename: &str) -> mime::Mime {
    let ext = filename
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    let t = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "ogg" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "txt" | "md" | "log" | "csv" | "json" | "ts" | "tsx" | "js" | "rs" | "py" | "toml"
        | "yaml" | "yml" => "text/plain",
        _ => "application/octet-stream",
    };
    t.parse().unwrap()
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
    if message.deleted {
        return Err(bad_request("Esta mensagem foi excluída"));
    }
    let input = body::<validate::SendMessage>(&b)?.check_with(!message.attachments.is_empty())?;
    let updated = q.edit_message(&message.id, &input.content);
    app.to_channel(&q, &message.channel_id, "message:update", &updated);
    ok(updated)
}

/// Quanto tempo uma mensagem pode ficar fixada (minutos): 1h, 5h, 10h, 1 dia, 7 dias, 30 dias.
/// Sem `minutes` (ou null) = sempre.
const PIN_MINUTES: [i64; 6] = [60, 300, 600, 1440, 10080, 43200];
/// Máximo de fixadas ao mesmo tempo por canal.
const MAX_PINS: usize = 50;

/// Mensagem que `me` pode fixar/desafixar: em servidor precisa de Gerenciar mensagens;
/// em DM e grupo qualquer participante pode.
fn pinnable(q: &Q, me: &str, id: &str) -> ApiResult<Message> {
    let message = q
        .message(id)
        .filter(|m| !m.deleted && q.can_access(me, &m.channel_id))
        .ok_or_else(|| not_found("Mensagem"))?;
    let channel = q
        .channel(&message.channel_id)
        .ok_or_else(|| not_found("Mensagem"))?;
    if let Some(server_id) = channel.server_id.as_deref()
        && !has(q.permissions(server_id, me), perms::MANAGE_MESSAGES)
        && !has(q.permissions(server_id, me), perms::PIN_MESSAGES)
    {
        return Err(forbidden(
            "Você precisa da permissão Fixar mensagens para fixar",
        ));
    }
    Ok(message)
}

#[derive(serde::Deserialize, Default)]
struct PinInput {
    minutes: Option<i64>,
}

async fn pin_message(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let input: PinInput = if b.is_empty() {
        PinInput::default()
    } else {
        serde_json::from_slice(&b).map_err(|_| validation("Dados inválidos"))?
    };
    let until = match input.minutes {
        None => None,
        Some(m) if PIN_MINUTES.contains(&m) => Some(
            (chrono::Utc::now() + chrono::Duration::minutes(m))
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string(),
        ),
        Some(_) => return Err(validation("Duração inválida")),
    };
    let q = app.store.q();
    let message = pinnable(&q, &me, &id)?;
    if message.pinned_at.is_none() && q.pinned_messages(&message.channel_id).len() >= MAX_PINS {
        return Err(validation(format!(
            "Esse canal já tem {MAX_PINS} mensagens fixadas. Desafixe alguma antes."
        )));
    }
    q.pin_message(&message.id, &me, until.as_deref());
    let updated = q
        .message(&message.id)
        .ok_or_else(|| not_found("Mensagem"))?;
    app.to_channel(&q, &message.channel_id, "message:update", &updated);
    ok(updated)
}

async fn unpin_message(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    let message = pinnable(&q, &me, &id)?;
    q.unpin_message(&message.id);
    let updated = q
        .message(&message.id)
        .ok_or_else(|| not_found("Mensagem"))?;
    app.to_channel(&q, &message.channel_id, "message:update", &updated);
    ok(updated)
}

async fn list_pins(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    let channel = require_access(&q, &id, &me)?;
    ok(q.pinned_messages(&channel.id))
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
    let can_manage = channel
        .server_id
        .as_deref()
        .is_some_and(|s| has(q.permissions(s, &me), perms::MANAGE_MESSAGES));
    if message.author.id != me && !can_manage {
        return Err(forbidden("Você não pode apagar esta mensagem"));
    }
    let files = q.attachment_ids_of_message(&message.id);
    // Com respostas na thread, a mensagem fica como "A mensagem foi excluída.".
    if message.thread.as_ref().is_some_and(|t| t.message_count > 0) {
        q.soft_delete_message(&message.id);
        app.remove_upload_files(&files);
        if let Some(updated) = q.message(&message.id) {
            app.to_channel(&q, &channel.id, "message:update", &updated);
        }
        return no_content();
    }
    q.delete_message(&message.id);
    app.remove_upload_files(&files);
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
    if ids.len() == 1 && q.is_blocked(&me, &ids[0]) {
        return Err(bad_request("Não é possível conversar com essa pessoa"));
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
    if target.bot_server_id.is_some() {
        return Err(bad_request("Não dá para adicionar um bot como amigo"));
    }
    let result = q.request_friend(&me, &target.id);
    if matches!(result, FriendRequest::Blocked) {
        return Err(bad_request(
            "Não foi possível enviar o pedido para essa pessoa",
        ));
    }
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

async fn block_user(State(app): S, Me(me): Me, Path(other): Path<String>) -> Res {
    let q = app.store.q();
    if other == me {
        return Err(bad_request("Você não pode bloquear a si mesmo"));
    }
    q.public_user(&other).ok_or_else(|| not_found("Usuário"))?;
    let was_friend = q.friend(&me, &other).is_some_and(|f| f.state == "friends");
    q.block_user(&me, &other);
    // Para a outra pessoa, a amizade ou o pedido simplesmente some.
    app.to_user(&other, "friend:remove", &json!({ "userId": me }));
    if let Some(f) = q.friend(&me, &other) {
        app.to_user(&me, "friend:update", &f);
    }
    if was_friend {
        app.broadcast_presence(&q, &me);
        app.broadcast_presence(&q, &other);
    }
    ok(q.friend(&me, &other))
}

async fn unblock_user(State(app): S, Me(me): Me, Path(other): Path<String>) -> Res {
    let q = app.store.q();
    if !q.unblock_user(&me, &other) {
        return Err(not_found("Bloqueio"));
    }
    app.to_user(&me, "friend:remove", &json!({ "userId": other }));
    no_content()
}

// ---------- interface web ----------

/// Fora de /api, entrega a interface (se configurada): assim dá para usar o Line pelo navegador
/// em https://seu-servidor/ sem instalar nada.
async fn web_fallback(State(app): S, req: Request) -> Response {
    let path = req.uri().path().to_string();
    let Some(web) = app
        .web
        .clone()
        .filter(|_| !path.starts_with("/api/") && path != "/api")
    else {
        return not_found("Rota").into_response();
    };
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        return not_found("Rota").into_response();
    }
    let rel = path.trim_start_matches('/');
    let rel = if rel.is_empty() || rel.ends_with('/') {
        format!("{rel}index.html")
    } else {
        rel.to_string()
    };
    if rel.split('/').any(|seg| seg == ".." || seg.is_empty()) {
        return not_found("Rota").into_response();
    }
    match web {
        crate::WebSource::Dir(dir) => {
            let mut target = dir.join(&rel);
            if !target.is_file() && !rel.contains('.') {
                // Rotas da interface sem arquivo próprio caem no index.html.
                target = dir.join("index.html");
            }
            let mime = mime_guess_web(&target.to_string_lossy());
            match tower_http::services::ServeFile::new_with_mime(&target, &mime)
                .oneshot(req)
                .await
            {
                Ok(res) => res.map(Body::new),
                Err(_) => not_found("Rota").into_response(),
            }
        }
        crate::WebSource::Assets(read) => {
            let found =
                read(&rel).or_else(|| (!rel.contains('.')).then(|| read("index.html")).flatten());
            match found {
                Some((bytes, mime)) => {
                    ([(axum::http::header::CONTENT_TYPE, mime)], bytes).into_response()
                }
                None => not_found("Rota").into_response(),
            }
        }
    }
}

fn mime_guess_web(path: &str) -> mime::Mime {
    let ext = path
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    let t = match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "txt" => "text/plain; charset=utf-8",
        _ => return mime_guess(path),
    };
    t.parse().unwrap()
}

// ---------- voz ----------

/// Servidores ICE para as chamadas: STUN público e, se configurado, o TURN do servidor
/// com credencial temporária (válida por 24h) no formato do `use-auth-secret` do coturn.
async fn ice_servers(State(app): S, Me(me): Me) -> Res {
    use base64::Engine;
    use hmac::{KeyInit, Mac};
    let mut list =
        vec![json!({ "urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] })];
    if let Some(turn) = &app.turn {
        let expires = chrono::Utc::now().timestamp() + 24 * 3600;
        let username = format!("{expires}:{me}");
        let mut mac = hmac::Hmac::<sha1::Sha1>::new_from_slice(turn.secret.as_bytes())
            .expect("hmac aceita qualquer chave");
        mac.update(username.as_bytes());
        let credential =
            base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
        list.push(json!({ "urls": turn.urls, "username": username, "credential": credential }));
    }
    ok(json!({ "iceServers": list }))
}

// ----- painel de efeitos sonoros -----

/// Duração máxima de cada som, em segundos (com uma folguinha para arredondamento).
const MAX_SOUND_SECS: f64 = 5.0;
const MAX_SOUND_BYTES: u64 = 2 * 1024 * 1024;

/// Duração de um WAV PCM pelo cabeçalho (bytes de áudio / bytes por segundo).
pub(crate) fn wav_duration(b: &[u8]) -> Option<f64> {
    if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return None;
    }
    let u32_at = |i: usize| {
        b.get(i..i + 4)
            .map(|x| u32::from_le_bytes([x[0], x[1], x[2], x[3]]))
    };
    let mut i = 12;
    let mut byte_rate = None;
    let mut data = None;
    while i + 8 <= b.len() {
        let size = u32_at(i + 4)? as usize;
        match &b[i..i + 4] {
            b"fmt " => byte_rate = u32_at(i + 8 + 8),
            b"data" => data = Some(size.min(b.len() - (i + 8))),
            _ => {}
        }
        i = i.checked_add(8 + size + (size & 1))?;
    }
    let rate = byte_rate.filter(|r| *r > 0)? as f64;
    Some(data? as f64 / rate)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SoundInput {
    attachment_id: Option<String>,
    name: String,
    #[serde(default)]
    emoji: String,
    #[serde(default = "one")]
    volume: f64,
}

fn one() -> f64 {
    1.0
}

impl SoundInput {
    fn clean(&self) -> ApiResult<(String, String, f64)> {
        let name: String = self.name.trim().chars().take(32).collect();
        if name.is_empty() {
            return Err(validation("Dê um nome para o som"));
        }
        let emoji: String = self.emoji.trim().chars().take(16).collect();
        let volume = if self.volume.is_finite() {
            self.volume.clamp(0.0, 1.0)
        } else {
            1.0
        };
        Ok((name, emoji, volume))
    }
}

fn can_manage_sound(q: &Q, server_id: &str, me: &str, sound: &crate::store::sounds::Sound) -> bool {
    sound.user_id.as_deref() == Some(me)
        || has(q.permissions(server_id, me), perms::MANAGE_SOUNDBOARD)
}

async fn list_my_sounds(State(app): S, Me(me): Me) -> Res {
    ok(app.store.q().my_sounds(&me))
}

async fn create_sound(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let input = body::<SoundInput>(&b)?;
    let (name, emoji, volume) = input.clean()?;
    let attachment_id = input
        .attachment_id
        .clone()
        .ok_or_else(|| validation("Escolha um arquivo"))?;
    // Confere tudo e solta o banco antes de ler o arquivo do disco.
    {
        let q = app.store.q();
        require_perm(&q, &id, &me, perms::MANAGE_SOUNDBOARD)?;
        if q.sound_count(&id) >= crate::store::sounds::MAX_SOUNDS {
            return Err(validation("Este servidor já chegou no limite de sons"));
        }
        if !q.loose_wav(&attachment_id, &me) {
            return Err(validation("Arquivo de som inválido"));
        }
    }
    let path = app.uploads_dir.join(&attachment_id);
    let size = tokio::fs::metadata(&path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    if size == 0 || size > MAX_SOUND_BYTES {
        return Err(validation("Arquivo de som grande demais"));
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| internal("Não deu para ler o arquivo"))?;
    let duration = wav_duration(&bytes).ok_or_else(|| validation("Arquivo de som inválido"))?;
    if duration > MAX_SOUND_SECS + 0.05 {
        return Err(validation("O som pode ter no máximo 5 segundos"));
    }
    if duration < 0.05 {
        return Err(validation("O som está vazio"));
    }
    let q = app.store.q();
    let sound = q.create_sound(&id, &me, &attachment_id, &name, &emoji, volume, duration);
    app.to_server(&id, "sounds:update", &json!({ "serverId": id }));
    created(sound)
}

async fn update_sound(
    State(app): S,
    Me(me): Me,
    Path((id, sound_id)): Path<(String, String)>,
    b: Bytes,
) -> Res {
    let input = body::<SoundInput>(&b)?;
    let (name, emoji, volume) = input.clean()?;
    let q = app.store.q();
    require_member(&q, &id, &me)?;
    let sound = q
        .sound(&sound_id)
        .filter(|s| s.server_id == id)
        .ok_or_else(|| not_found("Som"))?;
    if !can_manage_sound(&q, &id, &me, &sound) {
        return Err(forbidden("Você não tem permissão para fazer isso"));
    }
    q.update_sound(&sound_id, &name, &emoji, volume);
    app.to_server(&id, "sounds:update", &json!({ "serverId": id }));
    ok(q.sound(&sound_id))
}

async fn delete_sound(
    State(app): S,
    Me(me): Me,
    Path((id, sound_id)): Path<(String, String)>,
) -> Res {
    let q = app.store.q();
    require_member(&q, &id, &me)?;
    let sound = q
        .sound(&sound_id)
        .filter(|s| s.server_id == id)
        .ok_or_else(|| not_found("Som"))?;
    if !can_manage_sound(&q, &id, &me, &sound) {
        return Err(forbidden("Você não tem permissão para fazer isso"));
    }
    q.delete_sound(&sound_id);
    app.to_server(&id, "sounds:update", &json!({ "serverId": id }));
    no_content()
}

// ----- eventos (canal base "Eventos") -----

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventBody {
    title: String,
    #[serde(default)]
    description: String,
    starts_at: String,
    ends_at: Option<String>,
    #[serde(default)]
    location: String,
    voice_channel_id: Option<String>,
    #[serde(default)]
    game: String,
}

/// Data no formato ISO em UTC (o app manda `toISOString()`), normalizada para comparar como texto.
fn event_time(v: &str) -> ApiResult<String> {
    chrono::DateTime::parse_from_rfc3339(v.trim())
        .map(|d| {
            d.with_timezone(&chrono::Utc)
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string()
        })
        .map_err(|_| validation("Data inválida"))
}

fn event_input(q: &Q, server_id: &str, b: &Bytes) -> ApiResult<crate::store::events::EventInput> {
    let e: EventBody = serde_json::from_slice(b).map_err(|_| validation("Dados inválidos"))?;
    let title = e.title.trim().to_string();
    if title.is_empty() || title.chars().count() > 100 {
        return Err(validation(
            "O nome do evento precisa ter de 1 a 100 caracteres",
        ));
    }
    let description = e.description.trim().to_string();
    if description.chars().count() > 1000 {
        return Err(validation("A descrição pode ter até 1000 caracteres"));
    }
    let location = e.location.trim().to_string();
    if location.chars().count() > 200 {
        return Err(validation("O local pode ter até 200 caracteres"));
    }
    let game = e.game.trim().to_string();
    if game.chars().count() > 80 {
        return Err(validation("O nome do jogo pode ter até 80 caracteres"));
    }
    let starts_at = event_time(&e.starts_at)?;
    let ends_at = match e.ends_at.as_deref().filter(|v| !v.trim().is_empty()) {
        Some(v) => Some(event_time(v)?),
        None => None,
    };
    if ends_at.as_ref().is_some_and(|end| *end <= starts_at) {
        return Err(validation("O fim precisa ser depois do início"));
    }
    let voice_channel_id = e.voice_channel_id.filter(|v| !v.is_empty());
    if let Some(v) = &voice_channel_id
        && q.channel(v)
            .is_none_or(|c| c.kind != "voice" || c.server_id.as_deref() != Some(server_id))
    {
        return Err(validation("Canal de voz inválido"));
    }
    Ok(crate::store::events::EventInput {
        title,
        description,
        starts_at,
        ends_at,
        location,
        voice_channel_id,
        game,
    })
}

/// Canal "Eventos" que a pessoa enxerga.
fn require_events_channel(q: &Q, channel_id: &str, me: &str) -> ApiResult<(Channel, String)> {
    let channel = require_access(q, channel_id, me)?;
    match (&channel.server_id, channel.base.as_str()) {
        (Some(server_id), "events") => {
            let server_id = server_id.clone();
            Ok((channel, server_id))
        }
        _ => Err(bad_request("Esse canal não tem eventos")),
    }
}

/// Quem cria eventos: quem pode publicar no canal (dono, admin e "Publicar em Notas e Atualizações").
fn can_post_events(q: &Q, channel_id: &str, me: &str) -> bool {
    has(q.channel_permissions(me, channel_id), perms::SEND_MESSAGES)
}

async fn list_events(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    let (channel, _) = require_events_channel(&q, &id, &me)?;
    ok(q.channel_events(&channel.id))
}

async fn create_event(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let q = app.store.q();
    let (channel, server_id) = require_events_channel(&q, &id, &me)?;
    if !can_post_events(&q, &channel.id, &me) {
        return Err(forbidden("Você não tem permissão para criar eventos"));
    }
    let input = event_input(&q, &server_id, &b)?;
    let event = q.create_event(&server_id, &channel.id, &me, &input);
    app.to_channel(&q, &channel.id, "event:update", &event);
    created(event)
}

/// Evento que a pessoa pode editar: quem criou, ou quem pode publicar e gerencia mensagens.
fn editable_event(q: &Q, id: &str, me: &str) -> ApiResult<crate::store::events::Event> {
    let event = q
        .event(id)
        .filter(|e| q.can_access(me, &e.channel_id))
        .ok_or_else(|| not_found("Evento"))?;
    let mine = event.creator_id == me && can_post_events(q, &event.channel_id, me);
    if !mine
        && !has(
            q.channel_permissions(me, &event.channel_id),
            perms::MANAGE_MESSAGES,
        )
    {
        return Err(forbidden("Só quem criou o evento pode mudar ele"));
    }
    Ok(event)
}

async fn update_event(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let q = app.store.q();
    let event = editable_event(&q, &id, &me)?;
    let input = event_input(&q, &event.server_id, &b)?;
    let updated = q
        .update_event(&event.id, &input)
        .ok_or_else(|| not_found("Evento"))?;
    app.to_channel(&q, &event.channel_id, "event:update", &updated);
    ok(updated)
}

async fn delete_event(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    let event = editable_event(&q, &id, &me)?;
    q.delete_event(&event.id);
    app.to_channel(
        &q,
        &event.channel_id,
        "event:delete",
        &json!({ "id": event.id, "channelId": event.channel_id }),
    );
    no_content()
}

/// Marcar presença: { status: 'going' | 'maybe' | 'no' | null }.
async fn rsvp_event(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let v: serde_json::Value = body(&b)?;
    let status = match v.get("status").and_then(|s| s.as_str()) {
        None => None,
        Some(s @ ("going" | "maybe" | "no")) => Some(s),
        Some(_) => return Err(validation("Resposta inválida")),
    };
    let q = app.store.q();
    let event = q
        .event(&id)
        .filter(|e| q.can_access(&me, &e.channel_id))
        .ok_or_else(|| not_found("Evento"))?;
    q.set_rsvp(&event.id, &me, status);
    let updated = q.event(&event.id).ok_or_else(|| not_found("Evento"))?;
    app.to_channel(&q, &event.channel_id, "event:update", &updated);
    ok(updated)
}

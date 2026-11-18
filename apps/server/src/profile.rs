//! Perfil completo (modal "Perfil"): datas, nota pessoal, jogos do perfil, conexões, atividade
//! recente, estilo do nome exibido, busca de jogos na IGDB e usuários ignorados.
use crate::App;
use crate::errors::*;
use crate::routes::Me;
use crate::store::lock;
use crate::validate::body;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Json, Router};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;

type S = State<Arc<App>>;
type Res = ApiResult<Response>;

fn ok<T: serde::Serialize>(v: T) -> Res {
    Ok(Json(v).into_response())
}

pub fn router() -> Router<Arc<App>> {
    Router::new()
        .route("/users/@me/profile", put(update_extras))
        .route("/users/@me/ignored", get(list_ignored))
        .route("/users/{id}/profile", get(get_profile))
        .route("/users/{id}/note", put(put_note))
        .route("/users/{id}/ignore", put(ignore).delete(unignore))
        .route("/games/search", get(search_games))
        .route("/servers/{id}/profile", put(put_server_profile))
        .route("/servers/{id}/agent/profile", put(put_agent_profile))
}

/// Fontes e efeitos aceitos no estilo do nome (iguais aos de `apps/desktop/src/lib/nameStyle.ts`).
pub(crate) const FONTS: &[&str] = &[
    "default",
    "fredoka",
    "bungee",
    "lobster",
    "righteous",
    "playfair",
    "mono",
    "orbitron",
    "gothic",
    "pacifico",
    "pixel",
    "caveat",
];
pub(crate) const EFFECTS: &[&str] = &["solid", "gradient", "neon", "draw", "pop", "gummy", "prism"];
const CONNECTIONS: &[&str] = &[
    "twitch",
    "youtube",
    "steam",
    "spotify",
    "instagram",
    "x",
    "github",
    "tiktok",
    "xbox",
    "playstation",
    "epic",
    "riot",
    "battlenet",
    "site",
];

fn is_hex(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn clean_text(v: Option<&Value>, max: usize) -> Option<String> {
    let s: String = v?
        .as_str()?
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect();
    (!s.is_empty()).then_some(s)
}

/// Um jogo do perfil: `{ name, cover }` (capa só da IGDB).
fn clean_game(v: &Value) -> Option<Value> {
    let name = clean_text(v.get("name"), 80)?;
    let cover = v
        .get("cover")
        .and_then(|c| c.as_str())
        .filter(|c| c.starts_with("https://images.igdb.com/") && c.len() <= 200);
    Some(json!({ "name": name, "cover": cover }))
}

fn clean_style(v: &Value) -> ApiResult<Option<Value>> {
    if v.is_null() {
        return Ok(None);
    }
    let font = v.get("font").and_then(|x| x.as_str()).unwrap_or("default");
    let effect = v.get("effect").and_then(|x| x.as_str()).unwrap_or("solid");
    if !FONTS.contains(&font) || !EFFECTS.contains(&effect) {
        return Err(validation("Estilo de nome inválido"));
    }
    let colors: Vec<String> = v
        .get("colors")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|c| c.as_str())
                .filter(|c| is_hex(c))
                .take(6)
                .map(|c| c.to_lowercase())
                .collect()
        })
        .unwrap_or_default();
    let dir = v
        .get("dir")
        .and_then(|x| x.as_str())
        .filter(|d| matches!(*d, "h" | "v"));
    let motion = v
        .get("motion")
        .and_then(|x| x.as_str())
        .filter(|m| matches!(*m, "static" | "wave" | "pulse"));
    let speed = v
        .get("speed")
        .and_then(|x| x.as_str())
        .filter(|s| matches!(*s, "slow" | "medium" | "fast"));
    let mut out = json!({ "font": font, "effect": effect, "colors": colors });
    if let Some(d) = dir {
        out["dir"] = json!(d);
    }
    if let Some(m) = motion {
        out["motion"] = json!(m);
    }
    if let Some(s) = speed {
        out["speed"] = json!(s);
    }
    Ok(Some(out))
}

/// PUT /users/@me/profile: `favoriteGame`, `likedGames` (até 20), `connections` (até 10) e
/// `nameStyle` (null = sem estilo). Campos ausentes ficam como estão.
async fn update_extras(State(app): S, Me(me): Me, b: Bytes) -> Res {
    let input = body::<Value>(&b)?;
    let song = resolve_input_song(&input).await?;
    let q = app.store.q();
    let style_changed = apply_extras(&q, &me, &input, song)?;
    if style_changed {
        if let Some(user) = q.self_user(&me) {
            app.to_user(&me, "self:update", &user);
        }
        if let Some(public) = q.public_user(&me) {
            app.to_users(&q.audience_of(&me), "user:update", &public);
        }
    }
    ok(extras_json(&q, &me))
}

/// PUT /servers/{id}/agent/profile: o mesmo de `/users/@me/profile` (cartão, estilo do nome,
/// música favorita, visual da chamada), só que no agente do servidor. Pede Personalizar o agente.
async fn put_agent_profile(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let input = body::<Value>(&b)?;
    let song = resolve_input_song(&input).await?;
    let q = app.store.q();
    crate::routes::require_perm(&q, &id, &me, crate::perms::MANAGE_AGENT)?;
    let bot = app.music_bot(&q, &id).ok_or_else(|| not_found("Agente"))?;
    if apply_extras(&q, &bot.id, &input, song)? {
        if let Some(public) = q.public_user(&bot.id) {
            app.to_server(&id, "user:update", &public);
        }
    }
    ok(extras_json(&q, &bot.id))
}

fn extras_json(q: &crate::store::Q<'_>, user_id: &str) -> Value {
    let (games, connections) = q.profile_extras(user_id);
    json!({
        "favoriteGame": games.get("favorite"),
        "likedGames": games.get("liked").cloned().unwrap_or_else(|| json!([])),
        "favoriteSong": games.get("song"),
        "cardColors": games.get("card"),
        "callLook": games.get("call"),
        "connections": connections,
    })
}

/// Música favorita: link do YouTube ou nome para buscar (resolvido antes de pegar o banco).
/// None = não mexe; Some(Null) = tira.
async fn resolve_input_song(input: &Value) -> ApiResult<Option<Value>> {
    Ok(match input.get("favoriteSong") {
        None => None,
        Some(Value::Null) => Some(Value::Null),
        Some(v) => {
            let text = clean_text(Some(v), 200).ok_or_else(|| validation("Música inválida"))?;
            Some(
                resolve_song(&text)
                    .await
                    .ok_or_else(|| validation("Não achei essa música no YouTube"))?,
            )
        }
    })
}

/// Grava os extras do perfil de `me` (ou do agente). Devolve se o estilo do nome mudou.
fn apply_extras(
    q: &crate::store::Q<'_>,
    me: &str,
    input: &Value,
    song: Option<Value>,
) -> ApiResult<bool> {
    let (mut games, _) = q.profile_extras(me);
    if !games.is_object() {
        games = json!({});
    }
    let mut changed_games = false;
    if let Some(song) = song {
        games["song"] = song;
        changed_games = true;
    }
    // Cores do cartão do perfil (degradê de cima para baixo): [c1, c2] em #rrggbb; null tira.
    if let Some(c) = input.get("cardColors") {
        let colors: Vec<String> = c
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str())
                    .filter(|x| is_hex(x))
                    .take(2)
                    .map(|x| x.to_lowercase())
                    .collect()
            })
            .unwrap_or_default();
        games["card"] = if colors.is_empty() {
            Value::Null
        } else {
            json!(colors)
        };
        changed_games = true;
    }
    // Visual do quadro na chamada: { bg: "color" | "image", color, image, border, ring (borda da foto) }; null tira.
    if let Some(c) = input.get("callLook") {
        games["call"] = if c.is_object() {
            let hex = |k: &str| {
                c.get(k)
                    .and_then(|x| x.as_str())
                    .filter(|x| is_hex(x))
                    .map(|x| x.to_lowercase())
            };
            let image = c.get("image").and_then(|x| x.as_str()).filter(|x| {
                x.starts_with("/api/attachments/") && x.len() <= 300 && !x.contains("..")
            });
            let bg = c
                .get("bg")
                .and_then(|x| x.as_str())
                .filter(|b| matches!(*b, "color" | "image"));
            json!({ "bg": bg, "color": hex("color"), "image": image, "border": hex("border"), "ring": hex("ring") })
        } else {
            Value::Null
        };
        changed_games = true;
    }
    if let Some(f) = input.get("favoriteGame") {
        games["favorite"] = clean_game(f).unwrap_or(Value::Null);
        changed_games = true;
    }
    if let Some(list) = input.get("likedGames") {
        let list = list
            .as_array()
            .ok_or_else(|| validation("Dados inválidos"))?;
        if list.len() > 20 {
            return Err(validation("Escolha até 20 jogos"));
        }
        let mut seen = std::collections::HashSet::new();
        let liked: Vec<Value> = list
            .iter()
            .filter_map(clean_game)
            .filter(|g| seen.insert(g["name"].as_str().unwrap_or("").to_lowercase()))
            .collect();
        games["liked"] = json!(liked);
        changed_games = true;
    }
    if changed_games {
        q.set_profile_games(me, &games);
    }
    if let Some(list) = input.get("connections") {
        let list = list
            .as_array()
            .ok_or_else(|| validation("Dados inválidos"))?;
        if list.len() > 10 {
            return Err(validation("Até 10 conexões"));
        }
        let conns: Vec<Value> = list
            .iter()
            .filter_map(|c| {
                let kind = c.get("type")?.as_str()?;
                CONNECTIONS
                    .contains(&kind)
                    .then(|| clean_text(c.get("name"), 100))
                    .flatten()
                    .map(|name| json!({ "type": kind, "name": name }))
            })
            .collect();
        q.set_connections(me, &json!(conns));
    }
    if let Some(style) = input.get("nameStyle") {
        q.set_name_style(me, clean_style(style)?.as_ref());
        return Ok(true);
    }
    Ok(false)
}

/// GET /users/{id}/profile?server=: o que o modal de perfil mostra além do PublicUser.
async fn get_profile(
    State(app): S,
    Me(me): Me,
    Path(id): Path<String>,
    Query(qs): Query<HashMap<String, String>>,
) -> Res {
    let id = if id == "@me" { me.clone() } else { id };
    let q = app.store.q();
    let created_at = q.user_created_at(&id).ok_or_else(|| not_found("Usuário"))?;
    let joined_at = qs
        .get("server")
        .filter(|s| q.is_member(s, &me))
        .and_then(|s| q.member(s, &id))
        .map(|m| m.joined_at);
    let (games, connections) = q.profile_extras(&id);
    let settings = q.activity_settings(&id);
    let visible = q.activity_visible(&id, &me, &settings);
    let playing = if visible {
        lock(&app.playing.0)
            .get(&id)
            .map(|(n, since, _)| (n.clone(), since.clone()))
            .filter(|(n, _)| !q.game_hidden(&id, n))
    } else {
        None
    };
    let activity = if visible {
        q.recent_activity(&id, 30)
    } else {
        vec![]
    };
    ok(json!({
        "createdAt": created_at,
        "joinedAt": joined_at,
        "friendsSince": if id == me { None } else { q.friends_since(&me, &id) },
        "note": if id == me { String::new() } else { q.note(&me, &id) },
        "ignored": id != me && q.ignored(&me).contains(&id),
        "favoriteGame": games.get("favorite"),
        "likedGames": games.get("liked").cloned().unwrap_or_else(|| json!([])),
        "favoriteSong": games.get("song"),
        "cardColors": games.get("card"),
        "callLook": games.get("call"),
        "connections": connections,
        "playing": playing.map(|(name, since)| json!({ "name": name, "since": since })),
        "activity": activity,
    }))
}

/// PUT /users/{id}/note `{ note }`: nota só minha sobre a pessoa (vazia apaga).
async fn put_note(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let input = body::<Value>(&b)?;
    let note: String = input
        .get("note")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .trim()
        .chars()
        .take(256)
        .collect();
    let q = app.store.q();
    if id == me || q.user_created_at(&id).is_none() {
        return Err(not_found("Usuário"));
    }
    q.set_note(&me, &id, &note);
    ok(json!({ "note": note }))
}

async fn list_ignored(State(app): S, Me(me): Me) -> Res {
    ok(app.store.q().ignored(&me))
}

async fn ignore(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    if id == me || q.user_created_at(&id).is_none() {
        return Err(not_found("Usuário"));
    }
    q.set_ignored(&me, &id, true);
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn unignore(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    app.store.q().set_ignored(&me, &id, false);
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// GET /games/search?q=: jogos da IGDB (vazio quando a IGDB não está configurada).
async fn search_games(State(app): S, Me(_): Me, Query(qs): Query<HashMap<String, String>>) -> Res {
    let text = qs.get("q").map(|s| s.trim()).unwrap_or("");
    let Some(igdb) = &app.igdb else {
        return ok(json!({ "games": [], "enabled": false }));
    };
    if text.chars().count() < 2 {
        return ok(json!({ "games": [], "enabled": true }));
    }
    match igdb.search(text).await {
        Ok(games) => ok(json!({ "games": games, "enabled": true })),
        Err(error) => ok(json!({ "games": [], "enabled": true, "error": error })),
    }
}

/// Id do vídeo num link do YouTube (watch?v=, youtu.be/, shorts/, music.youtube.com).
fn video_id(text: &str) -> Option<String> {
    let url = reqwest::Url::parse(text).ok()?;
    let host = url
        .host_str()?
        .trim_start_matches("www.")
        .trim_start_matches("m.");
    let id = match host {
        "youtu.be" => url.path_segments()?.next()?.to_string(),
        "youtube.com" | "music.youtube.com" => {
            let mut seg = url.path_segments()?;
            match seg.next()? {
                "watch" => url.query_pairs().find(|(k, _)| k == "v")?.1.to_string(),
                "shorts" | "embed" | "live" => seg.next()?.to_string(),
                _ => return None,
            }
        }
        _ => return None,
    };
    (id.len() == 11
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    .then_some(id)
}

/// `{ videoId, title, author }` de um link ou do primeiro resultado da busca.
async fn resolve_song(text: &str) -> Option<Value> {
    let id = match video_id(text) {
        Some(id) => id,
        None if text.starts_with("http") => return None,
        None => crate::music::search(text).await?,
    };
    let (title, author, _) = crate::music::fetch_meta(&id).await?;
    Some(
        json!({ "videoId": id, "title": title.chars().take(150).collect::<String>(), "author": author.chars().take(100).collect::<String>() }),
    )
}

/// PUT /servers/{id}/profile: meu perfil neste servidor `{ avatarId, bannerId, bio }`
/// (null = usar o do perfil principal; campos ausentes ficam como estão).
async fn put_server_profile(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let input = body::<Value>(&b)?;
    let q = app.store.q();
    if !q.is_member(&id, &me) {
        return Err(not_found("Servidor"));
    }
    let mut cur = q.member_profile_raw(&id, &me);
    if !cur.is_object() {
        cur = json!({});
    }
    for key in ["avatarId", "bannerId"] {
        match input.get(key) {
            None => {}
            Some(Value::Null) => cur[key] = Value::Null,
            Some(v) => {
                let img = v.as_str().ok_or_else(|| validation("Imagem inválida"))?;
                if !q.own_image(&me, img) {
                    return Err(validation("Imagem inválida"));
                }
                cur[key] = json!(img);
            }
        }
    }
    if let Some(bio) = input.get("bio") {
        let text: String = bio
            .as_str()
            .unwrap_or("")
            .trim()
            .chars()
            .take(190)
            .collect();
        cur["bio"] = if text.is_empty() {
            Value::Null
        } else {
            json!(text)
        };
    }
    q.set_member_profile(&id, &me, &cur);
    let member = q.member(&id, &me).ok_or_else(|| not_found("Membro"))?;
    app.to_server(&id, "member:update", &member);
    ok(member)
}

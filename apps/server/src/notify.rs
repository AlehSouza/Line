//! Notificações: configurações (por servidor, canal e gerais), read states (lido até onde,
//! menções não lidas) e a caixa de entrada de menções. Mesma lógica do Discord: o servidor guarda
//! e sincroniza entre aparelhos; o app decide o que notifica.
use crate::App;
use crate::errors::*;
use crate::routes::Me;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
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
        .route(
            "/users/@me/notification-settings",
            get(get_settings).put(put_settings),
        )
        .route("/users/@me/read-states", get(read_states))
        .route("/users/@me/mentions", get(mentions))
        .route("/channels/{id}/ack", post(ack))
        .route("/servers/{id}/ack", post(ack_server))
}

async fn get_settings(State(app): S, Me(me): Me) -> Res {
    let q = app.store.q();
    ok(q.notify_settings(&me).unwrap_or_else(|| json!({})))
}

async fn put_settings(State(app): S, Me(me): Me, b: Bytes) -> Res {
    if b.len() > 64 * 1024 {
        return Err(validation("Configurações grandes demais"));
    }
    let v: Value = serde_json::from_slice(&b).map_err(|_| validation("Dados inválidos"))?;
    if !v.is_object() {
        return Err(validation("Dados inválidos"));
    }
    let q = app.store.q();
    q.set_notify_settings(&me, &v);
    app.to_user(&me, "notify:settings", &v);
    ok(v)
}

async fn read_states(State(app): S, Me(me): Me) -> Res {
    let q = app.store.q();
    ok(q.read_states(&me))
}

async fn mentions(State(app): S, Me(me): Me, Query(p): Query<HashMap<String, String>>) -> Res {
    let q = app.store.q();
    let server = p.get("server").filter(|s| !s.is_empty());
    if let Some(sid) = server
        && !q.is_member(sid, &me)
    {
        return Err(not_found("Servidor"));
    }
    let flag = |k: &str| p.get(k).map(|v| v != "0" && v != "false").unwrap_or(true);
    ok(q.recent_mentions(
        &me,
        server.map(|s| s.as_str()),
        flag("everyone"),
        flag("roles"),
        p.get("before").map(|s| s.as_str()),
    ))
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AckInput {
    message_id: Option<String>,
}

async fn ack(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let input: AckInput = serde_json::from_slice(&b).unwrap_or_default();
    let q = app.store.q();
    if !q.can_access(&me, &id) {
        return Err(not_found("Canal"));
    }
    let message_id = match input.message_id {
        Some(m) if m.len() <= 64 => {
            q.ack(&me, &id, &m);
            Some(m)
        }
        _ => q.ack_latest(&me, &id),
    };
    if let Some(m) = &message_id {
        app.to_user(&me, "read:ack", &json!({ "channelId": id, "messageId": m }));
    }
    ok(json!({ "channelId": id, "messageId": message_id }))
}

/// "Marcar servidor como lido": todos os canais que eu vejo.
async fn ack_server(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    if !q.is_member(&id, &me) {
        return Err(not_found("Servidor"));
    }
    let mut acked = Vec::new();
    for cid in q.ids(
        "SELECT id FROM channels WHERE type != 'voice'
           AND (server_id = ?1 OR parent_id IN (SELECT id FROM channels WHERE server_id = ?1))",
        [id.as_str()],
    ) {
        if q.can_access(&me, &cid)
            && let Some(m) = q.ack_latest(&me, &cid)
        {
            acked.push(json!({ "channelId": cid, "messageId": m }));
        }
    }
    for a in &acked {
        app.to_user(&me, "read:ack", a);
    }
    ok(acked)
}

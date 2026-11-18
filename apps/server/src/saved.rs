//! Aba Salvos: mensagens que a pessoa marcou para ver depois. Se a mensagem for apagada (ou a
//! pessoa perder acesso ao canal), o salvo continua, só que sem a mensagem.
use crate::App;
use crate::errors::*;
use crate::routes::Me;
use crate::store::saved::MAX_SAVED;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Json, Router};
use serde_json::json;
use std::sync::Arc;

type S = State<Arc<App>>;
type Res = ApiResult<Response>;

fn ok<T: serde::Serialize>(v: T) -> Res {
    Ok(Json(v).into_response())
}

pub fn router() -> Router<Arc<App>> {
    Router::new()
        .route("/users/@me/saved", get(list_saved))
        .route("/users/@me/saved/ids", get(saved_ids))
        .route("/messages/{id}/save", put(save).delete(unsave))
}

async fn list_saved(State(app): S, Me(me): Me) -> Res {
    let q = app.store.q();
    let items: Vec<_> = q
        .saved_rows(&me)
        .into_iter()
        .map(|row| {
            let access = q.can_access(&me, &row.channel_id);
            let message = q.message(&row.message_id).filter(|m| access && !m.deleted);
            let channel = if access {
                q.channel(&row.channel_id)
            } else {
                None
            };
            let server = channel
                .as_ref()
                .and_then(|c| c.server_id.as_deref())
                .and_then(|id| q.server(id));
            json!({
                "messageId": row.message_id,
                "channelId": row.channel_id,
                "savedAt": row.saved_at,
                "message": message,
                "channelName": channel.as_ref().map(|c| c.name.clone()),
                "serverId": server.as_ref().map(|s| s.id.clone()),
                "serverName": server.as_ref().map(|s| s.name.clone()),
            })
        })
        .collect();
    ok(items)
}

async fn saved_ids(State(app): S, Me(me): Me) -> Res {
    let q = app.store.q();
    let ids: Vec<String> = q
        .saved_rows(&me)
        .into_iter()
        .map(|r| r.message_id)
        .collect();
    ok(ids)
}

async fn save(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    let message = q
        .message(&id)
        .filter(|m| !m.deleted && q.can_access(&me, &m.channel_id))
        .ok_or_else(|| not_found("Mensagem"))?;
    if q.saved_count(&me) >= MAX_SAVED {
        return Err(validation(format!(
            "Você já tem {MAX_SAVED} mensagens salvas. Remova alguma antes."
        )));
    }
    q.save_message(&me, &message.id, &message.channel_id);
    app.to_user(
        &me,
        "saved:update",
        &json!({ "messageId": message.id, "saved": true }),
    );
    ok(json!({ "messageId": message.id, "saved": true }))
}

async fn unsave(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let q = app.store.q();
    q.unsave_message(&me, &id);
    app.to_user(
        &me,
        "saved:update",
        &json!({ "messageId": id, "saved": false }),
    );
    ok(json!({ "messageId": id, "saved": false }))
}

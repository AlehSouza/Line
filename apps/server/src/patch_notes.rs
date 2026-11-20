//! Patch notes: quem usa o Line pode reagir e comentar em cada nota de versão.
//! O texto das notas vem com o app; aqui só ficam as reações e os comentários.
use crate::App;
use crate::errors::*;
use crate::routes::Me;
use crate::validate::reaction_emoji;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

type S = State<Arc<App>>;
type Res = ApiResult<Response>;

/// Tamanho máximo de um comentário.
const MAX_COMMENT: usize = 1000;
/// Emojis diferentes por nota.
const MAX_REACTION_KINDS: i64 = 20;
/// Comentários por pessoa a cada minuto.
const COMMENTS_PER_MINUTE: i64 = 5;

pub fn router() -> Router<Arc<App>> {
    Router::new()
        .route("/patch-notes/{id}", get(social))
        .route("/patch-notes/{id}/reactions/{emoji}", put(react).delete(unreact))
        .route("/patch-notes/{id}/comments", post(comment))
        .route("/patch-note-comments/{id}", delete(delete_comment))
}

/// Id da nota: letras minúsculas, números e hífen (ex.: "2026-11-20").
fn note_id(raw: &str) -> ApiResult<String> {
    let ok = !raw.is_empty()
        && raw.len() <= 64
        && raw
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(raw.to_string())
    } else {
        Err(not_found("Nota"))
    }
}

/// Reações e comentários da nota, já com os autores.
fn payload(app: &App, me: &str, id: &str, admin: bool) -> Value {
    let q = app.store.q();
    let reactions: Vec<Value> = q
        .patch_reactions(id)
        .into_iter()
        .map(|(emoji, user_ids)| json!({ "emoji": emoji, "userIds": user_ids }))
        .collect();
    let comments: Vec<Value> = q
        .patch_comments(id)
        .into_iter()
        .map(|c| {
            json!({
                "id": c.id,
                "author": q.public_user(&c.user_id),
                "content": c.content,
                "createdAt": c.created_at,
                "canDelete": admin || c.user_id == me,
            })
        })
        .collect();
    json!({ "noteId": id, "reactions": reactions, "comments": comments })
}

async fn social(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let id = note_id(&id)?;
    let admin = app.is_admin(&me);
    Ok(Json(payload(&app, &me, &id, admin)).into_response())
}

async fn react(State(app): S, Me(me): Me, Path((id, emoji)): Path<(String, String)>) -> Res {
    let id = note_id(&id)?;
    let emoji = reaction_emoji(&emoji)?;
    {
        let q = app.store.q();
        let exists = q.patch_reactions(&id).iter().any(|(e, _)| *e == emoji);
        if !exists && q.patch_reaction_kinds(&id) >= MAX_REACTION_KINDS {
            return Err(validation("Essa nota já tem emojis demais."));
        }
        q.patch_react(&id, &me, &emoji);
    }
    let admin = app.is_admin(&me);
    Ok(Json(payload(&app, &me, &id, admin)).into_response())
}

async fn unreact(State(app): S, Me(me): Me, Path((id, emoji)): Path<(String, String)>) -> Res {
    let id = note_id(&id)?;
    app.store.q().patch_unreact(&id, &me, emoji.trim());
    let admin = app.is_admin(&me);
    Ok(Json(payload(&app, &me, &id, admin)).into_response())
}

#[derive(Deserialize)]
struct CommentBody {
    content: String,
}

async fn comment(
    State(app): S,
    Me(me): Me,
    Path(id): Path<String>,
    Json(body): Json<CommentBody>,
) -> Res {
    let id = note_id(&id)?;
    let content = body.content.trim();
    if content.is_empty() {
        return Err(validation("Escreva alguma coisa antes de enviar."));
    }
    if content.chars().count() > MAX_COMMENT {
        return Err(validation(format!(
            "O comentário pode ter até {MAX_COMMENT} caracteres."
        )));
    }
    {
        let q = app.store.q();
        let since = (chrono::Utc::now() - chrono::Duration::minutes(1))
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        if q.patch_comments_since(&me, &since) >= COMMENTS_PER_MINUTE {
            return Err(validation("Calma! Espere um pouco antes de comentar de novo."));
        }
        q.patch_comment(&id, &me, content);
    }
    let admin = app.is_admin(&me);
    Ok(Json(payload(&app, &me, &id, admin)).into_response())
}

async fn delete_comment(State(app): S, Me(me): Me, Path(id): Path<String>) -> Res {
    let admin = app.is_admin(&me);
    let q = app.store.q();
    let author = q
        .patch_comment_author(&id)
        .ok_or_else(|| not_found("Comentário"))?;
    if author != me && !admin {
        return Err(forbidden("Você só pode apagar os seus comentários."));
    }
    q.patch_delete_comment(&id);
    Ok(Json(json!({ "id": id, "deleted": true })).into_response())
}

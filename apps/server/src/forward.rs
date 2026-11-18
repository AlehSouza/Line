//! Encaminhar mensagem: para canais do mesmo servidor ou para a DM de um amigo. Nunca para
//! outro servidor. A cópia sai com o marcador "Encaminhada" e não menciona ninguém.
use crate::App;
use crate::errors::*;
use crate::perms::{self, has};
use crate::routes::Me;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use std::sync::Arc;

type S = State<Arc<App>>;
type Res = ApiResult<Response>;

/// Quantos destinos de uma vez.
const MAX_TARGETS: usize = 5;

pub fn router() -> Router<Arc<App>> {
    Router::new().route("/messages/{id}/forward", post(forward))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForwardInput {
    channel_ids: Vec<String>,
    #[serde(default)]
    note: String,
}

async fn forward(State(app): S, Me(me): Me, Path(id): Path<String>, b: Bytes) -> Res {
    let input: ForwardInput =
        serde_json::from_slice(&b).map_err(|_| validation("Dados inválidos"))?;
    let mut targets = input.channel_ids;
    let mut seen = std::collections::HashSet::new();
    targets.retain(|t| seen.insert(t.clone()));
    if targets.is_empty() {
        return Err(validation("Escolha para onde encaminhar"));
    }
    if targets.len() > MAX_TARGETS {
        return Err(validation(format!(
            "Dá para encaminhar para até {MAX_TARGETS} lugares de uma vez"
        )));
    }
    let note = input.note.trim().to_string();
    if note.chars().count() > 2000 {
        return Err(validation(
            "O comentário pode ter no máximo 2000 caracteres",
        ));
    }

    let q = app.store.q();
    let message = q
        .message(&id)
        .filter(|m| !m.deleted)
        .ok_or_else(|| not_found("Mensagem"))?;
    let source = match q.channel(&message.channel_id) {
        Some(c) if q.can_access(&me, &c.id) => c,
        _ => return Err(not_found("Mensagem")),
    };
    if message.poll.is_some() {
        return Err(bad_request("Enquetes não podem ser encaminhadas"));
    }

    // Confere todos os destinos antes de mandar qualquer coisa.
    let mut channels = vec![];
    for t in &targets {
        let channel = match q.channel(t) {
            Some(c) if q.can_access(&me, &c.id) => c,
            _ => return Err(not_found("Canal")),
        };
        match &channel.server_id {
            Some(sid) => {
                if source.server_id.as_deref() != Some(sid.as_str()) {
                    return Err(forbidden(
                        "Só dá para encaminhar para canais deste servidor",
                    ));
                }
                if channel.kind == "voice" || channel.base == "activity" {
                    return Err(bad_request("Esse canal não aceita mensagens"));
                }
                let p = q.channel_permissions(&me, &channel.id);
                if !has(p, perms::SEND_MESSAGES) {
                    return Err(forbidden(&format!(
                        "Você não pode enviar mensagens em #{}",
                        channel.name
                    )));
                }
                if !message.attachments.is_empty() && !has(p, perms::ATTACH_FILES) {
                    return Err(forbidden(&format!(
                        "Você não pode enviar arquivos em #{}",
                        channel.name
                    )));
                }
            }
            None => {
                let others: Vec<String> = q
                    .recipient_ids(&channel.id)
                    .into_iter()
                    .filter(|u| u != &me)
                    .collect();
                let friend_dm = channel.kind == "dm"
                    && others.len() == 1
                    && q.friends_with(&me, &others[0])
                    && !q.is_blocked(&me, &others[0])
                    && !q.is_blocked(&others[0], &me);
                if !friend_dm {
                    return Err(forbidden("No privado, só dá para encaminhar para amigos"));
                }
            }
        }
        channels.push(channel);
    }

    let mut sent = vec![];
    for channel in &channels {
        let mut copies = vec![];
        for a in &message.attachments {
            let new = crate::ids::new_id();
            if std::fs::copy(app.uploads_dir.join(&a.id), app.uploads_dir.join(&new)).is_ok() {
                copies.push((new, a.clone()));
            }
        }
        let fwd = q.create_forwarded(
            &channel.id,
            &me,
            &message.content,
            &message.requires,
            &copies,
            &source.id,
        );
        q.ack(&me, &channel.id, &fwd.id);
        app.to_channel(&q, &channel.id, "message:create", &fwd);
        if !note.is_empty() {
            let extra = q.create_message_flagged(&channel.id, &me, &note, &[], &[], &[], &[]);
            q.ack(&me, &channel.id, &extra.id);
            app.to_channel(&q, &channel.id, "message:create", &extra);
        }
        if channel.kind == "thread" {
            crate::routes::refresh_thread_starter(&app, &q, channel);
        }
        sent.push(fwd);
    }
    Ok(Json(sent).into_response())
}

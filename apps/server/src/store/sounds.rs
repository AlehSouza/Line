//! Painel de efeitos sonoros: sons curtos de cada servidor (o arquivo é um anexo WAV).
use super::{Q, ok, url_segment};
use crate::ids::{new_id, now_iso};
use crate::model::PublicUser;
use rusqlite::{OptionalExtension, Row, params};
use serde::Serialize;

/// Quantos sons cada servidor pode ter.
pub const MAX_SOUNDS: i64 = 48;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sound {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub emoji: String,
    pub volume: f64,
    pub duration: f64,
    pub plays: i64,
    pub url: String,
    pub user_id: Option<String>,
    pub user: Option<PublicUser>,
    pub created_at: String,
}

const SELECT: &str =
    "SELECT s.*, a.filename FROM soundboard_sounds s JOIN attachments a ON a.id = s.attachment_id";

fn from_row(r: &Row) -> rusqlite::Result<Sound> {
    let attachment: String = r.get("attachment_id")?;
    let filename: String = r.get("filename")?;
    Ok(Sound {
        id: r.get("id")?,
        server_id: r.get("server_id")?,
        name: r.get("name")?,
        emoji: r.get("emoji")?,
        volume: r.get("volume")?,
        duration: r.get("duration")?,
        plays: r.get("plays")?,
        url: format!("/api/attachments/{attachment}/{}", url_segment(&filename)),
        user_id: r.get("user_id")?,
        user: None,
        created_at: r.get("created_at")?,
    })
}

impl Q<'_> {
    fn with_user(&self, mut s: Sound) -> Sound {
        s.user = s.user_id.as_deref().and_then(|u| self.public_user(u));
        s
    }

    pub fn sound(&self, id: &str) -> Option<Sound> {
        ok(self
            .c
            .query_row(&format!("{SELECT} WHERE s.id = ?"), [id], from_row)
            .optional())
        .map(|s| self.with_user(s))
    }

    pub fn server_sounds(&self, server_id: &str) -> Vec<Sound> {
        let list: Vec<Sound> = {
            let mut st = ok(self.c.prepare_cached(&format!(
                "{SELECT} WHERE s.server_id = ? ORDER BY s.created_at DESC"
            )));
            ok(ok(st.query_map([server_id], from_row)).collect())
        };
        list.into_iter().map(|s| self.with_user(s)).collect()
    }

    /// Sons de todos os servidores de que a pessoa participa.
    pub fn my_sounds(&self, user_id: &str) -> Vec<Sound> {
        self.server_ids_of(user_id)
            .into_iter()
            .flat_map(|sid| self.server_sounds(&sid))
            .collect()
    }

    pub fn sound_count(&self, server_id: &str) -> i64 {
        ok(self.c.query_row(
            "SELECT COUNT(*) FROM soundboard_sounds WHERE server_id = ?",
            [server_id],
            |r| r.get(0),
        ))
    }

    /// Anexo WAV solto (fora de mensagem e de outro som) enviado por `user_id`.
    pub fn loose_wav(&self, id: &str, user_id: &str) -> bool {
        ok(self
            .c
            .query_row(
                "SELECT 1 FROM attachments WHERE id = ? AND uploader_id = ? AND message_id IS NULL
                 AND content_type IN ('audio/wav', 'audio/x-wav', 'audio/wave')
                 AND id NOT IN (SELECT attachment_id FROM soundboard_sounds)",
                [id, user_id],
                |_| Ok(()),
            )
            .optional())
        .is_some()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_sound(
        &self,
        server_id: &str,
        user_id: &str,
        attachment_id: &str,
        name: &str,
        emoji: &str,
        volume: f64,
        duration: f64,
    ) -> Sound {
        let id = new_id();
        ok(self.c.execute(
            "INSERT INTO soundboard_sounds (id, server_id, user_id, attachment_id, name, emoji, volume, duration, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![id, server_id, user_id, attachment_id, name, emoji, volume, duration, now_iso()],
        ));
        self.sound(&id).unwrap()
    }

    pub fn update_sound(&self, id: &str, name: &str, emoji: &str, volume: f64) {
        ok(self.c.execute(
            "UPDATE soundboard_sounds SET name = ?, emoji = ?, volume = ? WHERE id = ?",
            params![name, emoji, volume, id],
        ));
    }

    /// Apaga o som (o arquivo sai do disco na próxima limpeza de anexos).
    pub fn delete_sound(&self, id: &str) {
        ok(self
            .c
            .execute("DELETE FROM soundboard_sounds WHERE id = ?", [id]));
    }

    pub fn sound_played(&self, id: &str) {
        ok(self.c.execute(
            "UPDATE soundboard_sounds SET plays = plays + 1 WHERE id = ?",
            [id],
        ));
    }
}

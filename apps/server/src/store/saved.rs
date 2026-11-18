//! Mensagens salvas de cada pessoa (aba Salvos).
use super::{Q, ok};
use crate::ids::now_iso;
use rusqlite::params;

/// Quantas mensagens cada pessoa pode ter salvas.
pub const MAX_SAVED: i64 = 500;

pub struct SavedRow {
    pub message_id: String,
    pub channel_id: String,
    pub saved_at: String,
}

impl Q<'_> {
    pub fn saved_count(&self, user_id: &str) -> i64 {
        ok(self.c.query_row(
            "SELECT COUNT(*) FROM saved_messages WHERE user_id = ?",
            [user_id],
            |r| r.get(0),
        ))
    }

    pub fn save_message(&self, user_id: &str, message_id: &str, channel_id: &str) {
        ok(self.c.execute(
            "INSERT OR IGNORE INTO saved_messages (user_id, message_id, channel_id, saved_at) VALUES (?, ?, ?, ?)",
            params![user_id, message_id, channel_id, now_iso()],
        ));
    }

    pub fn unsave_message(&self, user_id: &str, message_id: &str) {
        ok(self.c.execute(
            "DELETE FROM saved_messages WHERE user_id = ? AND message_id = ?",
            [user_id, message_id],
        ));
    }

    /// Salvos da pessoa, do mais recente para o mais antigo.
    pub fn saved_rows(&self, user_id: &str) -> Vec<SavedRow> {
        let mut st = ok(self.c.prepare_cached(
            "SELECT message_id, channel_id, saved_at FROM saved_messages WHERE user_id = ? ORDER BY saved_at DESC",
        ));
        ok(ok(st.query_map([user_id], |r| {
            Ok(SavedRow {
                message_id: r.get(0)?,
                channel_id: r.get(1)?,
                saved_at: r.get(2)?,
            })
        }))
        .collect())
    }
}

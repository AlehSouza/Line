//! Encaminhar mensagens: copia o texto e os anexos para outro canal, sem mencionar ninguém.
use super::{Q, ok};
use crate::ids::{new_id, now_iso};
use crate::model::{Attachment, Message};
use rusqlite::{OptionalExtension, params};

impl Q<'_> {
    pub fn friends_with(&self, a: &str, b: &str) -> bool {
        ok(self
            .c
            .query_row(
                "SELECT 1 FROM friendships WHERE status = 'accepted'
                 AND ((requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1))",
                [a, b],
                |_| Ok(()),
            )
            .optional())
        .is_some()
    }

    /// Cria a cópia encaminhada. `copies` = (id novo do anexo, anexo original), arquivo já copiado.
    pub fn create_forwarded(
        &self,
        channel_id: &str,
        author_id: &str,
        content: &str,
        requires: &[String],
        copies: &[(String, Attachment)],
        from_channel: &str,
    ) -> Message {
        let id = new_id();
        let at = now_iso();
        self.tx(|| {
            ok(self.c.execute(
                "INSERT INTO messages (id, channel_id, author_id, content, created_at, mention_everyone, mention_roles, requires, forwarded_from)
                 VALUES (?, ?, ?, ?, ?, 0, '', ?, ?)",
                params![id, channel_id, author_id, content, at, requires.join(","), from_channel],
            ));
            ok(self.c.execute("UPDATE channels SET last_message_at = ? WHERE id = ?", [&at, channel_id]));
            for (pos, (new, src)) in copies.iter().enumerate() {
                self.clone_attachment(src, new, author_id);
                ok(self.c.execute(
                    "UPDATE attachments SET message_id = ?, position = ?, spoiler = ?, nsfw = ? WHERE id = ?",
                    params![id, pos as i64, src.spoiler as i64, (src.nsfw || src.nsfw_locked) as i64, new],
                ));
            }
        });
        self.message(&id).unwrap()
    }
}

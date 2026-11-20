//! Patch notes: comentários e reações de cada nota de versão (as notas em si moram no app).
use super::{Q, ok};
use crate::ids::{new_id, now_iso};
use rusqlite::params;

pub struct PatchCommentRow {
    pub id: String,
    pub user_id: String,
    pub content: String,
    pub created_at: String,
}

impl Q<'_> {
    /// Reações da nota: (emoji, ids de quem reagiu na ordem em que reagiu).
    pub fn patch_reactions(&self, note_id: &str) -> Vec<(String, Vec<String>)> {
        let mut st = ok(self.c.prepare_cached(
            "SELECT emoji, user_id FROM patch_note_reactions WHERE note_id = ? ORDER BY created_at, rowid",
        ));
        let rows: Vec<(String, String)> =
            ok(ok(st.query_map([note_id], |r| Ok((r.get(0)?, r.get(1)?)))).collect());
        let mut out: Vec<(String, Vec<String>)> = Vec::new();
        for (emoji, user) in rows {
            match out.iter_mut().find(|(e, _)| *e == emoji) {
                Some((_, users)) => users.push(user),
                None => out.push((emoji, vec![user])),
            }
        }
        out
    }

    pub fn patch_react(&self, note_id: &str, user_id: &str, emoji: &str) {
        ok(self.c.execute(
            "INSERT OR IGNORE INTO patch_note_reactions (note_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)",
            params![note_id, user_id, emoji, now_iso()],
        ));
    }

    pub fn patch_unreact(&self, note_id: &str, user_id: &str, emoji: &str) {
        ok(self.c.execute(
            "DELETE FROM patch_note_reactions WHERE note_id = ? AND user_id = ? AND emoji = ?",
            params![note_id, user_id, emoji],
        ));
    }

    /// Quantos emojis diferentes a nota já tem.
    pub fn patch_reaction_kinds(&self, note_id: &str) -> i64 {
        ok(self.c.query_row(
            "SELECT COUNT(DISTINCT emoji) FROM patch_note_reactions WHERE note_id = ?",
            [note_id],
            |r| r.get(0),
        ))
    }

    /// Comentários da nota, do mais antigo para o mais novo.
    pub fn patch_comments(&self, note_id: &str) -> Vec<PatchCommentRow> {
        let mut st = ok(self.c.prepare_cached(
            "SELECT id, user_id, content, created_at FROM patch_note_comments WHERE note_id = ? ORDER BY id",
        ));
        ok(ok(st.query_map([note_id], |r| {
            Ok(PatchCommentRow {
                id: r.get(0)?,
                user_id: r.get(1)?,
                content: r.get(2)?,
                created_at: r.get(3)?,
            })
        }))
        .collect())
    }

    /// Comentários que a pessoa fez desde `since` (ISO), para segurar quem comenta sem parar.
    pub fn patch_comments_since(&self, user_id: &str, since: &str) -> i64 {
        ok(self.c.query_row(
            "SELECT COUNT(*) FROM patch_note_comments WHERE user_id = ? AND created_at >= ?",
            [user_id, since],
            |r| r.get(0),
        ))
    }

    pub fn patch_comment(&self, note_id: &str, user_id: &str, content: &str) -> PatchCommentRow {
        let row = PatchCommentRow {
            id: new_id(),
            user_id: user_id.to_string(),
            content: content.to_string(),
            created_at: now_iso(),
        };
        ok(self.c.execute(
            "INSERT INTO patch_note_comments (id, note_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
            params![row.id, note_id, row.user_id, row.content, row.created_at],
        ));
        row
    }

    /// Dono do comentário (None se não existe).
    pub fn patch_comment_author(&self, id: &str) -> Option<String> {
        use rusqlite::OptionalExtension;
        ok(self
            .c
            .query_row("SELECT user_id FROM patch_note_comments WHERE id = ?", [id], |r| r.get(0))
            .optional())
    }

    pub fn patch_delete_comment(&self, id: &str) {
        ok(self
            .c
            .execute("DELETE FROM patch_note_comments WHERE id = ?", [id]));
    }
}

//! Perfil completo: estilo do nome, jogos do perfil, conexões, notas e usuários ignorados.
use super::{Q, ok};
use crate::ids::now_iso;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

impl Q<'_> {
    /// `{ favorite, liked }` e `connections` da pessoa.
    pub fn profile_extras(&self, user_id: &str) -> (Value, Value) {
        let row: Option<(String, String)> = ok(self
            .c
            .query_row(
                "SELECT profile_games, connections FROM users WHERE id = ?",
                [user_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional());
        let (games, conns) = row.unwrap_or_default();
        (
            serde_json::from_str(&games).unwrap_or_else(|_| json!({})),
            serde_json::from_str(&conns).unwrap_or_else(|_| json!([])),
        )
    }

    pub fn set_profile_games(&self, user_id: &str, games: &Value) {
        ok(self.c.execute(
            "UPDATE users SET profile_games = ? WHERE id = ?",
            params![games.to_string(), user_id],
        ));
    }

    pub fn set_connections(&self, user_id: &str, conns: &Value) {
        ok(self.c.execute(
            "UPDATE users SET connections = ? WHERE id = ?",
            params![conns.to_string(), user_id],
        ));
    }

    pub fn set_name_style(&self, user_id: &str, style: Option<&Value>) {
        ok(self.c.execute(
            "UPDATE users SET name_style = ? WHERE id = ?",
            params![style.map(|s| s.to_string()), user_id],
        ));
    }

    /// Quando a pessoa entrou no Line.
    pub fn user_created_at(&self, user_id: &str) -> Option<String> {
        ok(self
            .c
            .query_row(
                "SELECT created_at FROM users WHERE id = ?",
                [user_id],
                |r| r.get(0),
            )
            .optional())
    }

    /// Desde quando são amigos (pedido aceito).
    pub fn friends_since(&self, a: &str, b: &str) -> Option<String> {
        ok(self
            .c
            .query_row(
                "SELECT created_at FROM friendships WHERE status = 'accepted' AND
                 ((requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1))",
                [a, b],
                |r| r.get(0),
            )
            .optional())
    }

    pub fn note(&self, owner: &str, target: &str) -> String {
        ok(self
            .c
            .query_row(
                "SELECT note FROM user_notes WHERE owner_id = ? AND target_id = ?",
                [owner, target],
                |r| r.get(0),
            )
            .optional())
        .unwrap_or_default()
    }

    pub fn set_note(&self, owner: &str, target: &str, note: &str) {
        if note.is_empty() {
            ok(self.c.execute(
                "DELETE FROM user_notes WHERE owner_id = ? AND target_id = ?",
                [owner, target],
            ));
        } else {
            ok(self.c.execute(
                "INSERT INTO user_notes (owner_id, target_id, note) VALUES (?1, ?2, ?3)
                 ON CONFLICT(owner_id, target_id) DO UPDATE SET note = ?3",
                [owner, target, note],
            ));
        }
    }

    pub fn ignored(&self, user_id: &str) -> Vec<String> {
        self.ids(
            "SELECT target_id FROM user_ignores WHERE user_id = ? ORDER BY created_at",
            [user_id],
        )
    }

    pub fn set_ignored(&self, user_id: &str, target: &str, on: bool) {
        if on {
            ok(self.c.execute(
                "INSERT OR IGNORE INTO user_ignores (user_id, target_id, created_at) VALUES (?, ?, ?)",
                params![user_id, target, now_iso()],
            ));
        } else {
            ok(self.c.execute(
                "DELETE FROM user_ignores WHERE user_id = ? AND target_id = ?",
                [user_id, target],
            ));
        }
    }

    /// Jogos (não escondidos) jogados nos últimos `days` dias, do mais recente ao mais antigo.
    pub fn recent_activity(&self, user_id: &str, days: i64) -> Vec<Value> {
        let since = (chrono::Utc::now() - chrono::Duration::days(days))
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let mut st = ok(self.c.prepare_cached(
            "SELECT g.name, g.icon, g.last_played, g.total_secs, c.cover
             FROM user_games g LEFT JOIN game_covers c ON c.name = lower(g.name)
             WHERE g.user_id = ? AND g.hidden = 0 AND g.last_played > ? ORDER BY g.last_played DESC LIMIT 20",
        ));
        ok(ok(st.query_map(params![user_id, since], |r| {
            Ok(json!({
                "name": r.get::<_, String>(0)?,
                "icon": r.get::<_, Option<String>>(1)?,
                "lastPlayed": r.get::<_, String>(2)?,
                "totalSecs": r.get::<_, i64>(3)?,
                "cover": r.get::<_, Option<String>>(4)?,
            }))
        }))
        .collect())
    }
}

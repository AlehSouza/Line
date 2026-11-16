//! Notificações: até onde cada pessoa leu cada canal (read states), contagem de menções não
//! lidas, caixa de entrada de menções e as configurações de notificação (JSON guardado como veio;
//! quem interpreta é o app, como no Discord).
use super::{Q, message_select, ok};
use crate::model::Message;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

/// Menções que entram na contagem: nunca passa disso por canal (o app mostra "99+").
const MAX_COUNT: i64 = 100;

impl Q<'_> {
    pub fn notify_settings(&self, user_id: &str) -> Option<Value> {
        let raw: Option<String> = ok(self
            .c
            .query_row(
                "SELECT notifications FROM user_settings WHERE user_id = ?",
                [user_id],
                |r| r.get(0),
            )
            .optional());
        raw.map(|s| serde_json::from_str(&s).unwrap_or_else(|_| json!({})))
    }

    pub fn set_notify_settings(&self, user_id: &str, v: &Value) {
        ok(self.c.execute(
            "INSERT INTO user_settings (user_id, notifications) VALUES (?1, ?2)
             ON CONFLICT(user_id) DO UPDATE SET notifications = ?2",
            params![user_id, v.to_string()],
        ));
    }

    /// Canais de texto (com threads) e DMs que a pessoa enxerga: (canal, servidor, canal pai).
    fn readable_channels(&self, user_id: &str) -> Vec<(String, Option<String>, Option<String>)> {
        let mut out = Vec::new();
        for sid in self.server_ids_of(user_id) {
            let rows: Vec<(String, Option<String>)> = {
                let mut st = ok(self.c.prepare_cached(
                    "SELECT id, parent_id FROM channels WHERE type != 'voice'
                       AND (server_id = ?1 OR parent_id IN (SELECT id FROM channels WHERE server_id = ?1))",
                ));
                ok(ok(st.query_map([sid.as_str()], |r| Ok((r.get(0)?, r.get(1)?)))).collect())
            };
            for (id, parent) in rows {
                if self.can_access(user_id, &id) {
                    out.push((id, Some(sid.clone()), parent));
                }
            }
        }
        for id in self.ids(
            "SELECT channel_id FROM channel_recipients WHERE user_id = ?",
            [user_id],
        ) {
            out.push((id, None, None));
        }
        out
    }

    fn last_message_id(&self, channel_id: &str) -> Option<String> {
        ok(self.c.query_row(
            "SELECT MAX(id) FROM messages WHERE channel_id = ? AND deleted_at IS NULL",
            [channel_id],
            |r| r.get(0),
        ))
    }

    fn last_read_id(&self, user_id: &str, channel_id: &str) -> Option<String> {
        ok(self
            .c
            .query_row(
                "SELECT last_read_id FROM read_states WHERE user_id = ? AND channel_id = ?",
                [user_id, channel_id],
                |r| r.get(0),
            )
            .optional())
    }

    /// Marca o canal como lido até `message_id` (nunca volta para trás).
    pub fn ack(&self, user_id: &str, channel_id: &str, message_id: &str) {
        ok(self.c.execute(
            "INSERT INTO read_states (user_id, channel_id, last_read_id) VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = MAX(last_read_id, ?3)",
            params![user_id, channel_id, message_id],
        ));
    }

    /// Marca como lido até a última mensagem e devolve o id dela.
    pub fn ack_latest(&self, user_id: &str, channel_id: &str) -> Option<String> {
        let last = self.last_message_id(channel_id)?;
        self.ack(user_id, channel_id, &last);
        Some(last)
    }

    /// Na primeira vez (antes de existir read state) tudo o que já existe conta como lido.
    fn seed_read_states(
        &self,
        user_id: &str,
        channels: &[(String, Option<String>, Option<String>)],
    ) {
        let seeded = ok(self
            .c
            .query_row(
                "SELECT 1 FROM user_settings WHERE user_id = ?",
                [user_id],
                |_| Ok(()),
            )
            .optional())
        .is_some();
        if seeded {
            return;
        }
        for (id, _, _) in channels {
            self.ack_latest(user_id, id);
        }
        ok(self.c.execute(
            "INSERT OR IGNORE INTO user_settings (user_id, notifications) VALUES (?, '{}')",
            [user_id],
        ));
    }

    /// Para cada canal: última mensagem, até onde li e menções não lidas, separadas em
    /// diretas (@eu, ou qualquer mensagem de DM), @everyone/@here e cargos.
    pub fn read_states(&self, user_id: &str) -> Vec<Value> {
        let channels = self.readable_channels(user_id);
        self.seed_read_states(user_id, &channels);
        let username = self
            .user_row(user_id)
            .map(|u| u.username.to_lowercase())
            .unwrap_or_default();
        let needle = format!("@{username}");
        let my_roles = self.ids(
            "SELECT role_id FROM member_roles WHERE user_id = ?",
            [user_id],
        );
        let mut out = Vec::new();
        for (id, server_id, parent_id) in channels {
            let is_dm = server_id.is_none();
            let Some(last) = self.last_message_id(&id) else {
                continue;
            };
            let read = self.last_read_id(user_id, &id).unwrap_or_default();
            let (mut direct, mut everyone, mut roles) = (0i64, 0i64, 0i64);
            if last > read {
                let rows: Vec<(String, bool, String)> = {
                    let mut st = ok(self.c.prepare_cached(
                        "SELECT lower(content), mention_everyone, COALESCE(mention_roles, '') FROM messages
                         WHERE channel_id = ? AND id > ? AND author_id != ? AND deleted_at IS NULL
                         ORDER BY id DESC LIMIT 500",
                    ));
                    ok(ok(st.query_map(params![id, read, user_id], |r| {
                        Ok((r.get(0)?, r.get::<_, i64>(1)? != 0, r.get(2)?))
                    }))
                    .collect())
                };
                for (content, ev, mr) in rows {
                    if is_dm || content.contains(&needle) {
                        direct += 1;
                    } else if ev {
                        everyone += 1;
                    } else if mr.split(',').any(|r| my_roles.iter().any(|m| m == r)) {
                        roles += 1;
                    }
                }
            }
            out.push(json!({
                "channelId": id,
                "serverId": server_id,
                "parentId": parent_id,
                "lastMessageId": last,
                "lastReadId": read,
                "mentions": direct.min(MAX_COUNT),
                "everyoneMentions": everyone.min(MAX_COUNT),
                "roleMentions": roles.min(MAX_COUNT),
            }));
        }
        out
    }

    /// Mensagens recentes que me mencionam (caixa de entrada). `server` filtra um servidor.
    pub fn recent_mentions(
        &self,
        user_id: &str,
        server: Option<&str>,
        everyone: bool,
        roles: bool,
        before: Option<&str>,
    ) -> Vec<Message> {
        let username = self
            .user_row(user_id)
            .map(|u| u.username.to_lowercase())
            .unwrap_or_default();
        let servers: Vec<String> = match server {
            Some(s) => vec![s.to_string()],
            None => self.server_ids_of(user_id),
        };
        if servers.is_empty() {
            return vec![];
        }
        let my_roles = if roles {
            self.ids(
                "SELECT role_id FROM member_roles WHERE user_id = ?",
                [user_id],
            )
        } else {
            vec![]
        };
        let marks = vec!["?"; servers.len()].join(",");
        let mut sql = format!(
            "{} WHERE m.deleted_at IS NULL AND m.author_id != ? AND m.channel_id IN (
               SELECT id FROM channels WHERE server_id IN ({marks})
               OR parent_id IN (SELECT id FROM channels WHERE server_id IN ({marks})))
             AND (lower(m.content) LIKE ? ESCAPE '\\'",
            message_select()
        );
        let mut args: Vec<String> = vec![user_id.to_string()];
        args.extend(servers.iter().cloned());
        args.extend(servers.iter().cloned());
        args.push(format!(
            "%@{}%",
            username
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        ));
        if everyone {
            sql.push_str(" OR m.mention_everyone = 1");
        }
        for r in my_roles.iter().take(200) {
            sql.push_str(" OR instr(',' || m.mention_roles || ',', ?) > 0");
            args.push(format!(",{r},"));
        }
        sql.push(')');
        if let Some(b) = before {
            sql.push_str(" AND m.id < ?");
            args.push(b.to_string());
        }
        sql.push_str(" ORDER BY m.id DESC LIMIT 100");
        let mut out = Vec::new();
        for m in self.message_rows(&sql, rusqlite::params_from_iter(args)) {
            if self.can_access(user_id, &m.channel_id) {
                out.push(m);
                if out.len() >= 25 {
                    break;
                }
            }
        }
        out
    }
}

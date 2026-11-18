//! SQL do painel administrador e das denúncias / bug reports.
use super::{Q, ok};
use crate::ids::{new_id, now_iso};
use rusqlite::types::{Value as Sql, ValueRef};
use rusqlite::{OptionalExtension, params, params_from_iter};
use serde_json::{Map, Value, json};

/// Suspensão "para sempre".
pub const BAN_FOREVER: &str = "9999-12-31T00:00:00.000Z";

/// Dia no horário de Brasília (UTC-3) de uma coluna ISO.
const DAY_BR: &str = "substr(datetime(created_at, '-3 hours'), 1, 10)";

/// Nova denúncia ou bug report.
pub struct NewReport<'a> {
    pub kind: &'a str,
    pub reporter_id: &'a str,
    pub target_user_id: Option<&'a str>,
    pub message_id: Option<&'a str>,
    pub channel_id: Option<&'a str>,
    pub server_id: Option<&'a str>,
    pub message_content: Option<&'a str>,
    pub reason: &'a str,
    pub details: &'a str,
    pub platform: &'a str,
    pub version: &'a str,
    /// Prints enviados junto (anexos ainda sem mensagem, da própria pessoa).
    pub images: &'a [String],
}

fn cell(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        ValueRef::Blob(_) => Value::Null,
    }
}

/// `snake_case` → `camelCase` (nomes das colunas viram as chaves do JSON).
fn camel(name: &str) -> String {
    let mut out = String::new();
    let mut up = false;
    for c in name.chars() {
        if c == '_' {
            up = true;
        } else if up {
            out.extend(c.to_uppercase());
            up = false;
        } else {
            out.push(c);
        }
    }
    out
}

impl Q<'_> {
    /// Roda um SELECT e devolve cada linha como objeto JSON (colunas em camelCase).
    fn rows(&self, sql: &str, p: Vec<Sql>) -> Vec<Value> {
        let mut st = ok(self.c.prepare(sql));
        let names: Vec<String> = st.column_names().map(camel).collect();
        let mut rows = ok(st.query(params_from_iter(p)));
        let mut out = Vec::new();
        while let Some(r) = ok(rows.next()) {
            let mut obj = Map::new();
            for (i, n) in names.iter().enumerate() {
                obj.insert(n.clone(), cell(ok(r.get_ref(i))));
            }
            out.push(Value::Object(obj));
        }
        drop(rows);
        drop(st);
        // Foto de perfil / ícone do servidor viram URL (o painel junta com o domínio principal).
        for row in &mut out {
            for (id_key, url_key) in [("avatarId", "avatarUrl"), ("iconId", "iconUrl")] {
                if let Some(id) = row.get(id_key).and_then(|v| v.as_str()).map(String::from) {
                    let url = self.profile_image_url(&id);
                    row[url_key] = if url.is_empty() {
                        Value::Null
                    } else {
                        json!(url)
                    };
                }
            }
        }
        out
    }

    fn count(&self, sql: &str, p: Vec<Sql>) -> i64 {
        ok(self.c.query_row(sql, params_from_iter(p), |r| r.get(0)))
    }

    /// (data, quantidade) dos últimos `days` dias, sem buracos.
    fn per_day(&self, table_sql: &str, days: i64) -> Vec<Value> {
        let since = (chrono::Utc::now() - chrono::Duration::days(days + 1))
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let sql = format!(
            "SELECT {DAY_BR} AS d, COUNT(*) FROM ({table_sql}) WHERE created_at >= ? GROUP BY d"
        );
        let mut st = ok(self.c.prepare(&sql));
        let got: std::collections::HashMap<String, i64> = ok(ok(st.query_map([since], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        }))
        .collect());
        let today = (chrono::Utc::now() - chrono::Duration::hours(3)).date_naive();
        (0..days)
            .rev()
            .map(|i| {
                let d = (today - chrono::Duration::days(i))
                    .format("%Y-%m-%d")
                    .to_string();
                json!({ "date": d, "count": got.get(&d).copied().unwrap_or(0) })
            })
            .collect()
    }

    // ---------- admins ----------

    pub fn admin_flag(&self, id: &str) -> bool {
        ok(self
            .c
            .query_row(
                "SELECT is_admin FROM users WHERE id = ? AND bot_server_id IS NULL",
                [id],
                |r| r.get::<_, i64>(0),
            )
            .optional())
            == Some(1)
    }

    pub fn set_admin_flag(&self, id: &str, on: bool) -> bool {
        ok(self.c.execute(
            "UPDATE users SET is_admin = ? WHERE id = ? AND bot_server_id IS NULL",
            params![on as i64, id],
        )) == 1
    }

    /// Admins adicionados pelo painel e os donos (ADMIN_USERS).
    pub fn admin_accounts(&self, owners: &[String]) -> Vec<Value> {
        let mut p: Vec<Sql> = owners.iter().map(|o| Sql::Text(o.clone())).collect();
        let marks = vec!["?"; owners.len().max(1)].join(",");
        if owners.is_empty() {
            p.push(Sql::Text(String::new()));
        }
        self.rows(
            &format!(
                "SELECT id, username, display_name, avatar_color, avatar_id, created_at, (id IN ({marks})) AS owner
                 FROM users WHERE is_admin = 1 OR id IN ({marks}) ORDER BY owner DESC, username"
            ),
            [p.clone(), p].concat(),
        )
    }

    // ---------- suspensão ----------

    /// Quando os tokens passam a valer e até quando a conta está suspensa (se estiver).
    pub fn session_gate(&self, id: &str) -> Option<(u64, Option<String>)> {
        ok(self
            .c
            .query_row(
                "SELECT sessions_after, banned_until FROM users WHERE id = ?",
                [id],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?.max(0) as u64,
                        r.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional())
        .map(|(after, until)| (after, until.filter(|u| u.as_str() > now_iso().as_str())))
    }

    /// Suspensão em vigor: (até quando, motivo).
    pub fn ban_of(&self, id: &str) -> Option<(String, String)> {
        let (until, reason): (Option<String>, Option<String>) = ok(self
            .c
            .query_row(
                "SELECT banned_until, ban_reason FROM users WHERE id = ?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional())?;
        until
            .filter(|u| u.as_str() > now_iso().as_str())
            .map(|u| (u, reason.unwrap_or_default()))
    }

    pub fn set_ban(&self, id: &str, until: Option<&str>, reason: &str) {
        ok(self.c.execute(
            "UPDATE users SET banned_until = ?, ban_reason = ? WHERE id = ?",
            params![until, until.map(|_| reason), id],
        ));
    }

    // ---------- denúncias ----------

    pub fn create_report(&self, r: NewReport) -> String {
        let id = new_id();
        ok(self.c.execute(
            "INSERT INTO reports (id, kind, reporter_id, target_user_id, message_id, channel_id, server_id, message_content,
               reason, details, platform, version, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                id, r.kind, r.reporter_id, r.target_user_id, r.message_id, r.channel_id, r.server_id, r.message_content,
                r.reason, r.details, r.platform, r.version, now_iso()
            ],
        ));
        for img in r.images {
            ok(self.c.execute(
                "INSERT OR IGNORE INTO report_attachments (report_id, attachment_id)
                 SELECT ?, id FROM attachments WHERE id = ? AND uploader_id = ? AND message_id IS NULL AND content_type LIKE 'image/%'",
                params![id, img, r.reporter_id],
            ));
        }
        id
    }

    /// Cópia completa da mensagem denunciada (JSON) e os anexos copiados como prova.
    pub fn set_report_evidence(&self, report_id: &str, snapshot: &str, attachment_ids: &[String]) {
        ok(self.c.execute(
            "UPDATE reports SET message_snapshot = ? WHERE id = ?",
            params![snapshot, report_id],
        ));
        for a in attachment_ids {
            ok(self.c.execute(
                "INSERT OR IGNORE INTO report_attachments (report_id, attachment_id) VALUES (?, ?)",
                params![report_id, a],
            ));
        }
    }

    /// Imagens anexadas a uma denúncia/bug report (URL pública do anexo).
    fn report_images(&self, report_id: &str) -> Vec<Value> {
        let mut st = ok(self.c.prepare_cached(
            "SELECT a.id, a.filename, a.content_type FROM report_attachments ra JOIN attachments a ON a.id = ra.attachment_id
             WHERE ra.report_id = ? ORDER BY a.created_at",
        ));
        ok(ok(st.query_map([report_id], |r| {
            let (id, name, ctype): (String, String, String) = (r.get(0)?, r.get(1)?, r.get(2)?);
            Ok(json!({ "id": id, "filename": name, "contentType": ctype, "url": format!("/api/attachments/{id}/{}", super::url_segment(&name)) }))
        }))
        .collect())
    }

    pub fn admin_reports(
        &self,
        kind: Option<&str>,
        status: Option<&str>,
        offset: i64,
    ) -> Vec<Value> {
        let mut sql = String::from(
            "SELECT r.*, ru.username AS reporter_username, ru.display_name AS reporter_name,
                    tu.username AS target_username, tu.display_name AS target_name, tu.banned_until AS target_banned_until,
                    s.name AS server_name, c.name AS channel_name, c.type AS channel_type,
                    (SELECT 1 FROM messages m WHERE m.id = r.message_id) AS message_exists
             FROM reports r
             LEFT JOIN users ru ON ru.id = r.reporter_id
             LEFT JOIN users tu ON tu.id = r.target_user_id
             LEFT JOIN servers s ON s.id = r.server_id
             LEFT JOIN channels c ON c.id = r.channel_id
             WHERE 1 = 1",
        );
        let mut p: Vec<Sql> = vec![];
        match kind {
            Some("reports") => sql.push_str(" AND r.kind IN ('user', 'message', 'nsfw')"),
            Some("feedback") => sql.push_str(" AND r.kind IN ('bug', 'idea')"),
            Some(k) if !k.is_empty() => {
                sql.push_str(" AND r.kind = ?");
                p.push(Sql::Text(k.into()));
            }
            _ => {}
        }
        if let Some(s) = status.filter(|s| !s.is_empty()) {
            sql.push_str(" AND r.status = ?");
            p.push(Sql::Text(s.into()));
        }
        // Abertas primeiro; entre elas, +18 com mais denúncias (e com o detector concordando) sobe.
        sql.push_str(
            " ORDER BY (r.status = 'open') DESC,
               CASE WHEN r.kind = 'nsfw' THEN r.report_count + 2 * r.detected_count ELSE 0 END DESC,
               r.created_at DESC LIMIT 50 OFFSET ?",
        );
        p.push(Sql::Integer(offset.max(0)));
        let mut list = self.rows(&sql, p);
        for r in &mut list {
            let id = r["id"].as_str().unwrap_or_default().to_string();
            r["images"] = json!(self.report_images(&id));
        }
        list
    }

    pub fn update_report(
        &self,
        id: &str,
        status: &str,
        note: Option<&str>,
        admin_id: &str,
    ) -> bool {
        let resolved = (status != "open").then(now_iso);
        ok(self.c.execute(
            "UPDATE reports SET status = ?, note = COALESCE(?, note), resolved_at = ?, resolved_by = ? WHERE id = ?",
            params![status, note, resolved, resolved.as_ref().map(|_| admin_id), id],
        )) == 1
    }

    // ---------- denúncias de anexo +18 ----------

    /// Mensagem a que o anexo pertence (None = anexo solto ou inexistente).
    pub fn attachment_message_id(&self, attachment_id: &str) -> Option<String> {
        ok(self
            .c
            .query_row(
                "SELECT message_id FROM attachments WHERE id = ?",
                [attachment_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional())
        .flatten()
    }

    /// Registra quem denunciou o anexo (false = essa pessoa já tinha denunciado).
    pub fn add_nsfw_reporter(&self, attachment_id: &str, reporter_id: &str, detected: bool) -> bool {
        ok(self.c.execute(
            "INSERT OR IGNORE INTO nsfw_reporters (attachment_id, reporter_id, detected, created_at) VALUES (?, ?, ?, ?)",
            params![attachment_id, reporter_id, detected as i64, now_iso()],
        )) == 1
    }

    /// Denúncia +18 ainda aberta desse anexo.
    pub fn open_nsfw_report(&self, attachment_id: &str) -> Option<String> {
        ok(self
            .c
            .query_row(
                "SELECT id FROM reports WHERE kind = 'nsfw' AND attachment_id = ? AND status = 'open' ORDER BY created_at LIMIT 1",
                [attachment_id],
                |r| r.get(0),
            )
            .optional())
    }

    /// Mais uma pessoa denunciou: sobe a contagem (e a do detector, se ele concordou).
    pub fn bump_nsfw_report(&self, report_id: &str, detected: bool) {
        ok(self.c.execute(
            "UPDATE reports SET report_count = report_count + 1, detected_count = detected_count + ? WHERE id = ?",
            params![detected as i64, report_id],
        ));
    }

    pub fn set_report_attachment(&self, report_id: &str, attachment_id: &str, detected: bool) {
        ok(self.c.execute(
            "UPDATE reports SET attachment_id = ?, detected_count = ? WHERE id = ?",
            params![attachment_id, detected as i64, report_id],
        ));
    }

    /// (denúncias, quantas o detector confirmou) de um anexo, contando todas as pessoas.
    pub fn nsfw_report_counts(&self, attachment_id: &str) -> (i64, i64) {
        ok(self.c.query_row(
            "SELECT COUNT(*), COALESCE(SUM(detected), 0) FROM nsfw_reporters WHERE attachment_id = ?",
            [attachment_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ))
    }

    /// Marca +18 por causa das denúncias (até o admin decidir). true = mudou.
    pub fn mark_nsfw_by_report(&self, attachment_id: &str) -> bool {
        ok(self.c.execute(
            "UPDATE attachments SET nsfw = 1, nsfw_by_report = 1 WHERE id = ? AND nsfw = 0",
            [attachment_id],
        )) == 1
    }

    /// Decisão do admin: é +18 (fixa, ninguém tira) ou não é (tira o +18 que veio de denúncia;
    /// o que quem enviou marcou continua). Fecha as denúncias +18 abertas do anexo.
    pub fn admin_set_nsfw(&self, attachment_id: &str, is_nsfw: bool, admin_id: &str) -> bool {
        let changed = if is_nsfw {
            ok(self.c.execute(
                "UPDATE attachments SET nsfw = 1, nsfw_locked = 1, nsfw_by_report = 0 WHERE id = ?",
                [attachment_id],
            ))
        } else {
            ok(self.c.execute(
                "UPDATE attachments SET nsfw = CASE WHEN nsfw_by_report = 1 THEN 0 ELSE nsfw END,
                   nsfw_locked = 0, nsfw_by_report = 0 WHERE id = ?",
                [attachment_id],
            ))
        } == 1;
        let now = now_iso();
        ok(self.c.execute(
            "UPDATE reports SET status = ?, resolved_at = ?, resolved_by = ?,
               note = CASE WHEN note = '' THEN ? ELSE note END
             WHERE kind = 'nsfw' AND attachment_id = ? AND status = 'open'",
            params![
                if is_nsfw { "resolved" } else { "dismissed" },
                now,
                admin_id,
                if is_nsfw { "Confirmado como +18" } else { "Não é +18" },
                attachment_id
            ],
        ));
        changed
    }

    pub fn reports_today(&self, reporter_id: &str) -> i64 {
        let since = (chrono::Utc::now() - chrono::Duration::hours(24))
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        self.count(
            "SELECT COUNT(*) FROM reports WHERE reporter_id = ? AND created_at > ?",
            vec![Sql::Text(reporter_id.into()), Sql::Text(since)],
        )
    }

    // ---------- uso ----------

    /// Registra um uso (ex.: "voice_join", "music_play") para os gráficos do painel.
    pub fn log_activity(&self, kind: &str, user_id: &str, server_id: Option<&str>) {
        ok(self.c.execute(
            "INSERT INTO activity (kind, user_id, server_id, created_at) VALUES (?, ?, ?, ?)",
            params![kind, user_id, server_id, now_iso()],
        ));
    }

    pub fn log_admin(&self, admin_id: &str, action: &str, target: &str, detail: &str) {
        ok(self.c.execute(
            "INSERT INTO admin_log (id, admin_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            params![new_id(), admin_id, action, target, detail, now_iso()],
        ));
    }

    pub fn admin_log(&self, offset: i64) -> Vec<Value> {
        self.rows(
            "SELECT l.*, u.username AS admin_username FROM admin_log l LEFT JOIN users u ON u.id = l.admin_id
             ORDER BY l.created_at DESC LIMIT 100 OFFSET ?",
            vec![Sql::Integer(offset.max(0))],
        )
    }

    // ---------- estatísticas ----------

    pub fn admin_stats(&self) -> Value {
        let ago = |h: i64| {
            (chrono::Utc::now() - chrono::Duration::hours(h))
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string()
        };
        let since = |sql: &str, h: i64| self.count(sql, vec![Sql::Text(ago(h))]);
        let people = "SELECT created_at FROM users WHERE bot_server_id IS NULL";
        let msgs = "SELECT m.created_at FROM messages m JOIN users u ON u.id = m.author_id WHERE u.bot_server_id IS NULL";
        json!({
            "users": {
                "total": self.count("SELECT COUNT(*) FROM users WHERE bot_server_id IS NULL", vec![]),
                "today": since("SELECT COUNT(*) FROM users WHERE bot_server_id IS NULL AND created_at > ?", 24),
                "week": since("SELECT COUNT(*) FROM users WHERE bot_server_id IS NULL AND created_at > ?", 24 * 7),
                "month": since("SELECT COUNT(*) FROM users WHERE bot_server_id IS NULL AND created_at > ?", 24 * 30),
                "banned": self.count("SELECT COUNT(*) FROM users WHERE banned_until > ?", vec![Sql::Text(now_iso())]),
                "google": self.count("SELECT COUNT(*) FROM users WHERE google_id IS NOT NULL", vec![]),
                "activeWeek": since(
                    "SELECT COUNT(DISTINCT author_id) FROM messages m JOIN users u ON u.id = m.author_id
                     WHERE u.bot_server_id IS NULL AND m.created_at > ?",
                    24 * 7,
                ),
            },
            "servers": {
                "total": self.count("SELECT COUNT(*) FROM servers", vec![]),
                "public": self.count("SELECT COUNT(*) FROM servers WHERE is_public = 1", vec![]),
                "week": since("SELECT COUNT(*) FROM servers WHERE created_at > ?", 24 * 7),
            },
            "messages": {
                "total": self.count("SELECT COUNT(*) FROM messages", vec![]),
                "today": since("SELECT COUNT(*) FROM messages WHERE created_at > ?", 24),
                "dm": self.count(
                    "SELECT COUNT(*) FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.server_id IS NULL",
                    vec![],
                ),
            },
            "attachments": {
                "total": self.count("SELECT COUNT(*) FROM attachments", vec![]),
                "bytes": self.count("SELECT COALESCE(SUM(size), 0) FROM attachments", vec![]),
            },
            "calls": {
                "total": self.count("SELECT COUNT(*) FROM activity WHERE kind = 'voice_join'", vec![]),
                "today": since("SELECT COUNT(*) FROM activity WHERE kind = 'voice_join' AND created_at > ?", 24),
            },
            "music": {
                "total": self.count("SELECT COUNT(*) FROM activity WHERE kind = 'music_play'", vec![]),
                "today": since("SELECT COUNT(*) FROM activity WHERE kind = 'music_play' AND created_at > ?", 24),
                "servers": self.count("SELECT COUNT(DISTINCT server_id) FROM activity WHERE kind = 'music_play'", vec![]),
            },
            "reports": {
                "open": self.count("SELECT COUNT(*) FROM reports WHERE status = 'open' AND kind IN ('user', 'message', 'nsfw')", vec![]),
                "feedbackOpen": self.count("SELECT COUNT(*) FROM reports WHERE status = 'open' AND kind IN ('bug', 'idea')", vec![]),
                "total": self.count("SELECT COUNT(*) FROM reports", vec![]),
            },
            "series": {
                "signups": self.per_day(people, 30),
                "messages": self.per_day(msgs, 30),
                "calls": self.per_day("SELECT created_at FROM activity WHERE kind = 'voice_join'", 30),
                "music": self.per_day("SELECT created_at FROM activity WHERE kind = 'music_play'", 30),
                "reports": self.per_day("SELECT created_at FROM reports", 30),
            },
            "topServers": self.rows(
                "SELECT s.id, s.name, s.icon_id, (SELECT COUNT(*) FROM members m WHERE m.server_id = s.id) AS member_count,
                        (SELECT COUNT(*) FROM messages m JOIN channels c ON c.id = m.channel_id
                          WHERE c.server_id = s.id AND m.created_at > ?) AS messages_week
                 FROM servers s ORDER BY messages_week DESC, member_count DESC LIMIT 5",
                vec![Sql::Text(ago(24 * 7))],
            ),
            "recentUsers": self.rows(
                "SELECT id, username, display_name, avatar_color, avatar_id, created_at FROM users
                 WHERE bot_server_id IS NULL ORDER BY created_at DESC LIMIT 8",
                vec![],
            ),
        })
    }

    // ---------- usuários ----------

    pub fn admin_users(
        &self,
        query: &str,
        filter: &str,
        online: &[String],
        offset: i64,
    ) -> Vec<Value> {
        let mut sql = String::from(
            "SELECT u.id, u.username, u.display_name, u.email, u.email_verified, u.avatar_color, u.avatar_id,
                    u.created_at, u.banned_until, u.ban_reason, u.status, u.bot_server_id,
                    (u.google_id IS NOT NULL) AS google,
                    (SELECT COUNT(*) FROM members m WHERE m.user_id = u.id) AS server_count,
                    (SELECT COUNT(*) FROM messages m WHERE m.author_id = u.id) AS message_count,
                    (SELECT COUNT(*) FROM reports r WHERE r.target_user_id = u.id) AS report_count
             FROM users u WHERE 1 = 1",
        );
        let mut p: Vec<Sql> = vec![];
        let q = query.trim().to_lowercase();
        if !q.is_empty() {
            sql.push_str(" AND (lower(u.username) LIKE ? OR lower(u.display_name) LIKE ? OR lower(COALESCE(u.email, '')) LIKE ? OR u.id = ?)");
            let like = format!("%{}%", q.replace('%', ""));
            p.extend([
                Sql::Text(like.clone()),
                Sql::Text(like.clone()),
                Sql::Text(like),
                Sql::Text(query.trim().into()),
            ]);
        }
        match filter {
            "banned" => {
                sql.push_str(" AND u.banned_until > ?");
                p.push(Sql::Text(now_iso()));
            }
            "bots" => sql.push_str(" AND u.bot_server_id IS NOT NULL"),
            "online" => {
                if online.is_empty() {
                    return vec![];
                }
                sql.push_str(&format!(
                    " AND u.id IN ({})",
                    vec!["?"; online.len()].join(",")
                ));
                p.extend(online.iter().map(|id| Sql::Text(id.clone())));
            }
            _ => sql.push_str(" AND u.bot_server_id IS NULL"),
        }
        sql.push_str(" ORDER BY u.created_at DESC LIMIT 50 OFFSET ?");
        p.push(Sql::Integer(offset.max(0)));
        self.rows(&sql, p)
    }

    pub fn admin_user(&self, id: &str) -> Option<Value> {
        let mut user = self
            .rows(
                "SELECT u.id, u.username, u.display_name, u.email, u.email_verified, u.avatar_color, u.avatar_id, u.bio,
                        u.pronouns, u.custom_status, u.status, u.created_at, u.banned_until, u.ban_reason, u.bot_server_id,
                        (u.google_id IS NOT NULL) AS google, (u.password_hash NOT IN ('google', 'deleted')) AS has_password,
                        (SELECT COUNT(*) FROM messages m WHERE m.author_id = u.id) AS message_count,
                        (SELECT COUNT(*) FROM attachments a WHERE a.uploader_id = u.id) AS attachment_count,
                        (SELECT COALESCE(SUM(size), 0) FROM attachments a WHERE a.uploader_id = u.id) AS attachment_bytes,
                        (SELECT COUNT(*) FROM friendships f WHERE (f.requester_id = u.id OR f.addressee_id = u.id) AND f.status = 'accepted') AS friend_count,
                        (SELECT MAX(created_at) FROM messages m WHERE m.author_id = u.id) AS last_message_at
                 FROM users u WHERE u.id = ?",
                vec![Sql::Text(id.into())],
            )
            .into_iter()
            .next()?;
        let servers = self.rows(
            "SELECT s.id, s.name, s.owner_id, m.joined_at, (SELECT COUNT(*) FROM members x WHERE x.server_id = s.id) AS member_count
             FROM members m JOIN servers s ON s.id = m.server_id WHERE m.user_id = ? ORDER BY m.joined_at",
            vec![Sql::Text(id.into())],
        );
        // Só mensagens de servidores: conversas privadas (DMs) ficam de fora do painel.
        let messages = self.rows(
            "SELECT m.id, m.content, m.created_at, c.id AS channel_id, c.name AS channel_name, s.id AS server_id, s.name AS server_name
             FROM messages m JOIN channels c ON c.id = m.channel_id JOIN servers s ON s.id = c.server_id
             WHERE m.author_id = ? ORDER BY m.created_at DESC LIMIT 25",
            vec![Sql::Text(id.into())],
        );
        let reports = self.rows(
            "SELECT r.id, r.kind, r.reason, r.details, r.status, r.created_at, r.message_content, ru.username AS reporter_username
             FROM reports r LEFT JOIN users ru ON ru.id = r.reporter_id WHERE r.target_user_id = ? ORDER BY r.created_at DESC LIMIT 500",
            vec![Sql::Text(id.into())],
        );
        let obj = user.as_object_mut()?;
        obj.insert("servers".into(), json!(servers));
        obj.insert("recentMessages".into(), json!(messages));
        obj.insert("reports".into(), json!(reports));
        Some(user)
    }

    /// Mensagens do usuário (id, canal) para apagar e avisar os canais.
    pub fn message_ids_by_author(&self, user_id: &str) -> Vec<(String, String)> {
        let mut st = ok(self
            .c
            .prepare("SELECT id, channel_id FROM messages WHERE author_id = ?"));
        ok(ok(st.query_map([user_id], |r| Ok((r.get(0)?, r.get(1)?)))).collect())
    }

    pub fn delete_messages_by_author(&self, user_id: &str) -> usize {
        ok(self
            .c
            .execute("DELETE FROM messages WHERE author_id = ?", [user_id]))
    }

    /// "Apagar conta" pelo admin: tira os dados pessoais, troca o nome e suspende para sempre.
    /// A linha continua existindo porque mensagens e servidores apontam para ela.
    /// Desativa (Some) ou reativa (None) a conta. Desativada: sai de todas as sessões e volta ao logar.
    pub fn set_deactivated(&self, id: &str, deactivated: bool) {
        let at = deactivated.then(now_iso);
        ok(self.c.execute(
            "UPDATE users SET deactivated_at = ? WHERE id = ?",
            params![at, id],
        ));
    }

    pub fn anonymize_user(&self, id: &str) {
        let short: String = id.chars().rev().take(8).collect();
        ok(self.c.execute(
            "UPDATE users SET username = ?, display_name = 'Conta apagada', password_hash = 'deleted', email = NULL,
               email_verified = 0, google_id = NULL, avatar_id = NULL, banner_id = NULL, bio = '', pronouns = '',
               thought = NULL, custom_status = NULL, tag_server_id = NULL, banned_until = ?, ban_reason = 'Conta apagada'
             WHERE id = ?",
            params![format!("apagado_{short}"), BAN_FOREVER, id],
        ));
        ok(self.c.execute(
            "DELETE FROM friendships WHERE requester_id = ?1 OR addressee_id = ?1",
            [id],
        ));
    }

    // ---------- servidores ----------

    pub fn admin_servers(&self, query: &str, offset: i64) -> Vec<Value> {
        let mut sql = String::from(
            "SELECT s.id, s.name, s.description, s.icon_color, s.icon_id, s.is_public, s.created_at, s.owner_id, s.tag, s.suspended_at,
                    u.username AS owner_username, u.display_name AS owner_name,
                    (SELECT COUNT(*) FROM members m WHERE m.server_id = s.id) AS member_count,
                    (SELECT COUNT(*) FROM channels c WHERE c.server_id = s.id AND c.type <> 'thread') AS channel_count,
                    (SELECT COUNT(*) FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.server_id = s.id) AS message_count
             FROM servers s LEFT JOIN users u ON u.id = s.owner_id WHERE 1 = 1",
        );
        let mut p: Vec<Sql> = vec![];
        let q = query.trim().to_lowercase();
        if !q.is_empty() {
            sql.push_str(" AND (lower(s.name) LIKE ? OR s.id = ? OR lower(u.username) LIKE ?)");
            let like = format!("%{}%", q.replace('%', ""));
            p.extend([
                Sql::Text(like.clone()),
                Sql::Text(query.trim().into()),
                Sql::Text(like),
            ]);
        }
        sql.push_str(" ORDER BY s.created_at DESC LIMIT 50 OFFSET ?");
        p.push(Sql::Integer(offset.max(0)));
        self.rows(&sql, p)
    }

    pub fn admin_server(&self, id: &str) -> Option<Value> {
        let mut server = self
            .admin_servers(id, 0)
            .into_iter()
            .find(|s| s["id"] == id)?;
        let members = self.rows(
            "SELECT u.id, u.username, u.display_name, u.avatar_color, u.avatar_id, u.banned_until, m.joined_at
             FROM members m JOIN users u ON u.id = m.user_id WHERE m.server_id = ? ORDER BY m.joined_at LIMIT 200",
            vec![Sql::Text(id.into())],
        );
        let channels = self.rows(
            "SELECT c.id, c.name, c.type, c.is_private,
                    (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id) AS message_count
             FROM channels c WHERE c.server_id = ? AND c.type <> 'thread' ORDER BY c.position",
            vec![Sql::Text(id.into())],
        );
        let obj = server.as_object_mut()?;
        obj.insert("members".into(), json!(members));
        obj.insert("channels".into(), json!(channels));
        Some(server)
    }
}

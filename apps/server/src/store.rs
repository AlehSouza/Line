//! Camada de acesso a dados. Todo SQL do app mora aqui.
//!
//! O banco fica atrás de um `Mutex`: cada requisição pega a conexão (`store.q()`),
//! faz o que precisa e solta. Para uso pessoal isso é mais que suficiente e evita
//! qualquer problema de concorrência no SQLite.
use crate::ids::{new_id, new_invite_code, now_iso, random_color};
use crate::model::*;
use crate::presence::PresenceTracker;
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};
use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard};

pub struct Store {
    conn: Mutex<Connection>,
    pub presence: Mutex<PresenceTracker>,
}

impl Store {
    pub fn new(conn: Connection) -> Self {
        Self {
            conn: Mutex::new(conn),
            presence: Mutex::new(PresenceTracker::default()),
        }
    }

    /// Pega a conexão. Não segure o retorno durante um `.await`.
    pub fn q(&self) -> Q<'_> {
        Q {
            c: lock(&self.conn),
            presence: &self.presence,
        }
    }
}

pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Erro de SQL aqui é bug (o esquema é nosso); vira 500 no handler.
fn ok<T>(r: rusqlite::Result<T>) -> T {
    r.unwrap_or_else(|e| panic!("erro no banco: {e}"))
}

pub struct UserRow {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub password_hash: String,
    pub avatar_color: String,
    pub bio: String,
    pub custom_status: Option<String>,
    pub status: String,
    pub created_at: String,
    /// Só vem nas consultas da própria tabela users (as junções não trazem).
    pub email: Option<String>,
}

impl UserRow {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get("id")?,
            username: r.get("username")?,
            display_name: r.get("display_name")?,
            password_hash: r.get("password_hash")?,
            avatar_color: r.get("avatar_color")?,
            bio: r.get("bio")?,
            custom_status: r.get("custom_status")?,
            status: r.get("status")?,
            created_at: r.get("created_at")?,
            email: r.get::<_, Option<String>>("email").unwrap_or(None),
        })
    }
}

const USER_COLS: &str = "u.id, u.username, u.display_name, u.password_hash, u.avatar_color, u.bio, u.custom_status, u.status, u.created_at";
const SERVER_SELECT: &str = "SELECT s.*, (SELECT COUNT(*) FROM members m WHERE m.server_id = s.id) AS member_count FROM servers s";

fn message_select() -> String {
    format!(
        "SELECT {USER_COLS}, m.id AS m_id, m.channel_id, m.author_id, m.content, m.created_at AS m_created_at, m.edited_at
         FROM messages m JOIN users u ON u.id = m.author_id"
    )
}

fn server_from_row(r: &Row) -> rusqlite::Result<Server> {
    Ok(Server {
        id: r.get("id")?,
        name: r.get("name")?,
        description: r.get("description")?,
        icon_color: r.get("icon_color")?,
        owner_id: r.get("owner_id")?,
        is_public: r.get::<_, i64>("is_public")? != 0,
        invite_code: r.get("invite_code")?,
        member_count: r.get("member_count")?,
        created_at: r.get("created_at")?,
    })
}

fn category_from_row(r: &Row) -> rusqlite::Result<Category> {
    Ok(Category {
        id: r.get("id")?,
        server_id: r.get("server_id")?,
        name: r.get("name")?,
        position: r.get("position")?,
    })
}

struct ChannelRow {
    id: String,
    kind: String,
    server_id: Option<String>,
    category_id: Option<String>,
    name: String,
    topic: String,
    position: i64,
    owner_id: Option<String>,
    last_message_at: Option<String>,
    parent_id: Option<String>,
    thread_message_id: Option<String>,
}

fn channel_row(r: &Row) -> rusqlite::Result<ChannelRow> {
    Ok(ChannelRow {
        id: r.get("id")?,
        kind: r.get("type")?,
        server_id: r.get("server_id")?,
        category_id: r.get("category_id")?,
        name: r.get("name")?,
        topic: r.get("topic")?,
        position: r.get("position")?,
        owner_id: r.get("owner_id")?,
        last_message_at: r.get("last_message_at")?,
        parent_id: r.get("parent_id")?,
        thread_message_id: r.get("thread_message_id")?,
    })
}

fn attachment_from_row(r: &Row) -> rusqlite::Result<Attachment> {
    let id: String = r.get("id")?;
    let filename: String = r.get("filename")?;
    Ok(Attachment {
        url: format!("/api/attachments/{id}/{}", url_segment(&filename)),
        id,
        filename,
        content_type: r.get("content_type")?,
        size: r.get("size")?,
    })
}

/// Codifica o nome do arquivo para caber num caminho de URL.
fn url_segment(name: &str) -> String {
    name.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[derive(Default)]
pub struct ProfilePatch {
    pub display_name: Option<String>,
    pub bio: Option<String>,
    pub avatar_color: Option<String>,
    pub custom_status: Option<Option<String>>,
    pub status: Option<String>,
}

#[derive(Default)]
pub struct ServerPatch {
    pub name: Option<String>,
    pub description: Option<String>,
    pub is_public: Option<bool>,
    pub icon_color: Option<String>,
}

#[derive(Default)]
pub struct ChannelPatch {
    pub name: Option<String>,
    pub topic: Option<String>,
    pub category_id: Option<Option<String>>,
    pub position: Option<i64>,
}

pub enum FriendRequest {
    Created,
    Accepted,
    Exists,
}

pub struct Q<'a> {
    c: MutexGuard<'a, Connection>,
    presence: &'a Mutex<PresenceTracker>,
}

impl Q<'_> {
    fn ids(&self, sql: &str, p: impl rusqlite::Params) -> Vec<String> {
        let mut st = ok(self.c.prepare_cached(sql));
        ok(ok(st.query_map(p, |r| r.get::<_, String>(0))).collect())
    }

    fn tx<T>(&self, f: impl FnOnce() -> T) -> T {
        ok(self.c.execute_batch("BEGIN"));
        let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
        match out {
            Ok(v) => {
                ok(self.c.execute_batch("COMMIT"));
                v
            }
            Err(e) => {
                let _ = self.c.execute_batch("ROLLBACK");
                std::panic::resume_unwind(e)
            }
        }
    }

    // ---------- usuários ----------

    pub fn user_row(&self, id: &str) -> Option<UserRow> {
        ok(self
            .c
            .query_row("SELECT * FROM users WHERE id = ?", [id], UserRow::from_row)
            .optional())
    }

    pub fn user_by_username(&self, username: &str) -> Option<UserRow> {
        ok(self
            .c
            .query_row(
                "SELECT * FROM users WHERE username = ?",
                [username],
                UserRow::from_row,
            )
            .optional())
    }

    pub fn presence_of(&self, user_id: &str, status: &str) -> &'static str {
        lock(self.presence).resolve(user_id, status)
    }

    pub fn to_public_user(&self, row: &UserRow) -> PublicUser {
        let presence = self.presence_of(&row.id, &row.status);
        PublicUser {
            id: row.id.clone(),
            username: row.username.clone(),
            display_name: row.display_name.clone(),
            avatar_color: row.avatar_color.clone(),
            bio: row.bio.clone(),
            // Quem está invisível/offline não exibe status personalizado.
            custom_status: if presence == "offline" {
                None
            } else {
                row.custom_status.clone()
            },
            presence,
        }
    }

    pub fn to_self_user(&self, row: &UserRow) -> SelfUser {
        let mut public = self.to_public_user(row);
        public.custom_status = row.custom_status.clone();
        SelfUser {
            public,
            status: row.status.clone(),
            created_at: row.created_at.clone(),
            email: row.email.clone(),
        }
    }

    pub fn set_username(&self, id: &str, username: &str) {
        ok(self.c.execute("UPDATE users SET username = ? WHERE id = ?", params![username, id]));
    }

    pub fn set_email(&self, id: &str, email: Option<&str>) {
        ok(self.c.execute("UPDATE users SET email = ? WHERE id = ?", params![email, id]));
    }

    pub fn set_password_hash(&self, id: &str, hash: &str) {
        ok(self.c.execute("UPDATE users SET password_hash = ? WHERE id = ?", params![hash, id]));
    }

    pub fn public_user(&self, id: &str) -> Option<PublicUser> {
        self.user_row(id).map(|r| self.to_public_user(&r))
    }

    pub fn self_user(&self, id: &str) -> Option<SelfUser> {
        self.user_row(id).map(|r| self.to_self_user(&r))
    }

    pub fn user_status(&self, id: &str) -> String {
        self.user_row(id)
            .map(|r| r.status)
            .unwrap_or_else(|| "online".into())
    }

    pub fn email_in_use(&self, email: &str) -> bool {
        ok(self
            .c
            .query_row("SELECT 1 FROM users WHERE email = ?", [email], |_| Ok(()))
            .optional())
        .is_some()
    }

    pub fn create_user(&self, username: &str, email: Option<&str>, display_name: &str, password_hash: &str) -> SelfUser {
        let id = new_id();
        ok(self.c.execute(
            "INSERT INTO users (id, username, email, display_name, password_hash, avatar_color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![id, username, email, display_name, password_hash, random_color(), now_iso()],
        ));
        self.self_user(&id).unwrap()
    }

    pub fn update_user(&self, id: &str, patch: ProfilePatch) -> SelfUser {
        let mut sets = Vec::new();
        let mut values: Vec<Value> = Vec::new();
        let mut set = |col: &str, v: Value| {
            sets.push(format!("{col} = ?"));
            values.push(v);
        };
        if let Some(v) = patch.display_name {
            set("display_name", v.into());
        }
        if let Some(v) = patch.bio {
            set("bio", v.into());
        }
        if let Some(v) = patch.avatar_color {
            set("avatar_color", v.into());
        }
        if let Some(v) = patch.custom_status {
            set(
                "custom_status",
                v.filter(|s| !s.is_empty())
                    .map(Value::from)
                    .unwrap_or(Value::Null),
            );
        }
        if let Some(v) = patch.status {
            set("status", v.into());
        }
        if !sets.is_empty() {
            values.push(id.to_string().into());
            ok(self.c.execute(
                &format!("UPDATE users SET {} WHERE id = ?", sets.join(", ")),
                params_from_iter(values),
            ));
        }
        self.self_user(id).unwrap()
    }

    /// Todo mundo que deve ser avisado quando a presença/perfil deste usuário mudar:
    /// membros de servidores em comum, participantes de DMs e amigos/pedidos.
    pub fn audience_of(&self, user_id: &str) -> Vec<String> {
        self.ids(
            "SELECT m2.user_id AS id FROM members m1 JOIN members m2 ON m1.server_id = m2.server_id WHERE m1.user_id = ?1
             UNION
             SELECT r2.user_id FROM channel_recipients r1 JOIN channel_recipients r2 ON r1.channel_id = r2.channel_id WHERE r1.user_id = ?1
             UNION
             SELECT addressee_id FROM friendships WHERE requester_id = ?1
             UNION
             SELECT requester_id FROM friendships WHERE addressee_id = ?1",
            [user_id],
        )
        .into_iter()
        .filter(|id| id != user_id)
        .collect()
    }

    // ---------- servidores ----------

    pub fn server(&self, id: &str) -> Option<Server> {
        ok(self
            .c
            .query_row(
                &format!("{SERVER_SELECT} WHERE s.id = ?"),
                [id],
                server_from_row,
            )
            .optional())
    }

    pub fn server_by_invite(&self, code: &str) -> Option<Server> {
        ok(self
            .c
            .query_row(
                &format!("{SERVER_SELECT} WHERE s.invite_code = ?"),
                [code],
                server_from_row,
            )
            .optional())
    }

    pub fn servers_of(&self, user_id: &str) -> Vec<Server> {
        let mut st = ok(self.c.prepare_cached(&format!(
            "{SERVER_SELECT} JOIN members me ON me.server_id = s.id AND me.user_id = ? ORDER BY me.joined_at"
        )));
        ok(ok(st.query_map([user_id], server_from_row)).collect())
    }

    pub fn server_ids_of(&self, user_id: &str) -> Vec<String> {
        self.ids("SELECT server_id FROM members WHERE user_id = ?", [user_id])
    }

    pub fn discover_servers(&self, user_id: &str, query: &str) -> Vec<Server> {
        let like = format!("%{query}%");
        let mut st = ok(self.c.prepare_cached(&format!(
            "{SERVER_SELECT}
             WHERE s.is_public = 1
               AND NOT EXISTS (SELECT 1 FROM members m WHERE m.server_id = s.id AND m.user_id = ?1)
               AND (s.name LIKE ?2 OR s.description LIKE ?2)
             ORDER BY member_count DESC, s.created_at DESC LIMIT 50"
        )));
        ok(ok(st.query_map(params![user_id, like], server_from_row)).collect())
    }

    pub fn create_server(
        &self,
        owner_id: &str,
        name: &str,
        description: &str,
        is_public: bool,
    ) -> Server {
        let id = new_id();
        self.tx(|| {
            ok(self.c.execute(
                "INSERT INTO servers (id, name, description, icon_color, owner_id, is_public, invite_code, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                params![id, name, description, random_color(), owner_id, is_public as i64, new_invite_code(), now_iso()],
            ));
            self.add_member(&id, owner_id);
            let text = self.create_category(&id, "Canais de texto");
            let voice = self.create_category(&id, "Canais de voz");
            self.create_channel(&id, "geral", "text", Some(&text.id), "Bem-vindo ao servidor!");
            self.create_channel(&id, "Geral", "voice", Some(&voice.id), "");
        });
        self.server(&id).unwrap()
    }

    pub fn update_server(&self, id: &str, patch: ServerPatch) -> Server {
        let s = self.server(id).unwrap();
        ok(self.c.execute(
            "UPDATE servers SET name = ?, description = ?, is_public = ?, icon_color = ? WHERE id = ?",
            params![
                patch.name.unwrap_or(s.name),
                patch.description.unwrap_or(s.description),
                patch.is_public.unwrap_or(s.is_public) as i64,
                patch.icon_color.unwrap_or(s.icon_color),
                id
            ],
        ));
        self.server(id).unwrap()
    }

    pub fn reset_invite(&self, id: &str) -> Server {
        ok(self.c.execute(
            "UPDATE servers SET invite_code = ? WHERE id = ?",
            params![new_invite_code(), id],
        ));
        self.server(id).unwrap()
    }

    pub fn delete_server(&self, id: &str) {
        ok(self.c.execute("DELETE FROM servers WHERE id = ?", [id]));
    }

    // ---------- membros ----------

    pub fn is_member(&self, server_id: &str, user_id: &str) -> bool {
        ok(self
            .c
            .query_row(
                "SELECT 1 FROM members WHERE server_id = ? AND user_id = ?",
                [server_id, user_id],
                |_| Ok(()),
            )
            .optional())
        .is_some()
    }

    pub fn add_member(&self, server_id: &str, user_id: &str) -> Member {
        ok(self.c.execute(
            "INSERT OR IGNORE INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)",
            params![server_id, user_id, now_iso()],
        ));
        self.member(server_id, user_id).unwrap()
    }

    pub fn remove_member(&self, server_id: &str, user_id: &str) {
        ok(self.c.execute(
            "DELETE FROM members WHERE server_id = ? AND user_id = ?",
            [server_id, user_id],
        ));
    }

    pub fn member(&self, server_id: &str, user_id: &str) -> Option<Member> {
        let row: Option<(Option<String>, String)> = ok(self
            .c
            .query_row(
                "SELECT nickname, joined_at FROM members WHERE server_id = ? AND user_id = ?",
                [server_id, user_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional());
        let (nickname, joined_at) = row?;
        Some(Member {
            server_id: server_id.into(),
            user: self.public_user(user_id)?,
            nickname,
            joined_at,
        })
    }

    pub fn members(&self, server_id: &str) -> Vec<Member> {
        let mut st = ok(self.c.prepare_cached(&format!(
            "SELECT {USER_COLS}, m.nickname, m.joined_at AS member_joined_at FROM members m JOIN users u ON u.id = m.user_id
             WHERE m.server_id = ? ORDER BY u.display_name COLLATE NOCASE"
        )));
        let rows: Vec<(UserRow, Option<String>, String)> = ok(ok(st.query_map([server_id], |r| {
            Ok((
                UserRow::from_row(r)?,
                r.get("nickname")?,
                r.get("member_joined_at")?,
            ))
        }))
        .collect());
        rows.into_iter()
            .map(|(u, nickname, joined_at)| Member {
                server_id: server_id.into(),
                user: self.to_public_user(&u),
                nickname,
                joined_at,
            })
            .collect()
    }

    // ---------- categorias ----------

    pub fn category(&self, id: &str) -> Option<Category> {
        ok(self
            .c
            .query_row(
                "SELECT * FROM categories WHERE id = ?",
                [id],
                category_from_row,
            )
            .optional())
    }

    pub fn categories(&self, server_id: &str) -> Vec<Category> {
        let mut st = ok(self
            .c
            .prepare_cached("SELECT * FROM categories WHERE server_id = ? ORDER BY position, id"));
        ok(ok(st.query_map([server_id], category_from_row)).collect())
    }

    pub fn create_category(&self, server_id: &str, name: &str) -> Category {
        let id = new_id();
        let n: i64 = ok(self.c.query_row(
            "SELECT COUNT(*) FROM categories WHERE server_id = ?",
            [server_id],
            |r| r.get(0),
        ));
        ok(self.c.execute(
            "INSERT INTO categories (id, server_id, name, position) VALUES (?, ?, ?, ?)",
            params![id, server_id, name, n],
        ));
        self.category(&id).unwrap()
    }

    pub fn rename_category(&self, id: &str, name: &str) -> Category {
        ok(self
            .c
            .execute("UPDATE categories SET name = ? WHERE id = ?", [name, id]));
        self.category(id).unwrap()
    }

    pub fn delete_category(&self, id: &str) {
        ok(self.c.execute("DELETE FROM categories WHERE id = ?", [id]));
    }

    // ---------- canais ----------

    fn to_channel(&self, row: ChannelRow) -> Channel {
        let is_dm = row.kind == "dm" || row.kind == "group_dm";
        let is_thread = row.kind == "thread";
        Channel {
            recipients: is_dm.then(|| self.recipients(&row.id)),
            message_count: is_thread.then(|| self.message_count(&row.id)),
            owner_id: (is_dm || is_thread).then_some(row.owner_id),
            parent_id: if is_thread { row.parent_id } else { None },
            thread_message_id: is_thread.then_some(row.thread_message_id),
            id: row.id,
            kind: row.kind,
            server_id: row.server_id,
            category_id: row.category_id,
            name: row.name,
            topic: row.topic,
            position: row.position,
            last_message_at: row.last_message_at,
        }
    }

    fn channel_rows(&self, sql: &str, p: impl rusqlite::Params) -> Vec<Channel> {
        let rows: Vec<ChannelRow> = {
            let mut st = ok(self.c.prepare_cached(sql));
            ok(ok(st.query_map(p, channel_row)).collect())
        };
        rows.into_iter().map(|r| self.to_channel(r)).collect()
    }

    pub fn channel(&self, id: &str) -> Option<Channel> {
        self.channel_rows("SELECT * FROM channels WHERE id = ?", [id])
            .pop()
    }

    pub fn channels(&self, server_id: &str) -> Vec<Channel> {
        self.channel_rows(
            "SELECT * FROM channels WHERE server_id = ? ORDER BY position, id",
            [server_id],
        )
    }

    pub fn create_channel(
        &self,
        server_id: &str,
        name: &str,
        kind: &str,
        category_id: Option<&str>,
        topic: &str,
    ) -> Channel {
        let id = new_id();
        let n: i64 = ok(self.c.query_row(
            "SELECT COUNT(*) FROM channels WHERE server_id = ?",
            [server_id],
            |r| r.get(0),
        ));
        ok(self.c.execute(
            "INSERT INTO channels (id, type, server_id, category_id, name, topic, position, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![id, kind, server_id, category_id, name, topic, n, now_iso()],
        ));
        self.channel(&id).unwrap()
    }

    pub fn update_channel(&self, id: &str, patch: ChannelPatch) -> Channel {
        let c = self.channel(id).unwrap();
        ok(self.c.execute(
            "UPDATE channels SET name = ?, topic = ?, category_id = ?, position = ? WHERE id = ?",
            params![
                patch.name.unwrap_or(c.name),
                patch.topic.unwrap_or(c.topic),
                patch.category_id.unwrap_or(c.category_id),
                patch.position.unwrap_or(c.position),
                id
            ],
        ));
        self.channel(id).unwrap()
    }

    pub fn delete_channel(&self, id: &str) {
        ok(self.c.execute("DELETE FROM channels WHERE id = ?", [id]));
    }

    /// Quem enxerga o canal: membro do servidor ou participante da DM.
    pub fn can_access(&self, user_id: &str, channel_id: &str) -> bool {
        let row: Option<Option<String>> = ok(self
            .c
            .query_row(
                "SELECT server_id FROM channels WHERE id = ?",
                [channel_id],
                |r| r.get(0),
            )
            .optional());
        match row {
            None => false,
            Some(Some(server_id)) => self.is_member(&server_id, user_id),
            Some(None) => self.recipient_ids(channel_id).iter().any(|r| r == user_id),
        }
    }

    // ---------- DMs ----------

    pub fn recipients(&self, channel_id: &str) -> Vec<PublicUser> {
        let rows: Vec<UserRow> = {
            let mut st = ok(self.c.prepare_cached(&format!(
                "SELECT {USER_COLS} FROM channel_recipients r JOIN users u ON u.id = r.user_id WHERE r.channel_id = ? ORDER BY u.display_name"
            )));
            ok(ok(st.query_map([channel_id], UserRow::from_row)).collect())
        };
        rows.iter().map(|r| self.to_public_user(r)).collect()
    }

    pub fn recipient_ids(&self, channel_id: &str) -> Vec<String> {
        self.ids(
            "SELECT user_id FROM channel_recipients WHERE channel_id = ?",
            [channel_id],
        )
    }

    pub fn dms_of(&self, user_id: &str) -> Vec<Channel> {
        self.channel_rows(
            "SELECT c.* FROM channels c JOIN channel_recipients r ON r.channel_id = c.id
             WHERE r.user_id = ? ORDER BY COALESCE(c.last_message_at, c.created_at) DESC",
            [user_id],
        )
    }

    /// Reaproveita a DM 1:1 se ela já existir.
    pub fn find_direct_dm(&self, a: &str, b: &str) -> Option<Channel> {
        self.channel_rows(
            "SELECT c.* FROM channels c
             JOIN channel_recipients r1 ON r1.channel_id = c.id AND r1.user_id = ?
             JOIN channel_recipients r2 ON r2.channel_id = c.id AND r2.user_id = ?
             WHERE c.type = 'dm' LIMIT 1",
            [a, b],
        )
        .pop()
    }

    pub fn create_dm(&self, owner_id: &str, user_ids: &[String], name: Option<&str>) -> Channel {
        let id = new_id();
        let mut seen = HashSet::new();
        let all: Vec<&str> = std::iter::once(owner_id)
            .chain(user_ids.iter().map(|s| s.as_str()))
            .filter(|u| seen.insert(*u))
            .collect();
        let kind = if all.len() > 2 { "group_dm" } else { "dm" };
        self.tx(|| {
            ok(self.c.execute(
                "INSERT INTO channels (id, type, name, owner_id, created_at) VALUES (?, ?, ?, ?, ?)",
                params![id, kind, if kind == "group_dm" { name.unwrap_or("") } else { "" }, owner_id, now_iso()],
            ));
            for u in &all {
                ok(self.c.execute("INSERT INTO channel_recipients (channel_id, user_id) VALUES (?, ?)", [&id, *u]));
            }
        });
        self.channel(&id).unwrap()
    }

    /// Remove do grupo; se ninguém sobrar, apaga a conversa.
    pub fn leave_group_dm(&self, channel_id: &str, user_id: &str) {
        ok(self.c.execute(
            "DELETE FROM channel_recipients WHERE channel_id = ? AND user_id = ?",
            [channel_id, user_id],
        ));
        if self.recipient_ids(channel_id).is_empty() {
            self.delete_channel(channel_id);
        }
    }

    // ---------- mensagens ----------

    fn message_rows(&self, sql: &str, p: impl rusqlite::Params) -> Vec<Message> {
        let rows: Vec<(UserRow, Message)> = {
            let mut st = ok(self.c.prepare_cached(sql));
            ok(ok(st.query_map(p, |r| {
                let user = UserRow::from_row(r)?;
                let msg = Message {
                    id: r.get("m_id")?,
                    channel_id: r.get("channel_id")?,
                    author: PublicUser {
                        id: String::new(),
                        username: String::new(),
                        display_name: String::new(),
                        avatar_color: String::new(),
                        bio: String::new(),
                        custom_status: None,
                        presence: "offline",
                    },
                    content: r.get("content")?,
                    created_at: r.get("m_created_at")?,
                    edited_at: r.get("edited_at")?,
                    attachments: Vec::new(),
                    thread: None,
                };
                Ok((user, msg))
            }))
            .collect())
        };
        rows.into_iter()
            .map(|(u, mut m)| {
                m.author = self.to_public_user(&u);
                m.attachments = self.attachments_of(&m.id);
                m.thread = self.thread_of_message(&m.id);
                m
            })
            .collect()
    }

    pub fn message(&self, id: &str) -> Option<Message> {
        self.message_rows(&format!("{} WHERE m.id = ?", message_select()), [id])
            .pop()
    }

    /// Mensagens mais recentes primeiro no banco, devolvidas em ordem cronológica.
    pub fn messages(&self, channel_id: &str, before: Option<&str>, limit: i64) -> Vec<Message> {
        let mut rows = match before {
            Some(before) => self.message_rows(
                &format!(
                    "{} WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?",
                    message_select()
                ),
                params![channel_id, before, limit],
            ),
            None => self.message_rows(
                &format!(
                    "{} WHERE m.channel_id = ? ORDER BY m.id DESC LIMIT ?",
                    message_select()
                ),
                params![channel_id, limit],
            ),
        };
        rows.reverse();
        rows
    }

    pub fn create_message(&self, channel_id: &str, author_id: &str, content: &str, attachment_ids: &[String]) -> Message {
        let id = new_id();
        let at = now_iso();
        self.tx(|| {
            ok(self.c.execute(
                "INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
                params![id, channel_id, author_id, content, at],
            ));
            ok(self.c.execute("UPDATE channels SET last_message_at = ? WHERE id = ?", [&at, channel_id]));
            for (pos, a) in attachment_ids.iter().enumerate() {
                ok(self.c.execute(
                    "UPDATE attachments SET message_id = ?, position = ? WHERE id = ? AND uploader_id = ? AND message_id IS NULL",
                    params![id, pos as i64, a, author_id],
                ));
            }
        });
        self.message(&id).unwrap()
    }

    // ---------- anexos ----------

    pub fn create_attachment(&self, id: &str, uploader_id: &str, filename: &str, content_type: &str, size: i64) -> Attachment {
        ok(self.c.execute(
            "INSERT INTO attachments (id, uploader_id, filename, content_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            params![id, uploader_id, filename, content_type, size, now_iso()],
        ));
        self.attachment(id).unwrap()
    }

    pub fn attachment(&self, id: &str) -> Option<Attachment> {
        ok(self.c.query_row("SELECT * FROM attachments WHERE id = ?", [id], attachment_from_row).optional())
    }

    /// Anexos enviados por `user_id` e ainda soltos (prontos para entrar numa mensagem).
    pub fn pending_attachments(&self, user_id: &str, ids: &[String]) -> usize {
        ids.iter()
            .filter(|id| {
                ok(self
                    .c
                    .query_row(
                        "SELECT 1 FROM attachments WHERE id = ? AND uploader_id = ? AND message_id IS NULL",
                        [id.as_str(), user_id],
                        |_| Ok(()),
                    )
                    .optional())
                .is_some()
            })
            .count()
    }

    fn attachments_of(&self, message_id: &str) -> Vec<Attachment> {
        let mut st = ok(self.c.prepare_cached("SELECT * FROM attachments WHERE message_id = ? ORDER BY position, id"));
        ok(ok(st.query_map([message_id], attachment_from_row)).collect())
    }

    /// Ids dos arquivos de um canal inteiro (inclui threads), para apagar do disco.
    pub fn attachment_ids_in_channel(&self, channel_id: &str) -> Vec<String> {
        self.ids(
            "SELECT a.id FROM attachments a JOIN messages m ON m.id = a.message_id
             WHERE m.channel_id = ?1 OR m.channel_id IN (SELECT id FROM channels WHERE parent_id = ?1)",
            [channel_id],
        )
    }

    pub fn all_attachment_ids(&self) -> Vec<String> {
        self.ids("SELECT id FROM attachments", [])
    }

    /// Anexos enviados mas nunca colocados numa mensagem.
    pub fn prune_unused_attachments(&self) {
        let cutoff = (chrono::Utc::now() - chrono::Duration::days(1)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        ok(self.c.execute("DELETE FROM attachments WHERE message_id IS NULL AND created_at < ?", [cutoff]));
    }

    pub fn attachment_ids_of_message(&self, message_id: &str) -> Vec<String> {
        self.ids("SELECT id FROM attachments WHERE message_id = ?", [message_id])
    }

    // ---------- threads ----------

    fn message_count(&self, channel_id: &str) -> i64 {
        ok(self.c.query_row("SELECT COUNT(*) FROM messages WHERE channel_id = ?", [channel_id], |r| r.get(0)))
    }

    fn thread_of_message(&self, message_id: &str) -> Option<ThreadSummary> {
        let row: Option<(String, String, Option<String>)> = ok(self
            .c
            .query_row(
                "SELECT id, name, last_message_at FROM channels WHERE thread_message_id = ? AND type = 'thread' LIMIT 1",
                [message_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional());
        let (id, name, last_message_at) = row?;
        let participant_ids = ok(self
            .c
            .prepare_cached(
                "SELECT author_id FROM messages WHERE channel_id = ? GROUP BY author_id ORDER BY MAX(created_at) DESC LIMIT 3",
            )
            .and_then(|mut st| st.query_map([&id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()));
        let participant_count: i64 = ok(self.c.query_row(
            "SELECT COUNT(DISTINCT author_id) FROM messages WHERE channel_id = ?",
            [&id],
            |r| r.get(0),
        ));
        Some(ThreadSummary { message_count: self.message_count(&id), id, name, last_message_at, participant_ids, participant_count })
    }

    pub fn thread_for_message(&self, message_id: &str) -> Option<Channel> {
        self.channel_rows("SELECT * FROM channels WHERE thread_message_id = ? AND type = 'thread' LIMIT 1", [message_id]).pop()
    }

    pub fn threads_of(&self, parent_id: &str) -> Vec<Channel> {
        self.channel_rows("SELECT * FROM channels WHERE parent_id = ? ORDER BY id", [parent_id])
    }

    pub fn create_thread(&self, parent: &Channel, owner_id: &str, name: &str, message_id: Option<&str>) -> Channel {
        let id = new_id();
        ok(self.c.execute(
            "INSERT INTO channels (id, type, server_id, name, owner_id, parent_id, thread_message_id, created_at)
             VALUES (?, 'thread', ?, ?, ?, ?, ?, ?)",
            params![id, parent.server_id, name, owner_id, parent.id, message_id, now_iso()],
        ));
        self.channel(&id).unwrap()
    }

    pub fn edit_message(&self, id: &str, content: &str) -> Message {
        ok(self.c.execute(
            "UPDATE messages SET content = ?, edited_at = ? WHERE id = ?",
            params![content, now_iso(), id],
        ));
        self.message(id).unwrap()
    }

    pub fn delete_message(&self, id: &str) {
        ok(self.c.execute("DELETE FROM messages WHERE id = ?", [id]));
    }

    // ---------- amizades ----------

    /// (requester_id, addressee_id, status, created_at)
    fn friendship_row(&self, a: &str, b: &str) -> Option<(String, String, String, String)> {
        ok(self
            .c
            .query_row(
                "SELECT requester_id, addressee_id, status, created_at FROM friendships
                 WHERE (requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1)",
                [a, b],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional())
    }

    /// Relação vista por `viewer_id`.
    pub fn friend(&self, viewer_id: &str, other_id: &str) -> Option<Friend> {
        let (requester, _, status, since) = self.friendship_row(viewer_id, other_id)?;
        let state = if status == "accepted" {
            "friends"
        } else if requester == viewer_id {
            "outgoing"
        } else {
            "incoming"
        };
        Some(Friend {
            user: self.public_user(other_id)?,
            state,
            since,
        })
    }

    pub fn friends(&self, user_id: &str) -> Vec<Friend> {
        self.ids(
            "SELECT CASE WHEN requester_id = ?1 THEN addressee_id ELSE requester_id END AS other
             FROM friendships WHERE requester_id = ?1 OR addressee_id = ?1",
            [user_id],
        )
        .iter()
        .filter_map(|other| self.friend(user_id, other))
        .collect()
    }

    pub fn request_friend(&self, from: &str, to: &str) -> FriendRequest {
        match self.friendship_row(from, to) {
            None => {
                ok(self.c.execute(
                    "INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES (?, ?, 'pending', ?)",
                    params![from, to, now_iso()],
                ));
                FriendRequest::Created
            }
            // Se a outra pessoa já tinha pedido, aceitar na hora.
            Some((_, addressee, status, _)) if status == "pending" && addressee == from => {
                self.accept_friend(from, to);
                FriendRequest::Accepted
            }
            Some(_) => FriendRequest::Exists,
        }
    }

    pub fn accept_friend(&self, user_id: &str, requester_id: &str) -> bool {
        ok(self.c.execute(
            "UPDATE friendships SET status = 'accepted', created_at = ? WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'",
            params![now_iso(), requester_id, user_id],
        )) > 0
    }

    pub fn remove_friend(&self, a: &str, b: &str) -> bool {
        ok(self.c.execute(
            "DELETE FROM friendships WHERE (requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1)",
            [a, b],
        )) > 0
    }
}

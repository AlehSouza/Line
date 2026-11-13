//! Camada de acesso a dados. Todo SQL do app mora aqui.
//!
//! O banco fica atrás de um `Mutex`: cada requisição pega a conexão (`store.q()`),
//! faz o que precisa e solta. Para uso pessoal isso é mais que suficiente e evita
//! qualquer problema de concorrência no SQLite.
use crate::ids::{new_id, new_invite_code, now_iso, random_color};
use crate::model::*;
use crate::perms;
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
    pub avatar_id: Option<String>,
    pub banner_id: Option<String>,
    pub pronouns: String,
    pub thought: Option<String>,
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
            avatar_id: r.get("avatar_id").unwrap_or(None),
            banner_id: r.get("banner_id").unwrap_or(None),
            pronouns: r.get("pronouns").unwrap_or_default(),
            thought: r.get("thought").unwrap_or(None),
        })
    }
}

const USER_COLS: &str = "u.id, u.username, u.display_name, u.password_hash, u.avatar_color, u.bio, u.custom_status, u.status, u.created_at, u.avatar_id, u.banner_id, u.pronouns, u.thought";
const SERVER_SELECT: &str = "SELECT s.*, (SELECT COUNT(*) FROM members m WHERE m.server_id = s.id) AS member_count,
  (SELECT filename FROM attachments a WHERE a.id = s.icon_id) AS icon_filename,
  (SELECT filename FROM attachments a WHERE a.id = s.banner_id) AS banner_filename
  FROM servers s";

/// URL pública de uma imagem do servidor (ícone/banner), se ainda existir.
fn image_url(r: &Row, id_col: &str, name_col: &str) -> Option<String> {
    let id: Option<String> = r.get(id_col).ok().flatten();
    let name: Option<String> = r.get(name_col).ok().flatten();
    Some(format!("/api/attachments/{}/{}", id?, url_segment(&name?)))
}

fn message_select() -> String {
    format!(
        "SELECT {USER_COLS}, m.id AS m_id, m.channel_id, m.author_id, m.content, m.created_at AS m_created_at, m.edited_at,
                m.mention_everyone, m.mention_roles
         FROM messages m JOIN users u ON u.id = m.author_id"
    )
}

fn server_from_row(r: &Row) -> rusqlite::Result<Server> {
    Ok(Server {
        id: r.get("id")?,
        name: r.get("name")?,
        description: r.get("description")?,
        icon_color: r.get("icon_color")?,
        icon_url: image_url(r, "icon_id", "icon_filename"),
        banner_url: image_url(r, "banner_id", "banner_filename"),
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
    is_private: bool,
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
        is_private: r.get::<_, i64>("is_private")? != 0,
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
    pub pronouns: Option<String>,
    pub thought: Option<Option<String>>,
    pub avatar_id: Option<Option<String>>,
    pub banner_id: Option<Option<String>>,
}

#[derive(Default)]
pub struct ServerPatch {
    pub name: Option<String>,
    pub description: Option<String>,
    pub is_public: Option<bool>,
    pub icon_color: Option<String>,
    pub icon_id: Option<Option<String>>,
    pub banner_id: Option<Option<String>>,
}

#[derive(Default)]
pub struct RolePatch {
    pub name: Option<String>,
    pub color: Option<Option<String>>,
    pub permissions: Option<i64>,
    pub mentionable: Option<bool>,
}

#[derive(Default)]
pub struct ChannelPatch {
    pub name: Option<String>,
    pub topic: Option<String>,
    pub category_id: Option<Option<String>>,
    pub position: Option<i64>,
}

pub enum SearchScope {
    Server(String),
    Channel(String),
}

#[derive(Default)]
pub struct SearchFilter {
    pub text: String,
    pub author_id: Option<String>,
    pub channel_id: Option<String>,
    pub mentions: Option<String>,
    pub has: Option<String>,
    /// Canais privados que quem busca não enxerga.
    pub hidden: Vec<String>,
}

pub enum FriendRequest {
    Created,
    Accepted,
    Exists,
    /// Uma das duas pessoas bloqueou a outra.
    Blocked,
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
            avatar_url: row.avatar_id.as_deref().map(|id| self.profile_image_url(id)),
            banner_url: row.banner_id.as_deref().map(|id| self.profile_image_url(id)),
            pronouns: row.pronouns.clone(),
            thought: if presence == "offline" { None } else { row.thought.clone() },
        }
    }

    fn profile_image_url(&self, attachment_id: &str) -> String {
        self.attachment(attachment_id).map(|a| a.url).unwrap_or_default()
    }

    /// Imagem enviada por esta pessoa que pode virar foto ou banner do perfil.
    pub fn own_image(&self, user_id: &str, attachment_id: &str) -> bool {
        ok(self
            .c
            .query_row(
                "SELECT 1 FROM attachments WHERE id = ? AND uploader_id = ? AND content_type LIKE 'image/%' AND content_type != 'image/svg+xml'",
                [attachment_id, user_id],
                |_| Ok(()),
            )
            .optional())
        .is_some()
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

    pub fn user_by_email(&self, email: &str) -> Option<UserRow> {
        ok(self
            .c
            .query_row("SELECT * FROM users WHERE email = ?", [email], UserRow::from_row)
            .optional())
    }

    /// Último pedido de recuperação do usuário foi há menos de `secs` segundos?
    pub fn reset_requested_recently(&self, user_id: &str, secs: i64) -> bool {
        let since = (chrono::Utc::now() - chrono::Duration::seconds(secs))
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        ok(self
            .c
            .query_row(
                "SELECT 1 FROM password_resets WHERE user_id = ? AND created_at > ? LIMIT 1",
                params![user_id, since],
                |_| Ok(()),
            )
            .optional())
        .is_some()
    }

    /// Novo token de recuperação (só o hash é guardado). Tokens antigos do usuário deixam de valer.
    pub fn create_password_reset(&self, user_id: &str, token_hash: &str, minutes: i64) {
        let now = now_iso();
        let expires = (chrono::Utc::now() + chrono::Duration::minutes(minutes))
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        ok(self.c.execute(
            "UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL",
            params![now, user_id],
        ));
        ok(self.c.execute("DELETE FROM password_resets WHERE expires_at < ?", [&now]));
        ok(self.c.execute(
            "INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            params![token_hash, user_id, now, expires],
        ));
    }

    /// Dono de um token ainda válido (não usado e não expirado).
    pub fn password_reset_user(&self, token_hash: &str) -> Option<String> {
        ok(self
            .c
            .query_row(
                "SELECT user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
                params![token_hash, now_iso()],
                |r| r.get(0),
            )
            .optional())
    }

    /// Gasta o token; devolve false se ele já tinha sido usado ou expirou.
    pub fn consume_password_reset(&self, token_hash: &str) -> bool {
        let now = now_iso();
        ok(self.c.execute(
            "UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
            params![now, token_hash, now],
        )) == 1
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
        if let Some(v) = patch.pronouns {
            set("pronouns", v.into());
        }
        let opt = |v: Option<String>| v.filter(|s| !s.is_empty()).map(Value::from).unwrap_or(Value::Null);
        if let Some(v) = patch.thought {
            set("thought", opt(v));
        }
        if let Some(v) = patch.avatar_id {
            set("avatar_id", opt(v));
        }
        if let Some(v) = patch.banner_id {
            set("banner_id", opt(v));
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
        let list: Vec<Server> = {
            let mut st = ok(self.c.prepare_cached(&format!(
                "{SERVER_SELECT} JOIN members me ON me.server_id = s.id AND me.user_id = ? ORDER BY me.joined_at"
            )));
            ok(ok(st.query_map([user_id], server_from_row)).collect())
        };
        list.into_iter().map(|s| self.for_viewer(s, user_id)).collect()
    }

    /// Esconde o código de convite de quem não tem "Criar convite".
    pub fn for_viewer(&self, mut server: Server, viewer: &str) -> Server {
        if !perms::has(self.permissions(&server.id, viewer), perms::CREATE_INVITE) {
            server.invite_code = String::new();
        }
        server
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
        let list: Vec<Server> = ok(ok(st.query_map(params![user_id, like], server_from_row)).collect());
        list.into_iter().map(|s| Server { invite_code: String::new(), ..s }).collect()
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
            ok(self.c.execute(
                "INSERT INTO roles (id, server_id, name, permissions, position, created_at) VALUES (?, ?, '@everyone', ?, 0, ?)",
                params![id, id, perms::DEFAULT_EVERYONE, now_iso()],
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
        if let Some(v) = patch.icon_id {
            ok(self.c.execute("UPDATE servers SET icon_id = ? WHERE id = ?", params![v, id]));
        }
        if let Some(v) = patch.banner_id {
            ok(self.c.execute("UPDATE servers SET banner_id = ? WHERE id = ?", params![v, id]));
        }
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
            role_ids: self.member_role_ids(server_id, user_id),
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
        let mut roles: std::collections::HashMap<String, Vec<String>> = Default::default();
        {
            let mut st = ok(self.c.prepare_cached(
                "SELECT mr.user_id, mr.role_id FROM member_roles mr JOIN roles r ON r.id = mr.role_id
                 WHERE mr.server_id = ? ORDER BY r.position DESC",
            ));
            let pairs: Vec<(String, String)> =
                ok(ok(st.query_map([server_id], |r| Ok((r.get(0)?, r.get(1)?)))).collect());
            for (u, r) in pairs {
                roles.entry(u).or_default().push(r);
            }
        }
        rows.into_iter()
            .map(|(u, nickname, joined_at)| Member {
                server_id: server_id.into(),
                role_ids: roles.remove(&u.id).unwrap_or_default(),
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
            is_private: row.is_private,
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
        self.create_channel_ex(server_id, name, kind, category_id, topic, None, &[])
    }

    /// `private_members`: Some(lista) cria um canal privado visível só para eles (e o dono).
    pub fn create_channel_ex(
        &self,
        server_id: &str,
        name: &str,
        kind: &str,
        category_id: Option<&str>,
        topic: &str,
        private_members: Option<&[String]>,
        private_roles: &[String],
    ) -> Channel {
        let id = new_id();
        let n: i64 = ok(self.c.query_row(
            "SELECT COUNT(*) FROM channels WHERE server_id = ?",
            [server_id],
            |r| r.get(0),
        ));
        ok(self.c.execute(
            "INSERT INTO channels (id, type, server_id, category_id, name, topic, position, is_private, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![id, kind, server_id, category_id, name, topic, n, private_members.is_some() as i64, now_iso()],
        ));
        for user_id in private_members.unwrap_or_default() {
            ok(self.c.execute(
                "INSERT OR IGNORE INTO channel_recipients (channel_id, user_id) VALUES (?, ?)",
                params![id, user_id],
            ));
        }
        if private_members.is_some() {
            for role_id in private_roles {
                ok(self.c.execute(
                    "INSERT OR IGNORE INTO channel_roles (channel_id, role_id) VALUES (?, ?)",
                    params![id, role_id],
                ));
            }
        }
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

    /// Quem enxerga o canal. DM: os participantes. Servidor: canal privado só para quem foi
    /// escolhido (pessoa ou cargo); canal aberto para quem tem "Ver canais". Dono e
    /// administradores veem tudo. Threads seguem o canal pai.
    pub fn can_access(&self, user_id: &str, channel_id: &str) -> bool {
        let row: Option<(Option<String>, String, bool)> = ok(self
            .c
            .query_row(
                "SELECT r.server_id, r.id, r.is_private FROM channels r
                 WHERE r.id = (SELECT COALESCE(parent_id, id) FROM channels WHERE id = ?)",
                [channel_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)),
            )
            .optional());
        match row {
            None => false,
            Some((None, _, _)) => self.recipient_ids(channel_id).iter().any(|r| r == user_id),
            Some((Some(server_id), root, is_private)) => {
                if !self.is_member(&server_id, user_id) {
                    return false;
                }
                let p = self.permissions(&server_id, user_id);
                if perms::has(p, perms::ADMINISTRATOR) {
                    return true;
                }
                if !is_private {
                    return perms::has(p, perms::VIEW_CHANNELS);
                }
                ok(self
                    .c
                    .query_row(
                        "SELECT 1 WHERE EXISTS (SELECT 1 FROM channel_recipients WHERE channel_id = ?1 AND user_id = ?2)
                            OR EXISTS (SELECT 1 FROM channel_roles cr JOIN member_roles mr ON mr.role_id = cr.role_id
                                       WHERE cr.channel_id = ?1 AND mr.user_id = ?2)",
                        [&root, user_id],
                        |_| Ok(()),
                    )
                    .optional())
                .is_some()
            }
        }
    }

    /// Quem enxerga um canal de servidor, quando não é o servidor inteiro (canal privado ou
    /// @everyone sem "Ver canais"). None = todos os membros veem (pode usar a sala do servidor).
    pub fn private_audience(&self, channel_id: &str) -> Option<Vec<String>> {
        let (server_id, is_private): (String, bool) = ok(self
            .c
            .query_row(
                "SELECT r.server_id, r.is_private FROM channels r
                 WHERE r.server_id IS NOT NULL
                   AND r.id = (SELECT COALESCE(parent_id, id) FROM channels WHERE id = ?)",
                [channel_id],
                |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0)),
            )
            .optional())?;
        if !is_private && perms::has(self.everyone_permissions(&server_id), perms::VIEW_CHANNELS) {
            return None;
        }
        Some(
            self.ids("SELECT user_id FROM members WHERE server_id = ?", [server_id.as_str()])
                .into_iter()
                .filter(|u| self.can_access(u, channel_id))
                .collect(),
        )
    }

    /// Canais (e threads) do servidor que essa pessoa não pode ver.
    pub fn hidden_channel_ids(&self, server_id: &str, user_id: &str) -> Vec<String> {
        self.ids("SELECT id FROM channels WHERE server_id = ?", [server_id])
            .into_iter()
            .filter(|id| !self.can_access(user_id, id))
            .collect()
    }

    // ---------- cargos e permissões ----------

    fn role_rows(&self, sql: &str, p: impl rusqlite::Params) -> Vec<Role> {
        let mut st = ok(self.c.prepare_cached(sql));
        ok(ok(st.query_map(p, |r| {
            Ok(Role {
                id: r.get("id")?,
                server_id: r.get("server_id")?,
                name: r.get("name")?,
                color: r.get("color")?,
                permissions: r.get("permissions")?,
                position: r.get("position")?,
                mentionable: r.get::<_, i64>("mentionable")? != 0,
                member_count: r.get("member_count")?,
            })
        }))
        .collect())
    }

    /// Cargos do servidor, do mais alto para o mais baixo (o @everyone por último).
    pub fn roles(&self, server_id: &str) -> Vec<Role> {
        self.role_rows(
            "SELECT r.*, CASE WHEN r.id = r.server_id THEN (SELECT COUNT(*) FROM members m WHERE m.server_id = r.server_id)
                    ELSE (SELECT COUNT(*) FROM member_roles mr WHERE mr.role_id = r.id) END AS member_count
             FROM roles r WHERE r.server_id = ? ORDER BY r.position DESC, r.created_at",
            [server_id],
        )
    }

    pub fn role(&self, id: &str) -> Option<Role> {
        self.role_rows(
            "SELECT r.*, (SELECT COUNT(*) FROM member_roles mr WHERE mr.role_id = r.id) AS member_count
             FROM roles r WHERE r.id = ?",
            [id],
        )
        .pop()
    }

    /// Novo cargo entra logo acima do @everyone (posição 1); os outros sobem uma casa.
    pub fn create_role(&self, server_id: &str, name: &str, color: Option<&str>, permissions: i64, mentionable: bool) -> Role {
        let id = new_id();
        self.tx(|| {
            ok(self.c.execute(
                "UPDATE roles SET position = position + 1 WHERE server_id = ? AND position >= 1",
                [server_id],
            ));
            ok(self.c.execute(
                "INSERT INTO roles (id, server_id, name, color, permissions, position, mentionable, created_at)
                 VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
                params![id, server_id, name, color, permissions, mentionable as i64, now_iso()],
            ));
        });
        self.role(&id).unwrap()
    }

    pub fn update_role(&self, id: &str, patch: RolePatch) -> Role {
        let r = self.role(id).unwrap();
        ok(self.c.execute(
            "UPDATE roles SET name = ?, color = ?, permissions = ?, mentionable = ? WHERE id = ?",
            params![
                patch.name.unwrap_or(r.name),
                patch.color.unwrap_or(r.color),
                patch.permissions.unwrap_or(r.permissions),
                patch.mentionable.unwrap_or(r.mentionable) as i64,
                id
            ],
        ));
        self.role(id).unwrap()
    }

    pub fn delete_role(&self, id: &str) {
        ok(self.c.execute("DELETE FROM roles WHERE id = ?", [id]));
    }

    /// Grava a nova ordem: `top_first` lista os cargos (sem o @everyone) do mais alto ao mais baixo.
    pub fn reorder_roles(&self, server_id: &str, top_first: &[String]) {
        let n = top_first.len() as i64;
        self.tx(|| {
            for (i, id) in top_first.iter().enumerate() {
                ok(self.c.execute(
                    "UPDATE roles SET position = ? WHERE id = ? AND server_id = ? AND id != server_id",
                    params![n - i as i64, id, server_id],
                ));
            }
        });
    }

    pub fn member_role_ids(&self, server_id: &str, user_id: &str) -> Vec<String> {
        self.ids(
            "SELECT mr.role_id FROM member_roles mr JOIN roles r ON r.id = mr.role_id
             WHERE mr.server_id = ? AND mr.user_id = ? ORDER BY r.position DESC",
            [server_id, user_id],
        )
    }

    pub fn set_member_role(&self, server_id: &str, user_id: &str, role_id: &str, on: bool) {
        if on {
            ok(self.c.execute(
                "INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)",
                [server_id, user_id, role_id],
            ));
        } else {
            ok(self.c.execute(
                "DELETE FROM member_roles WHERE role_id = ? AND user_id = ?",
                [role_id, user_id],
            ));
        }
    }

    /// Quem tem o cargo (para avisar sobre menções e mostrar em "Gerenciar membros").
    pub fn set_nickname(&self, server_id: &str, user_id: &str, nickname: Option<&str>) {
        ok(self.c.execute(
            "UPDATE members SET nickname = ? WHERE server_id = ? AND user_id = ?",
            params![nickname, server_id, user_id],
        ));
    }

    pub fn member_ids(&self, server_id: &str) -> Vec<String> {
        self.ids("SELECT user_id FROM members WHERE server_id = ?", [server_id])
    }

    pub fn role_member_ids(&self, role_id: &str) -> Vec<String> {
        self.ids("SELECT user_id FROM member_roles WHERE role_id = ?", [role_id])
    }

    pub fn everyone_permissions(&self, server_id: &str) -> i64 {
        ok(self
            .c
            .query_row("SELECT permissions FROM roles WHERE id = ?", [server_id], |r| r.get(0))
            .optional())
        .unwrap_or(perms::DEFAULT_EVERYONE)
    }

    /// Permissões da pessoa no servidor (0 se não for membro).
    pub fn permissions(&self, server_id: &str, user_id: &str) -> i64 {
        let owner: Option<String> = ok(self
            .c
            .query_row("SELECT owner_id FROM servers WHERE id = ?", [server_id], |r| r.get(0))
            .optional());
        if owner.as_deref() == Some(user_id) {
            return perms::ALL;
        }
        if !self.is_member(server_id, user_id) {
            return 0;
        }
        let mut p = self.everyone_permissions(server_id);
        let list: Vec<i64> = {
            let mut st = ok(self.c.prepare_cached(
                "SELECT r.permissions FROM member_roles mr JOIN roles r ON r.id = mr.role_id
                 WHERE mr.server_id = ? AND mr.user_id = ?",
            ));
            ok(ok(st.query_map([server_id, user_id], |r| r.get::<_, i64>(0))).collect())
        };
        for x in list {
            p |= x;
        }
        if perms::has(p, perms::ADMINISTRATOR) { perms::ALL } else { p & perms::ALL }
    }

    /// Posição do cargo mais alto da pessoa (dono = acima de tudo).
    pub fn top_position(&self, server_id: &str, user_id: &str) -> i64 {
        if self.server(server_id).is_some_and(|s| s.owner_id == user_id) {
            return i64::MAX;
        }
        ok(self.c.query_row(
            "SELECT COALESCE(MAX(r.position), 0) FROM member_roles mr JOIN roles r ON r.id = mr.role_id
             WHERE mr.server_id = ? AND mr.user_id = ?",
            [server_id, user_id],
            |r| r.get(0),
        ))
    }

    /// Quais menções da mensagem valem: @everyone/@here só com permissão; cargo só se for
    /// mencionável ou se quem mandou puder mencionar todos. Fora de servidor, nenhuma.
    fn resolve_mentions(&self, channel_id: &str, author_id: &str, content: &str) -> (bool, String) {
        let Some(server_id) = self.channel(channel_id).and_then(|c| c.server_id) else {
            return (false, String::new());
        };
        let p = self.permissions(&server_id, author_id);
        let can_all = perms::has(p, perms::MENTION_EVERYONE);
        let everyone = can_all
            && content
                .split(|c: char| !(c.is_alphanumeric() || c == '@'))
                .any(|w| w == "@everyone" || w == "@here");
        let mut roles: Vec<String> = Vec::new();
        for part in content.split("<@&").skip(1) {
            let Some((id, _)) = part.split_once('>') else { continue };
            if roles.iter().any(|r| r == id) || id == server_id {
                continue;
            }
            if let Some(role) = self.role(id)
                && role.server_id == server_id
                && (role.mentionable || can_all)
            {
                roles.push(role.id);
            }
        }
        (everyone, roles.join(","))
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
                        avatar_url: None,
                        banner_url: None,
                        pronouns: String::new(),
                        thought: None,
                    },
                    content: r.get("content")?,
                    created_at: r.get("m_created_at")?,
                    edited_at: r.get("edited_at")?,
                    attachments: Vec::new(),
                    thread: None,
                    poll: None,
                    reactions: Vec::new(),
                    mention_everyone: r.get::<_, i64>("mention_everyone")? != 0,
                    mention_role_ids: r
                        .get::<_, String>("mention_roles")?
                        .split(',')
                        .filter(|s| !s.is_empty())
                        .map(String::from)
                        .collect(),
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
                m.poll = self.poll_of(&m.id);
                m.reactions = self.reactions_of(&m.id);
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

    /// Mensagens em volta de uma (para pular até ela): 25 antes e até 500 depois.
    pub fn messages_around(&self, channel_id: &str, around: &str) -> Vec<Message> {
        let mut before = self.message_rows(
            &format!("{} WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT 25", message_select()),
            params![channel_id, around],
        );
        before.reverse();
        let after = self.message_rows(
            &format!("{} WHERE m.channel_id = ? AND m.id >= ? ORDER BY m.id ASC LIMIT 500", message_select()),
            params![channel_id, around],
        );
        before.extend(after);
        before
    }

    /// Busca nas mensagens de um servidor (canais e threads) ou de uma conversa.
    pub fn search_messages(&self, scope: &SearchScope, f: &SearchFilter, offset: i64) -> Vec<Message> {
        let mut sql = format!("{} WHERE ", message_select());
        let mut args: Vec<String> = Vec::new();
        match scope {
            SearchScope::Server(id) => {
                sql.push_str(
                    "m.channel_id IN (SELECT id FROM channels WHERE type != 'voice' AND (server_id = ? OR parent_id IN (SELECT id FROM channels WHERE server_id = ?)))",
                );
                args.push(id.clone());
                args.push(id.clone());
            }
            SearchScope::Channel(id) => {
                sql.push_str("m.channel_id = ?");
                args.push(id.clone());
            }
        }
        let like = |t: &str| format!("%{}%", t.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        for word in f.text.split_whitespace().take(8) {
            sql.push_str(" AND m.content LIKE ? ESCAPE '\\'");
            args.push(like(word));
        }
        for h in f.hidden.iter().take(500) {
            sql.push_str(" AND m.channel_id != ?");
            args.push(h.clone());
        }
        if let Some(a) = &f.author_id {
            sql.push_str(" AND m.author_id = ?");
            args.push(a.clone());
        }
        if let Some(c) = &f.channel_id {
            sql.push_str(" AND (m.channel_id = ? OR m.channel_id IN (SELECT id FROM channels WHERE parent_id = ?))");
            args.push(c.clone());
            args.push(c.clone());
        }
        if let Some(u) = &f.mentions {
            sql.push_str(" AND m.content LIKE ? ESCAPE '\\'");
            args.push(like(&format!("@{u}")));
        }
        match f.has.as_deref() {
            Some("link") => sql.push_str(" AND (m.content LIKE '%http://%' OR m.content LIKE '%https://%')"),
            Some("anexo") => sql.push_str(" AND EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)"),
            Some("imagem") => sql.push_str(" AND EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.content_type LIKE 'image/%')"),
            Some("arquivo") => sql.push_str(
                " AND EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.content_type NOT LIKE 'image/%' AND a.content_type NOT LIKE 'video/%')",
            ),
            _ => {}
        }
        sql.push_str(&format!(" ORDER BY m.id DESC LIMIT 25 OFFSET {}", offset.max(0)));
        self.message_rows(&sql, rusqlite::params_from_iter(args))
    }

    pub fn create_message(&self, channel_id: &str, author_id: &str, content: &str, attachment_ids: &[String]) -> Message {
        let id = new_id();
        let at = now_iso();
        let (everyone, roles) = self.resolve_mentions(channel_id, author_id, content);
        self.tx(|| {
            ok(self.c.execute(
                "INSERT INTO messages (id, channel_id, author_id, content, created_at, mention_everyone, mention_roles)
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
                params![id, channel_id, author_id, content, at, everyone as i64, roles],
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
        ok(self.c.execute(
            "DELETE FROM attachments WHERE message_id IS NULL AND created_at < ?
             AND id NOT IN (SELECT avatar_id FROM users WHERE avatar_id IS NOT NULL)
             AND id NOT IN (SELECT banner_id FROM users WHERE banner_id IS NOT NULL)
             AND id NOT IN (SELECT icon_id FROM servers WHERE icon_id IS NOT NULL)
             AND id NOT IN (SELECT banner_id FROM servers WHERE banner_id IS NOT NULL)",
            [cutoff],
        ));
    }

    pub fn attachment_ids_of_message(&self, message_id: &str) -> Vec<String> {
        self.ids("SELECT id FROM attachments WHERE message_id = ?", [message_id])
    }

    // ---------- enquetes ----------

    pub fn create_poll(&self, message_id: &str, question: &str, options: &[String], multi: bool) {
        ok(self.c.execute(
            "INSERT INTO polls (message_id, question, multi) VALUES (?, ?, ?)",
            params![message_id, question, multi as i64],
        ));
        for (i, text) in options.iter().enumerate() {
            ok(self.c.execute(
                "INSERT INTO poll_options (id, message_id, position, text) VALUES (?, ?, ?, ?)",
                params![new_id(), message_id, i as i64, text],
            ));
        }
    }

    fn poll_of(&self, message_id: &str) -> Option<Poll> {
        let (question, multi): (String, i64) = ok(self
            .c
            .query_row("SELECT question, multi FROM polls WHERE message_id = ?", [message_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional())?;
        let opts: Vec<(String, String)> = ok(self
            .c
            .prepare_cached("SELECT id, text FROM poll_options WHERE message_id = ? ORDER BY position")
            .and_then(|mut st| st.query_map([message_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect()));
        let options = opts
            .into_iter()
            .map(|(id, text)| {
                let voter_ids = ok(self
                    .c
                    .prepare_cached("SELECT user_id FROM poll_votes WHERE option_id = ?")
                    .and_then(|mut st| st.query_map([&id], |r| r.get(0))?.collect()));
                PollOption { id, text, voter_ids }
            })
            .collect();
        Some(Poll { question, multi: multi != 0, options })
    }

    /// Marca ou desmarca o voto. Em enquete de escolha única, trocar de opção tira o voto anterior.
    /// Devolve false se a opção não for dessa enquete.
    pub fn toggle_vote(&self, message_id: &str, option_id: &str, user_id: &str) -> bool {
        let multi: Option<i64> = ok(self
            .c
            .query_row(
                "SELECT p.multi FROM poll_options o JOIN polls p ON p.message_id = o.message_id WHERE o.id = ? AND o.message_id = ?",
                [option_id, message_id],
                |r| r.get(0),
            )
            .optional());
        let Some(multi) = multi else { return false };
        let removed = ok(self.c.execute("DELETE FROM poll_votes WHERE option_id = ? AND user_id = ?", [option_id, user_id]));
        if removed == 0 {
            if multi == 0 {
                ok(self.c.execute(
                    "DELETE FROM poll_votes WHERE user_id = ? AND option_id IN (SELECT id FROM poll_options WHERE message_id = ?)",
                    [user_id, message_id],
                ));
            }
            ok(self.c.execute("INSERT INTO poll_votes (option_id, user_id) VALUES (?, ?)", [option_id, user_id]));
        }
        true
    }

    // ---------- reações ----------

    fn reactions_of(&self, message_id: &str) -> Vec<Reaction> {
        let rows: Vec<(String, String)> = ok(self
            .c
            .prepare_cached(
                "SELECT emoji, user_id FROM message_reactions WHERE message_id = ? ORDER BY created_at, rowid",
            )
            .and_then(|mut st| st.query_map([message_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect()));
        let mut out: Vec<Reaction> = Vec::new();
        for (emoji, user_id) in rows {
            match out.iter_mut().find(|r| r.emoji == emoji) {
                Some(r) => r.user_ids.push(user_id),
                None => out.push(Reaction { emoji, user_ids: vec![user_id] }),
            }
        }
        out
    }

    /// Quantos emojis diferentes a mensagem já tem.
    pub fn reaction_kinds(&self, message_id: &str) -> i64 {
        ok(self.c.query_row(
            "SELECT COUNT(DISTINCT emoji) FROM message_reactions WHERE message_id = ?",
            [message_id],
            |r| r.get(0),
        ))
    }

    pub fn has_reaction_emoji(&self, message_id: &str, emoji: &str) -> bool {
        ok(self.c.query_row(
            "SELECT EXISTS(SELECT 1 FROM message_reactions WHERE message_id = ? AND emoji = ?)",
            [message_id, emoji],
            |r| r.get(0),
        ))
    }

    /// Devolve true se mudou algo (já tinha reagido = nada muda).
    pub fn add_reaction(&self, message_id: &str, user_id: &str, emoji: &str) -> bool {
        ok(self.c.execute(
            "INSERT OR IGNORE INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)",
            params![message_id, user_id, emoji, now_iso()],
        )) > 0
    }

    pub fn remove_reaction(&self, message_id: &str, user_id: &str, emoji: &str) -> bool {
        ok(self.c.execute(
            "DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
            [message_id, user_id, emoji],
        )) > 0
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
        let old = self.message(id).unwrap();
        let (everyone, roles) = self.resolve_mentions(&old.channel_id, &old.author.id, content);
        ok(self.c.execute(
            "UPDATE messages SET content = ?, edited_at = ?, mention_everyone = ?, mention_roles = ? WHERE id = ?",
            params![content, now_iso(), everyone as i64, roles, id],
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
        let state = if status == "blocked" {
            // Quem foi bloqueado não fica sabendo.
            if requester != viewer_id {
                return None;
            }
            "blocked"
        } else if status == "accepted" {
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
            Some((_, _, status, _)) if status == "blocked" => FriendRequest::Blocked,
            Some(_) => FriendRequest::Exists,
        }
    }

    /// Bloqueia: desfaz amizade ou pedido e impede novos pedidos e mensagens diretas.
    pub fn block_user(&self, blocker: &str, other: &str) {
        if let Some((requester, _, status, _)) = self.friendship_row(blocker, other)
            && status == "blocked"
            && requester != blocker
        {
            // A outra pessoa já bloqueou; mantém o bloqueio dela.
            return;
        }
        self.remove_relation(blocker, other);
        ok(self.c.execute(
            "INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES (?, ?, 'blocked', ?)",
            params![blocker, other, now_iso()],
        ));
    }

    pub fn unblock_user(&self, blocker: &str, other: &str) -> bool {
        ok(self.c.execute(
            "DELETE FROM friendships WHERE requester_id = ? AND addressee_id = ? AND status = 'blocked'",
            [blocker, other],
        )) > 0
    }

    /// Alguma das duas bloqueou a outra?
    pub fn is_blocked(&self, a: &str, b: &str) -> bool {
        matches!(self.friendship_row(a, b), Some((_, _, status, _)) if status == "blocked")
    }

    fn remove_relation(&self, a: &str, b: &str) -> bool {
        ok(self.c.execute(
            "DELETE FROM friendships WHERE (requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1)",
            [a, b],
        )) > 0
    }

    pub fn accept_friend(&self, user_id: &str, requester_id: &str) -> bool {
        ok(self.c.execute(
            "UPDATE friendships SET status = 'accepted', created_at = ? WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'",
            params![now_iso(), requester_id, user_id],
        )) > 0
    }

    /// Desfaz amizade, recusa ou cancela pedido. Bloqueios saem só por `unblock_user`.
    pub fn remove_friend(&self, a: &str, b: &str) -> bool {
        ok(self.c.execute(
            "DELETE FROM friendships WHERE ((requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1)) AND status != 'blocked'",
            [a, b],
        )) > 0
    }
}

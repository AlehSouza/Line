use rusqlite::Connection;

/// Migrações em ordem. Cada uma roda uma vez; a versão atual fica em PRAGMA user_version.
/// Para mudar o banco: adicione uma nova entrada no fim (nunca edite as antigas).
/// A primeira é idêntica à do servidor antigo em Node, então o arquivo line.db existente continua valendo.
const MIGRATIONS: &[&str] = &[
    // 1: fase 1 (mesmo esquema da versão Node)
    r#"
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_color  TEXT NOT NULL,
    bio           TEXT NOT NULL DEFAULT '',
    custom_status TEXT,
    status        TEXT NOT NULL DEFAULT 'online',
    created_at    TEXT NOT NULL
  );

  CREATE TABLE servers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    icon_color  TEXT NOT NULL,
    owner_id    TEXT NOT NULL REFERENCES users(id),
    is_public   INTEGER NOT NULL DEFAULT 0,
    invite_code TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE members (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nickname  TEXT,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (server_id, user_id)
  );
  CREATE INDEX members_user ON members(user_id);

  CREATE TABLE categories (
    id        TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    position  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE channels (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL,
    server_id       TEXT REFERENCES servers(id) ON DELETE CASCADE,
    category_id     TEXT REFERENCES categories(id) ON DELETE SET NULL,
    name            TEXT NOT NULL DEFAULT '',
    topic           TEXT NOT NULL DEFAULT '',
    position        INTEGER NOT NULL DEFAULT 0,
    owner_id        TEXT REFERENCES users(id),
    last_message_at TEXT,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX channels_server ON channels(server_id);

  CREATE TABLE channel_recipients (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, user_id)
  );
  CREATE INDEX channel_recipients_user ON channel_recipients(user_id);

  CREATE TABLE messages (
    id         TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id  TEXT NOT NULL REFERENCES users(id),
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    edited_at  TEXT
  );
  CREATE INDEX messages_channel ON messages(channel_id, id);

  CREATE TABLE friendships (
    requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (requester_id, addressee_id)
  );
  CREATE INDEX friendships_addressee ON friendships(addressee_id);
"#,
    // 2: anexos e threads
    r#"
  CREATE TABLE attachments (
    id           TEXT PRIMARY KEY,
    message_id   TEXT REFERENCES messages(id) ON DELETE CASCADE,
    uploader_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename     TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size         INTEGER NOT NULL,
    position     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX attachments_message ON attachments(message_id);

  ALTER TABLE channels ADD COLUMN parent_id TEXT REFERENCES channels(id) ON DELETE CASCADE;
  ALTER TABLE channels ADD COLUMN thread_message_id TEXT;
  CREATE INDEX channels_parent ON channels(parent_id);
  CREATE INDEX channels_thread_message ON channels(thread_message_id);
"#,
    // 3: email da conta (guardado em minúsculas, único quando existe)
    r#"
  ALTER TABLE users ADD COLUMN email TEXT;
  CREATE UNIQUE INDEX users_email ON users(email) WHERE email IS NOT NULL;
"#,
    // 4: enquetes
    r#"
  CREATE TABLE polls (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    multi INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE poll_options (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX poll_options_message ON poll_options(message_id);
  CREATE TABLE poll_votes (
    option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (option_id, user_id)
  );
"#,
    // 5: perfil completo (foto, banner, pronomes, pensamento)
    r#"
  ALTER TABLE users ADD COLUMN avatar_id TEXT;
  ALTER TABLE users ADD COLUMN banner_id TEXT;
  ALTER TABLE users ADD COLUMN pronouns TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN thought TEXT;
"#,
    // 6: canais privados (quem pode ver fica em channel_recipients)
    r#"
  ALTER TABLE channels ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0;
"#,
    // 7: ícone e banner do servidor
    r#"
  ALTER TABLE servers ADD COLUMN icon_id TEXT;
  ALTER TABLE servers ADD COLUMN banner_id TEXT;
"#,
    // 8: reações nas mensagens (um emoji Unicode por linha; cada pessoa reage uma vez com cada emoji)
    r#"
  CREATE TABLE IF NOT EXISTS message_reactions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, emoji, user_id)
  );
  CREATE INDEX IF NOT EXISTS message_reactions_message ON message_reactions(message_id, created_at);
"#,
    // 9: cargos e permissões. O cargo @everyone de cada servidor tem o mesmo id do servidor.
    // 48913 = ver canais, criar convite, enviar mensagens, anexar, criar threads, conectar, falar, vídeo, alterar apelido.
    r#"
  CREATE TABLE roles (
    id          TEXT PRIMARY KEY,
    server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    color       TEXT,
    permissions INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0,
    mentionable INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX roles_server ON roles(server_id);

  CREATE TABLE member_roles (
    server_id TEXT NOT NULL,
    user_id   TEXT NOT NULL,
    role_id   TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, user_id),
    FOREIGN KEY (server_id, user_id) REFERENCES members(server_id, user_id) ON DELETE CASCADE
  );
  CREATE INDEX member_roles_member ON member_roles(server_id, user_id);

  CREATE TABLE channel_roles (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, role_id)
  );

  ALTER TABLE messages ADD COLUMN mention_everyone INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE messages ADD COLUMN mention_roles TEXT NOT NULL DEFAULT '';

  INSERT INTO roles (id, server_id, name, permissions, position, created_at)
    SELECT id, id, '@everyone', 48913, 0, created_at FROM servers;
"#,
    // Recursos que o app precisa conhecer para mostrar a mensagem (ex.: "audio").
    // Apps mais antigos que não conhecem algum deles mostram "Você precisa atualizar...".
    r#"
  ALTER TABLE messages ADD COLUMN requires TEXT NOT NULL DEFAULT '';
"#,
];

pub fn open_database(file: &str) -> rusqlite::Result<Connection> {
    let conn = if file == ":memory:" {
        Connection::open_in_memory()?
    } else {
        Connection::open(file)?
    };
    if file != ":memory:" {
        conn.pragma_update(None, "journal_mode", "WAL")?;
    }
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for (v, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        conn.execute_batch(&format!(
            "BEGIN; {sql}; PRAGMA user_version = {}; COMMIT;",
            v + 1
        ))?;
    }
    Ok(())
}

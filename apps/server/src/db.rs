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
    // Conta do Google vinculada ("Entrar com Google"): o `sub` do Google.
    r#"
  ALTER TABLE users ADD COLUMN google_id TEXT;
  CREATE UNIQUE INDEX users_google_id ON users(google_id) WHERE google_id IS NOT NULL;
"#,
    // Cargo "exibir separadamente" na lista de membros.
    r#"
  ALTER TABLE roles ADD COLUMN hoist INTEGER NOT NULL DEFAULT 0;
"#,
    // Bot de música de cada servidor: um usuário de verdade (sem senha) ligado ao servidor.
    r#"
  ALTER TABLE users ADD COLUMN bot_server_id TEXT;
  CREATE UNIQUE INDEX users_bot_server ON users(bot_server_id) WHERE bot_server_id IS NOT NULL;
"#,
    // Status com duração ("Ausente por 1 hora"): quando expira volta para Disponível.
    r#"
  ALTER TABLE users ADD COLUMN status_until TEXT;
"#,
    // Segurança: email confirmado (pelo Google ou pelo link de recuperação) e
    // corte de sessões (tokens emitidos antes de sessions_after deixam de valer).
    r#"
  ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN sessions_after INTEGER NOT NULL DEFAULT 0;
  UPDATE users SET email_verified = 1 WHERE google_id IS NOT NULL;
"#,
    // Categoria privada: só os cargos escolhidos (e dono/admin) veem a categoria e os canais dela.
    r#"
  ALTER TABLE categories ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE category_roles (
    category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    role_id     TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (category_id, role_id)
  );
"#,
    // Tag do servidor (estilo tag de clã) e a tag que cada pessoa escolheu exibir.
    r#"
  ALTER TABLE servers ADD COLUMN tag TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN tag_server_id TEXT;
"#,
    // Bot de música: mensagem quando a fila acaba ('' = a padrão).
    r#"
  ALTER TABLE servers ADD COLUMN music_idle_message TEXT NOT NULL DEFAULT '';
"#,
    // Bot: cor do nome, cor da etiqueta e texto da etiqueta ("BOT" ou "B").
    r#"
  ALTER TABLE users ADD COLUMN bot_name_color TEXT;
  ALTER TABLE users ADD COLUMN bot_tag_color TEXT;
  ALTER TABLE users ADD COLUMN bot_tag_text TEXT NOT NULL DEFAULT 'BOT';
"#,
    // Ícone da tag do servidor: '' = foto do servidor; senão o nome de um ícone do Lucide.
    r#"
  ALTER TABLE servers ADD COLUMN tag_icon TEXT NOT NULL DEFAULT '';
"#,
    // Painel administrador: suspensão de contas, denúncias/bug reports, log das ações do admin,
    // contagem de uso (entradas em chamadas, músicas tocadas) e a tabela da recuperação de senha
    // (que faltava nas migrações).
    r#"
  ALTER TABLE users ADD COLUMN banned_until TEXT;
  ALTER TABLE users ADD COLUMN ban_reason TEXT;
  CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id);
  CREATE TABLE reports (
    id              TEXT PRIMARY KEY,
    kind            TEXT NOT NULL,
    reporter_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_user_id  TEXT,
    message_id      TEXT,
    channel_id      TEXT,
    server_id       TEXT,
    message_content TEXT,
    reason          TEXT NOT NULL DEFAULT '',
    details         TEXT NOT NULL DEFAULT '',
    platform        TEXT NOT NULL DEFAULT '',
    version         TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'open',
    note            TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    resolved_at     TEXT,
    resolved_by     TEXT
  );
  CREATE INDEX reports_status ON reports(status, created_at);
  CREATE TABLE admin_log (
    id         TEXT PRIMARY KEY,
    admin_id   TEXT NOT NULL,
    action     TEXT NOT NULL,
    target     TEXT NOT NULL DEFAULT '',
    detail     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE activity (
    kind       TEXT NOT NULL,
    user_id    TEXT,
    server_id  TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX activity_kind ON activity(kind, created_at);
  CREATE INDEX messages_created ON messages(created_at);
  CREATE INDEX users_created ON users(created_at);
  CREATE INDEX messages_author ON messages(author_id);
"#,
    // Admins do painel adicionados pelo dono (os de ADMIN_USERS valem sempre).
    r#"
  ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE reports ADD COLUMN message_snapshot TEXT;
  CREATE TABLE report_attachments (
    report_id     TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    PRIMARY KEY (report_id, attachment_id)
  );
"#,
    // Ordem dos servidores na barra lateral, escolhida por cada pessoa (NULL = pela entrada).
    r#"
  ALTER TABLE members ADD COLUMN rail_position INTEGER;
"#,
    // Aparência da tag (JSON: bg, fg, border, iconColor, iconStyle), respostas inteligentes do
    // agente (JSON [{q, a}]) e cor do anel de fala do agente.
    r#"
  ALTER TABLE servers ADD COLUMN tag_style TEXT NOT NULL DEFAULT '';
  ALTER TABLE servers ADD COLUMN bot_replies TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE users ADD COLUMN bot_ring_color TEXT;
"#,
    // Mensagens fixadas: quando, até quando (NULL = sempre) e por quem.
    r#"
  ALTER TABLE messages ADD COLUMN pinned_at TEXT;
  ALTER TABLE messages ADD COLUMN pinned_until TEXT;
  ALTER TABLE messages ADD COLUMN pinned_by TEXT;
  CREATE INDEX messages_pinned ON messages(channel_id, pinned_at) WHERE pinned_at IS NOT NULL;
"#,
    // Atividade de jogos: histórico por pessoa, privacidade e capas (cache da IGDB, nome em minúsculas).
    r#"
  CREATE TABLE user_games (
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    icon         TEXT,
    first_played TEXT NOT NULL,
    last_played  TEXT NOT NULL,
    total_secs   INTEGER NOT NULL DEFAULT 0,
    hidden       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, name)
  );
  CREATE TABLE activity_settings (
    user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    share          INTEGER NOT NULL DEFAULT 1,
    scope          TEXT NOT NULL DEFAULT 'all',
    hidden_servers TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE game_covers (
    name       TEXT PRIMARY KEY,
    cover      TEXT,
    fetched_at TEXT NOT NULL
  );
"#,
    r#"
  ALTER TABLE servers ADD COLUMN suspended_at TEXT;
"#,
    r#"
  ALTER TABLE users ADD COLUMN deactivated_at TEXT;
"#,
    // Quem pode interagir no canal (mandar mensagem / falar na voz) quando o canal restringe
    // isso. `kind` = 'role' ou 'user'. Os outros só leem / só escutam.
    r#"
  ALTER TABLE channels ADD COLUMN interact_restricted INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE channel_interact (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    target_id  TEXT NOT NULL,
    PRIMARY KEY (channel_id, kind, target_id)
  );
"#,
    // Mensagem que abriu uma thread com respostas não some: fica "A mensagem foi excluída.".
    r#"
  ALTER TABLE messages ADD COLUMN deleted_at TEXT;
"#,
    // Perfil completo: estilo do nome, jogo favorito e jogos que a pessoa gosta (JSON), conexões
    // (JSON [{type, name}]), notas pessoais sobre outras pessoas e usuários ignorados.
    r#"
  ALTER TABLE users ADD COLUMN name_style TEXT;
  ALTER TABLE users ADD COLUMN profile_games TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE users ADD COLUMN connections TEXT NOT NULL DEFAULT '[]';
  CREATE TABLE user_notes (
    owner_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note      TEXT NOT NULL,
    PRIMARY KEY (owner_id, target_id)
  );
  CREATE TABLE user_ignores (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, target_id)
  );
"#,
    // Tempo de jogo na semana (segunda-feira UTC em week_start).
    r#"
  ALTER TABLE user_games ADD COLUMN week_start TEXT;
  ALTER TABLE user_games ADD COLUMN week_secs INTEGER NOT NULL DEFAULT 0;
"#,
    // Notificações: configurações (JSON do app) e até onde cada pessoa leu cada canal.
    r#"
  CREATE TABLE user_settings (
    user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    notifications TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE read_states (
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_id TEXT NOT NULL,
    PRIMARY KEY (user_id, channel_id)
  );
"#,
    // Perfil por servidor (JSON: avatarId, bannerId, bio).
    r#"
  ALTER TABLE members ADD COLUMN server_profile TEXT;
"#,
    // Painel de efeitos sonoros: sons curtos (até 5 s) de cada servidor.
    r#"
  CREATE TABLE soundboard_sounds (
    id            TEXT PRIMARY KEY,
    server_id     TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
    attachment_id TEXT NOT NULL,
    name          TEXT NOT NULL,
    emoji         TEXT NOT NULL DEFAULT '',
    volume        REAL NOT NULL DEFAULT 1,
    duration      REAL NOT NULL DEFAULT 0,
    plays         INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX soundboard_sounds_server ON soundboard_sounds(server_id);
"#,
    // Agente: formato do status do canal enquanto toca (null = "▶️ {musica}", vazio = desligado).
    r#"
  ALTER TABLE users ADD COLUMN bot_now_playing TEXT;
"#,
    // Canais base ("Notas e Atualizações"), emblema de dono opcional e permissões novas.
    // Quem já podia fazer algo continua podendo: @everyone ganha os usos do dia a dia,
    // quem tinha Vídeo ganha Transmitir, Gerenciar servidor ganha sons e agente, e
    // Gerenciar mensagens ganha Fixar.
    r#"
  ALTER TABLE categories ADD COLUMN base INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE channels ADD COLUMN base TEXT NOT NULL DEFAULT '';
  ALTER TABLE servers ADD COLUMN show_owner_badge INTEGER NOT NULL DEFAULT 1;
  UPDATE roles SET permissions = permissions | (1 << 19) | (1 << 21) | (1 << 23) | (1 << 26) | (1 << 28)
    WHERE id = server_id;
  UPDATE roles SET permissions = permissions | (1 << 25) WHERE (permissions & (1 << 13)) != 0;
  UPDATE roles SET permissions = permissions | (1 << 22) | (1 << 24) WHERE (permissions & (1 << 3)) != 0;
  UPDATE roles SET permissions = permissions | (1 << 20) WHERE (permissions & (1 << 6)) != 0;
"#,
    // Eventos do canal "Eventos" e quem marcou presença.
    r#"
  CREATE TABLE events (
    id               TEXT PRIMARY KEY,
    server_id        TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id       TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    creator_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title            TEXT NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    starts_at        TEXT NOT NULL,
    ends_at          TEXT,
    location         TEXT NOT NULL DEFAULT '',
    voice_channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
    game             TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL
  );
  CREATE INDEX events_channel ON events(channel_id, starts_at);
  CREATE TABLE event_rsvps (
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status   TEXT NOT NULL,
    at       TEXT NOT NULL,
    PRIMARY KEY (event_id, user_id)
  );
"#,
    // Anexos marcados como spoiler ou +18 e data de nascimento (libera o +18).
    r#"
  ALTER TABLE attachments ADD COLUMN spoiler INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE attachments ADD COLUMN nsfw INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN birth_date TEXT;
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

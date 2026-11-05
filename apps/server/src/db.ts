import Database from 'better-sqlite3';

export type DB = Database.Database;

/**
 * Migrações em ordem. Cada uma roda uma vez; a versão atual fica em PRAGMA user_version.
 * Para mudar o banco: adicione uma nova entrada no fim (nunca edite as antigas).
 */
const migrations: string[] = [
  `
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
  `,
];

export function openDatabase(file: string): DB {
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

import type {
  Category,
  Channel,
  ChannelType,
  Friend,
  Member,
  Message,
  PublicUser,
  SelfUser,
  Server,
  UserStatus,
} from '@line/shared';
import type { DB } from './db';
import { newId, newInviteCode } from './ids';
import type { PresenceTracker } from './presence';

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  avatar_color: string;
  bio: string;
  custom_status: string | null;
  status: UserStatus;
  created_at: string;
}

interface ServerRow {
  id: string;
  name: string;
  description: string;
  icon_color: string;
  owner_id: string;
  is_public: number;
  invite_code: string;
  created_at: string;
  member_count?: number;
}

interface ChannelRow {
  id: string;
  type: ChannelType;
  server_id: string | null;
  category_id: string | null;
  name: string;
  topic: string;
  position: number;
  owner_id: string | null;
  last_message_at: string | null;
}

interface MessageRow {
  id: string;
  channel_id: string;
  author_id: string;
  content: string;
  created_at: string;
  edited_at: string | null;
}

const PALETTE = ['#00a868', '#f5b700', '#2b6cff', '#e5484d', '#8e4ec6', '#12a594', '#f76b15', '#d6409f'];
export const randomColor = () => PALETTE[Math.floor(Math.random() * PALETTE.length)]!;
const now = () => new Date().toISOString();

/** Camada de acesso a dados. Todo SQL do app mora aqui. */
export class Store {
  constructor(
    private db: DB,
    private presence: PresenceTracker,
  ) {}

  // ---------- usuários ----------

  private userRow(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  userByUsername(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  }

  toPublicUser(row: UserRow): PublicUser {
    const presence = this.presence.resolve(row.id, row.status);
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarColor: row.avatar_color,
      bio: row.bio,
      // Quem está invisível/offline não exibe status personalizado.
      customStatus: presence === 'offline' ? null : row.custom_status,
      presence,
    };
  }

  toSelfUser(row: UserRow): SelfUser {
    return {
      ...this.toPublicUser(row),
      customStatus: row.custom_status,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  publicUser(id: string): PublicUser | undefined {
    const row = this.userRow(id);
    return row && this.toPublicUser(row);
  }

  selfUser(id: string): SelfUser | undefined {
    const row = this.userRow(id);
    return row && this.toSelfUser(row);
  }

  userStatus(id: string): UserStatus {
    return this.userRow(id)?.status ?? 'online';
  }

  createUser(input: { username: string; displayName: string; passwordHash: string }): SelfUser {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO users (id, username, display_name, password_hash, avatar_color, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.username, input.displayName, input.passwordHash, randomColor(), now());
    return this.selfUser(id)!;
  }

  updateUser(
    id: string,
    patch: { displayName?: string; bio?: string; avatarColor?: string; customStatus?: string | null; status?: UserStatus },
  ): SelfUser {
    const map: Record<string, string> = {
      displayName: 'display_name',
      bio: 'bio',
      avatarColor: 'avatar_color',
      customStatus: 'custom_status',
      status: 'status',
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(map)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        values.push(value === '' && key === 'customStatus' ? null : value);
      }
    }
    if (sets.length) this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return this.selfUser(id)!;
  }

  /**
   * Todo mundo que deve ser avisado quando a presença/perfil deste usuário mudar:
   * membros de servidores em comum, participantes de DMs e amigos/pedidos.
   */
  audienceOf(userId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT m2.user_id AS id FROM members m1 JOIN members m2 ON m1.server_id = m2.server_id WHERE m1.user_id = ?
         UNION
         SELECT r2.user_id FROM channel_recipients r1 JOIN channel_recipients r2 ON r1.channel_id = r2.channel_id WHERE r1.user_id = ?
         UNION
         SELECT addressee_id FROM friendships WHERE requester_id = ?
         UNION
         SELECT requester_id FROM friendships WHERE addressee_id = ?`,
      )
      .all(userId, userId, userId, userId) as { id: string }[];
    return rows.map((r) => r.id).filter((id) => id !== userId);
  }

  // ---------- servidores ----------

  private toServer(row: ServerRow): Server {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      iconColor: row.icon_color,
      ownerId: row.owner_id,
      isPublic: !!row.is_public,
      inviteCode: row.invite_code,
      memberCount: row.member_count ?? 0,
      createdAt: row.created_at,
    };
  }

  private serverSelect = `SELECT s.*, (SELECT COUNT(*) FROM members m WHERE m.server_id = s.id) AS member_count FROM servers s`;

  server(id: string): Server | undefined {
    const row = this.db.prepare(`${this.serverSelect} WHERE s.id = ?`).get(id) as ServerRow | undefined;
    return row && this.toServer(row);
  }

  serverByInvite(code: string): Server | undefined {
    const row = this.db.prepare(`${this.serverSelect} WHERE s.invite_code = ?`).get(code) as ServerRow | undefined;
    return row && this.toServer(row);
  }

  serversOf(userId: string): Server[] {
    const rows = this.db
      .prepare(
        `${this.serverSelect} JOIN members me ON me.server_id = s.id AND me.user_id = ? ORDER BY me.joined_at`,
      )
      .all(userId) as ServerRow[];
    return rows.map((r) => this.toServer(r));
  }

  serverIdsOf(userId: string): string[] {
    return (this.db.prepare('SELECT server_id FROM members WHERE user_id = ?').all(userId) as { server_id: string }[]).map(
      (r) => r.server_id,
    );
  }

  discoverServers(userId: string, query = ''): Server[] {
    const rows = this.db
      .prepare(
        `${this.serverSelect}
         WHERE s.is_public = 1
           AND NOT EXISTS (SELECT 1 FROM members m WHERE m.server_id = s.id AND m.user_id = ?)
           AND (s.name LIKE ? OR s.description LIKE ?)
         ORDER BY member_count DESC, s.created_at DESC LIMIT 50`,
      )
      .all(userId, `%${query}%`, `%${query}%`) as ServerRow[];
    return rows.map((r) => this.toServer(r));
  }

  createServer(ownerId: string, input: { name: string; description?: string; isPublic?: boolean }): Server {
    const id = newId();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO servers (id, name, description, icon_color, owner_id, is_public, invite_code, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.name, input.description ?? '', randomColor(), ownerId, input.isPublic ? 1 : 0, newInviteCode(), now());
      this.addMember(id, ownerId);
      const text = this.createCategory(id, 'Canais de texto');
      const voice = this.createCategory(id, 'Canais de voz');
      this.createChannel(id, { name: 'geral', type: 'text', categoryId: text.id, topic: 'Bem-vindo ao servidor!' });
      this.createChannel(id, { name: 'Geral', type: 'voice', categoryId: voice.id });
    })();
    return this.server(id)!;
  }

  updateServer(
    id: string,
    patch: { name?: string; description?: string; isPublic?: boolean; iconColor?: string },
  ): Server {
    const s = this.server(id)!;
    this.db
      .prepare('UPDATE servers SET name = ?, description = ?, is_public = ?, icon_color = ? WHERE id = ?')
      .run(
        patch.name ?? s.name,
        patch.description ?? s.description,
        (patch.isPublic ?? s.isPublic) ? 1 : 0,
        patch.iconColor ?? s.iconColor,
        id,
      );
    return this.server(id)!;
  }

  resetInvite(id: string): Server {
    this.db.prepare('UPDATE servers SET invite_code = ? WHERE id = ?').run(newInviteCode(), id);
    return this.server(id)!;
  }

  deleteServer(id: string) {
    this.db.prepare('DELETE FROM servers WHERE id = ?').run(id);
  }

  // ---------- membros ----------

  isMember(serverId: string, userId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
  }

  addMember(serverId: string, userId: string): Member {
    this.db
      .prepare('INSERT OR IGNORE INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)')
      .run(serverId, userId, now());
    return this.member(serverId, userId)!;
  }

  removeMember(serverId: string, userId: string) {
    this.db.prepare('DELETE FROM members WHERE server_id = ? AND user_id = ?').run(serverId, userId);
  }

  member(serverId: string, userId: string): Member | undefined {
    const row = this.db
      .prepare('SELECT nickname, joined_at FROM members WHERE server_id = ? AND user_id = ?')
      .get(serverId, userId) as { nickname: string | null; joined_at: string } | undefined;
    if (!row) return undefined;
    return { serverId, user: this.publicUser(userId)!, nickname: row.nickname, joinedAt: row.joined_at };
  }

  members(serverId: string): Member[] {
    const rows = this.db
      .prepare(
        `SELECT u.*, m.nickname, m.joined_at AS member_joined_at FROM members m JOIN users u ON u.id = m.user_id
         WHERE m.server_id = ? ORDER BY u.display_name COLLATE NOCASE`,
      )
      .all(serverId) as (UserRow & { nickname: string | null; member_joined_at: string })[];
    return rows.map((r) => ({
      serverId,
      user: this.toPublicUser(r),
      nickname: r.nickname,
      joinedAt: r.member_joined_at,
    }));
  }

  // ---------- categorias ----------

  category(id: string): Category | undefined {
    const row = this.db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as
      | { id: string; server_id: string; name: string; position: number }
      | undefined;
    return row && { id: row.id, serverId: row.server_id, name: row.name, position: row.position };
  }

  categories(serverId: string): Category[] {
    const rows = this.db
      .prepare('SELECT * FROM categories WHERE server_id = ? ORDER BY position, id')
      .all(serverId) as { id: string; server_id: string; name: string; position: number }[];
    return rows.map((r) => ({ id: r.id, serverId: r.server_id, name: r.name, position: r.position }));
  }

  createCategory(serverId: string, name: string): Category {
    const id = newId();
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM categories WHERE server_id = ?').get(serverId) as {
      n: number;
    };
    this.db.prepare('INSERT INTO categories (id, server_id, name, position) VALUES (?, ?, ?, ?)').run(id, serverId, name, n);
    return this.category(id)!;
  }

  renameCategory(id: string, name: string): Category {
    this.db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, id);
    return this.category(id)!;
  }

  deleteCategory(id: string) {
    this.db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  }

  // ---------- canais ----------

  private toChannel(row: ChannelRow, withRecipients = true): Channel {
    const channel: Channel = {
      id: row.id,
      type: row.type,
      serverId: row.server_id,
      categoryId: row.category_id,
      name: row.name,
      topic: row.topic,
      position: row.position,
      lastMessageAt: row.last_message_at,
    };
    if (row.type === 'dm' || row.type === 'group_dm') {
      channel.ownerId = row.owner_id;
      if (withRecipients) channel.recipients = this.recipients(row.id);
    }
    return channel;
  }

  channel(id: string): Channel | undefined {
    const row = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelRow | undefined;
    return row && this.toChannel(row);
  }

  channels(serverId: string): Channel[] {
    const rows = this.db
      .prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY position, id')
      .all(serverId) as ChannelRow[];
    return rows.map((r) => this.toChannel(r));
  }

  createChannel(
    serverId: string,
    input: { name: string; type: 'text' | 'voice'; categoryId?: string | null; topic?: string },
  ): Channel {
    const id = newId();
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM channels WHERE server_id = ?').get(serverId) as {
      n: number;
    };
    this.db
      .prepare(
        `INSERT INTO channels (id, type, server_id, category_id, name, topic, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.type, serverId, input.categoryId ?? null, input.name, input.topic ?? '', n, now());
    return this.channel(id)!;
  }

  updateChannel(
    id: string,
    patch: { name?: string; topic?: string; categoryId?: string | null; position?: number },
  ): Channel {
    const c = this.channel(id)!;
    this.db
      .prepare('UPDATE channels SET name = ?, topic = ?, category_id = ?, position = ? WHERE id = ?')
      .run(
        patch.name ?? c.name,
        patch.topic ?? c.topic,
        patch.categoryId === undefined ? c.categoryId : patch.categoryId,
        patch.position ?? c.position,
        id,
      );
    return this.channel(id)!;
  }

  deleteChannel(id: string) {
    this.db.prepare('DELETE FROM channels WHERE id = ?').run(id);
  }

  // ---------- DMs ----------

  recipients(channelId: string): PublicUser[] {
    const rows = this.db
      .prepare(
        'SELECT u.* FROM channel_recipients r JOIN users u ON u.id = r.user_id WHERE r.channel_id = ? ORDER BY u.display_name',
      )
      .all(channelId) as UserRow[];
    return rows.map((r) => this.toPublicUser(r));
  }

  recipientIds(channelId: string): string[] {
    return (
      this.db.prepare('SELECT user_id FROM channel_recipients WHERE channel_id = ?').all(channelId) as {
        user_id: string;
      }[]
    ).map((r) => r.user_id);
  }

  dmsOf(userId: string): Channel[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM channels c JOIN channel_recipients r ON r.channel_id = c.id
         WHERE r.user_id = ? ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
      )
      .all(userId) as ChannelRow[];
    return rows.map((r) => this.toChannel(r));
  }

  /** Reaproveita a DM 1:1 se ela já existir. */
  findDirectDm(a: string, b: string): Channel | undefined {
    const row = this.db
      .prepare(
        `SELECT c.* FROM channels c
         JOIN channel_recipients r1 ON r1.channel_id = c.id AND r1.user_id = ?
         JOIN channel_recipients r2 ON r2.channel_id = c.id AND r2.user_id = ?
         WHERE c.type = 'dm'`,
      )
      .get(a, b) as ChannelRow | undefined;
    return row && this.toChannel(row);
  }

  createDm(ownerId: string, userIds: string[], name?: string): Channel {
    const id = newId();
    const all = [...new Set([ownerId, ...userIds])];
    const type: ChannelType = all.length > 2 ? 'group_dm' : 'dm';
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO channels (id, type, name, owner_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, type, type === 'group_dm' ? (name ?? '') : '', ownerId, now());
      const add = this.db.prepare('INSERT INTO channel_recipients (channel_id, user_id) VALUES (?, ?)');
      for (const u of all) add.run(id, u);
    })();
    return this.channel(id)!;
  }

  /** Remove do grupo; se ninguém sobrar, apaga a conversa. */
  leaveGroupDm(channelId: string, userId: string) {
    this.db.prepare('DELETE FROM channel_recipients WHERE channel_id = ? AND user_id = ?').run(channelId, userId);
    if (this.recipientIds(channelId).length === 0) this.deleteChannel(channelId);
  }

  // ---------- mensagens ----------

  private toMessage(row: MessageRow & UserRow & { message_created_at: string }): Message {
    return {
      id: row.id,
      channelId: row.channel_id,
      author: this.toPublicUser({ ...row, id: row.author_id }),
      content: row.content,
      createdAt: row.message_created_at,
      editedAt: row.edited_at,
    };
  }

  private messageSelect = `SELECT u.*, m.id, m.channel_id, m.author_id, m.content, m.created_at AS message_created_at, m.edited_at
     FROM messages m JOIN users u ON u.id = m.author_id`;

  message(id: string): Message | undefined {
    const row = this.db.prepare(`${this.messageSelect} WHERE m.id = ?`).get(id) as
      | (MessageRow & UserRow & { message_created_at: string })
      | undefined;
    return row && this.toMessage(row);
  }

  /** Mensagens mais recentes primeiro no banco, devolvidas em ordem cronológica. */
  messages(channelId: string, opts: { before?: string; limit: number }): Message[] {
    const rows = (
      opts.before
        ? this.db
            .prepare(`${this.messageSelect} WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`)
            .all(channelId, opts.before, opts.limit)
        : this.db.prepare(`${this.messageSelect} WHERE m.channel_id = ? ORDER BY m.id DESC LIMIT ?`).all(channelId, opts.limit)
    ) as (MessageRow & UserRow & { message_created_at: string })[];
    return rows.reverse().map((r) => this.toMessage(r));
  }

  createMessage(channelId: string, authorId: string, content: string): Message {
    const id = newId();
    const at = now();
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, channelId, authorId, content, at);
      this.db.prepare('UPDATE channels SET last_message_at = ? WHERE id = ?').run(at, channelId);
    })();
    return this.message(id)!;
  }

  editMessage(id: string, content: string): Message {
    this.db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(content, now(), id);
    return this.message(id)!;
  }

  deleteMessage(id: string) {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  }

  // ---------- amizades ----------

  private friendshipRow(a: string, b: string) {
    return this.db
      .prepare(
        `SELECT * FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`,
      )
      .get(a, b, b, a) as
      | { requester_id: string; addressee_id: string; status: 'pending' | 'accepted'; created_at: string }
      | undefined;
  }

  /** Relação vista por `viewerId`. */
  friend(viewerId: string, otherId: string): Friend | undefined {
    const row = this.friendshipRow(viewerId, otherId);
    if (!row) return undefined;
    const state = row.status === 'accepted' ? 'friends' : row.requester_id === viewerId ? 'outgoing' : 'incoming';
    return { user: this.publicUser(otherId)!, state, since: row.created_at };
  }

  friends(userId: string): Friend[] {
    const rows = this.db
      .prepare(
        `SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END AS other
         FROM friendships WHERE requester_id = ? OR addressee_id = ?`,
      )
      .all(userId, userId, userId) as { other: string }[];
    return rows.map((r) => this.friend(userId, r.other)!).filter(Boolean);
  }

  requestFriend(from: string, to: string): 'created' | 'accepted' | 'exists' {
    const row = this.friendshipRow(from, to);
    if (!row) {
      this.db
        .prepare('INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES (?, ?, ?, ?)')
        .run(from, to, 'pending', now());
      return 'created';
    }
    // Se a outra pessoa já tinha pedido, aceitar na hora.
    if (row.status === 'pending' && row.addressee_id === from) {
      this.acceptFriend(from, to);
      return 'accepted';
    }
    return 'exists';
  }

  acceptFriend(userId: string, requesterId: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE friendships SET status = 'accepted', created_at = ? WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'`,
      )
      .run(now(), requesterId, userId);
    return res.changes > 0;
  }

  removeFriend(a: string, b: string): boolean {
    const res = this.db
      .prepare(
        'DELETE FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)',
      )
      .run(a, b, b, a);
    return res.changes > 0;
  }
}

'use client';

import { ALL_PERMS, hasPerm, Perm, type Category, type Channel, type Friend, type Member, type Message, type Presence, type PublicUser, type Role, type SelfUser, type Server } from '@line/shared';
import { create } from 'zustand';

export type View =
  | { kind: 'home'; dmId: string | null }
  | { kind: 'server'; serverId: string; channelId: string | null }
  | { kind: 'discover' };

export type Modal =
  | { kind: 'create-server' }
  | { kind: 'create-channel'; serverId: string; categoryId: string | null }
  | { kind: 'create-category'; serverId: string }
  | { kind: 'edit-category'; categoryId: string }
  | { kind: 'edit-channel'; channelId: string }
  | { kind: 'server-settings'; serverId: string; section?: 'overview' | 'roles' }
  | { kind: 'nickname'; serverId: string; userId: string }
  | { kind: 'invite'; serverId: string }
  | { kind: 'profile' }
  | { kind: 'settings'; section?: 'account' | 'profile' | 'voice' }
  | { kind: 'create-poll'; channelId: string }
  | { kind: 'new-dm' }
  | { kind: 'user'; userId: string; at?: { x: number; y: number; above?: boolean }; hover?: boolean }
  | { kind: 'create-thread'; channelId: string; messageId?: string; suggestedName?: string }
  | { kind: 'image'; url: string; filename: string }
  | { kind: 'voice-invite'; serverId: string; channelId: string }
  | { kind: 'voice-status'; channelId: string }
  | null;

interface MessageBucket {
  items: Message[];
  hasMore: boolean;
  loaded: boolean;
}

interface MemberRef {
  userId: string;
  nickname: string | null;
  joinedAt: string;
  roleIds: string[];
}

const memberRef = (m: Member): MemberRef => ({ userId: m.user.id, nickname: m.nickname, joinedAt: m.joinedAt, roleIds: m.roleIds ?? [] });

export interface LineState {
  serverUrl: string;
  token: string | null;
  me: SelfUser | null;
  connection: 'idle' | 'connecting' | 'connected' | 'disconnected';

  users: Record<string, PublicUser>;
  servers: Record<string, Server>;
  serverOrder: string[];
  /** Servidores cujo detalhe (canais, membros) já foi carregado. */
  loadedServers: Record<string, boolean>;
  categories: Record<string, Category>;
  channels: Record<string, Channel>;
  members: Record<string, Record<string, MemberRef>>;
  /** Cargos de cada servidor, do mais alto ao mais baixo (o @everyone por último). */
  roles: Record<string, Role[]>;
  dmOrder: string[];
  friends: Record<string, Friend>;
  messages: Record<string, MessageBucket>;
  unread: Record<string, number>;
  typing: Record<string, Record<string, { name: string; until: number }>>;
  lastChannelByServer: Record<string, string>;

  view: View;
  /** Thread aberta no painel lateral direito. */
  threadId: string | null;
  /** "Responder" numa mensagem sem thread: painel aberto, thread criada só na primeira resposta. */
  threadDraft: Channel | null;
  /** Mensagem para rolar até e destacar (busca). */
  highlight: { channelId: string; messageId: string } | null;
  modal: Modal;
}

const initial: Omit<LineState, 'serverUrl' | 'token'> = {
  me: null,
  connection: 'idle',
  users: {},
  servers: {},
  serverOrder: [],
  loadedServers: {},
  categories: {},
  channels: {},
  members: {},
  roles: {},
  dmOrder: [],
  friends: {},
  messages: {},
  unread: {},
  typing: {},
  lastChannelByServer: {},
  view: { kind: 'home', dmId: null },
  threadId: null,
  threadDraft: null,
  highlight: null,
  modal: null,
};

export const useLine = create<LineState>(() => ({
  serverUrl: '',
  token: null,
  ...initial,
}));

const set = useLine.setState;
const get = useLine.getState;

// ---------- helpers de atualização (chamados pela API e pelo socket) ----------

export const actions = {
  reset(keepUrl = true) {
    set({ ...initial, token: null, serverUrl: keepUrl ? get().serverUrl : '' });
  },

  upsertUsers(list: PublicUser[]) {
    if (!list.length) return;
    set((s) => {
      const users = { ...s.users };
      for (const u of list) users[u.id] = { ...users[u.id], ...u };
      return { users };
    });
  },

  setPresence(userId: string, presence: Presence, customStatus: string | null) {
    set((s) => {
      const patch: Partial<LineState> = {};
      if (s.users[userId]) patch.users = { ...s.users, [userId]: { ...s.users[userId]!, presence, customStatus } };
      if (s.me?.id === userId) patch.me = { ...s.me, presence };
      return patch;
    });
  },

  setMe(me: SelfUser) {
    set((s) => ({ me, users: { ...s.users, [me.id]: { ...s.users[me.id], ...me } } }));
  },

  setServers(list: Server[]) {
    set({
      servers: Object.fromEntries(list.map((s) => [s.id, s])),
      serverOrder: list.map((s) => s.id),
    });
  },

  upsertServer(server: Server) {
    set((s) => ({
      servers: { ...s.servers, [server.id]: server },
      serverOrder: s.serverOrder.includes(server.id) ? s.serverOrder : [...s.serverOrder, server.id],
    }));
  },

  removeServer(id: string) {
    set((s) => {
      const servers = { ...s.servers };
      delete servers[id];
      const channels = Object.fromEntries(Object.entries(s.channels).filter(([, c]) => c.serverId !== id));
      const categories = Object.fromEntries(Object.entries(s.categories).filter(([, c]) => c.serverId !== id));
      const view: View = s.view.kind === 'server' && s.view.serverId === id ? { kind: 'home', dmId: null } : s.view;
      return { servers, channels, categories, serverOrder: s.serverOrder.filter((x) => x !== id), view };
    });
  },

  loadServerDetail(serverId: string, categories: Category[], channels: Channel[], members: Member[], roles: Role[] = []) {
    actions.upsertUsers(members.map((m) => m.user));
    set((s) => ({
      loadedServers: { ...s.loadedServers, [serverId]: true },
      categories: {
        ...Object.fromEntries(Object.entries(s.categories).filter(([, c]) => c.serverId !== serverId)),
        ...Object.fromEntries(categories.map((c) => [c.id, c])),
      },
      channels: {
        ...Object.fromEntries(Object.entries(s.channels).filter(([, c]) => c.serverId !== serverId)),
        ...Object.fromEntries(channels.map((c) => [c.id, c])),
      },
      members: {
        ...s.members,
        [serverId]: Object.fromEntries(members.map((m) => [m.user.id, memberRef(m)])),
      },
      roles: { ...s.roles, [serverId]: roles },
    }));
  },

  setRoles(serverId: string, roles: Role[]) {
    set((s) => ({ roles: { ...s.roles, [serverId]: roles } }));
  },

  upsertMember(member: Member) {
    actions.upsertUsers([member.user]);
    set((s) => ({
      members: {
        ...s.members,
        [member.serverId]: {
          ...s.members[member.serverId],
          [member.user.id]: memberRef(member),
        },
      },
    }));
  },

  removeMember(serverId: string, userId: string) {
    set((s) => {
      const list = { ...s.members[serverId] };
      delete list[userId];
      return { members: { ...s.members, [serverId]: list } };
    });
  },

  upsertChannel(channel: Channel) {
    if (channel.recipients) actions.upsertUsers(channel.recipients);
    set((s) => {
      const isDm = !channel.serverId;
      const dmOrder = isDm ? [channel.id, ...s.dmOrder.filter((x) => x !== channel.id)] : s.dmOrder;
      const existing = s.channels[channel.id];
      // Ao atualizar uma DM existente, mantém a ordem atual.
      return {
        channels: { ...s.channels, [channel.id]: channel },
        dmOrder: isDm && existing ? s.dmOrder : dmOrder,
      };
    });
  },

  setDms(list: Channel[]) {
    for (const c of list) if (c.recipients) actions.upsertUsers(c.recipients);
    set((s) => ({
      channels: { ...s.channels, ...Object.fromEntries(list.map((c) => [c.id, c])) },
      dmOrder: list.map((c) => c.id),
    }));
  },

  removeChannel(id: string) {
    set((s) => {
      const channels = { ...s.channels };
      delete channels[id];
      let view = s.view;
      if (view.kind === 'server' && view.channelId === id) view = { ...view, channelId: null };
      if (view.kind === 'home' && view.dmId === id) view = { kind: 'home', dmId: null };
      // Apagar um canal também leva as threads dele.
      for (const [cid, c] of Object.entries(channels)) if (c.parentId === id) delete channels[cid];
      const threadId = s.threadId && channels[s.threadId] ? s.threadId : null;
      return { channels, dmOrder: s.dmOrder.filter((x) => x !== id), view, threadId };
    });
  },

  upsertCategory(category: Category) {
    set((s) => ({ categories: { ...s.categories, [category.id]: category } }));
  },

  removeCategory(id: string) {
    set((s) => {
      const categories = { ...s.categories };
      delete categories[id];
      return { categories };
    });
  },

  setFriends(list: Friend[]) {
    actions.upsertUsers(list.map((f) => f.user));
    set({ friends: Object.fromEntries(list.map((f) => [f.user.id, f])) });
  },

  upsertFriend(friend: Friend) {
    actions.upsertUsers([friend.user]);
    set((s) => ({ friends: { ...s.friends, [friend.user.id]: friend } }));
  },

  removeFriend(userId: string) {
    set((s) => {
      const friends = { ...s.friends };
      delete friends[userId];
      return { friends };
    });
  },

  // ----- mensagens -----

  setMessages(channelId: string, items: Message[], hasMore: boolean, prepend = false) {
    actions.upsertUsers(items.map((m) => m.author));
    set((s) => {
      const prev = s.messages[channelId];
      const merged = prepend && prev ? [...items, ...prev.items] : items;
      return { messages: { ...s.messages, [channelId]: { items: merged, hasMore, loaded: true } } };
    });
  },

  addMessage(message: Message) {
    set((s) => {
      const bucket = s.messages[message.channelId];
      const channel = s.channels[message.channelId];
      const patch: Partial<LineState> = {};
      if (bucket && !bucket.items.some((m) => m.id === message.id)) {
        patch.messages = { ...s.messages, [message.channelId]: { ...bucket, items: [...bucket.items, message] } };
      }
      if (channel) {
        patch.channels = { ...s.channels, [channel.id]: { ...channel, lastMessageAt: message.createdAt } };
        if (!channel.serverId) patch.dmOrder = [channel.id, ...s.dmOrder.filter((x) => x !== channel.id)];
      }
      // Quem enviou parou de digitar.
      const typing = s.typing[message.channelId];
      if (typing?.[message.author.id]) {
        const t = { ...typing };
        delete t[message.author.id];
        patch.typing = { ...s.typing, [message.channelId]: t };
      }
      return patch;
    });
  },

  updateMessage(message: Message) {
    set((s) => {
      const bucket = s.messages[message.channelId];
      if (!bucket) return {};
      return {
        messages: {
          ...s.messages,
          [message.channelId]: { ...bucket, items: bucket.items.map((m) => (m.id === message.id ? message : m)) },
        },
      };
    });
  },

  deleteMessage(channelId: string, id: string) {
    set((s) => {
      const bucket = s.messages[channelId];
      if (!bucket) return {};
      return { messages: { ...s.messages, [channelId]: { ...bucket, items: bucket.items.filter((m) => m.id !== id) } } };
    });
  },

  markUnread(channelId: string) {
    set((s) => ({ unread: { ...s.unread, [channelId]: (s.unread[channelId] ?? 0) + 1 } }));
  },

  markRead(channelId: string) {
    if (!get().unread[channelId]) return;
    set((s) => {
      const unread = { ...s.unread };
      delete unread[channelId];
      return { unread };
    });
  },

  setTyping(channelId: string, userId: string, name: string) {
    set((s) => ({
      typing: { ...s.typing, [channelId]: { ...s.typing[channelId], [userId]: { name, until: Date.now() + 8000 } } },
    }));
  },

  pruneTyping() {
    const now = Date.now();
    const { typing } = get();
    let changed = false;
    const next: LineState['typing'] = {};
    for (const [cid, users] of Object.entries(typing)) {
      const alive = Object.fromEntries(Object.entries(users).filter(([, t]) => t.until > now));
      if (Object.keys(alive).length !== Object.keys(users).length) changed = true;
      if (Object.keys(alive).length) next[cid] = alive;
    }
    if (changed) set({ typing: next });
  },

  // ----- navegação -----

  goHome(dmId: string | null = null) {
    set({ view: { kind: 'home', dmId }, threadId: null });
    if (dmId) actions.markRead(dmId);
  },

  goServer(serverId: string, channelId?: string | null) {
    const s = get();
    const target = channelId ?? s.lastChannelByServer[serverId] ?? null;
    set((st) => ({
      view: { kind: 'server', serverId, channelId: target },
      // A thread aberta só continua se for deste canal.
      threadId: st.threadId && st.channels[st.threadId]?.parentId === target ? st.threadId : null,
      lastChannelByServer: target ? { ...st.lastChannelByServer, [serverId]: target } : st.lastChannelByServer,
    }));
    if (target) actions.markRead(target);
  },

  goDiscover() {
    set({ view: { kind: 'discover' }, threadId: null });
  },

  /** Abre o painel de resposta de uma mensagem que ainda não tem thread. */
  openThreadDraft(parent: Channel, messageId: string, name: string) {
    const id = `draft:${messageId}`;
    const draft: Channel = {
      ...parent,
      id,
      type: 'thread',
      name,
      parentId: parent.id,
      threadMessageId: messageId,
      messageCount: 0,
    };
    set((s) => ({
      threadDraft: draft,
      threadId: null,
      messages: { ...s.messages, [id]: { items: [], hasMore: false, loaded: true } },
    }));
  },

  /** Abre uma thread no painel lateral, indo para o canal onde ela nasceu. */
  openThread(threadId: string) {
    const thread = get().channels[threadId];
    if (!thread) return;
    set({ threadDraft: null });
    if (thread.serverId && thread.parentId) {
      const v = get().view;
      if (v.kind !== 'server' || v.channelId !== thread.parentId) actions.goServer(thread.serverId, thread.parentId);
    }
    set({ threadId });
    actions.markRead(threadId);
  },

  setHighlight(h: { channelId: string; messageId: string } | null) {
    set({ highlight: h });
  },

  closeThread() {
    set({ threadId: null, threadDraft: null });
  },

  openModal(modal: Modal) {
    set({ modal });
  },

  closeModal() {
    set({ modal: null });
  },
};

// ---------- seletores ----------

/** Primeiro canal de texto do servidor, na ordem em que aparece na barra lateral. */
export function firstTextChannel(s: LineState, serverId: string): string | null {
  const catPos = (id: string | null) => (id && s.categories[id] ? s.categories[id]!.position : -1);
  const list = Object.values(s.channels)
    .filter((c) => c.serverId === serverId && c.type === 'text')
    .sort((a, b) => catPos(a.categoryId) - catPos(b.categoryId) || a.position - b.position);
  return list[0]?.id ?? null;
}

export function currentChannelId(s: LineState): string | null {
  if (s.view.kind === 'server') return s.view.channelId;
  if (s.view.kind === 'home') return s.view.dmId;
  return null;
}

export function dmTitle(channel: Channel, meId: string | undefined, users: Record<string, PublicUser>): string {
  if (channel.type === 'group_dm' && channel.name) return channel.name;
  const others = (channel.recipients ?? []).filter((r) => r.id !== meId);
  if (!others.length) return 'Só você';
  return others.map((r) => users[r.id]?.displayName ?? r.displayName).join(', ');
}

// ---------- cargos e permissões ----------

/** Permissões de alguém no servidor (mesma conta do servidor: @everyone + cargos; dono e admin = tudo). */
export function permsOf(s: LineState, serverId: string | null | undefined, userId: string | undefined): number {
  if (!serverId || !userId) return ALL_PERMS;
  const server = s.servers[serverId];
  if (server?.ownerId === userId) return ALL_PERMS;
  const roles = s.roles[serverId] ?? [];
  const mine = s.members[serverId]?.[userId]?.roleIds ?? [];
  let p = roles.find((r) => r.id === serverId)?.permissions ?? 0;
  for (const r of roles) if (mine.includes(r.id)) p |= r.permissions;
  return hasPerm(p, Perm.Administrator) ? ALL_PERMS : p;
}

/** Minhas permissões no servidor (fora de servidor, tudo). */
export function useMyPerms(serverId: string | null | undefined): number {
  return useLine((s) => permsOf(s, serverId, s.me?.id));
}

export function useCan(serverId: string | null | undefined, flag: number): boolean {
  return useLine((s) => hasPerm(permsOf(s, serverId, s.me?.id), flag));
}

/** Cor do cargo mais alto (com cor) da pessoa no servidor. */
export function memberColor(s: LineState, serverId: string | null | undefined, userId: string): string | undefined {
  if (!serverId) return undefined;
  const mine = s.members[serverId]?.[userId]?.roleIds;
  if (!mine?.length) return undefined;
  return (s.roles[serverId] ?? []).find((r) => r.color && mine.includes(r.id))?.color ?? undefined;
}

export function useMemberColor(serverId: string | null | undefined, userId: string): string | undefined {
  return useLine((s) => memberColor(s, serverId, userId));
}

/** Posição do cargo mais alto (dono = infinito). */
export function topPosition(s: LineState, serverId: string, userId: string | undefined): number {
  if (!userId) return 0;
  if (s.servers[serverId]?.ownerId === userId) return Infinity;
  const mine = s.members[serverId]?.[userId]?.roleIds ?? [];
  return Math.max(0, ...(s.roles[serverId] ?? []).filter((r) => mine.includes(r.id)).map((r) => r.position));
}

/** Troca `<@&id>` por `@Nome do cargo` (para notificações e para editar mensagens). */
export function mentionsToText(content: string, serverId: string | null | undefined): string {
  if (!serverId || !content.includes('<@&')) return content;
  const roles = get().roles[serverId] ?? [];
  return content.replace(/<@&([\w-]+)>/g, (all, id: string) => {
    const r = roles.find((x) => x.id === id);
    return r ? `@${r.name}` : all;
  });
}

/** O contrário: `@Nome do cargo` digitado vira `<@&id>` (nomes mais longos primeiro). */
export function textToMentions(content: string, serverId: string | null | undefined): string {
  if (!serverId) return content;
  const roles = (get().roles[serverId] ?? []).filter((r) => r.id !== serverId).sort((a, b) => b.name.length - a.name.length);
  let out = content;
  for (const r of roles) {
    const esc = r.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(^|[^\\w<&])@${esc}(?![\\w])`, 'gu'), (_m, pre: string) => `${pre}<@&${r.id}>`);
  }
  return out;
}

/** Nome mostrado dentro do servidor: o apelido de lá, senão o nome de exibição. */
export function displayNameIn(s: LineState, serverId: string | null | undefined, userId: string): string {
  const nick = serverId ? s.members[serverId]?.[userId]?.nickname : null;
  return nick || s.users[userId]?.displayName || 'Alguém';
}

export function useDisplayName(serverId: string | null | undefined, userId: string): string {
  return useLine((s) => displayNameIn(s, serverId, userId));
}

'use client';

import type { ClientToServerEvents, Message, ServerToClientEvents } from '@line/shared';
import { io, type Socket } from 'socket.io-client';
import { api, configureApi, DEFAULT_SERVER_URL } from './api';
import { actions, currentChannelId, dmTitle, firstTextChannel, mentionsToText, useLine, type View } from './store';
import { bindVoiceSocket, syncVoice, unbindVoice } from './voice';

/** Convites de voz (ver components/VoiceInvite) viram um texto legível na notificação. */
const previewContent = (c: string) => c.replace(/^\[\[voz:[\w-]+:[\w-]+:[\w-]+\]\]\s?(.*)$/, '🔊 Convite para a chamada de voz $1');

type LineSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const STORAGE_URL = 'line.serverUrl';
const STORAGE_TOKEN = 'line.token';
const IDLE_AFTER_MS = 5 * 60 * 1000;

let socket: LineSocket | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let isIdle = false;
let typingTicker: ReturnType<typeof setInterval> | null = null;
let idleSetup = false;

const storage = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* ignora */
    }
  },
};

export function savedServerUrl() {
  return DEFAULT_SERVER_URL;
}

/** Tenta reabrir a sessão salva. Retorna true se conseguiu. */
export async function restoreSession(): Promise<boolean> {
  const serverUrl = savedServerUrl();
  // Login feito em outro servidor (antes do useline.tech) não vale aqui: começa do zero.
  if ((storage.get(STORAGE_URL) ?? serverUrl) !== serverUrl) storage.set(STORAGE_TOKEN, null);
  const token = storage.get(STORAGE_TOKEN);
  useLine.setState({ serverUrl });
  configureApi({ baseUrl: serverUrl, token, onUnauthorized: logout });
  if (!token) return false;
  try {
    const me = await api.me();
    useLine.setState({ token });
    actions.setMe(me);
    await bootstrap();
    return true;
  } catch {
    storage.set(STORAGE_TOKEN, null);
    configureApi({ token: null });
    return false;
  }
}

export async function authenticate(
  mode: 'login' | 'register',
  serverUrl: string,
  username: string,
  password: string,
  displayName?: string,
  email?: string,
  captchaToken?: string,
) {
  let url = serverUrl.trim().replace(/\/+$/, '') || DEFAULT_SERVER_URL;
  // Aceita "10.0.0.5:4000" ou "line.exemplo.com" sem o http(s)://
  if (!/^https?:\/\//i.test(url)) url = `${/^(localhost|\d{1,3}(\.\d{1,3}){3})(:|$)/.test(url) ? 'http' : 'https'}://${url}`;
  configureApi({ baseUrl: url, token: null, onUnauthorized: logout });
  const res = mode === 'login' ? await api.login(username, password) : await api.register(username, password, displayName, email, captchaToken);
  storage.set(STORAGE_URL, url);
  storage.set(STORAGE_TOKEN, res.token);
  configureApi({ token: res.token });
  useLine.setState({ serverUrl: url, token: res.token });
  actions.setMe(res.user);
  await bootstrap();
}

export function logout() {
  unbindVoice();
  socket?.disconnect();
  socket = null;
  if (typingTicker) clearInterval(typingTicker);
  typingTicker = null;
  storage.set(STORAGE_TOKEN, null);
  configureApi({ token: null });
  actions.reset();
}

async function bootstrap() {
  const [servers, dms, friends] = await Promise.all([api.servers(), api.dms(), api.friends()]);
  actions.setServers(servers);
  actions.setDms(dms);
  actions.setFriends(friends);
  restoreView();
  connectSocket();
  setupIdleDetection();
  if (!typingTicker) typingTicker = setInterval(actions.pruneTyping, 2000);
  requestNotificationPermission();
}

const STORAGE_VIEW = 'line.view';
let viewSaver: (() => void) | null = null;

/** Volta para o servidor/canal ou conversa privada que estava aberto antes do F5. */
function restoreView() {
  try {
    const saved = JSON.parse(storage.get(STORAGE_VIEW) ?? 'null') as View | null;
    const s = useLine.getState();
    if (saved?.kind === 'server' && s.servers[saved.serverId]) actions.goServer(saved.serverId, saved.channelId);
    else if (saved?.kind === 'home' && saved.dmId && s.channels[saved.dmId]) actions.goHome(saved.dmId);
    else if (saved?.kind === 'discover') actions.goDiscover();
  } catch {
    /* sem lugar salvo */
  }
  viewSaver ??= useLine.subscribe((st, prev) => {
    if (st.view !== prev.view) storage.set(STORAGE_VIEW, JSON.stringify(st.view));
    // Abriu outro servidor: confere quem está na voz dele.
    const sid = st.view.kind === 'server' ? st.view.serverId : null;
    const before = prev.view.kind === 'server' ? prev.view.serverId : null;
    if (sid && sid !== before) void syncVoice();
  });
}

export async function ensureServerLoaded(serverId: string, force = false) {
  if (!force && useLine.getState().loadedServers[serverId]) return;
  const detail = await api.server(serverId);
  actions.upsertServer(detail.server);
  actions.loadServerDetail(serverId, detail.categories, detail.channels, detail.members, detail.roles);
}

/** Abre o canal (ou a thread) da mensagem e rola até ela. */
export async function jumpToMessage(message: Message) {
  const s = useLine.getState();
  const channel = s.channels[message.channelId];
  if (!channel) return;
  const bucket = s.messages[channel.id];
  if (!bucket?.items.some((m) => m.id === message.id)) {
    const items = await api.messagesAround(channel.id, message.id);
    actions.setMessages(channel.id, items, true);
  }
  if (channel.type === 'thread' && channel.parentId && channel.serverId) {
    actions.goServer(channel.serverId, channel.parentId);
    actions.openThread(channel.id);
  } else if (channel.serverId) {
    actions.goServer(channel.serverId, channel.id);
  } else {
    actions.goHome(channel.id);
  }
  actions.setHighlight({ channelId: channel.id, messageId: message.id });
}

export async function loadMessages(channelId: string, older = false) {
  const bucket = useLine.getState().messages[channelId];
  if (older && (!bucket || !bucket.hasMore)) return;
  if (!older && bucket?.loaded) return;
  const before = older ? bucket?.items[0]?.id : undefined;
  const limit = 50;
  const items = await api.messages(channelId, before, limit);
  actions.setMessages(channelId, items, items.length === limit, older);
}

let lastTypingSent = 0;
export function sendTyping(channelId: string) {
  const now = Date.now();
  if (now - lastTypingSent < 4000) return;
  lastTypingSent = now;
  socket?.emit('typing:start', { channelId });
}

function connectSocket() {
  const { serverUrl, token } = useLine.getState();
  socket?.disconnect();
  firstReady = true;
  useLine.setState({ connection: 'connecting' });
  const s: LineSocket = io(serverUrl, { auth: { token }, transports: ['websocket'] });
  socket = s;
  bindVoiceSocket(s, useLine.getState().me!.id);

  s.on('connect', () => {
    useLine.setState({ connection: 'connected' });
    void syncVoice();
  });
  s.on('disconnect', () => useLine.setState({ connection: 'disconnected' }));
  s.on('connect_error', (err) => {
    useLine.setState({ connection: 'disconnected' });
    if (err.message === 'unauthorized') logout();
  });

  s.on('ready', ({ user }) => {
    actions.setMe(user);
    // Ao reconectar, recarrega o que pode ter mudado enquanto estávamos fora.
    void resync();
  });

  s.on('message:create', onMessage);
  s.on('message:update', (m) => actions.updateMessage(m));
  s.on('message:delete', ({ id, channelId }) => actions.deleteMessage(channelId, id));
  s.on('typing:start', ({ channelId, userId, displayName }) => actions.setTyping(channelId, userId, displayName));
  s.on('presence:update', ({ userId, presence, customStatus }) => actions.setPresence(userId, presence, customStatus));
  s.on('user:update', (u) => actions.upsertUsers([u]));
  s.on('self:update', (u) => actions.setMe(u));
  s.on('server:create', (srv) => {
    actions.upsertServer(srv);
    void syncVoice();
  });
  s.on('server:update', (srv) => actions.upsertServer(srv));
  s.on('server:delete', ({ id }) => actions.removeServer(id));
  s.on('member:add', (m) => {
    actions.upsertMember(m);
    const srv = useLine.getState().servers[m.serverId];
    if (srv) actions.upsertServer({ ...srv, memberCount: srv.memberCount + 1 });
  });
  s.on('member:remove', ({ serverId, userId }) => {
    actions.removeMember(serverId, userId);
    const srv = useLine.getState().servers[serverId];
    if (srv) actions.upsertServer({ ...srv, memberCount: Math.max(0, srv.memberCount - 1) });
  });
  s.on('member:update', (m) => {
    actions.upsertMember(m);
    // Meus cargos mudaram: os canais que eu vejo podem ter mudado.
    if (m.user.id === useLine.getState().me?.id) refreshServer(m.serverId);
  });
  s.on('roles:update', ({ serverId, roles }) => {
    actions.setRoles(serverId, roles);
    refreshServer(serverId);
  });
  s.on('channel:create', (c) => actions.upsertChannel(c));
  s.on('channel:update', (c) => actions.upsertChannel(c));
  s.on('channel:delete', ({ id }) => actions.removeChannel(id));
  s.on('category:create', (c) => actions.upsertCategory(c));
  s.on('category:update', (c) => actions.upsertCategory(c));
  s.on('category:delete', ({ id }) => actions.removeCategory(id));
  s.on('friend:update', (f) => actions.upsertFriend(f));
  s.on('friend:remove', ({ userId }) => actions.removeFriend(userId));
}

/** Recarrega canais e convite depois de mudar cargo ou permissão (agrupa rajadas de eventos). */
const refreshTimers: Record<string, ReturnType<typeof setTimeout>> = {};
function refreshServer(serverId: string) {
  if (!useLine.getState().loadedServers[serverId]) return;
  clearTimeout(refreshTimers[serverId]);
  refreshTimers[serverId] = setTimeout(() => {
    void ensureServerLoaded(serverId, true)
      .then(() => {
        // Se perdi acesso ao canal aberto, volta para o primeiro que ainda vejo.
        const st = useLine.getState();
        if (st.view.kind === 'server' && st.view.serverId === serverId && st.view.channelId && !st.channels[st.view.channelId])
          actions.goServer(serverId, firstTextChannel(st, serverId));
      })
      .catch(() => {});
  }, 300);
}

/** A mensagem me menciona? (@meu_usuario, @everyone/@here válido ou um cargo que eu tenho). */
export function mentionsMe(message: Message): boolean {
  const st = useLine.getState();
  const me = st.me;
  if (!me || message.author.id === me.id) return false;
  if (message.content.toLowerCase().includes(`@${me.username}`)) return true;
  if (message.mentionEveryone) return true;
  const serverId = st.channels[message.channelId]?.serverId;
  const mine = serverId ? (st.members[serverId]?.[me.id]?.roleIds ?? []) : [];
  return (message.mentionRoleIds ?? []).some((r) => mine.includes(r));
}

let firstReady = true;
async function resync() {
  if (firstReady) {
    firstReady = false;
    return;
  }
  const [servers, dms, friends] = await Promise.all([api.servers(), api.dms(), api.friends()]);
  actions.setServers(servers);
  actions.setDms(dms);
  actions.setFriends(friends);
  useLine.setState({ loadedServers: {}, messages: {} });
  const { view } = useLine.getState();
  if (view.kind === 'server') await ensureServerLoaded(view.serverId);
}

function onMessage(message: Message) {
  const state = useLine.getState();
  // DM nova que ainda não conhecemos: busca a lista de novo.
  if (!state.channels[message.channelId]) void api.dms().then(actions.setDms);
  actions.addMessage(message);
  actions.upsertUsers([message.author]);

  const mine = message.author.id === state.me?.id;
  if (mine) return;
  const viewing =
    (currentChannelId(state) === message.channelId || state.threadId === message.channelId) && document.hasFocus();
  if (!viewing) actions.markUnread(message.channelId);

  const channel = state.channels[message.channelId];
  const isDm = !channel?.serverId;
  const mentioned = mentionsMe(message);
  const dnd = state.me?.status === 'dnd';
  if (!viewing && !dnd && (isDm || mentioned)) notify(message);
}

function notify(message: Message) {
  const state = useLine.getState();
  const channel = state.channels[message.channelId];
  let title = message.author.displayName;
  if (channel?.serverId) {
    const srv = state.servers[channel.serverId];
    title = `${message.author.displayName} (#${channel.name}${srv ? `, ${srv.name}` : ''})`;
  } else if (channel?.type === 'group_dm') {
    title = `${message.author.displayName} em ${dmTitle(channel, state.me?.id, state.users)}`;
  }
  window.line?.requestAttention();
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const body = (message.content && previewContent(mentionsToText(message.content, channel?.serverId))) || (message.attachments.length ? `📎 ${message.attachments.map((a) => a.filename).join(', ')}` : '');
  const n = new Notification(title, { body: body.slice(0, 200), silent: false });
  n.onclick = () => {
    window.focus();
    if (channel?.type === 'thread') actions.openThread(channel.id);
    else if (channel?.serverId) actions.goServer(channel.serverId, channel.id);
    else actions.goHome(message.channelId);
  };
}

function requestNotificationPermission() {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    void Notification.requestPermission();
  }
}

function setupIdleDetection() {
  if (typeof window === 'undefined' || idleSetup) return;
  idleSetup = true;
  const reset = () => {
    if (isIdle) {
      isIdle = false;
      socket?.emit('presence:activity', { idle: false });
    }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      isIdle = true;
      socket?.emit('presence:activity', { idle: true });
    }, IDLE_AFTER_MS);
  };
  for (const ev of ['mousemove', 'keydown', 'mousedown', 'wheel', 'focus']) {
    window.addEventListener(ev, reset, { passive: true });
  }
  reset();
}

declare global {
  interface Window {
    line?: {
      isDesktop: boolean;
      version?: string;
      platform: string;
      requestAttention: () => void;
      setBadge: (count: number) => void;
      window?: {
        minimize: () => void;
        toggleMaximize: () => Promise<boolean>;
        isMaximized: () => Promise<boolean>;
        close: () => void;
      };
      updates?: {
        check: () => Promise<string | null>;
        install: () => Promise<void>;
      };
    };
  }
}

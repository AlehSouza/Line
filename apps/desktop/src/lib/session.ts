'use client';

import { loadIgnored } from './ignored';
import type { ClientToServerEvents, Message, ServerToClientEvents } from '@line/shared';
import { io, type Socket } from 'socket.io-client';
import { api, configureApi, DEFAULT_SERVER_URL, fileUrl } from './api';
import { actions, currentChannelId, dmTitle, firstTextChannel, mentionsToText, useLine, type View } from './store';
import { bindVoiceSocket, syncVoice, unbindVoice } from './voice';
import { bindMusicSocket, syncMusic } from './music';
import { bindSoundsSocket } from './sounds';
import { handleIncoming, loadNotifyState, onRemoteAck, pref } from './notify';

/** Convites de voz (ver components/VoiceInvite) viram um texto legível na notificação. */
const previewContent = (c: string) =>
  c
    .replace(/^\[\[voz:[\w-]+:[\w-]+:[\w-]+\]\]\s?(.*)$/, '🔊 Convite para a chamada de voz $1')
    .replace(/^\[\[musica:[^\]]*\]\]\s?([^\n]*)[\s\S]*$/, '🎵 Tocando agora: $1');

type LineSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const STORAGE_URL = 'line.serverUrl';
const STORAGE_TOKEN = 'line.token';
/** "Manter sessão" desmarcado: o token fica só no sessionStorage e some ao fechar o app/navegador. */
const STORAGE_REMEMBER = 'line.remember';
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

/** Lê/salva o token respeitando o "Manter sessão". */
const tokenStore = {
  get: () => {
    try {
      return sessionStorage.getItem(STORAGE_TOKEN) ?? storage.get(STORAGE_TOKEN);
    } catch {
      return storage.get(STORAGE_TOKEN);
    }
  },
  set: (v: string | null) => {
    const keep = rememberSession();
    try {
      if (v === null || keep) sessionStorage.removeItem(STORAGE_TOKEN);
      else sessionStorage.setItem(STORAGE_TOKEN, v);
    } catch {
      /* ignora */
    }
    storage.set(STORAGE_TOKEN, keep ? v : null);
  },
};

/** Preferência do "Manter sessão" (padrão: marcado). */
export function rememberSession() {
  return storage.get(STORAGE_REMEMBER) !== '0';
}

export function setRememberSession(on: boolean) {
  storage.set(STORAGE_REMEMBER, on ? null : '0');
}

export function savedServerUrl() {
  return DEFAULT_SERVER_URL;
}

/** Tenta reabrir a sessão salva. Retorna true se conseguiu. */
export async function restoreSession(): Promise<boolean> {
  const serverUrl = savedServerUrl();
  // Login feito em outro servidor (antes do useline.tech) não vale aqui: começa do zero.
  if ((storage.get(STORAGE_URL) ?? serverUrl) !== serverUrl) tokenStore.set(null);
  const token = tokenStore.get();
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
    tokenStore.set(null);
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
  tokenStore.set(res.token);
  configureApi({ token: res.token });
  useLine.setState({ serverUrl: url, token: res.token });
  actions.setMe(res.user);
  await bootstrap();
}

/** "Entrar com Google": troca o código de uso único (que voltou do Google) pelo token. */
export async function authenticateWithGoogle(serverUrl: string, code: string, desktop = false) {
  const url = serverUrl.trim().replace(/\/+$/, '') || DEFAULT_SERVER_URL;
  configureApi({ baseUrl: url, token: null, onUnauthorized: logout });
  const res = await api.googleFinish(code, desktop);
  storage.set(STORAGE_URL, url);
  tokenStore.set(res.token);
  configureApi({ token: res.token });
  useLine.setState({ serverUrl: url, token: res.token });
  actions.setMe(res.user);
  await bootstrap();
}

/** Troca o token da sessão (ex.: depois de mudar a senha, que derruba as sessões antigas) e reconecta. */
export function replaceToken(token: string) {
  tokenStore.set(token);
  configureApi({ token });
  useLine.setState({ token });
  if (socket) connectSocket();
}

let lastGame: { name: string; icon?: string } | null = null;

/** Conta ao servidor qual jogo está aberto (ou null). Só manda quando muda. */
export function reportGame(game: { name: string; icon?: string } | null) {
  if ((game?.name ?? null) === (lastGame?.name ?? null)) return;
  lastGame = game;
  socket?.emit('presence:game', game);
}

export function logout() {
  unbindVoice();
  socket?.disconnect();
  socket = null;
  if (typingTicker) clearInterval(typingTicker);
  typingTicker = null;
  tokenStore.set(null);
  configureApi({ token: null });
  actions.reset();
}

/** Link de perfil compartilhado (useline.tech/app/?perfil=<id>): abre o perfil e limpa a URL. */
function openSharedProfile() {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const id = url.searchParams.get('perfil');
  if (!id) return;
  url.searchParams.delete('perfil');
  window.history.replaceState(window.history.state, '', url.toString());
  api.user(id).then(
    (u) => {
      actions.upsertUsers([u]);
      actions.openModal({ kind: 'full-profile', userId: u.id });
    },
    () => {},
  );
}

/** Link de convite (useline.tech/app/?convite=...): abre a tela do convite e limpa a URL. */
function openSharedInvite() {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const code = url.searchParams.get('convite');
  if (!code) return;
  url.searchParams.delete('convite');
  window.history.replaceState(window.history.state, '', url.toString());
  actions.openModal({ kind: 'invite-page', code });
}

/** Link de mensagem (useline.tech/app/?mensagem=...): abre o canal na mensagem e limpa a URL. */
function openSharedMessage() {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const value = url.searchParams.get('mensagem');
  if (!value) return;
  url.searchParams.delete('mensagem');
  window.history.replaceState(window.history.state, '', url.toString());
  void import('./messageLink').then((m) => m.openMessageLink(value));
}

async function bootstrap() {
  const [servers, dms, friends] = await Promise.all([api.servers(), api.dms(), api.friends()]);
  actions.setServers(servers);
  actions.setDms(dms);
  actions.setFriends(friends);
  loadIgnored();
  void loadNotifyState();
  void loadSaved();
  restoreView();
  openSharedProfile();
  openSharedMessage();
  openSharedInvite();
  connectSocket();
  setupIdleDetection();
  if (!typingTicker) typingTicker = setInterval(actions.pruneTyping, 2000);
  requestNotificationPermission();
}

const STORAGE_VIEW = 'line.view';
const STORAGE_THREAD = 'line.view.thread';
let viewSaver: (() => void) | null = null;

/** F5 (o sessionStorage continua) ou o app reiniciou sozinho na atualização. Abrir do zero não conta. */
function isResume() {
  let reload = false;
  try {
    reload = sessionStorage.getItem('line.alive') === '1';
    sessionStorage.setItem('line.alive', '1');
  } catch {
    /* sem armazenamento */
  }
  return reload || (window as { __LINE_RESUMED__?: boolean }).__LINE_RESUMED__ === true;
}

/** Volta para o servidor/canal ou conversa privada que estava aberto antes do F5 ou da atualização. */
function restoreView() {
  if (!isResume()) {
    // Abriu do zero: começa no Início e esquece o lugar antigo (senão um F5 aqui voltaria para lá).
    storage.set(STORAGE_VIEW, JSON.stringify(useLine.getState().view));
    storage.set(STORAGE_THREAD, null);
  }
  try {
    const saved = JSON.parse(storage.get(STORAGE_VIEW) ?? 'null') as View | null;
    const s = useLine.getState();
    if (saved?.kind === 'server' && s.servers[saved.serverId]) actions.goServer(saved.serverId, saved.channelId);
    else if (saved?.kind === 'home' && saved.dmId && s.channels[saved.dmId]) actions.goHome(saved.dmId);
    else if (saved?.kind === 'discover') actions.goDiscover();
    // A conversa (thread) aberta no painel ao lado: volta quando os canais do servidor chegarem.
    const threadId = storage.get(STORAGE_THREAD);
    if (threadId && saved?.kind === 'server') restoreThread(threadId, saved.channelId);
  } catch {
    /* sem lugar salvo */
  }
  viewSaver ??= useLine.subscribe((st, prev) => {
    if (st.view !== prev.view) storage.set(STORAGE_VIEW, JSON.stringify(st.view));
    if (st.threadId !== prev.threadId) storage.set(STORAGE_THREAD, st.threadId);
    // Abriu outro servidor: confere quem está na voz dele.
    const sid = st.view.kind === 'server' ? st.view.serverId : null;
    const before = prev.view.kind === 'server' ? prev.view.serverId : null;
    if (sid && sid !== before) void syncVoice();
  });
}

function restoreThread(threadId: string, parentId: string | null) {
  const stillHere = () => {
    const v = useLine.getState().view;
    return v.kind === 'server' && v.channelId === parentId;
  };
  const tryOpen = () => {
    const st = useLine.getState();
    if (!stillHere() || st.threadId || st.threadDraft) return true;
    if (st.channels[threadId]?.parentId !== parentId) return false;
    actions.openThread(threadId);
    return true;
  };
  if (tryOpen()) return;
  const stop = useLine.subscribe(() => {
    if (tryOpen()) stop();
  });
  // Conversa apagada ou sem acesso: desiste depois de um tempo.
  setTimeout(stop, 30_000);
}

export async function ensureServerLoaded(serverId: string, force = false) {
  if (!force && useLine.getState().loadedServers[serverId]) return;
  const detail = await api.server(serverId);
  actions.upsertServer(detail.server);
  actions.loadServerDetail(serverId, detail.categories, detail.channels, detail.members, detail.roles);
}

/** Abre o canal (ou a thread) da mensagem e rola até ela. */
/** Ids das mensagens salvas (para o marcador nas mensagens). */
async function loadSaved() {
  const ids = await api.savedIds().catch(() => null);
  if (ids) useLine.setState({ saved: Object.fromEntries(ids.map((id) => [id, true as const])) });
}

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

/** Mensagens por página: abre com as 40 últimas e, rolando para cima, busca de 40 em 40. */
export const MESSAGES_PAGE = 40;
const loadingMessages = new Set<string>();

export async function loadMessages(channelId: string, older = false) {
  const bucket = useLine.getState().messages[channelId];
  if (older && (!bucket || !bucket.hasMore)) return;
  if (!older && bucket?.loaded) return;
  const key = `${channelId}:${older ? bucket?.items[0]?.id ?? '' : ''}`;
  if (loadingMessages.has(key)) return;
  loadingMessages.add(key);
  try {
    const before = older ? bucket?.items[0]?.id : undefined;
    const items = await api.messages(channelId, before, MESSAGES_PAGE);
    ensureUsers(items.flatMap((m) => (m.threads ?? (m.thread ? [m.thread] : [])).flatMap((t) => t.participantIds ?? [])));
    actions.setMessages(channelId, items, items.length === MESSAGES_PAGE, older);
  } finally {
    loadingMessages.delete(key);
  }
}

const fetchingUsers = new Set<string>();
/** Busca quem ainda não está na memória (ex.: avatares de quem respondeu numa conversa). */
export function ensureUsers(ids: string[]) {
  const known = useLine.getState().users;
  for (const id of new Set(ids)) {
    if (!id || known[id] || fetchingUsers.has(id)) continue;
    fetchingUsers.add(id);
    api.user(id).then(
      (u) => actions.upsertUsers([u]),
      () => fetchingUsers.delete(id),
    );
  }
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
  bindMusicSocket(s);
  bindSoundsSocket(s);

  s.on('connect', () => {
    useLine.setState({ connection: 'connected' });
    // Reconectou: conta de novo o jogo aberto (o servidor esquece quando a conexão cai).
    if (lastGame) s.emit('presence:game', lastGame);
    for (const id of watchedNews) s.emit('news:watch', { channelId: id });
    void syncVoice();
    void syncMusic();
  });
  s.on('disconnect', () => useLine.setState({ connection: 'disconnected' }));
  s.on('activity:update', (p) => window.dispatchEvent(new CustomEvent('line:activity', { detail: p })));
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
  s.on('message:delete', ({ id, channelId }) => {
    actions.deleteMessage(channelId, id);
    window.dispatchEvent(new CustomEvent('line:message-deleted', { detail: id }));
  });
  s.on('typing:start', ({ channelId, userId, displayName }) => actions.setTyping(channelId, userId, displayName));
  s.on('presence:update', ({ userId, presence, customStatus }) => actions.setPresence(userId, presence, customStatus));
  s.on('user:update', (u) => actions.upsertUsers([u]));
  s.on('self:update', (u) => actions.setMe(u));
  s.on('notify:settings', (n) => useLine.setState({ notify: n }));
  s.on('saved:update', ({ messageId, saved }) => actions.setSaved(messageId, saved));
  s.on('read:ack', ({ channelId, messageId }) => onRemoteAck(channelId, messageId));
  s.on('server:create', (srv) => {
    actions.upsertServer(srv);
    void syncVoice();
  });
  s.on('server:update', (srv) => {
    const was = !!useLine.getState().servers[srv.id]?.suspended;
    actions.upsertServer(srv);
    // Suspenso ou reativado: recarrega canais, membros e o canal aberto.
    if (was !== !!srv.suspended) refreshServer(srv.id);
  });
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
  // Eventos do canal Eventos: a tela aberta escuta e atualiza a lista.
  s.on('event:update', (e) => window.dispatchEvent(new CustomEvent('line:event', { detail: { event: e } })));
  s.on('event:delete', (d) => window.dispatchEvent(new CustomEvent('line:event', { detail: { deleted: d.id } })));
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
        if (st.view.kind === 'server' && st.view.serverId === serverId && (!st.view.channelId || !st.channels[st.view.channelId]))
          actions.goServer(serverId, firstTextChannel(st, serverId));
      })
      .catch(() => {});
  }, 300);
}

/** A mensagem me menciona? (@meu_usuario, @everyone/@here válido ou um cargo que eu tenho). */
export function mentionsMe(message: Message): boolean {
  const st = useLine.getState();
  const me = st.me;
  if (!me || message.author.id === me.id || message.forwardedFrom) return false;
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
  void loadNotifyState();
  void loadSaved();
  const { view } = useLine.getState();
  if (view.kind === 'server') await ensureServerLoaded(view.serverId);
}

/** Comentários de uma nota das Novidades em tempo real enquanto a página está aberta. */
const watchedNews = new Set<string>();
export function watchNews(channelId: string, on: boolean) {
  if (on) watchedNews.add(channelId);
  else watchedNews.delete(channelId);
  socket?.emit(on ? 'news:watch' : 'news:unwatch', { channelId });
}

/** Canal (ou conversa) dos comentários das Novidades. */
function isNewsChannel(state: ReturnType<typeof useLine.getState>, channelId: string) {
  let c = state.channels[channelId];
  if (c?.type === 'thread' && c.parentId) c = state.channels[c.parentId] ?? c;
  return c?.base === 'news';
}

function onMessage(message: Message) {
  const state = useLine.getState();
  // Comentário nas Novidades: entra na lista, sem notificação nem contador.
  if (isNewsChannel(state, message.channelId)) {
    actions.addMessage(message);
    actions.upsertUsers([message.author]);
    return;
  }
  // DM nova que ainda não conhecemos: busca a lista de novo.
  if (!state.channels[message.channelId] && !state.channelInfo[message.channelId]) void api.dms().then(actions.setDms);
  actions.addMessage(message);
  actions.upsertUsers([message.author]);

  if (message.author.id === state.me?.id) {
    // Minha mensagem: o servidor já marcou o canal como lido até ela.
    useLine.setState((s) => ({ readMarks: { ...s.readMarks, [message.channelId]: { read: message.id, last: message.id } } }));
    return;
  }
  const viewing =
    (currentChannelId(state) === message.channelId || state.threadId === message.channelId) && document.hasFocus();
  handleIncoming(message, viewing, notify);
}

function notify(message: Message, desktop: boolean) {
  const state = useLine.getState();
  const channel = state.channels[message.channelId];
  const serverId = channel?.serverId ?? state.channelInfo[message.channelId]?.serverId ?? null;
  let title = message.author.displayName;
  if (serverId) {
    const srv = state.servers[serverId];
    title = `${message.author.displayName}${channel ? ` (#${channel.name}${srv ? `, ${srv.name}` : ''})` : srv ? ` (${srv.name})` : ''}`;
  } else if (channel?.type === 'group_dm') {
    title = `${message.author.displayName} em ${dmTitle(channel, state.me?.id, state.users)}`;
  }
  if (!desktop) return;
  const full = (message.content && previewContent(mentionsToText(message.content, serverId))) || (message.attachments.length ? `📎 ${message.attachments.map((a) => a.filename).join(', ')}` : '');
  const body = (state.notify.preview === false ? 'Nova mensagem' : full).slice(0, 200);
  const data = `${message.channelId}:${serverId ?? ''}`;
  void (async () => {
    // Windows: notificação nativa com o nome e o ícone do Line (sem "tauri.localhost"),
    // foto redonda de quem mandou e resposta rápida, no estilo do Teams.
    if (window.line?.notify && window.line.platform === 'win32') {
      const avatar = pref(state.notify, 'avatar') ? await avatarPng(message.author).catch(() => null) : null;
      const shown = await window.line.notify({
        title,
        body,
        tag: message.channelId,
        data,
        avatar,
        avatarKey: `${message.author.id}${(message.author.avatarUrl ?? '').replace(/[^a-z0-9]/gi, '').slice(-16)}`,
        reply: pref(state.notify, 'quickReply'),
      });
      // Nunca cai na Notification do WebView2 no Windows: ela mostraria "tauri.localhost".
      if (shown || window.line.platform === 'win32') return;
    }
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    // Sem o som do sistema: o Line toca o próprio (e respeita a opção "Sons").
    const n = new Notification(title, { body, silent: true });
    n.onclick = () => {
      window.focus();
      openFromNotification(data);
    };
  })();
}

/** Abre a conversa de uma notificação ("canal:servidor"). */
function openFromNotification(data: string) {
  const [channelId = '', serverId = ''] = data.split(':');
  void (async () => {
    if (serverId && !useLine.getState().channels[channelId]) await ensureServerLoaded(serverId).catch(() => {});
    const ch = useLine.getState().channels[channelId];
    if (ch?.type === 'thread' && ch.parentId && ch.serverId) {
      actions.goServer(ch.serverId, ch.parentId);
      actions.openThread(ch.id);
    } else if (serverId) actions.goServer(serverId, channelId);
    else actions.goHome(channelId);
  })();
}

/** Foto de quem mandou como PNG (data URL) para a notificação; sem foto, a inicial na cor da pessoa. */
async function avatarPng(user: Message['author']): Promise<string> {
  const S = 96;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  if (user.avatarUrl) {
    const blob = await fetch(fileUrl(user.avatarUrl)).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))));
    const img = await createImageBitmap(blob);
    const k = Math.max(S / img.width, S / img.height);
    const w = img.width * k;
    const h = img.height * k;
    g.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
  } else {
    g.fillStyle = user.avatarColor || '#5865f2';
    g.fillRect(0, 0, S, S);
    g.fillStyle = '#fff';
    g.font = 'bold 44px "Segoe UI", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText((user.displayName || user.username || '?').trim().charAt(0).toUpperCase(), S / 2, S / 2 + 2);
  }
  return c.toDataURL('image/png');
}

if (typeof window !== 'undefined') {
  // Clique ou "Enviar" na notificação nativa do Windows (vem do Rust).
  (window as unknown as { lineToast?: (e: { action: string; data: string; reply?: string | null }) => void }).lineToast = (e) => {
    const [channelId = ''] = e.data.split(':');
    if (!channelId) return;
    if (e.action === 'reply') {
      const text = e.reply?.trim();
      if (text && channelId) void api.sendMessage(channelId, text).catch(() => {});
      return;
    }
    openFromNotification(e.data);
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
      notify?: (opts: { title: string; body: string; tag: string; data: string; avatar: string | null; avatarKey: string; reply: boolean }) => Promise<boolean>;
      setBadge: (count: number) => void;
      window?: {
        minimize: () => void;
        toggleMaximize: () => Promise<boolean>;
        isMaximized: () => Promise<boolean>;
        /** Só nas versões novas do app. */
        setFullscreen?: (on: boolean) => Promise<void>;
        close: () => void;
      };
      updates?: {
        check: () => Promise<string | null>;
        install: () => Promise<void>;
        run?: () => Promise<void>;
      };
      startup?: {
        get: () => Promise<{ enabled: boolean; minimized: boolean } | null>;
        set: (enabled: boolean, minimized: boolean) => Promise<void>;
      };
      /** Aceleração de hardware (GPU). get() devolve null no macOS. Mudar vale ao reabrir. */
      gpu?: {
        get: () => Promise<boolean | null>;
        set: (enabled: boolean, restart?: boolean) => Promise<void>;
      };
      /** Seletor de tela do Line (captura em Rust). No Linux só no X11; no Wayland vale o do sistema. */
      nativeScreen?: boolean;
    };
  }
}

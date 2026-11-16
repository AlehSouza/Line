'use client';

/**
 * Notificações no jeito do Discord:
 * - Cada servidor tem um nível (Todas as mensagens / Apenas @menções / Nada), pode ser silenciado
 *   (com duração) e pode ignorar @everyone/@here e menções de cargo.
 * - Cada canal (ou DM) pode sobrescrever o nível e ser silenciado; thread herda do canal pai.
 * - Silenciado = sem bolinha de não lido e sem notificação, MAS menção continua contando
 *   (badge vermelho) e notificando, a não ser que o nível seja "Nada".
 * - DM: toda mensagem conta como menção.
 * - Ocupado (Não perturbe): nada de som, notificação na área de trabalho nem piscar a barra.
 * As configurações ficam no servidor (sincronizam entre aparelhos); quem decide é o app.
 */
import type { ChannelNotify, Message, NotifyLevel, NotifySettings, ReadState, ServerNotify } from '@line/shared';
import { api } from './api';
import { useIgnored } from './ignored';
import { actions, setReadHook, useLine, type LineState, type MentionCount } from './store';

export const LEVEL_LABEL: Record<NotifyLevel, string> = {
  all: 'Todas as mensagens',
  mentions: 'Apenas @menções',
  nothing: 'Nada',
};

/** Durações do "Silenciar" (minutos; null = até eu reativar). */
export const MUTE_OPTIONS: { label: string; minutes: number | null }[] = [
  { label: 'Por 15 minutos', minutes: 15 },
  { label: 'Por 1 hora', minutes: 60 },
  { label: 'Por 3 horas', minutes: 180 },
  { label: 'Por 8 horas', minutes: 480 },
  { label: 'Por 24 horas', minutes: 1440 },
  { label: 'Até eu reativar', minutes: null },
];

/** Nível padrão de um servidor sem ajuste (o mesmo que o Line fazia antes: só menções). */
export const DEFAULT_SERVER_LEVEL: NotifyLevel = 'mentions';

export const muteActive = (n?: ChannelNotify | null) => !!n?.muted && (!n.muteUntil || Date.parse(n.muteUntil) > Date.now());

/** "Silenciado até 14:30" / "Silenciado até reativar". */
export function muteLabel(n?: ChannelNotify | null): string | null {
  if (!muteActive(n)) return null;
  if (!n!.muteUntil) return 'Silenciado até você reativar';
  const d = new Date(n!.muteUntil);
  const sameDay = d.toDateString() === new Date().toDateString();
  return `Silenciado até ${d.toLocaleString('pt-BR', sameDay ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
}

// ---------- onde cada canal está ----------

export function infoOf(s: LineState, channelId: string): { serverId: string | null; parentId: string | null } {
  const c = s.channels[channelId];
  if (c) return { serverId: c.serverId ?? null, parentId: c.parentId ?? null };
  return s.channelInfo[channelId] ?? { serverId: null, parentId: null };
}

// Objeto vazio fixo: seletores do zustand não podem devolver um objeto novo a cada chamada (loop infinito).
const EMPTY: Readonly<ServerNotify> = Object.freeze({});
export const serverNotify = (s: LineState, serverId: string): ServerNotify => s.notify.servers?.[serverId] ?? EMPTY;
export const channelNotify = (s: LineState, channelId: string): ChannelNotify => s.notify.channels?.[channelId] ?? EMPTY;

export const isServerMuted = (s: LineState, serverId: string) => muteActive(s.notify.servers?.[serverId]);

/** O canal em si (ou o canal pai da thread) está silenciado. Não olha o servidor. */
export function isChannelMuted(s: LineState, channelId: string): boolean {
  if (muteActive(s.notify.channels?.[channelId])) return true;
  const { parentId } = infoOf(s, channelId);
  return !!parentId && muteActive(s.notify.channels?.[parentId]);
}

/** Canal silenciado por ele mesmo, pelo pai ou pelo servidor. */
export function isMutedAnywhere(s: LineState, channelId: string): boolean {
  const { serverId } = infoOf(s, channelId);
  return isChannelMuted(s, channelId) || (!!serverId && isServerMuted(s, serverId));
}

/** Nível que vale para o canal: o do canal, o do pai (thread), o do servidor ou o padrão. */
export function levelOf(s: LineState, channelId: string): NotifyLevel {
  const { serverId, parentId } = infoOf(s, channelId);
  const own = s.notify.channels?.[channelId]?.level;
  if (own) return own;
  if (!serverId) return 'all';
  const parent = parentId ? s.notify.channels?.[parentId]?.level : undefined;
  return parent ?? s.notify.servers?.[serverId]?.level ?? DEFAULT_SERVER_LEVEL;
}

/** Menções não lidas que aparecem no badge (respeita "ignorar @everyone" e "ignorar cargos"). */
export function mentionCount(s: LineState, channelId: string): number {
  const c: MentionCount | undefined = s.mentionCounts[channelId];
  if (!c) return 0;
  const { serverId } = infoOf(s, channelId);
  if (!serverId) return c.d;
  const sn = serverNotify(s, serverId);
  return c.d + (sn.suppressEveryone ? 0 : c.e) + (sn.suppressRoles ? 0 : c.r);
}

/** Canal com mensagens novas que deve aparecer em branco/negrito (não silenciado). */
export const showsUnread = (s: LineState, channelId: string) => !!s.unread[channelId] && !isMutedAnywhere(s, channelId);

/** Canais (e threads) de um servidor que eu conheço. */
function serverChannelIds(s: LineState, serverId: string): string[] {
  const ids = new Set<string>();
  for (const id of Object.keys(s.unread)) if (infoOf(s, id).serverId === serverId) ids.add(id);
  for (const id of Object.keys(s.mentionCounts)) if (infoOf(s, id).serverId === serverId) ids.add(id);
  return [...ids];
}

export function serverBadge(s: LineState, serverId: string): { unread: boolean; mentions: number } {
  const muted = isServerMuted(s, serverId);
  let unread = false;
  let mentions = 0;
  for (const id of serverChannelIds(s, serverId)) {
    mentions += mentionCount(s, id);
    if (!muted && !unread && showsUnread(s, id)) unread = true;
  }
  return { unread, mentions };
}

/** DMs com mensagens não lidas e não silenciadas (aparecem acima dos servidores). */
export function unreadDms(s: LineState): { id: string; count: number }[] {
  return s.dmOrder
    .filter((id) => !infoOf(s, id).serverId && !isChannelMuted(s, id))
    .map((id) => ({ id, count: mentionCount(s, id) }))
    .filter((d) => d.count > 0);
}

/** Total do ícone da barra de tarefas: menções e mensagens diretas não lidas. */
export function totalMentions(s: LineState): number {
  let n = 0;
  for (const id of Object.keys(s.mentionCounts)) {
    const { serverId } = infoOf(s, id);
    if (!serverId && isChannelMuted(s, id)) continue;
    n += mentionCount(s, id);
  }
  return n;
}

// ---------- configurações ----------

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Muda as configurações (já aparece no app) e salva no servidor logo depois. */
export function updateNotify(fn: (n: NotifySettings) => NotifySettings) {
  const next = fn(structuredClone(useLine.getState().notify));
  useLine.setState({ notify: next });
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void api.setNotifySettings(useLine.getState().notify).catch(() => {}), 400);
}

const until = (minutes: number | null) => (minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null);

export function setServerNotify(serverId: string, patch: Partial<ServerNotify>) {
  updateNotify((n) => ({ ...n, servers: { ...n.servers, [serverId]: { ...n.servers?.[serverId], ...patch } } }));
}

export function setChannelNotify(channelId: string, patch: Partial<ChannelNotify>) {
  updateNotify((n) => {
    const cur = { ...n.channels?.[channelId], ...patch };
    if (!cur.level) delete cur.level;
    const channels = { ...n.channels, [channelId]: cur };
    if (!cur.level && !cur.muted) delete channels[channelId];
    return { ...n, channels };
  });
}

export const muteServer = (serverId: string, minutes: number | null) => setServerNotify(serverId, { muted: true, muteUntil: until(minutes) });
export const unmuteServer = (serverId: string) => setServerNotify(serverId, { muted: false, muteUntil: null });
export const muteChannel = (channelId: string, minutes: number | null) => setChannelNotify(channelId, { muted: true, muteUntil: until(minutes) });
export const unmuteChannel = (channelId: string) => setChannelNotify(channelId, { muted: false, muteUntil: null });

/** Preferência geral (padrão: ligada). */
export const pref = (n: NotifySettings, k: 'desktop' | 'sounds' | 'badge' | 'flash' | 'preview' | 'friendRequests') => n[k] !== false;

// ---------- lido / não lido ----------

const ackTimers: Record<string, ReturnType<typeof setTimeout>> = {};

/** Avisa o servidor que li o canal até a última mensagem (agrupa rajadas). */
function scheduleAck(channelId: string) {
  const mark = useLine.getState().readMarks[channelId];
  if (mark && mark.read >= mark.last) return;
  clearTimeout(ackTimers[channelId]);
  ackTimers[channelId] = setTimeout(() => {
    const m = useLine.getState().readMarks[channelId];
    if (m && m.read >= m.last) return;
    if (m) setMark(channelId, { read: m.last });
    void api.ack(channelId, m?.last).catch(() => {});
  }, 800);
}

function setMark(channelId: string, patch: Partial<{ read: string; last: string }>) {
  useLine.setState((s) => {
    const cur = s.readMarks[channelId] ?? { read: '', last: '' };
    return { readMarks: { ...s.readMarks, [channelId]: { ...cur, ...patch } } };
  });
}

setReadHook(scheduleAck);

/** Marca todos os canais de um servidor como lidos. */
export function markServerRead(serverId: string) {
  const s = useLine.getState();
  for (const id of serverChannelIds(s, serverId)) {
    clearTimeout(ackTimers[id]);
    const m = s.readMarks[id];
    if (m) setMark(id, { read: m.last });
    useLine.setState((st) => {
      const unread = { ...st.unread };
      const mentionCounts = { ...st.mentionCounts };
      delete unread[id];
      delete mentionCounts[id];
      return { unread, mentionCounts };
    });
  }
  void api.ackServer(serverId).catch(() => {});
}

/** Carrega do servidor o que está lido/não lido e as configurações (login e reconexão). */
export async function loadNotifyState() {
  const [settings, states] = await Promise.all([api.notifySettings().catch(() => null), api.readStates().catch(() => null)]);
  if (settings) useLine.setState({ notify: settings });
  if (states) applyReadStates(states);
}

function applyReadStates(states: ReadState[]) {
  const unread: Record<string, number> = {};
  const mentionCounts: Record<string, MentionCount> = {};
  const readMarks: LineState['readMarks'] = {};
  const channelInfo: LineState['channelInfo'] = {};
  const s = useLine.getState();
  const open = new Set([currentChannel(s), s.threadId].filter(Boolean) as string[]);
  for (const r of states) {
    channelInfo[r.channelId] = { serverId: r.serverId, parentId: r.parentId };
    readMarks[r.channelId] = { read: r.lastReadId, last: r.lastMessageId };
    if (r.lastMessageId > r.lastReadId && !open.has(r.channelId)) {
      unread[r.channelId] = 1;
      if (r.mentions || r.everyoneMentions || r.roleMentions)
        mentionCounts[r.channelId] = { d: r.mentions, e: r.everyoneMentions, r: r.roleMentions };
    }
  }
  useLine.setState({ unread, mentionCounts, readMarks, channelInfo });
  for (const id of open) scheduleAck(id);
}

function currentChannel(s: LineState): string | null {
  if (s.view.kind === 'server') return s.view.channelId;
  if (s.view.kind === 'home') return s.view.dmId;
  return null;
}

/** Outro aparelho meu leu o canal. */
export function onRemoteAck(channelId: string, messageId: string) {
  const m = useLine.getState().readMarks[channelId];
  setMark(channelId, { read: m && m.read > messageId ? m.read : messageId });
  if (!m || messageId >= m.last) {
    useLine.setState((st) => {
      if (!st.unread[channelId] && !st.mentionCounts[channelId]) return {};
      const unread = { ...st.unread };
      const mentionCounts = { ...st.mentionCounts };
      delete unread[channelId];
      delete mentionCounts[channelId];
      return { unread, mentionCounts };
    });
  }
}

// ---------- mensagem nova ----------

/** Que tipo de menção a mensagem me faz: direta (@eu), @everyone/@here ou de cargo. */
export function mentionKind(s: LineState, message: Message): 'd' | 'e' | 'r' | null {
  const me = s.me;
  if (!me || message.author.id === me.id) return null;
  if (message.content.toLowerCase().includes(`@${me.username.toLowerCase()}`)) return 'd';
  if (message.mentionEveryone) return 'e';
  const { serverId } = infoOf(s, message.channelId);
  const mine = serverId ? (s.members[serverId]?.[me.id]?.roleIds ?? []) : [];
  if ((message.mentionRoleIds ?? []).some((r) => mine.includes(r))) return 'r';
  return null;
}

/**
 * Chega mensagem de outra pessoa. `viewing` = estou com o canal aberto e a janela em foco.
 * Atualiza não lido/menções, e decide som e notificação na área de trabalho.
 */
export function handleIncoming(message: Message, viewing: boolean, show: (m: Message, desktop: boolean) => void) {
  const s = useLine.getState();
  const cid = message.channelId;
  setMark(cid, { last: message.id });
  if (viewing) {
    scheduleAck(cid);
    return;
  }
  actions.markUnread(cid);
  const { serverId } = infoOf(s, cid);
  const isDm = !serverId;
  let kind = isDm ? 'd' : mentionKind(s, message);
  if (kind) actions.addMention(cid, kind);

  // Ignorados não notificam (a mensagem fica recolhida no chat).
  if (useIgnored.getState().ids.includes(message.author.id)) return;
  // Ocupado: nada de som, notificação nem piscar.
  if (s.me?.status === 'dnd') return;

  if (!isDm) {
    const sn = serverNotify(s, serverId!);
    if ((kind === 'e' && sn.suppressEveryone) || (kind === 'r' && sn.suppressRoles)) kind = null;
  }
  const level = levelOf(s, cid);
  if (level === 'nothing') return;
  const muted = isDm ? isChannelMuted(s, cid) : isMutedAnywhere(s, cid);
  // Silenciado: só menção notifica (DM silenciada não notifica).
  if (muted && (isDm || !kind)) return;
  if (level === 'mentions' && !kind) return;

  const n = s.notify;
  if (pref(n, 'sounds')) playMessageSound();
  const focused = typeof document !== 'undefined' && document.hasFocus();
  // Com a janela em foco o Discord só toca o som; fora dela mostra a notificação.
  if (!focused) {
    if (pref(n, 'flash')) window.line?.requestAttention();
    show(message, pref(n, 'desktop'));
  }
}

// Silenciado com hora para acabar: quando acaba, atualiza a tela (as bolinhas voltam).
if (typeof window !== 'undefined') {
  setInterval(() => {
    const n = useLine.getState().notify;
    const expired = (x?: ChannelNotify) => !!x?.muted && !!x.muteUntil && Date.parse(x.muteUntil) <= Date.now();
    const hit = Object.values(n.servers ?? {}).some(expired) || Object.values(n.channels ?? {}).some(expired);
    if (!hit) return;
    const clean = structuredClone(n);
    for (const x of [...Object.values(clean.servers ?? {}), ...Object.values(clean.channels ?? {})])
      if (expired(x)) {
        x.muted = false;
        x.muteUntil = null;
      }
    useLine.setState({ notify: clean });
  }, 20_000);
}

// ---------- som ----------

let audioCtx: AudioContext | null = null;
let lastSound = 0;

/** Som curto de mensagem nova (dois toques), gerado na hora. */
export function playMessageSound() {
  const now = Date.now();
  if (now - lastSound < 400) return;
  lastSound = now;
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    void ctx.resume();
    const t = ctx.currentTime;
    for (const [freq, delay] of [
      [740, 0],
      [1110, 0.08],
    ] as const) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t + delay);
      g.gain.exponentialRampToValueAtTime(0.16, t + delay + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.32);
      o.connect(g).connect(ctx.destination);
      o.start(t + delay);
      o.stop(t + delay + 0.36);
    }
  } catch {
    /* sem áudio */
  }
}

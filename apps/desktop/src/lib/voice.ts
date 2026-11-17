'use client';

import type { ClientToServerEvents, ScreenGame, ServerToClientEvents, VoiceModeration, VoiceSignal, VoiceState } from '@line/shared';
import type { Socket } from 'socket.io-client';
import { create } from 'zustand';
import { disposeNoiseSuppressor, resumeNoiseSuppressor, suppressNoise } from './noise';
import { api } from './api';
import { detectGame, hasGameDetection, hasNativeScreen, startNativeScreen } from './nativeScreen';
import { hasPerm, Perm } from '@line/shared';
import { actions, channelPermsOf, useLine } from './store';

/** Pode isso no canal de voz (de servidor) atual ou no indicado? DM pode tudo. */
function voiceCan(flag: number, channelId = getV().channelId): boolean {
  const s = useLine.getState();
  return hasPerm(channelPermsOf(s, channelId, s.me?.id), flag);
}

type LineSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Voz, vídeo e tela com WebRTC em malha: cada participante conecta direto com cada outro.
 * O servidor só repassa a sinalização (ofertas, respostas e candidatos ICE).
 * Funciona bem para grupos pequenos (até ~6 pessoas com vídeo). Para salas grandes,
 * o próximo passo é um SFU (LiveKit/mediasoup) mantendo esta mesma interface.
 */

const DEFAULT_ICE: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
/** STUN + TURN do servidor (quando ele tiver), renovado a cada chamada. */
let iceServers: RTCIceServer[] = DEFAULT_ICE;

async function refreshIceServers() {
  try {
    const res = await api.iceServers();
    if (res.iceServers?.length) iceServers = res.iceServers;
  } catch {
    iceServers = DEFAULT_ICE;
  }
}

// ---------- qualidade da transmissão de tela ----------

export type Resolution = '720' | '1080' | '1440' | '2160';
export type Fps = 30 | 60;
export interface ScreenQuality {
  resolution: Resolution;
  fps: Fps;
}

// Teto de cada pessoa que assiste. Movimento rápido (jogo, rolar a tela) é o que mais pede bits:
// com teto baixo o codificador sobe a quantização e a imagem vira blocos.
export const RESOLUTIONS: Record<Resolution, { label: string; width: number; height: number; kbps: Record<Fps, number> }> = {
  '720': { label: '720p', width: 1280, height: 720, kbps: { 30: 4000, 60: 6000 } },
  '1080': { label: '1080p', width: 1920, height: 1080, kbps: { 30: 8000, 60: 12000 } },
  '1440': { label: '1440p', width: 2560, height: 1440, kbps: { 30: 14000, 60: 20000 } },
  '2160': { label: '4K', width: 3840, height: 2160, kbps: { 30: 25000, 60: 35000 } },
};

// ---------- preferências (ficam salvas no PC) ----------

export type InputProfile = 'voice' | 'studio' | 'custom';
export type InputMode = 'voice' | 'ptt';

interface VoicePrefs {
  noiseSuppression: boolean;
  inputId: string | null;
  outputId: string | null;
  screenQuality: ScreenQuality;
  /** Volume do microfone e geral da saída (1 = 100%, até 2). */
  inputVolume: number;
  outputVolume: number;
  /** Isolamento de voz (supressor + eco + sensibilidade automática), Estúdio (tudo cru) ou Personalizado. */
  inputProfile: InputProfile;
  echoCancellation: boolean;
  /** Sensibilidade automática; desligada, o microfone só abre acima de `sensitivityDb`. */
  autoSensitivity: boolean;
  sensitivityDb: number;
  /** Detecção de voz ou Apertar para falar (com a tecla `pttKey`, um KeyboardEvent.code). */
  inputMode: InputMode;
  pttKey: string | null;
}

const PREFS_KEY = 'line.voice';
const defaultPrefs: VoicePrefs = {
  noiseSuppression: true,
  inputId: null,
  outputId: null,
  screenQuality: { resolution: '1080', fps: 60 },
  inputVolume: 1,
  outputVolume: 1,
  inputProfile: 'voice',
  echoCancellation: true,
  autoSensitivity: true,
  sensitivityDb: -45,
  inputMode: 'voice',
  pttKey: null,
};

function loadPrefs(): VoicePrefs {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PREFS_KEY) : null;
    return raw ? { ...defaultPrefs, ...(JSON.parse(raw) as Partial<VoicePrefs>) } : defaultPrefs;
  } catch {
    return defaultPrefs;
  }
}

function savePrefs() {
  const v = getV();
  const prefs: VoicePrefs = {
    noiseSuppression: v.noiseSuppression,
    inputId: v.inputId,
    outputId: v.outputId,
    screenQuality: v.screenQuality,
    inputVolume: v.inputVolume,
    outputVolume: v.outputVolume,
    inputProfile: v.inputProfile,
    echoCancellation: v.echoCancellation,
    autoSensitivity: v.autoSensitivity,
    sensitivityDb: v.sensitivityDb,
    inputMode: v.inputMode,
    pttKey: v.pttKey,
  };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // sem localStorage: as preferências valem só nesta sessão
  }
}

const VOLUMES_KEY = 'line.voice.volumes';

function loadUserVolumes(): Record<string, number> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(VOLUMES_KEY) : null;
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

const SCREEN_AUDIO_KEY = 'line.voice.screenAudio';

/** Som da tela que cada pessoa transmite: volume (0 a 1) e silenciado. Guardado só neste aparelho. */
function loadScreenAudio(): { screenVolume: Record<string, number>; screenMuted: Record<string, boolean> } {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SCREEN_AUDIO_KEY) : null;
    const v = raw ? (JSON.parse(raw) as Partial<{ volume: Record<string, number>; muted: Record<string, boolean> }>) : {};
    return { screenVolume: v.volume ?? {}, screenMuted: v.muted ?? {} };
  } catch {
    return { screenVolume: {}, screenMuted: {} };
  }
}

function saveScreenAudio() {
  const { screenVolume, screenMuted } = getV();
  try {
    localStorage.setItem(SCREEN_AUDIO_KEY, JSON.stringify({ volume: screenVolume, muted: screenMuted }));
  } catch {
    // sem localStorage: vale só nesta sessão
  }
}

export interface VoiceStore {
  /** Estados de voz visíveis, por usuário. */
  states: Record<string, VoiceState>;
  /** Volume local de cada pessoa (0 a 1), silenciar localmente e esconder vídeo. Só valem para mim. */
  userVolume: Record<string, number>;
  localMuted: Record<string, boolean>;
  hiddenVideo: Record<string, boolean>;
  /** Som da tela transmitida por cada pessoa (separado da voz) e telas que parei de assistir. Só valem para mim. */
  screenVolume: Record<string, number>;
  screenMuted: Record<string, boolean>;
  /** Telas que eu escolhi assistir (por quem transmite). Sem clicar em "Assistir", não recebo vídeo nem som. */
  watching: Record<string, boolean>;
  /** Miniatura estática da tela de cada pessoa que transmite (para o quadro de quem ainda não assiste). */
  screenThumbs: Record<string, string>;
  /** Jogo que cada pessoa está transmitindo (vem junto da miniatura). */
  screenGames: Record<string, ScreenGame>;
  /** Quem está assistindo à tela de cada pessoa que transmite (quem transmite avisa a todos do canal). */
  screenViewers: Record<string, string[]>;
  /** Status temporário de cada canal de voz (some quando todos saem). */
  channelStatus: Record<string, string>;
  /** Canal em que eu estou (ou entrando). */
  channelId: string | null;
  connecting: boolean;
  muted: boolean;
  deafened: boolean;
  camera: MediaStream | null;
  screen: MediaStream | null;
  /** Streams remotos por id (câmera, tela e microfone). */
  streams: Record<string, MediaStream>;
  speaking: Record<string, boolean>;
  error: string | null;
  /** Supressor de ruído (RNNoise) no microfone. */
  noiseSuppression: boolean;
  /** Microfone e saída de áudio escolhidos (null = padrão do sistema). */
  inputId: string | null;
  outputId: string | null;
  screenQuality: ScreenQuality;
  inputVolume: number;
  outputVolume: number;
  inputProfile: InputProfile;
  echoCancellation: boolean;
  autoSensitivity: boolean;
  sensitivityDb: number;
  inputMode: InputMode;
  pttKey: string | null;
  /** Tecla do Apertar para falar segurada agora. */
  pttDown: boolean;
  /** Sobe quando troco a câmera ou a tela sem parar (mesmo stream, trilha nova): a prévia recarrega. */
  mediaRev: number;
  /** Quadro a pôr em destaque quando a tela da chamada abrir (ex.: clique no mini player). */
  stageFocus: string | null;
}

export const useVoice = create<VoiceStore>(() => ({
  states: {},
  channelStatus: {},
  userVolume: loadUserVolumes(),
  localMuted: {},
  hiddenVideo: {},
  ...loadScreenAudio(),
  watching: {},
  screenThumbs: {},
  screenGames: {},
  screenViewers: {},
  channelId: null,
  connecting: false,
  muted: false,
  deafened: false,
  camera: null,
  screen: null,
  streams: {},
  speaking: {},
  error: null,
  mediaRev: 0,
  stageFocus: null,
  pttDown: false,
  ...loadPrefs(),
}));

const setV = useVoice.setState;
const getV = useVoice.getState;

interface Peer {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  streamIds: Set<string>;
}

let socket: LineSocket | null = null;
let myId: string | null = null;
/** Microfone cru (do dispositivo). */
let rawMic: MediaStream | null = null;
/** O que vai para os outros: o microfone já com o supressor de ruído (ou o cru, se desligado). */
let mic: MediaStream | null = null;
const peers = new Map<string, Peer>();
const audioEls = new Map<string, HTMLAudioElement>();

// ---------- sons da chamada ----------

type CallSound =
  | 'enter'
  | 'left'
  | 'mute_microphone'
  | 'mute_headphone'
  | 'start_transmission'
  | 'close_transmission'
  | 'enter_in_transmission'
  | 'left_transmission';

const callSounds: Partial<Record<CallSound, HTMLAudioElement>> = {};

function playCallSound(kind: CallSound) {
  try {
    // Caminho relativo: funciona no app (raiz) e na web (/app/).
    const el = (callSounds[kind] ??= new Audio(new URL(`sounds/${kind}.mp3`, document.baseURI).href));
    el.currentTime = 0;
    void el.play().catch(() => {});
  } catch {
    /* sem áudio */
  }
}

// ---------- ligação com o socket ----------

export function bindVoiceSocket(s: LineSocket, userId: string) {
  socket = s;
  myId = userId;

  s.on('voice:snapshot', (list) => {
    setV({ states: Object.fromEntries(list.map((v) => [v.userId, v])) });
    // Reconectou: se eu estava num canal, o servidor me tirou. Entra de novo.
    const { channelId } = getV();
    // Página recarregada (F5) ou app reiniciado pela atualização: volta para a chamada de antes.
    if (!channelId && !resumeTried) {
      resumeTried = true;
      resumeVoice(list);
    }
    if (channelId && !list.some((v) => v.userId === myId)) {
      cleanupPeers();
      void rejoin(channelId);
    }
  });

  s.on('voice:update', ({ userId: uid, channelId, state }) => {
    // Som de entrada/saída para quem está no mesmo canal (o meu próprio toca no joinVoice/leaveVoice).
    if (uid !== myId) {
      const here = getV().channelId;
      const before = getV().states[uid]?.channelId ?? null;
      const after = state?.channelId ?? null;
      if (here && before !== after) {
        if (after === here) playCallSound('enter');
        else if (before === here) playCallSound('left');
      } else if (here && after === here && state?.screenStreamId && !getV().states[uid]?.screenStreamId) {
        // Alguém do meu canal começou a transmitir: todos do canal ouvem.
        playCallSound('start_transmission');
      } else if (here && after === here && before === here && state) {
        // Alguém do meu canal mutou/desmutou o microfone ou o fone: todos do canal ouvem.
        const prev = getV().states[uid];
        if (!!prev?.deafened !== !!state.deafened) playCallSound('mute_headphone');
        else if (!!prev?.muted !== !!state.muted) playCallSound('mute_microphone');
      }
    }
    setV((v) => {
      const states = { ...v.states };
      if (state) states[uid] = state;
      else if (states[uid]?.channelId === channelId) delete states[uid];
      return { states };
    });
    if (uid === myId) return applyMute();
    // Parou de transmitir (ou saiu): na próxima vez, assistir de novo é escolha minha.
    if (!state?.screenStreamId && (getV().watching[uid] || getV().screenThumbs[uid] || getV().screenViewers[uid])) {
      // Só quem assistia ouve o fim da transmissão.
      if (getV().watching[uid]) playCallSound('close_transmission');
      setV((v) => {
        const screenThumbs = { ...v.screenThumbs };
        delete screenThumbs[uid];
        const screenGames = { ...v.screenGames };
        delete screenGames[uid];
        const screenViewers = { ...v.screenViewers };
        delete screenViewers[uid];
        return { watching: { ...v.watching, [uid]: false }, screenThumbs, screenGames, screenViewers };
      });
    }
    // A tela dessa pessoa pode ter começado/parado: reaplica o volume da voz ou da tela em cada áudio dela.
    for (const el of audioEls.values()) if (el.dataset.peer === uid) applyPeerAudio(el);
    const mine = getV().channelId;
    if (!mine) return;
    // Quem chega é quem abre a conexão (no rejoin). Se os dois lados criassem a conexão ao mesmo tempo,
    // as ofertas colidiam e a câmera/tela de quem já estava na sala podia nunca chegar ao novato.
    if ((!state || state.channelId !== mine) && peers.has(uid)) closePeer(uid);
  });

  s.on('voice:signal', ({ from, signal }) => void onSignal(from, signal));

  s.on('voice:move', ({ channelId }) => void joinVoice(channelId));

  s.on('voice:statuses', (channelStatus) => setV({ channelStatus }));
  s.on('voice:status', ({ channelId, status }) =>
    setV((v) => {
      const channelStatus = { ...v.channelStatus };
      if (status) channelStatus[channelId] = status;
      else delete channelStatus[channelId];
      return { channelStatus };
    }),
  );

  s.on('voice:kicked', () => {
    void leaveVoice(false);
  });
}

/**
 * Busca de novo quem está na voz. O retrato que vem na conexão pode se perder (ou chegar antes de
 * entrarmos num servidor), então pedimos também ao conectar, ao entrar num servidor e ao trocar de servidor.
 */
export async function syncVoice() {
  const s = socket;
  if (!s?.connected) return;
  const res: { states: VoiceState[]; statuses: Record<string, string> } | null = await s
    .timeout(10_000)
    .emitWithAck('voice:sync')
    .catch(() => null);
  if (!res || socket !== s) return;
  setV((v) => {
    const states = Object.fromEntries(res.states.map((st: VoiceState) => [st.userId, st]));
    // Enquanto entro num canal, meu próprio estado ainda pode não estar no retrato.
    const mine = myId ? v.states[myId] : undefined;
    if (mine && v.connecting && !states[mine.userId]) states[mine.userId] = mine;
    return { states, channelStatus: res.statuses };
  });
}

export function unbindVoice() {
  void leaveVoice(false);
  socket = null;
  myId = null;
  setV({ states: {}, channelStatus: {} });
}

/** Define o status do canal de voz em que estou ('' limpa). */
export function setChannelStatus(channelId: string, status: string) {
  socket?.emit('voice:status', { channelId, status });
}

// ---------- voltar para a chamada depois de recarregar ou atualizar ----------

const RESUME_KEY = 'line.voice.resume';
/** Sem sinal de vida por mais que isso, a chamada salva é antiga: não volta sozinho. */
const RESUME_WINDOW = 60_000;
let resumeTried = false;

interface VoiceResume {
  channelId: string;
  serverId: string | null;
  watching: string[];
  until: number;
}

/**
 * F5/Ctrl+Shift+R: fica no sessionStorage, que é só desta aba/janela (outra aba aberta não
 * entra na chamada no lugar desta). Atualização do app: o processo reinicia e o sessionStorage
 * some, então vai para o localStorage com prazo maior (ver keepVoiceForUpdate).
 */
function saveResume(store: 'session' | 'local' = 'session', windowMs = RESUME_WINDOW) {
  const { channelId, connecting, watching } = getV();
  if (!channelId || connecting) return;
  const data: VoiceResume = {
    channelId,
    serverId: useLine.getState().channels[channelId]?.serverId ?? null,
    watching: Object.keys(watching).filter((id) => watching[id]),
    until: Date.now() + windowMs,
  };
  try {
    (store === 'local' ? localStorage : sessionStorage).setItem(RESUME_KEY, JSON.stringify(data));
  } catch {
    // sem armazenamento: só não volta sozinho
  }
}

function readResume(store: Storage): VoiceResume | null {
  try {
    const data = JSON.parse(store.getItem(RESUME_KEY) ?? 'null') as VoiceResume | null;
    store.removeItem(RESUME_KEY);
    return data?.channelId && data.until > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function clearResume() {
  try {
    sessionStorage.removeItem(RESUME_KEY);
    localStorage.removeItem(RESUME_KEY);
  } catch {
    // nada
  }
}

/** Antes de instalar uma atualização: guarda a chamada atual para depois de reiniciar (baixar + instalar). */
export function keepVoiceForUpdate() {
  saveResume('local', 10 * 60_000);
}

if (typeof window !== 'undefined') {
  // Mantém o registro vivo enquanto estou numa chamada; ao recarregar, ele ainda está no prazo.
  setInterval(() => saveResume(), 10_000);
  window.addEventListener('pagehide', () => saveResume());
  window.addEventListener('beforeunload', () => saveResume());
}

function resumeVoice(list: VoiceState[]) {
  const fromReload = typeof sessionStorage !== 'undefined' ? readResume(sessionStorage) : null;
  const fromUpdate = typeof localStorage !== 'undefined' ? readResume(localStorage) : null;
  const data = fromReload ?? fromUpdate;
  if (!data) return;
  // Só volta a assistir quem ainda está transmitindo.
  const live = new Set(list.filter((v) => v.screenStreamId).map((v) => v.userId));
  const watching = Object.fromEntries((data.watching ?? []).filter((id) => live.has(id)).map((id) => [id, true]));
  if (Object.keys(watching).length) setV((v) => ({ watching: { ...v.watching, ...watching } }));
  const { channelId, serverId } = data;
  // Abre a chamada na tela (servidor ou DM) e entra.
  if (serverId) actions.goServer(serverId, channelId);
  else actions.goHome(channelId);
  void joinVoice(channelId);
}

// ---------- entrar / sair ----------

export async function joinVoice(channelId: string) {
  if (!socket) return;
  const current = getV();
  if (current.channelId === channelId) return;
  if (current.channelId) await leaveVoice();

  if (typeof RTCPeerConnection === 'undefined') {
    setV({
      error:
        'Este navegador não tem WebRTC, então as chamadas não funcionam aqui. Use o app do Line ou abra pelo Chrome ou Firefox.',
    });
    return;
  }
  if (!voiceCan(Perm.Connect, channelId)) {
    setV({ error: 'Você não tem permissão para entrar neste canal de voz.' });
    return;
  }
  // Sem "Falar" entra mutado (o servidor também garante isso).
  if (!voiceCan(Perm.Speak, channelId)) setV({ muted: true });
  setV({ channelId, connecting: true, error: null });
  try {
    await refreshIceServers();
    if (!mic) await openMic();
    applyMute();
    await rejoin(channelId);
    playCallSound('enter');
  } catch (err) {
    const name = (err as Error).name;
    const message =
      name === 'NotAllowedError'
        ? 'Sem permissão para usar o microfone.'
        : name === 'NotFoundError'
          ? 'Nenhum microfone encontrado.'
          : (err as Error).message;
    stopMic();
    setV({ channelId: null, connecting: false, error: message });
  }
}

async function rejoin(channelId: string) {
  if (!socket) return;
  const { muted, deafened } = getV();
  const res = await socket.emitWithAck('voice:join', { channelId, muted, deafened });
  if (!res.ok) throw new Error(res.error);
  setV({ connecting: false });
  // Reenvia câmera/tela se já estavam ligadas (reconexão).
  const { camera, screen } = getV();
  if (camera || screen) socket.emit('voice:state', { cameraStreamId: camera?.id ?? null, screenStreamId: screen?.id ?? null });
  for (const p of res.peers) if (!peers.has(p.userId)) createPeer(p.userId);
  startSpeakingLoop();
}

export async function leaveVoice(notify = true) {
  clearResume();
  if (getV().channelId && !getV().connecting) playCallSound('left');
  if (notify) socket?.emit('voice:leave');
  if (cameraOpening) cameraCancelled = true;
  cleanupPeers();
  stopStream(getV().camera);
  stopStream(getV().screen);
  stopMic();
  stopSpeakingLoop();
  setV({ channelId: null, connecting: false, camera: null, screen: null, streams: {}, speaking: {} });
}

function cleanupPeers() {
  for (const id of [...peers.keys()]) closePeer(id);
}

// ---------- controles ----------

export function toggleMute() {
  const { muted, deafened } = getV();
  // Desmutar enquanto ensurdecido também tira o ensurdecer.
  const next = deafened ? { muted: false, deafened: false } : { muted: !muted };
  if (next.muted === false && !voiceCan(Perm.Speak)) {
    setV({ error: 'Você não tem permissão para falar neste canal.' });
    if (!deafened) return;
    next.muted = true;
  }
  setV(next);
  playCallSound(next.deafened === false ? 'mute_headphone' : 'mute_microphone');
  applyMute();
  socket?.emit('voice:state', next);
}

export function toggleDeafen() {
  const deafened = !getV().deafened;
  const next = { deafened, muted: deafened ? true : !voiceCan(Perm.Speak) };
  setV(next);
  playCallSound('mute_headphone');
  applyMute();
  socket?.emit('voice:state', next);
}

function applyMute() {
  const { muted, deafened, states, inputMode, pttDown } = getV();
  const forced = myId ? states[myId] : undefined;
  const silent = muted || deafened || !!forced?.serverMuted || !!forced?.serverDeafened || (inputMode === 'ptt' && !pttDown);
  for (const s of [rawMic, mic]) s?.getAudioTracks().forEach((t) => (t.enabled = !silent));
  for (const el of audioEls.values()) applyPeerAudio(el);
}

/** Ensurdecido (por mim ou pelo servidor), silenciado localmente e volume de cada pessoa. */
function applyPeerAudio(el: HTMLAudioElement) {
  const { deafened, states, localMuted, userVolume, screenVolume, screenMuted, watching, outputVolume } = getV();
  const peer = el.dataset.peer ?? '';
  const forced = myId ? states[myId]?.serverDeafened : false;
  // O áudio da tela vem no mesmo stream do vídeo da tela; o resto é a voz.
  const isScreen = !!states[peer]?.screenStreamId && el.dataset.stream === states[peer]?.screenStreamId;
  const off = deafened || !!forced || (isScreen ? !!screenMuted[peer] || !watching[peer] : !!localMuted[peer]);
  const volume = Math.min(2, Math.max(0, ((isScreen ? screenVolume[peer] : userVolume[peer]) ?? 1) * (outputVolume ?? 1)));
  const boost = volume > 1 ? boostFor(el) : null;
  if (boost) {
    // Acima de 100%: o elemento fica mudo e o som sai amplificado pelo GainNode.
    el.muted = true;
    boost.gain.value = off ? 0 : volume;
  } else {
    const g = boosts.get(el);
    if (g) g.gain.value = 0;
    el.muted = off;
    el.volume = Math.min(1, volume);
  }
}

/** Saída amplificada (até 200%) de cada áudio remoto, criada só quando alguém passa de 100%. */
let playCtx: AudioContext | null = null;
const boosts = new Map<HTMLAudioElement, GainNode>();

function boostFor(el: HTMLAudioElement): GainNode | null {
  const existing = boosts.get(el);
  if (existing) return existing;
  const stream = el.srcObject as MediaStream | null;
  if (!stream?.getAudioTracks().length || typeof AudioContext === 'undefined') return null;
  try {
    if (!playCtx) {
      playCtx = new AudioContext();
      applyCtxSink();
    }
    void playCtx.resume();
    const source = playCtx.createMediaStreamSource(stream);
    const gain = playCtx.createGain();
    source.connect(gain).connect(playCtx.destination);
    boosts.set(el, gain);
    return gain;
  } catch {
    return null;
  }
}

function applyCtxSink() {
  const sink = (playCtx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null)?.setSinkId;
  if (playCtx && sink) void sink.call(playCtx, getV().outputId ?? '').catch(() => {});
}

function dropBoost(el: HTMLAudioElement) {
  const g = boosts.get(el);
  if (!g) return;
  g.disconnect();
  boosts.delete(el);
}

export function setScreenVolume(userId: string, volume: number) {
  setV((v) => ({
    screenVolume: { ...v.screenVolume, [userId]: volume },
    // Mexer no volume tira do silencioso.
    screenMuted: volume > 0 ? { ...v.screenMuted, [userId]: false } : v.screenMuted,
  }));
  saveScreenAudio();
  applyMute();
}

export function toggleScreenMute(userId: string) {
  setV((v) => ({ screenMuted: { ...v.screenMuted, [userId]: !v.screenMuted[userId] } }));
  saveScreenAudio();
  applyMute();
}

/** Assistir / sair da transmissão de alguém. Avisa quem transmite, que passa a mandar (ou para de mandar) a tela só para mim. */
/** Pede para a tela da chamada abrir com este quadro em destaque ("screen:<id>" ou "person:<id>"). */
export function requestStageFocus(key: string | null) {
  setV({ stageFocus: key });
}

export function setWatching(userId: string, on: boolean) {
  if (!!getV().watching[userId] !== on) playCallSound(on ? 'enter_in_transmission' : 'left_transmission');
  setV((v) => ({ watching: { ...v.watching, [userId]: on } }));
  send(userId, { type: 'watch', on });
  applyMute();
}

export function setUserVolume(userId: string, volume: number) {
  setV((v) => ({ userVolume: { ...v.userVolume, [userId]: volume } }));
  try {
    localStorage.setItem(VOLUMES_KEY, JSON.stringify(getV().userVolume));
  } catch {
    // sem localStorage: vale só nesta sessão
  }
  applyMute();
}

export function toggleLocalMute(userId: string) {
  setV((v) => ({ localMuted: { ...v.localMuted, [userId]: !v.localMuted[userId] } }));
  applyMute();
}

export function toggleHiddenVideo(userId: string) {
  setV((v) => ({ hiddenVideo: { ...v.hiddenVideo, [userId]: !v.hiddenVideo[userId] } }));
}

/** Moderação de voz (dono do servidor, por enquanto). */
export function moderateVoice(m: VoiceModeration) {
  socket?.emit('voice:moderate', m);
}

// ---------- microfone, supressor de ruído e dispositivos ----------

async function openMic() {
  const { inputId, noiseSuppression, echoCancellation, autoSensitivity, inputProfile } = getV();
  const studio = inputProfile === 'studio';
  const audio: MediaTrackConstraints = {
    deviceId: inputId ? { exact: inputId } : undefined,
    echoCancellation,
    // Com o nosso supressor ligado, o do navegador sai do caminho (os dois juntos deixam a voz "metálica").
    // No Estúdio o som vai cru: sem nenhum filtro do navegador.
    noiseSuppression: !noiseSuppression && !studio,
    autoGainControl: autoSensitivity && !studio,
    channelCount: 1,
  };
  try {
    rawMic = await navigator.mediaDevices.getUserMedia({ audio, video: false });
  } catch (err) {
    // O microfone salvo sumiu (desplugado): volta para o padrão.
    if (!inputId || (err as Error).name !== 'OverconstrainedError') throw err;
    setV({ inputId: null });
    savePrefs();
    rawMic = await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: undefined }, video: false });
  }
  mic = rawMic;
  rememberDevice('audioinput', rawMic.getAudioTracks()[0]?.getSettings().deviceId);
  watchMicEnded(rawMic);
  if (noiseSuppression) {
    try {
      mic = await suppressNoise(rawMic);
    } catch (err) {
      console.warn('Supressor de ruído indisponível', err);
      setV({ noiseSuppression: false, error: 'Não deu para ligar o supressor de ruído neste PC.' });
    }
  }
  // Estágio de volume e do corte por sensibilidade: o medidor de fala lê antes dele (micPre).
  micPre = mic;
  mic = withGain(mic);
}

/** Microfone já tratado, antes do volume/corte (para medir o nível mesmo com o corte fechado). */
let micPre: MediaStream | null = null;
let gainCtx: AudioContext | null = null;
let gainNode: GainNode | null = null;
/** Corte por sensibilidade aberto agora (fala passou do limiar). */
let gateOpen = true;
let gateUntil = 0;

function withGain(s: MediaStream): MediaStream {
  try {
    gainCtx = new AudioContext();
    const dest = gainCtx.createMediaStreamDestination();
    gainNode = gainCtx.createGain();
    gainCtx.createMediaStreamSource(s).connect(gainNode).connect(dest);
    applyGain();
    void gainCtx.resume().catch(() => {});
    return dest.stream;
  } catch {
    gainCtx = null;
    gainNode = null;
    return s;
  }
}

function disposeGain() {
  void gainCtx?.close().catch(() => {});
  gainCtx = null;
  gainNode = null;
  micPre = null;
  gateOpen = true;
}

function applyGain() {
  if (!gainNode) return;
  const { inputVolume } = getV();
  gainNode.gain.setTargetAtTime(gateOpen ? inputVolume : 0, gainNode.context.currentTime, 0.015);
}

/** Abre/fecha o corte pela sensibilidade manual (chamado pelo laço de fala). */
function updateGate(lvl: number, now: number) {
  const { autoSensitivity, sensitivityDb, inputProfile } = getV();
  let open = true;
  if (!autoSensitivity && inputProfile !== 'voice') {
    const db = lvl > 0 ? 20 * Math.log10(lvl) : -100;
    if (db >= sensitivityDb) gateUntil = now + 400;
    open = now < gateUntil;
  }
  if (open !== gateOpen) {
    gateOpen = open;
    applyGain();
  }
}

export function setInputVolume(v: number) {
  setV({ inputVolume: Math.min(2, Math.max(0, v)) });
  savePrefs();
  applyGain();
}

export function setOutputVolume(v: number) {
  setV({ outputVolume: Math.min(2, Math.max(0, v)) });
  savePrefs();
  for (const el of audioEls.values()) applyPeerAudio(el);
}

/** Perfil de entrada: Isolamento de voz liga os filtros, Estúdio desliga tudo; mexer num filtro vira Personalizado. */
export async function setInputProfile(p: InputProfile) {
  if (p === 'voice') setV({ inputProfile: p, noiseSuppression: true, echoCancellation: true, autoSensitivity: true });
  else if (p === 'studio') setV({ inputProfile: p, noiseSuppression: false, echoCancellation: false, autoSensitivity: false });
  else setV({ inputProfile: p });
  savePrefs();
  await reopenMic();
}

export async function setEchoCancellation(on: boolean) {
  setV({ echoCancellation: on, inputProfile: 'custom' });
  savePrefs();
  await reopenMic();
}

export async function setAutoSensitivity(on: boolean) {
  setV({ autoSensitivity: on, inputProfile: 'custom' });
  savePrefs();
  gateOpen = true;
  applyGain();
  await reopenMic();
}

export function setSensitivityDb(db: number) {
  setV({ sensitivityDb: Math.min(0, Math.max(-100, db)) });
  savePrefs();
}

export function setInputMode(mode: InputMode) {
  setV({ inputMode: mode, pttDown: false });
  savePrefs();
  applyMute();
}

export function setPttKey(code: string | null) {
  setV({ pttKey: code, pttDown: false });
  savePrefs();
  applyMute();
}

/** Apertar para falar: segura a tecla escolhida e o microfone abre (só com a janela do Line em foco). */
if (typeof window !== 'undefined') {
  const isPtt = (e: KeyboardEvent) => {
    const { inputMode, pttKey } = getV();
    return inputMode === 'ptt' && !!pttKey && e.code === pttKey;
  };
  window.addEventListener('keydown', (e) => {
    if (!isPtt(e) || e.repeat || getV().pttDown) return;
    setV({ pttDown: true });
    applyMute();
  });
  const release = () => {
    if (!getV().pttDown) return;
    setV({ pttDown: false });
    applyMute();
  };
  window.addEventListener('keyup', (e) => isPtt(e) && release());
  window.addEventListener('blur', release);
}

/** Reabre o microfone (trocou o dispositivo ou o supressor) sem derrubar a chamada. */
async function reopenMic() {
  if (!getV().channelId) return;
  const old = mic;
  const oldRaw = rawMic;
  mic = null;
  rawMic = null;
  disposeNoiseSuppressor();
  disposeGain();
  try {
    await openMic();
  } catch (err) {
    setV({ error: (err as Error).name === 'NotAllowedError' ? 'Sem permissão para usar o microfone.' : 'Não foi possível abrir o microfone.' });
    // O supressor antigo já foi desmontado: continua com o microfone cru.
    mic = oldRaw;
    rawMic = oldRaw;
    return;
  }
  applyMute();
  const oldTrack = old?.getAudioTracks()[0];
  const newTrack = (mic as MediaStream | null)?.getAudioTracks()[0] ?? null;
  for (const { pc } of peers.values()) {
    for (const sender of pc.getSenders()) {
      if (sender.track && sender.track === oldTrack) void sender.replaceTrack(newTrack);
    }
  }
  stopStream(oldRaw);
  if (old !== oldRaw) stopStream(old);
  analysers.delete('local');
}

export async function setNoiseSuppression(on: boolean) {
  setV({ noiseSuppression: on, inputProfile: 'custom' });
  savePrefs();
  await reopenMic();
}

export async function setInputDevice(deviceId: string | null) {
  rememberDevice('audioinput', deviceId);
  setV({ inputId: deviceId });
  savePrefs();
  await reopenMic();
}

export function setOutputDevice(deviceId: string | null) {
  rememberDevice('audiooutput', getV().outputId ?? 'default');
  rememberDevice('audiooutput', deviceId ?? 'default');
  setV({ outputId: deviceId });
  savePrefs();
  for (const el of audioEls.values()) applySink(el);
  applyCtxSink();
}

function applySink(el: HTMLAudioElement) {
  const sink = (el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
  if (sink) void sink.call(el, getV().outputId ?? '').catch(() => {});
}

export async function listAudioDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const pick = (kind: MediaDeviceKind) =>
    devices
      .filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `${kind === 'audioinput' ? 'Microfone' : 'Saída'} ${i + 1}` }));
  return { inputs: pick('audioinput'), outputs: pick('audiooutput') };
}

export function setScreenQuality(q: ScreenQuality) {
  setV({ screenQuality: q });
  savePrefs();
}

// Câmera abrindo (getUserMedia pode demorar): um segundo clique cancela em vez de abrir outra.
let cameraOpening = false;
let cameraCancelled = false;

/** Liga a câmera com um stream já aberto (o da prévia), sem abrir o dispositivo de novo. */
export function startCamera(stream: MediaStream) {
  if (!getV().channelId || getV().camera) {
    stopStream(stream);
    return;
  }
  setV({ camera: stream });
  addStreamToPeers(stream);
  socket?.emit('voice:state', { cameraStreamId: stream.id });
}

export async function toggleCamera() {
  const { camera } = getV();
  if (cameraOpening) {
    cameraCancelled = true;
    return;
  }
  if (camera) {
    removeStreamFromPeers(camera);
    stopStream(camera);
    setV({ camera: null });
    socket?.emit('voice:state', { cameraStreamId: null });
    return;
  }
  if (!voiceCan(Perm.Video)) {
    setV({ error: 'Você não tem permissão para usar vídeo neste canal.' });
    return;
  }
  cameraOpening = true;
  cameraCancelled = false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    // Desligou (ou saiu da chamada) enquanto a câmera abria: solta o dispositivo na hora.
    if (cameraCancelled || !getV().channelId) {
      stopStream(stream);
      return;
    }
    rememberDevice('videoinput', stream.getVideoTracks()[0]?.getSettings().deviceId);
    setV({ camera: stream });
    addStreamToPeers(stream);
    socket?.emit('voice:state', { cameraStreamId: stream.id });
  } catch (err) {
    setV({ error: (err as Error).name === 'NotAllowedError' ? 'Sem permissão para usar a câmera.' : 'Não foi possível abrir a câmera.' });
  } finally {
    cameraOpening = false;
  }
}

/** Captura do seletor próprio (Windows): para quando a tela parar e tamanho real da fonte. */
let nativeStop: ((keepCapture?: boolean) => void) | null = null;
let screenSize: { width: number; height: number } | null = null;
/** Sobe a cada captura nova: o "acabou" de uma captura já trocada não derruba a transmissão. */
let screenGen = 0;

/** Abre a captura (seletor do Line ou do navegador) sem mexer na chamada. */
async function openScreen(source: { id: string; audio: boolean } | undefined, gen: number) {
  const { resolution, fps } = getV().screenQuality;
  // Descobre antes quais codecs a placa de vídeo codifica: a escolha do codec é feita na hora de
  // adicionar a tela na conexão, sem tempo para perguntar.
  await detectHardwareCodecs(resolution, fps);
  const ended = () => {
    if (gen === screenGen) stopScreen();
  };
  let stream: MediaStream;
  let stop: ((keepCapture?: boolean) => void) | null = null;
  let size: { width: number; height: number } | null = null;
  if (source && hasNativeScreen()) {
    const native = await startNativeScreen(source.id, {
      fps,
      audio: source.audio,
      height: RESOLUTIONS[resolution].height,
      onEnded: ended,
    });
    stream = native.stream;
    stop = native.stop;
    size = { width: native.width, height: native.height };
  } else {
    const r = RESOLUTIONS[resolution];
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: r.width, max: r.width },
        height: { ideal: r.height, max: r.height },
        frameRate: { ideal: fps, max: fps },
      },
      // Tira do áudio capturado o som do próprio Line (vozes, sons, música), para os outros não
      // ouvirem a própria voz de volta. É uma restrição da trilha de áudio: no nível de cima do
      // pedido o navegador ignorava e o som da chamada ia junto na transmissão.
      audio: { restrictOwnAudio: true, suppressLocalAudioPlayback: false } as MediaTrackConstraints,
      // Pede o áudio do sistema já marcado no seletor (Chromium/WebView2). No Windows ele vem ao compartilhar a tela inteira.
      systemAudio: 'include',
      windowAudio: 'system',
    } as DisplayMediaStreamOptions);
  }
  const video = stream.getVideoTracks()[0];
  // 60fps = jogo/vídeo (prioriza fluidez); 30fps = texto/código (prioriza nitidez).
  if (video) video.contentHint = fps >= 60 ? 'motion' : 'detail';
  video?.addEventListener('ended', ended);
  return { stream, stop, size };
}

/**
 * Liga/desliga o compartilhamento de tela.
 * Com `source` (app do Windows ou do macOS), captura a janela/tela escolhida no seletor do Line.
 * Sem ela, usa o seletor do próprio navegador (web, macOS, Linux).
 */
export async function toggleScreen(source?: { id: string; audio: boolean }) {
  const { screen } = getV();
  if (screen) {
    stopScreen();
    return;
  }
  if (!voiceCan(Perm.Video)) {
    setV({ error: 'Você não tem permissão para compartilhar a tela neste canal.' });
    return;
  }
  const gen = ++screenGen;
  try {
    const opened = await openScreen(source, gen);
    // Saiu da chamada enquanto abria: solta a captura.
    if (!getV().channelId) {
      opened.stop?.();
      stopStream(opened.stream);
      return;
    }
    const { stream } = opened;
    nativeStop = opened.stop;
    screenSize = opened.size;
    setV({ screen: stream });
    addStreamToPeers(stream);
    startThumbs(stream, source?.id);
    socket?.emit('voice:state', { screenStreamId: stream.id });
    playCallSound('start_transmission');
  } catch (err) {
    if ((err as Error).name !== 'NotAllowedError') setV({ error: 'Não foi possível compartilhar a tela.' });
  }
}

/**
 * Troca a janela/tela transmitida sem parar: as trilhas novas entram no mesmo stream e nas mesmas
 * conexões (replaceTrack), então quem assiste continua assistindo, sem renegociar o vídeo.
 */
export async function switchScreen(source?: { id: string; audio: boolean }) {
  const screen = getV().screen;
  if (!screen) return toggleScreen(source);
  const gen = ++screenGen;
  const oldStop = nativeStop;
  let opened: Awaited<ReturnType<typeof openScreen>>;
  try {
    opened = await openScreen(source, gen);
  } catch (err) {
    if (source && hasNativeScreen()) {
      // O Rust só captura uma fonte por vez: a antiga já parou ao tentar a nova.
      stopScreen();
      setV({ error: 'Não foi possível trocar a tela.' });
      return;
    }
    // Cancelou ou falhou no seletor do navegador: continua transmitindo o que já estava.
    if (screenGen === gen) screenGen = gen - 1;
    if ((err as Error).name !== 'NotAllowedError') setV({ error: 'Não foi possível trocar a tela.' });
    return;
  }
  // Parou de transmitir (ou saiu) enquanto abria: solta a captura nova.
  if (getV().screen !== screen) {
    opened.stop?.();
    stopStream(opened.stream);
    return;
  }
  const oldTracks = screen.getTracks();
  const newVideo = opened.stream.getVideoTracks()[0] ?? null;
  const newAudio = opened.stream.getAudioTracks()[0] ?? null;
  for (const t of oldTracks) screen.removeTrack(t);
  for (const t of opened.stream.getTracks()) screen.addTrack(t);
  screenSize = opened.size;
  const { resolution, fps } = getV().screenQuality;
  for (const [id, { pc }] of peers) {
    if (!watchers.has(id)) continue;
    let hadAudio = false;
    for (const sender of pc.getSenders()) {
      const old = sender.track;
      if (!old || !oldTracks.includes(old)) continue;
      if (old.kind === 'video') {
        void sender.replaceTrack(newVideo);
        void retuneScreenSender(sender, resolution, fps);
      } else if (newAudio) {
        hadAudio = true;
        void sender.replaceTrack(newAudio);
      } else pc.removeTrack(sender);
    }
    // Fonte nova tem som e a antiga não tinha: o som entra na conexão (renegocia só o áudio).
    if (newAudio && !hadAudio) pc.addTrack(newAudio, screen);
  }
  // A captura antiga sai sem desligar a nova no Rust (que já trocou de fonte ao começar a nova).
  oldStop?.(true);
  for (const t of oldTracks) t.stop();
  nativeStop = opened.stop;
  startThumbs(screen, source?.id);
  setV((v) => ({ mediaRev: v.mediaRev + 1 }));
}

/** Depois de trocar a fonte: ajusta taxa, fps e redução ao tamanho da tela nova. */
async function retuneScreenSender(sender: RTCRtpSender, resolution: Resolution, fps: Fps) {
  try {
    const params = sender.getParameters();
    const enc = params.encodings?.[0];
    if (!enc) return;
    enc.maxBitrate = RESOLUTIONS[resolution].kbps[fps] * 1000;
    enc.maxFramerate = fps;
    enc.scaleResolutionDownBy = downscale(resolution);
    await sender.setParameters(params);
  } catch {
    // fica com os parâmetros de antes
  }
}

/** Troca a câmera sem desligar: mesma trilha nas conexões (replaceTrack), só muda o dispositivo. */
export async function switchCamera(deviceId: string) {
  const camera = getV().camera;
  if (!camera) return;
  let fresh: MediaStream;
  try {
    fresh = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch (err) {
    setV({ error: (err as Error).name === 'NotAllowedError' ? 'Sem permissão para usar a câmera.' : 'Não foi possível abrir essa câmera.' });
    return;
  }
  if (getV().camera !== camera) {
    stopStream(fresh);
    return;
  }
  const old = camera.getVideoTracks()[0];
  const track = fresh.getVideoTracks()[0];
  rememberDevice('videoinput', track?.getSettings().deviceId);
  if (old) camera.removeTrack(old);
  camera.addTrack(track);
  for (const { pc } of peers.values()) {
    for (const sender of pc.getSenders()) if (old && sender.track === old) void sender.replaceTrack(track);
  }
  old?.stop();
  setV((v) => ({ mediaRev: v.mediaRev + 1 }));
}

function stopScreen() {
  const { screen } = getV();
  if (!screen) return;
  removeStreamFromPeers(screen);
  watchers.clear();
  if (myId) {
    const me = myId;
    setV((v) => {
      const screenViewers = { ...v.screenViewers };
      delete screenViewers[me];
      return { screenViewers };
    });
  }
  playCallSound('close_transmission');
  stopThumbs();
  stopStream(screen);
  nativeStop?.();
  nativeStop = null;
  screenSize = null;
  setV({ screen: null });
  socket?.emit('voice:state', { screenStreamId: null });
}

export function clearVoiceError() {
  setV({ error: null });
}

// ---------- WebRTC ----------

// ---------- miniatura da tela ----------

let thumbVideo: HTMLVideoElement | null = null;
let thumbTimer: ReturnType<typeof setInterval> | null = null;
let lastThumb: string | null = null;
/** Jogo da janela que estou transmitindo (vai junto da miniatura). */
let thumbGame: ScreenGame | undefined;

/** Tira um quadro pequeno da minha tela e manda para quem ainda não assiste (a cada 10 s). */
function startThumbs(stream: MediaStream, sourceId?: string) {
  stopThumbs();
  if (sourceId && hasGameDetection()) {
    void detectGame().then((g) => {
      if (!g || g.windowId !== sourceId || thumbVideo?.srcObject !== stream) return;
      // O ícone vai pela sinalização, que só aceita mensagens pequenas.
      thumbGame = { name: g.name, icon: g.icon && g.icon.length < 20_000 ? g.icon : undefined };
    });
  }
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.srcObject = stream;
  void v.play().catch(() => {});
  thumbVideo = v;
  const tick = () => {
    const data = captureThumb();
    if (!data) return;
    lastThumb = data;
    for (const id of peers.keys()) if (!watchers.has(id)) send(id, { type: 'thumb', data, game: thumbGame });
  };
  setTimeout(tick, 1500);
  thumbTimer = setInterval(tick, 10_000);
}

function captureThumb(): string | null {
  const v = thumbVideo;
  // Quadro minúsculo (janela minimizada): não vira miniatura, senão estica o quadro de quem vê.
  if (!v || v.videoWidth < 100 || v.videoHeight < 100) return null;
  const width = 256;
  const height = Math.max(1, Math.round((width * v.videoHeight) / v.videoWidth));
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(v, 0, 0, width, height);
  const data = c.toDataURL('image/jpeg', 0.5);
  // O servidor de sinalização aceita mensagens pequenas.
  return data.length < 60_000 ? data : null;
}

function stopThumbs() {
  if (thumbTimer) clearInterval(thumbTimer);
  thumbTimer = null;
  if (thumbVideo) thumbVideo.srcObject = null;
  thumbVideo = null;
  lastThumb = null;
  thumbGame = undefined;
}

/** Quem está assistindo à minha tela: só essas conexões recebem o vídeo e o som dela. */
const watchers = new Set<string>();

function send(to: string, signal: VoiceSignal) {
  socket?.emit('voice:signal', { to, signal });
}

/** Conta para todos do canal quem assiste à minha tela (o som de entrar/sair só toca para quem está nela). */
function sendViewers(to?: string) {
  const ids = [...watchers];
  for (const id of to ? [to] : peers.keys()) send(id, { type: 'viewers', ids });
  // Eu também vejo quem assiste à minha tela.
  if (myId) setV((v) => ({ screenViewers: { ...v.screenViewers, [myId as string]: ids } }));
}

function createPeer(peerId: string): Peer {
  const pc = new RTCPeerConnection({ iceServers });
  const peer: Peer = { pc, polite: (myId ?? '') > peerId, makingOffer: false, ignoreOffer: false, streamIds: new Set() };
  peers.set(peerId, peer);

  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      if (pc.localDescription) send(peerId, { type: 'description', description: pc.localDescription.toJSON() });
    } catch (err) {
      console.warn('Falha na negociação de voz', err);
    } finally {
      peer.makingOffer = false;
    }
  };

  pc.onicecandidate = ({ candidate }) => send(peerId, { type: 'candidate', candidate: candidate ? candidate.toJSON() as never : null });

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') pc.restartIce();
  };

  pc.ontrack = ({ track, streams, receiver }) => {
    const stream = streams[0] ?? new MediaStream([track]);
    peer.streamIds.add(stream.id);
    bufferScreen(peerId, stream, track, receiver);
    setV((v) => ({ streams: { ...v.streams, [stream.id]: stream } }));
    if (track.kind === 'audio') attachAudio(peerId, stream);
    const onGone = () => {
      if (stream.getTracks().every((t) => t.readyState === 'ended') || stream.getTracks().length === 0) {
        dropRemoteStream(stream.id);
      }
    };
    stream.onremovetrack = onGone;
    track.onended = onGone;
  };

  if (mic) for (const t of mic.getTracks()) pc.addTrack(t, mic);
  const { camera, screen } = getV();
  if (camera) addStream(pc, camera);
  if (screen && watchers.has(peerId)) addStream(pc, screen);
  // Quem chega vê a miniatura da minha tela antes de escolher assistir.
  if (screen && lastThumb) {
    const thumb = lastThumb;
    setTimeout(() => send(peerId, { type: 'thumb', data: thumb, game: thumbGame }), 500);
  }
  if (screen && watchers.size) setTimeout(() => sendViewers(peerId), 500);
  // Conexão nova com quem eu já assistia: avisa de novo para a tela voltar.
  if (getV().watching[peerId]) queueMicrotask(() => send(peerId, { type: 'watch', on: true }));
  return peer;
}

async function onSignal(from: string, signal: VoiceSignal) {
  const mine = getV().channelId;
  // O servidor só repassa sinais entre pessoas do mesmo canal; o estado local pode ainda não ter chegado.
  if (!mine) return;
  const peer = peers.get(from) ?? createPeer(from);
  const { pc } = peer;
  if (signal.type === 'thumb') {
    if (typeof signal.data === 'string' && signal.data.startsWith('data:image/jpeg')) {
      const g = signal.game;
      const game =
        g && typeof g.name === 'string'
          ? { name: g.name.slice(0, 80), icon: typeof g.icon === 'string' && g.icon.startsWith('data:image/') ? g.icon : undefined }
          : undefined;
      setV((v) => {
        const screenGames = { ...v.screenGames };
        if (game) screenGames[from] = game;
        else delete screenGames[from];
        return { screenThumbs: { ...v.screenThumbs, [from]: signal.data }, screenGames };
      });
    }
    return;
  }
  if (signal.type === 'viewers') {
    if (!Array.isArray(signal.ids)) return;
    const ids = signal.ids.filter((id): id is string => typeof id === 'string');
    const before = getV().screenViewers[from] ?? [];
    // Eu assisto a essa tela: ouço quando outra pessoa entra ou sai dela (a minha própria toca no setWatching).
    if (getV().watching[from]) {
      const others = (list: string[]) => list.filter((id) => id !== myId);
      if (others(ids).some((id) => !before.includes(id))) playCallSound('enter_in_transmission');
      else if (others(before).some((id) => !ids.includes(id))) playCallSound('left_transmission');
    }
    setV((v) => ({ screenViewers: { ...v.screenViewers, [from]: ids } }));
    return;
  }
  if (signal.type === 'watch') {
    const { screen } = getV();
    if (signal.on) {
      if (watchers.has(from)) return;
      watchers.add(from);
      if (screen) {
        addStream(pc, screen);
        playCallSound('enter_in_transmission');
        sendViewers();
      }
    } else {
      if (!watchers.delete(from)) return;
      if (screen) {
        removeStreamFrom(pc, screen);
        playCallSound('left_transmission');
        sendViewers();
      }
    }
    return;
  }
  try {
    if (signal.type === 'description') {
      const desc = signal.description;
      const collision = desc.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(desc.sdp ? { type: desc.type, sdp: tuneScreenSdp(desc.sdp, from) } : desc);
      if (desc.type === 'offer') {
        await pc.setLocalDescription();
        if (pc.localDescription) send(from, { type: 'description', description: pc.localDescription.toJSON() });
        // Na colisão (os dois ofereceram ao mesmo tempo, como quando alguém entra na sala) o lado
        // educado desfaz a própria oferta. Câmera/tela que estavam nela ficam sem negociar e nem todo
        // WebView dispara negotiationneeded de novo: então renegocia na mão se sobrou algo pendente.
        if (collision) setTimeout(() => renegotiateIfPending(peer), 0);
      }
    } else {
      try {
        await pc.addIceCandidate(signal.candidate ?? undefined);
      } catch (err) {
        if (!peer.ignoreOffer) throw err;
      }
    }
  } catch (err) {
    console.warn('Erro de sinalização de voz', err);
  }
}

/** Envia uma nova oferta se há faixas locais que nunca entraram numa negociação (sem mid). */
async function renegotiateIfPending(peer: Peer) {
  const { pc } = peer;
  if (pc.signalingState !== 'stable' || peer.makingOffer) return;
  if (!pc.getTransceivers().some((t) => !t.mid && t.sender.track)) return;
  const peerId = [...peers.entries()].find(([, p]) => p === peer)?.[0];
  if (!peerId) return;
  try {
    peer.makingOffer = true;
    await pc.setLocalDescription();
    if (pc.localDescription) send(peerId, { type: 'description', description: pc.localDescription.toJSON() });
  } catch (err) {
    console.warn('Falha ao renegociar voz', err);
  } finally {
    peer.makingOffer = false;
  }
}

/**
 * Tela recebida: guarda ~50 ms a mais antes de mostrar. Dá tempo de o reenvio (NACK) repor um
 * pacote perdido e de reordenar os que chegam trocados, em vez de travar ou borrar o quadro.
 * Voz e câmera ficam sem buffer extra (latência da conversa).
 */
const SCREEN_BUFFER_MS = 50;
function bufferScreen(peerId: string, stream: MediaStream, track: MediaStreamTrack, receiver: RTCRtpReceiver) {
  const state = getV().states[peerId];
  const isScreen =
    stream.id === state?.screenStreamId || (track.kind === 'video' && !!state && stream.id !== state.cameraStreamId);
  if (!isScreen) return;
  const r = receiver as unknown as { jitterBufferTarget?: number | null; playoutDelayHint?: number };
  try {
    // jitterBufferTarget em ms (Chromium/WebView2 novos); playoutDelayHint em segundos (antigos, WebKit).
    if ('jitterBufferTarget' in receiver) r.jitterBufferTarget = SCREEN_BUFFER_MS;
    else r.playoutDelayHint = SCREEN_BUFFER_MS / 1000;
  } catch {
    // navegador sem esse ajuste: segue com o buffer automático
  }
}

function closePeer(peerId: string) {
  // Quem assistia saiu da chamada: os outros que assistem ficam sabendo.
  if (watchers.delete(peerId) && getV().screen) queueMicrotask(() => sendViewers());
  const peer = peers.get(peerId);
  if (!peer) return;
  peer.pc.close();
  peers.delete(peerId);
  for (const id of peer.streamIds) dropRemoteStream(id);
  setV((v) => {
    const speaking = { ...v.speaking };
    delete speaking[peerId];
    return { speaking };
  });
}

function addStreamToPeers(stream: MediaStream) {
  // A tela só vai para quem clicou em "Assistir transmissão".
  const isScreen = stream === getV().screen;
  for (const [id, { pc }] of peers) if (!isScreen || watchers.has(id)) addStream(pc, stream);
}

/** Adiciona câmera ou tela numa conexão. A tela vai com a taxa de bits da qualidade escolhida. */
function addStream(pc: RTCPeerConnection, stream: MediaStream) {
  const isScreen = stream === getV().screen;
  for (const track of stream.getTracks()) {
    if (!isScreen || track.kind !== 'video') {
      pc.addTrack(track, stream);
      continue;
    }
    const { resolution, fps } = getV().screenQuality;
    const transceiver = pc.addTransceiver(track, {
      direction: 'sendonly',
      streams: [stream],
      sendEncodings: [
        {
          maxBitrate: RESOLUTIONS[resolution].kbps[fps] * 1000,
          maxFramerate: fps,
          scaleResolutionDownBy: downscale(resolution),
          // A tela passa na frente do resto da conexão quando a banda aperta.
          priority: 'high',
          networkPriority: 'high',
        } as RTCRtpEncodingParameters,
      ],
    });
    preferHardwareCodec(transceiver, resolution, fps);
    void tuneScreenSender(transceiver.sender, fps);
  }
}

/** Captura do Rust vem no tamanho real da fonte: reduz no envio até a resolução escolhida. */
function downscale(resolution: Resolution) {
  if (!screenSize) return 1;
  const r = RESOLUTIONS[resolution];
  return Math.max(1, screenSize.width / r.width, screenSize.height / r.height);
}

/** Codecs que a placa de vídeo codifica nesta qualidade (mediaCapabilities: powerEfficient). */
let hwCodecs = new Set<string>();
let hwKey = '';

async function detectHardwareCodecs(resolution: Resolution, fps: Fps) {
  const key = `${resolution}@${fps}`;
  if (hwKey === key) return;
  const caps = (navigator as Navigator & { mediaCapabilities?: MediaCapabilities }).mediaCapabilities;
  const found = new Set<string>();
  if (caps?.encodingInfo) {
    const r = RESOLUTIONS[resolution];
    await Promise.all(
      ['video/AV1', 'video/H264', 'video/VP9'].map(async (contentType) => {
        try {
          const info = await Promise.race([
            caps.encodingInfo({
              type: 'webrtc',
              video: { contentType, width: r.width, height: r.height, bitrate: r.kbps[fps] * 1000, framerate: fps },
            } as MediaEncodingConfiguration),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 800)),
          ]);
          if (info?.supported && info.powerEfficient) found.add(contentType.toLowerCase());
        } catch {
          // navegador sem suporte a essa pergunta: trata como codificação por software
        }
      }),
    );
  }
  hwCodecs = found;
  hwKey = key;
}

/**
 * Ordem dos codecs da tela. Primeiro o que a placa de vídeo codifica (AV1, depois H.264, depois VP9):
 * não disputa a CPU com o jogo, então a qualidade não cai quando o Line fica em segundo plano.
 * Sem placa: em 60fps e acima de 1080p, H.264 (o mais leve em software); em 30fps (texto, código),
 * VP9, que deixa letras e bordas bem mais nítidas que o VP8 na mesma taxa. Se o outro lado não
 * aceitar, a negociação cai para o próximo da lista.
 */
function preferHardwareCodec(transceiver: RTCRtpTransceiver, resolution: Resolution, fps: Fps) {
  if (!transceiver.setCodecPreferences) return;
  const codecs = RTCRtpSender.getCapabilities?.('video')?.codecs;
  if (!codecs) return;
  const heavy = fps >= 60 || (resolution !== '720' && resolution !== '1080');
  const software = heavy ? ['video/h264', 'video/vp9', 'video/vp8'] : ['video/vp9', 'video/vp8', 'video/h264'];
  const order = [...['video/av1', 'video/h264', 'video/vp9'].filter((m) => hwCodecs.has(m)), ...software];
  const rank = (c: { mimeType: string }) => {
    const i = order.indexOf(c.mimeType.toLowerCase());
    // rtx/red/ulpfec e AV1 por software ficam no fim, na ordem original
    return i < 0 ? order.length : i;
  };
  try {
    transceiver.setCodecPreferences([...codecs].sort((a, b) => rank(a) - rank(b)));
  } catch {
    // navegador não deixou escolher: fica com o padrão
  }
}

/**
 * Sem isto o WebRTC começa a estimar a banda em ~300 kbps e sobe aos poucos, e em qualquer perda
 * despenca: os primeiros segundos e os movimentos rápidos saem em blocos. Na descrição do outro
 * lado (que vale para o meu envio) marca a taxa inicial e o mínimo da conexão para a qualidade
 * escolhida. Só no Chromium/WebView2/WebKit (libwebrtc); o adaptador do Linux ignora.
 */
function tuneScreenSdp(sdp: string, peerId: string) {
  if (!getV().screen || !watchers.has(peerId)) return sdp;
  if ((window as unknown as { __lineRtc?: { adapter?: boolean } }).__lineRtc?.adapter) return sdp;
  const { resolution, fps } = getV().screenQuality;
  const cap = RESOLUTIONS[resolution].kbps[fps];
  // Começo alto mas sem passar de 8 Mbps (upload mais fraco não engasga logo no início).
  const extra = `x-google-start-bitrate=${Math.round(Math.min(cap * 0.6, 8000))};x-google-min-bitrate=${Math.round(Math.min(cap * 0.15, 2500))}`;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  // Separa por m= e mexe só nas seções de vídeo.
  const sections = sdp.split(new RegExp(`${eol}(?=m=)`));
  return sections
    .map((section) => {
      if (!section.startsWith('m=video')) return section;
      const lines = section.split(eol);
      const pts = new Set<string>();
      for (const l of lines) {
        const rtp = /^a=rtpmap:(\d+) (VP8|VP9|AV1|H264)\//i.exec(l);
        if (rtp) pts.add(rtp[1]);
      }
      const out: string[] = [];
      for (const line of lines) {
        const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(line);
        if (fmtp && pts.has(fmtp[1])) {
          out.push(fmtp[2].includes('x-google-') ? line : `${line};${extra}`);
          continue;
        }
        out.push(line);
        // VP8 costuma vir sem a=fmtp: cria a linha logo depois do rtpmap.
        const rtp = /^a=rtpmap:(\d+) /.exec(line);
        if (rtp && pts.has(rtp[1]) && !lines.some((l) => l.startsWith(`a=fmtp:${rtp[1]} `))) {
          out.push(`a=fmtp:${rtp[1]} ${extra}`);
        }
      }
      return out.join(eol);
    })
    .join(eol);
}

async function tuneScreenSender(sender: RTCRtpSender, fps: Fps, retry = true) {
  try {
    const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
    params.degradationPreference = fps >= 60 ? 'maintain-framerate' : 'maintain-resolution';
    await sender.setParameters(params);
  } catch {
    // Alguns navegadores só aceitam depois da negociação: tenta de novo quando a conexão já subiu.
    if (retry) setTimeout(() => void tuneScreenSender(sender, fps, false), 3000);
  }
}

function removeStreamFromPeers(stream: MediaStream) {
  for (const { pc } of peers.values()) removeStreamFrom(pc, stream);
}

function removeStreamFrom(pc: RTCPeerConnection, stream: MediaStream) {
  const ids = new Set(stream.getTracks().map((t) => t.id));
  for (const sender of pc.getSenders()) if (sender.track && ids.has(sender.track.id)) pc.removeTrack(sender);
}

function attachAudio(peerId: string, stream: MediaStream) {
  if (audioEls.has(stream.id)) return;
  const el = document.createElement('audio');
  el.autoplay = true;
  el.srcObject = stream;
  el.dataset.peer = peerId;
  el.dataset.stream = stream.id;
  applyPeerAudio(el);
  applySink(el);
  document.body.appendChild(el);
  void el.play().catch(() => {});
  audioEls.set(stream.id, el);
}

function dropRemoteStream(id: string) {
  const el = audioEls.get(id);
  if (el) {
    dropBoost(el);
    el.srcObject = null;
    el.remove();
    audioEls.delete(id);
  }
  analysers.delete(id);
  setV((v) => {
    if (!v.streams[id]) return {};
    const streams = { ...v.streams };
    delete streams[id];
    return { streams };
  });
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}

function stopMic() {
  stopStream(rawMic);
  if (mic !== rawMic) stopStream(mic);
  if (micPre && micPre !== rawMic) stopStream(micPre);
  disposeNoiseSuppressor();
  disposeGain();
  mic = null;
  rawMic = null;
  analysers.delete('local');
}

// ---------- quem está falando ----------

let audioCtx: AudioContext | null = null;
let loop: ReturnType<typeof setInterval> | null = null;
const analysers = new Map<string, { analyser: AnalyserNode; userId: string; buf: Uint8Array<ArrayBuffer> }>();

function analyserFor(key: string, userId: string, stream: MediaStream) {
  let entry = analysers.get(key);
  if (!entry && stream.getAudioTracks().length) {
    audioCtx ??= new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    entry = { analyser, userId, buf: new Uint8Array(new ArrayBuffer(analyser.fftSize)) };
    analysers.set(key, entry);
  }
  return entry;
}

function level(entry: { analyser: AnalyserNode; buf: Uint8Array<ArrayBuffer> }) {
  entry.analyser.getByteTimeDomainData(entry.buf);
  let sum = 0;
  for (const v of entry.buf) {
    const x = (v - 128) / 128;
    sum += x * x;
  }
  return Math.sqrt(sum / entry.buf.length);
}

/** Última vez (ms) que cada pessoa passou do limiar. A fala tem pausas curtas entre sílabas: segura o estado por um tempo. */
const lastLoud = new Map<string, number>();
const SPEAK_ON = 0.04;
const SPEAK_KEEP = 0.025;
const SPEAK_HOLD_MS = 700;

function isSpeaking(userId: string, lvl: number, now: number) {
  const was = now - (lastLoud.get(userId) ?? -Infinity) < SPEAK_HOLD_MS;
  // Histerese: começa a falar acima de SPEAK_ON; enquanto fala, um nível menor já mantém.
  if (lvl > (was ? SPEAK_KEEP : SPEAK_ON)) {
    lastLoud.set(userId, now);
    return true;
  }
  return was;
}

function startSpeakingLoop() {
  if (loop) return;
  void audioCtx?.resume();
  loop = setInterval(() => {
    const v = getV();
    const now = performance.now();
    const next: Record<string, boolean> = {};
    const pttClosed = v.inputMode === 'ptt' && !v.pttDown;
    if (mic && myId && !v.muted && !v.deafened && !pttClosed) {
      const e = analyserFor('local', myId, micPre ?? mic);
      if (e) {
        const lvl = level(e);
        updateGate(lvl, now);
        if (gateOpen && isSpeaking(myId, lvl, now)) next[myId] = true;
      }
    } else if (myId) lastLoud.delete(myId);
    for (const [peerId, peer] of peers) {
      const screenId = v.states[peerId]?.screenStreamId;
      let lvl = 0;
      for (const sid of peer.streamIds) {
        if (sid === screenId) continue; // áudio da tela não conta como fala
        const stream = v.streams[sid];
        if (!stream) continue;
        const e = analyserFor(sid, peerId, stream);
        if (e) lvl = Math.max(lvl, level(e));
      }
      // Microfone desligado do outro lado: a borda some na hora.
      if (v.states[peerId]?.muted) lastLoud.delete(peerId);
      else if (isSpeaking(peerId, lvl, now)) next[peerId] = true;
    }
    const prev = v.speaking;
    const changed =
      Object.keys(next).length !== Object.keys(prev).filter((k) => prev[k]).length ||
      Object.keys(next).some((k) => next[k] !== !!prev[k]);
    if (changed) setV({ speaking: Object.fromEntries(Object.entries(next).filter(([, s]) => s)) });
  }, 120);
}

function stopSpeakingLoop() {
  if (loop) clearInterval(loop);
  loop = null;
  analysers.clear();
  lastLoud.clear();
}

/** Participantes de um canal, em ordem de chegada. */
export function participants(states: Record<string, VoiceState>, channelId: string): VoiceState[] {
  return Object.values(states)
    .filter((s) => s.channelId === channelId)
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
}

// ---------- celular: aba em segundo plano ----------
//
// No navegador do celular a aba em segundo plano é congelada/suspensa: o áudio para, o microfone pode ser
// encerrado pelo sistema e a conexão cai. Não dá para impedir isso numa página web, mas dá para:
// manter a tela acesa durante a chamada (Wake Lock), mostrar a chamada nos controles de mídia do sistema
// (Media Session, que ajuda o Android a manter a aba viva) e, ao voltar, religar tudo sozinho.

let micLostInBackground = false;

// ---------- dispositivo removido (fone bluetooth desligou, câmera desplugada…) ----------

/** Dispositivos usados, do mais antigo ao mais recente, para voltar ao anterior quando um some. */
const usedDevices: Record<'audioinput' | 'audiooutput' | 'videoinput', string[]> = { audioinput: [], audiooutput: [], videoinput: [] };

function rememberDevice(kind: keyof typeof usedDevices, id: string | undefined | null) {
  if (!id) return;
  const list = usedDevices[kind].filter((x) => x !== id);
  list.push(id);
  usedDevices[kind] = list.slice(-10);
}

/** O anterior ainda conectado (ou null = padrão do sistema). */
function previousDevice(kind: keyof typeof usedDevices, gone: string, present: Set<string>): string | null {
  const list = usedDevices[kind].filter((id) => id !== gone && id !== 'default' && present.has(id));
  return list[list.length - 1] ?? null;
}

let deviceCheck: ReturnType<typeof setTimeout> | null = null;

async function onDeviceChange() {
  let devices: MediaDeviceInfo[];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return;
  }
  const ids = (kind: MediaDeviceKind) => new Set(devices.filter((d) => d.kind === kind).map((d) => d.deviceId));
  const inputs = ids('audioinput');
  const outputs = ids('audiooutput');
  const cams = ids('videoinput');
  const { inputId, outputId, channelId, camera } = getV();

  // Microfone escolhido sumiu: volta para o anterior (ou o padrão) sem sair da chamada.
  const micTrack = rawMic?.getAudioTracks()[0];
  const micDevice = micTrack?.getSettings().deviceId;
  if (inputId && !inputs.has(inputId)) {
    const next = previousDevice('audioinput', inputId, inputs);
    setV({ inputId: next });
    savePrefs();
    if (channelId) await reopenMic();
  } else if (channelId && micTrack && (micTrack.readyState === 'ended' || (micDevice && !inputs.has(micDevice)))) {
    await reopenMic();
  }

  // Saída escolhida sumiu: toca no anterior (ou no padrão).
  if (outputId && !outputs.has(outputId)) {
    const next = previousDevice('audiooutput', outputId, outputs);
    setV({ outputId: next });
    savePrefs();
    for (const el of audioEls.values()) applySink(el);
    applyCtxSink();
  }

  // Câmera em uso sumiu: troca para a anterior ou qualquer outra; sem nenhuma, desliga.
  const camTrack = camera?.getVideoTracks()[0];
  const camDevice = camTrack?.getSettings().deviceId;
  if (camera && camTrack && (camTrack.readyState === 'ended' || (camDevice && !cams.has(camDevice)))) {
    const next = previousDevice('videoinput', camDevice ?? '', cams) ?? [...cams].find((id) => id && id !== camDevice) ?? null;
    if (next) await switchCamera(next);
    else if (getV().camera === camera) await toggleCamera();
  }
}

if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    // O sistema manda vários avisos seguidos: espera assentar.
    if (deviceCheck) clearTimeout(deviceCheck);
    deviceCheck = setTimeout(() => void onDeviceChange(), 400);
  });
}

function watchMicEnded(stream: MediaStream) {
  const track = stream.getAudioTracks()[0];
  if (!track) return;
  track.addEventListener('ended', () => {
    // O sistema tirou o microfone (aba em segundo plano, ligação telefônica…). Reabre assim que der.
    if (rawMic !== stream || !getV().channelId) return;
    if (document.visibilityState === 'visible') void reopenMic();
    else micLostInBackground = true;
  });
}

function onForeground() {
  if (document.visibilityState !== 'visible') return;
  void playCtx?.resume().catch(() => {});
  void audioCtx?.resume().catch(() => {});
  resumeNoiseSuppressor();
  void gainCtx?.resume().catch(() => {});
  if (!getV().channelId) return;
  for (const el of audioEls.values()) if (el.paused) void el.play().catch(() => {});
  const track = rawMic?.getAudioTracks()[0];
  if (micLostInBackground || !track || track.readyState === 'ended') {
    micLostInBackground = false;
    void reopenMic();
  }
  // A conexão pode ter caído enquanto a aba dormia: reconecta já (o voice:snapshot nos põe de volta no canal).
  if (socket && !socket.connected) socket.connect();
  else void syncVoice();
  void keepScreenOn(true);
}

type WakeLock = { release: () => Promise<void>; released: boolean };
let wakeLock: WakeLock | null = null;

async function keepScreenOn(on: boolean) {
  const nav = navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLock> } };
  if (!on) {
    const lock = wakeLock;
    wakeLock = null;
    await lock?.release().catch(() => {});
    return;
  }
  if (!nav.wakeLock || document.visibilityState !== 'visible' || (wakeLock && !wakeLock.released)) return;
  wakeLock = await nav.wakeLock.request('screen').catch(() => null);
}

function updateMediaSession(channelId: string | null) {
  const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
  if (!ms) return;
  const set = (action: string, handler: (() => void) | null) => {
    try {
      ms.setActionHandler(action as MediaSessionAction, handler);
    } catch {
      // Ação não suportada neste navegador.
    }
  };
  if (!channelId) {
    ms.metadata = null;
    ms.playbackState = 'none';
    set('hangup', null);
    set('togglemicrophone', null);
    return;
  }
  const st = useLine.getState();
  const channel = st.channels[channelId];
  const server = channel?.serverId ? st.servers[channel.serverId] : undefined;
  try {
    ms.metadata = new MediaMetadata({
      title: channel?.name ? `Em chamada: ${channel.name}` : 'Em chamada',
      artist: server?.name ?? 'Line',
      album: 'Line',
    });
  } catch {
    // MediaMetadata indisponível.
  }
  ms.playbackState = 'playing';
  set('hangup', () => void leaveVoice());
  set('togglemicrophone', () => toggleMute());
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', onForeground);
  window.addEventListener('pageshow', onForeground);
  useVoice.subscribe((v, prev) => {
    if (v.channelId === prev.channelId) return;
    updateMediaSession(v.channelId);
    void keepScreenOn(!!v.channelId);
    if (!v.channelId) micLostInBackground = false;
  });
}

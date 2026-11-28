'use client';

import type { ClientToServerEvents, ScreenGame, ServerToClientEvents, VoiceModeration, VoiceSignal, VoiceState } from '@line/shared';
import type { Socket } from 'socket.io-client';
import { create } from 'zustand';
import { defaultNoiseModel, disposeNoiseSuppressor, resumeNoiseSuppressor, suppressNoise, type NoiseModel } from './noise';
import { api } from './api';
import { detectGame, hasGameDetection, hasNativeScreen, startNativeScreen } from './nativeScreen';
import { hasPerm, Perm } from '@line/shared';
import { actions, channelPermsOf, useLine } from './store';
import { toast } from '@/components/Dialogs';
import { playSfx, sfxLoop, startSfxLoop, stopSfxLoop } from './sfx';
import { needsNsfwGate } from './nsfwGate';
import { clearHistory, diagnosticsText, forgetSamples, pushHistory, readRecv, readSend, useScreenStats, type RecvStat, type SendStat } from './screenStats';

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
/** Quando a lista foi buscada. A senha do TURN vale 24 h: numa chamada longa, renova antes de reconectar. */
let iceFetchedAt = 0;
const ICE_STALE_MS = 6 * 3600_000;

async function refreshIceServers() {
  try {
    const res = await api.iceServers();
    if (res.iceServers?.length) iceServers = res.iceServers;
    iceFetchedAt = Date.now();
  } catch {
    iceServers = DEFAULT_ICE;
  }
}

async function freshIceServers() {
  if (Date.now() - iceFetchedAt > ICE_STALE_MS) await refreshIceServers();
  return iceServers;
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
  '720': { label: '720p', width: 1280, height: 720, kbps: { 30: 5000, 60: 8000 } },
  '1080': { label: '1080p', width: 1920, height: 1080, kbps: { 30: 10000, 60: 16000 } },
  '1440': { label: '1440p', width: 2560, height: 1440, kbps: { 30: 14000, 60: 20000 } },
  '2160': { label: '4K', width: 3840, height: 2160, kbps: { 30: 25000, 60: 35000 } },
};

// ---------- preferências (ficam salvas no PC) ----------

export type InputProfile = 'voice' | 'studio' | 'custom';
export type InputMode = 'voice' | 'ptt';

interface VoicePrefs {
  noiseSuppression: boolean;
  /** Modelo do supressor: DeepFilterNet (máximo), GTCRN (equilibrado) ou RNNoise (leve). */
  noiseModel: NoiseModel;
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
  noiseModel: defaultNoiseModel(),
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
    noiseModel: v.noiseModel,
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
const SELF_MUTE_KEY = 'line.voice.selfMute';

/** Meu mudo/ensurdecido, guardado no aparelho para continuar igual depois de recarregar ou reabrir. */
/** Se o mic já estava mutado antes de ensurdecer: ao voltar a ouvir, ele continua como estava. */

function loadSelfMute(): { muted: boolean; deafened: boolean } {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SELF_MUTE_KEY) : null;
    const v = raw ? (JSON.parse(raw) as Partial<{ muted: boolean; deafened: boolean }>) : {};
    const deafened = !!v.deafened;
    return { muted: deafened || !!v.muted, deafened };
  } catch {
    return { muted: false, deafened: false };
  }
}

function saveSelfMute(muted: boolean, deafened: boolean) {
  try {
    localStorage.setItem(SELF_MUTE_KEY, JSON.stringify({ muted, deafened }));
  } catch {
    // sem localStorage: vale só nesta sessão
  }
}

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
  /** Supressor de ruído no microfone e o modelo dele. */
  noiseSuppression: boolean;
  noiseModel: NoiseModel;
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
  /** Na tela da chamada: mostrar quem está sem câmera/tela e o meu próprio vídeo. Só valem para mim. */
  showNoVideo: boolean;
  showMyCamera: boolean;
  showMyScreen: boolean;
  showUnwatched: boolean;
}

export const useVoice = create<VoiceStore>(() => ({
  states: {},
  channelStatus: {},
  userVolume: loadUserVolumes(),
  localMuted: {},
  hiddenVideo: {},
  ...loadStageView(),
  ...loadScreenAudio(),
  watching: {},
  screenThumbs: {},
  screenGames: {},
  screenViewers: {},
  channelId: null,
  connecting: false,
  ...loadSelfMute(),
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
  /** Parou de assistir: os envios da minha tela ficam na conexão sem trilha, prontos para voltar sem renegociar. */
  pausedScreen?: RTCRtpSender[];
  createdAt: number;
  /** Conta as ofertas: o vigia de uma oferta antiga não mexe numa nova. */
  offerSeq: number;
  offerTimer?: ReturnType<typeof setTimeout>;
  offerRetries: number;
  iceTimer?: ReturnType<typeof setTimeout>;
  lastIceRestart: number;
  iceRestarts: number;
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

/** Canal de mensagem direta (ou grupo): a chamada ali toca como ligação. */
function isDmChannel(channelId: string | null | undefined) {
  if (!channelId) return false;
  const ch = useLine.getState().channels[channelId];
  return !!ch && !ch.serverId;
}

/** Estou ligando no privado: as pessoas chamadas aparecem na chamada, apagadas e pulsando, até atender ou recusar. */
export const useCalling = create<{ channelId: string | null; declined: string[] }>(() => ({ channelId: null, declined: [] }));
let callingTimer: ReturnType<typeof setTimeout> | null = null;

function startCalling(channelId: string) {
  if (callingTimer) clearTimeout(callingTimer);
  useCalling.setState({ channelId, declined: [] });
  // Ninguém atendeu em 30 s: para de chamar.
  callingTimer = setTimeout(endCalling, 30_000);
}

function endCalling() {
  if (callingTimer) clearTimeout(callingTimer);
  callingTimer = null;
  const c = useCalling.getState().channelId;
  if (c) stopSfxLoop(c);
  useCalling.setState({ channelId: null, declined: [] });
}

/** Recuso a ligação: o meu toque para e quem liga fica sabendo. */
export function declineCall(channelId: string) {
  stopSfxLoop(channelId);
  socket?.emit('voice:decline', { channelId });
}

/** Toque de ligação que não faz mais sentido (quem ligou saiu, ou eu saí da minha ligação): para na hora. */
function stopDeadRing() {
  const c = useCalling.getState().channelId;
  if (c && (getV().channelId !== c || othersIn(c) > 0)) endCalling();
  const l = sfxLoop();
  if (!l) return;
  if (l.kind === 'incomingCall' && (getV().channelId === l.key || !othersIn(l.key))) stopSfxLoop(l.key);
  if (l.kind === 'callRinging' && (getV().channelId !== l.key || othersIn(l.key) > 0)) stopSfxLoop(l.key);
}

/** Quantas pessoas, além de mim e de `except`, estão num canal. */
function othersIn(channelId: string, except?: string) {
  return Object.values(getV().states).filter((v) => v.channelId === channelId && v.userId !== myId && v.userId !== except).length;
}

// ---------- ligação com o socket ----------

/** Id do socket com que entrei no canal: se o socket reconectar com outro, preciso entrar de novo. */
let joinedSid: string | null = null;
/** Som de saída esperando um instante: se a pessoa volta logo (reconexão), não toca nada. */
const leaveSounds = new Map<string, ReturnType<typeof setTimeout>>();
const LEAVE_SOUND_DELAY_MS = 2500;

export function bindVoiceSocket(s: LineSocket, userId: string) {
  socket = s;
  myId = userId;

  s.on('voice:snapshot', (list) => {
    setV({ states: Object.fromEntries(list.map((v) => [v.userId, v])) });
    stopDeadRing();
    // Reconectou: se eu estava num canal, o servidor me tirou. Entra de novo.
    const { channelId } = getV();
    // Página recarregada (F5) ou app reiniciado pela atualização: volta para a chamada de antes.
    if (!channelId && !resumeTried) {
      resumeTried = true;
      resumeVoice(list);
    }
    // O socket caiu e voltou com outra identidade: mesmo que o servidor ainda me mostre no canal (ele
    // demora a notar a queda), os sinais da conexão nova não chegavam a ninguém e câmera/tela ligadas
    // depois disso não carregavam. Entra de novo com esta conexão.
    const stale = !!joinedSid && s.id !== joinedSid;
    if (channelId && !getV().connecting && (stale || !list.some((v) => v.userId === myId))) {
      cleanupPeers();
      void freshIceServers().then(() => (getV().channelId === channelId ? rejoin(channelId) : undefined)).catch(() => {});
    }
  });

  s.on('voice:update', ({ userId: uid, channelId, state }) => {
    // Som de entrada/saída para quem está no mesmo canal (o meu próprio toca no joinVoice/leaveVoice).
    if (uid !== myId) {
      const here = getV().channelId;
      const before = getV().states[uid]?.channelId ?? null;
      const after = state?.channelId ?? null;
      if (before !== after) {
        // Ligação no privado: alguém começou a chamada e eu não estou nela, toca chegando.
        if (after && after !== here && (state?.serverId === null || isDmChannel(after)) && !othersIn(after, uid) && useLine.getState().me?.status !== 'dnd')
          startSfxLoop('incomingCall', after, () => getV().channelId !== after && othersIn(after) > 0);
        // Quem ligou desistiu antes de eu atender.
        if (before && before !== here && !othersIn(before, uid)) stopSfxLoop(before);
      }
      if (here && before !== after) {
        if (after === here) {
          // Atenderam a minha ligação: para de chamar.
          if (sfxLoop()?.key === here) stopSfxLoop(here);
          // Saiu e voltou na hora (reconexão automática): nem som de saída, nem de entrada.
          const pending = leaveSounds.get(uid);
          if (pending) {
            clearTimeout(pending);
            leaveSounds.delete(uid);
          } else playSfx('voiceJoin');
        } else if (before === here) {
          const sound = isDmChannel(here) && !othersIn(here, uid) ? 'callEnd' : 'voiceLeave';
          clearTimeout(leaveSounds.get(uid));
          leaveSounds.set(
            uid,
            setTimeout(() => {
              leaveSounds.delete(uid);
              if (getV().channelId === here && getV().states[uid]?.channelId !== here) playSfx(sound);
            }, LEAVE_SOUND_DELAY_MS),
          );
        }
      } else if (here && after === here && state?.screenStreamId && !getV().states[uid]?.screenStreamId) {
        // Alguém do meu canal começou a transmitir: todos do canal ouvem.
        playSfx('streamStarted');
      } else if (here && after === here && before === here && state) {
        // Alguém do meu canal mutou/desmutou o microfone ou o fone: todos do canal ouvem.
        const prev = getV().states[uid];
        if (!!prev?.deafened !== !!state.deafened) playSfx(state.deafened ? 'userDeafened' : 'userUndeafened');
        else if (!!prev?.muted !== !!state.muted) playSfx(state.muted ? 'userMuted' : 'userUnmuted');
      }
    }
    setV((v) => {
      const states = { ...v.states };
      if (state) states[uid] = state;
      else if (states[uid]?.channelId === channelId) delete states[uid];
      return { states };
    });
    stopDeadRing();
    if (uid === myId) return applyMute();
    // Parou de transmitir (ou saiu): na próxima vez, assistir de novo é escolha minha.
    if (!state?.screenStreamId && (getV().watching[uid] || getV().screenThumbs[uid] || getV().screenViewers[uid])) {
      // Só quem assistia ouve o fim da transmissão.
      if (getV().watching[uid]) playSfx('streamEnded');
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

  s.on('voice:move', ({ channelId }) => {
    // Um moderador me moveu: toca o som de "movido" em vez de sair e entrar.
    playSfx('userMoved');
    void joinVoice(channelId, false);
  });

  s.on('voice:statuses', (channelStatus) => setV({ channelStatus }));
  s.on('voice:status', ({ channelId, status }) =>
    setV((v) => {
      const channelStatus = { ...v.channelStatus };
      if (status) channelStatus[channelId] = status;
      else delete channelStatus[channelId];
      return { channelStatus };
    }),
  );

  s.on('voice:declined', ({ channelId, userId }) => {
    if (userId === myId || useCalling.getState().channelId !== channelId) return;
    const declined = [...useCalling.getState().declined, userId];
    const ch = useLine.getState().channels[channelId];
    const waiting = (ch?.recipients ?? []).filter((u) => u.id !== myId && !declined.includes(u.id));
    // Todos recusaram (no privado é só uma pessoa): para de chamar e o cartão some.
    if (!waiting.length) endCalling();
    else useCalling.setState({ declined });
  });

  s.on('voice:kicked', () => {
    if (getV().channelId) playSfx('disconnect');
    void leaveVoice(false, false);
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
    serverId: serverOfVoice(channelId),
    watching: Object.keys(watching).filter((id) => watching[id]),
    until: Date.now() + windowMs,
  };
  try {
    (store === 'local' ? localStorage : sessionStorage).setItem(RESUME_KEY, JSON.stringify(data));
  } catch {
    // sem armazenamento: só não volta sozinho
  }
}

/** Servidor do canal de voz, mesmo que os canais daquele servidor ainda não tenham carregado. */
function serverOfVoice(channelId: string, list: VoiceState[] = Object.values(getV().states)): string | null {
  return (
    useLine.getState().channels[channelId]?.serverId ??
    list.find((v) => v.channelId === channelId && v.serverId)?.serverId ??
    null
  );
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

/** A atualização não aconteceu (já estava na mais nova ou falhou): esquece a chamada guardada. */
export function forgetVoiceForUpdate() {
  try {
    localStorage.removeItem(RESUME_KEY);
  } catch {
    // nada
  }
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
  const { channelId } = data;
  const serverId = data.serverId ?? serverOfVoice(channelId, list);
  // Carrega os canais do servidor da chamada, mesmo abrindo em outro lugar: sem eles o ícone de voz
  // no servidor e o nome do canal na barra da chamada não aparecem.
  if (serverId && !useLine.getState().loadedServers[serverId]) {
    void api
      .server(serverId)
      .then((detail) => {
        if (useLine.getState().loadedServers[serverId]) return;
        actions.upsertServer(detail.server);
        actions.loadServerDetail(serverId, detail.categories, detail.channels, detail.members, detail.roles);
      })
      .catch(() => {});
  }
  // Abre a chamada na tela só se não havia outro lugar aberto antes (ex.: um canal de texto).
  let hadView = false;
  try {
    hadView = !!localStorage.getItem('line.view');
  } catch {
    // sem armazenamento
  }
  if (!hadView) {
    if (serverId) actions.goServer(serverId, channelId);
    else actions.goHome(channelId);
  }
  void joinVoice(channelId);
}

// ---------- entrar / sair ----------

/** `sound` = false quando quem chama já tocou outro som (ex.: movido por um moderador). */
export async function joinVoice(channelId: string, sound = true) {
  if (!socket) return;
  // Canal +18 sem passar pelo aviso: a tela do canal mostra o aviso e entra no Prosseguir.
  if (needsNsfwGate(channelId)) return;
  const current = getV();
  if (current.channelId === channelId) return;
  if (current.channelId) await leaveVoice(true, sound);

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
    stopSfxLoop(channelId);
    if (!sound) {
      /* o som já tocou */
    } else if (isDmChannel(channelId) && !othersIn(channelId)) {
      // Comecei uma ligação no privado: toca a saída e fica chamando até alguém atender.
      playSfx('outgoingCall');
      startCalling(channelId);
      setTimeout(() => {
        if (useCalling.getState().channelId === channelId)
          startSfxLoop('callRinging', channelId, () => useCalling.getState().channelId === channelId);
      }, 700);
    } else playSfx('selfJoin');
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
  joinedSid = socket.id ?? null;
  setV({ connecting: false });
  // Reenvia câmera/tela se já estavam ligadas (reconexão).
  const { camera, screen } = getV();
  if (camera || screen) socket.emit('voice:state', { cameraStreamId: camera?.id ?? null, screenStreamId: screen?.id ?? null });
  for (const p of res.peers) if (!peers.has(p.userId)) createPeer(p.userId);
  startSpeakingLoop();
  startStatsLoop();
  startHealthLoop();
}

export async function leaveVoice(notify = true, sound = true) {
  clearResume();
  const was = getV().channelId;
  if (was && sfxLoop()?.key === was) stopSfxLoop(was);
  if (sound && was && !getV().connecting) playSfx(isDmChannel(was) ? 'callEnd' : 'selfLeave');
  if (notify) socket?.emit('voice:leave');
  if (cameraOpening) cameraCancelled = true;
  cleanupPeers();
  stopStream(getV().camera);
  stopStream(getV().screen);
  stopMic();
  stopSpeakingLoop();
  stopStatsLoop();
  stopHealthLoop();
  joinedSid = null;
  // Sair da chamada também para de assistir: ao voltar com "Entrar", a tela de ninguém abre sozinha.
  setV({ channelId: null, connecting: false, camera: null, screen: null, streams: {}, speaking: {}, watching: {} });
  stopDeadRing();
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
  saveSelfMute(getV().muted, getV().deafened);
  playSfx(next.deafened === false ? 'selfUndeafen' : next.muted ? 'selfMute' : 'selfUnmute');
  applyMute();
  socket?.emit('voice:state', next);
}

export function toggleDeafen() {
  const cur = getV();
  const deafened = !cur.deafened;
  // Ensurdecer muta o mic; voltar a ouvir devolve só o som: o mic continua mutado até eu ativar.
  const next = { deafened, muted: true };
  setV(next);
  saveSelfMute(next.muted, next.deafened);
  playSfx(deafened ? 'selfDeafen' : 'selfUndeafen');
  applyMute();
  socket?.emit('voice:state', next);
}

function applyMute() {
  const { muted, deafened, states, inputMode, pttDown } = getV();
  const forced = myId ? states[myId] : undefined;
  const silent = muted || deafened || !!forced?.serverMuted || !!forced?.serverDeafened || (inputMode === 'ptt' && !pttDown);
  // No teste do microfone nada é enviado.
  rawMic?.getAudioTracks().forEach((t) => (t.enabled = !silent));
  mic?.getAudioTracks().forEach((t) => (t.enabled = !silent && !micTesting));
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
  if (!!getV().watching[userId] !== on) playSfx(on ? 'streamJoin' : 'streamLeave');
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

const STAGE_VIEW_KEY = 'line.stageView';
function loadStageView() {
  try {
    const v = JSON.parse(localStorage.getItem(STAGE_VIEW_KEY) ?? '{}');
    return { showNoVideo: v.showNoVideo !== false, showMyCamera: v.showMyCamera !== false, showMyScreen: v.showMyScreen !== false, showUnwatched: v.showUnwatched !== false };
  } catch {
    return { showNoVideo: true, showMyCamera: true, showMyScreen: true, showUnwatched: true };
  }
}
function saveStageView() {
  const { showNoVideo, showMyCamera, showMyScreen, showUnwatched } = useVoice.getState();
  try {
    localStorage.setItem(STAGE_VIEW_KEY, JSON.stringify({ showNoVideo, showMyCamera, showMyScreen, showUnwatched }));
  } catch {
    // sem localStorage: vale só nesta sessão
  }
}
export function toggleShowNoVideo() {
  setV((v) => ({ showNoVideo: !v.showNoVideo }));
  saveStageView();
}
export function toggleShowUnwatched() {
  setV((v) => ({ showUnwatched: !v.showUnwatched }));
  saveStageView();
}
export function toggleShowMyScreen() {
  setV((v) => ({ showMyScreen: !v.showMyScreen }));
  saveStageView();
}
export function toggleShowMyCamera() {
  setV((v) => ({ showMyCamera: !v.showMyCamera }));
  saveStageView();
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
  const { inputId, noiseSuppression, noiseModel, echoCancellation, autoSensitivity, inputProfile } = getV();
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
      const res = await suppressNoise(rawMic, noiseModel);
      mic = res.stream;
      // O máximo não abriu neste aparelho: fica no leve (e não tenta de novo a cada chamada).
      if (res.model !== noiseModel) {
        setV({ noiseModel: res.model });
        savePrefs();
      }
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
  syncGlobalPtt();
}

export function setPttKey(code: string | null) {
  setV({ pttKey: code, pttDown: false });
  savePrefs();
  applyMute();
  syncGlobalPtt();
}

/**
 * Apertar para falar: segura a tecla escolhida e o microfone abre.
 * No app do Windows a tecla vale em qualquer lugar (jogo, outro app): o casco em Rust vigia o teclado
 * e avisa por 'line:ptt'. Na web e nos outros sistemas, só com a janela do Line em foco.
 */
let globalPtt = false;

function setPttDown(down: boolean) {
  if (getV().pttDown === down) return;
  setV({ pttDown: down });
  applyMute();
}

/** Liga/desliga a tecla global no app do Windows conforme o modo e a tecla escolhidos. */
function syncGlobalPtt() {
  if (typeof window === 'undefined' || window.line?.platform !== 'win32') return;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string, a?: unknown) => Promise<boolean> } }).__TAURI_INTERNALS__;
  if (!internals) return;
  const { inputMode, pttKey } = getV();
  const code = inputMode === 'ptt' ? pttKey : null;
  internals.invoke('ptt_set', { code }).then(
    (ok) => (globalPtt = ok),
    () => (globalPtt = false),
  );
}

export function pttIsGlobal() {
  return globalPtt;
}

if (typeof window !== 'undefined') {
  const isPtt = (e: KeyboardEvent) => {
    const { inputMode, pttKey } = getV();
    return !globalPtt && inputMode === 'ptt' && !!pttKey && e.code === pttKey;
  };
  window.addEventListener('keydown', (e) => {
    if (!isPtt(e) || e.repeat) return;
    setPttDown(true);
  });
  window.addEventListener('keyup', (e) => isPtt(e) && setPttDown(false));
  // Sem a tecla global, sair da janela solta a tecla (o keyup não chegaria).
  window.addEventListener('blur', () => !globalPtt && setPttDown(false));
  window.addEventListener('line:ptt', (e) => {
    if (globalPtt && getV().inputMode === 'ptt') setPttDown(!!(e as CustomEvent<boolean>).detail);
  });
  syncGlobalPtt();
}

/**
 * Reabre o microfone (trocou o dispositivo ou o supressor) sem derrubar a chamada.
 * As reaberturas vão em fila: duas ao mesmo tempo misturariam os streams e deixariam a voz muda.
 */
let reopenQueue: Promise<void> = Promise.resolve();
function reopenMic(): Promise<void> {
  const run = reopenQueue.then(reopenMicNow);
  reopenQueue = run.catch(() => {});
  return run;
}

async function reopenMicNow() {
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

// ---------- teste do microfone (Configurações → Voz e vídeo) ----------

let micTest: { raw: MediaStream | null; ctx: AudioContext; el: HTMLAudioElement; dispose: (() => void) | null } | null = null;
/** Teste do microfone ligado dentro de um canal: o microfone da chamada fica solto e nada é enviado. */
let micTesting = false;
/** Sobe a cada início/parada: um teste que termina de abrir depois de parado (ou substituído) se desfaz. */
let micTestGen = 0;
/** Como eu estava no canal antes do teste (para voltar igual ao parar). */
let micTestPrev: { muted: boolean; deafened: boolean } | null = null;
/** Reabertura do microfone da chamada ao parar o teste (o próximo teste espera ela terminar). */
let micTestReopen: Promise<void> = Promise.resolve();

/**
 * Toca o meu microfone de volta para mim, com o mesmo tratamento da chamada (supressor escolhido,
 * volume). Se eu estiver num canal de voz, fico mutado e ensurdecido enquanto testo: ouço só
 * o retorno e ninguém me ouve. Devolve o áudio tratado (para o medidor).
 */
export async function startMicTest(): Promise<MediaStream> {
  stopMicTest();
  const gen = ++micTestGen;
  const v = getV();
  let raw: MediaStream | null = null;
  let dispose: (() => void) | null = null;
  const cancelled = () => {
    if (gen === micTestGen) return false;
    dispose?.();
    stopStream(raw);
    return true;
  };
  if (v.channelId) {
    micTestPrev = { muted: v.muted, deafened: v.deafened };
    micTesting = true;
    if (!v.muted || !v.deafened) {
      setV({ muted: true, deafened: true });
      socket?.emit('voice:state', { muted: true, deafened: true });
    }
    applyMute();
    // Solta o microfone da chamada enquanto testo (o Chrome não abre o mesmo microfone duas vezes com
    // tratamentos diferentes); ao parar, ele reabre do jeito de antes.
    await micTestReopen;
    await reopenQueue;
    if (cancelled()) throw new Error('teste parado');
    stopStream(rawMic);
  }
  const studio = v.inputProfile === 'studio';
  raw = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: v.inputId ? { exact: v.inputId } : undefined,
      // Sem cancelamento de eco no teste: ele trataria o próprio retorno como eco e apagaria a voz.
      echoCancellation: false,
      noiseSuppression: !v.noiseSuppression && !studio,
      autoGainControl: v.autoSensitivity && !studio,
      channelCount: 1,
    },
    video: false,
  });
  if (cancelled()) throw new Error('teste parado');
  let clean: MediaStream = raw;
  if (v.noiseSuppression) {
    try {
      const res = await suppressNoise(raw, v.noiseModel, 'test');
      clean = res.stream;
      dispose = res.dispose;
    } catch (err) {
      console.warn('Supressor indisponível no teste', err);
    }
  }
  if (cancelled()) throw new Error('teste parado');
  const ctx = new AudioContext();
  const gain = ctx.createGain();
  gain.gain.value = v.inputVolume;
  const dest = ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(clean).connect(gain).connect(dest);
  const el = new Audio();
  el.autoplay = true;
  el.srcObject = dest.stream;
  el.volume = Math.min(1, v.outputVolume);
  micTest = { raw, ctx, el, dispose };
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  const sink = (el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
  if (v.outputId && sink) await sink.call(el, v.outputId).catch(() => {});
  void el.play().catch((err) => console.warn('Retorno do teste não tocou', err));
  return dest.stream;
}

export function stopMicTest() {
  micTestGen++;
  if (micTest) {
    const { raw, ctx, el, dispose } = micTest;
    micTest = null;
    el.pause();
    el.srcObject = null;
    dispose?.();
    stopStream(raw);
    void ctx.close().catch(() => {});
  }
  const wasTesting = micTesting;
  micTesting = false;
  const prev = micTestPrev;
  micTestPrev = null;
  if (!getV().channelId) return;
  if (prev) {
    const now = getV();
    if (now.muted !== prev.muted || now.deafened !== prev.deafened) {
      setV(prev);
      socket?.emit('voice:state', prev);
    }
  }
  // Volta o microfone da chamada com o cancelamento de eco de antes.
  if (wasTesting) micTestReopen = micTestReopen.then(reopenMic).then(applyMute).catch(() => {});
  else applyMute();
}

export async function setNoiseModel(model: NoiseModel) {
  setV({ noiseModel: model });
  savePrefs();
  if (getV().noiseSuppression) await reopenMic();
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
    if (gen !== screenGen || !getV().screen) return;
    // Jogo com outra janela (cliente/partida do League): segue para ela em vez de encerrar.
    if (followGame && source?.id.startsWith('window:')) {
      void followAfterClose(gen, source);
      return;
    }
    stopScreen();
    // Alt+F4 na janela transmitida (ou fechou o jogo): avisa em vez de só sumir.
    toast(source?.id.startsWith('window:') ? 'A janela transmitida foi fechada. A transmissão terminou.' : 'A transmissão terminou.');
  };
  let stream: MediaStream;
  let stop: ((keepCapture?: boolean) => void) | null = null;
  let pausedSince: (() => number | null) | null = null;
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
    pausedSince = native.pausedSince;
    size = { width: native.width, height: native.height };
  } else {
    const r = RESOLUTIONS[resolution];
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: r.width, max: r.width },
        height: { ideal: r.height, max: r.height },
        // Teto um pouco acima do escolhido: com o teto exato a captura do navegador pulava todo
        // quadro que chegava alguns ms adiantado e 60 fps viravam 51 a 58.
        frameRate: { ideal: fps, max: encoderFps(fps) },
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
  return { stream, stop, size, pausedSince };
}

/**
 * Liga/desliga o compartilhamento de tela.
 * Com `source` (app do Windows ou do macOS), captura a janela/tela escolhida no seletor do Line.
 * Sem ela, usa o seletor do próprio navegador (web, macOS, Linux).
 */
export async function toggleScreen(source?: { id: string; audio: boolean }): Promise<string | null> {
  const { screen } = getV();
  if (screen) {
    stopScreen();
    return null;
  }
  if (!voiceCan(Perm.Stream)) return 'Você não tem permissão para transmitir neste canal.';
  const gen = ++screenGen;
  try {
    const opened = await openScreen(source, gen);
    // Saiu da chamada enquanto abria: solta a captura.
    if (!getV().channelId) {
      opened.stop?.();
      stopStream(opened.stream);
      return null;
    }
    const { stream } = opened;
    nativeStop = opened.stop;
    nativePaused = opened.pausedSince;
    screenSize = opened.size;
    currentSource = source ?? null;
    currentFps = getV().screenQuality.fps;
    watchGame(source);
    setV({ screen: stream });
    addStreamToPeers(stream);
    startThumbs(stream, source?.id);
    socket?.emit('voice:state', { screenStreamId: stream.id });
    playSfx('streamStarted');
    return null;
  } catch (err) {
    if ((err as Error).name === 'NotAllowedError') return null;
    return source?.id.startsWith('window:')
      ? 'Não foi possível capturar essa janela. Tente transmitir a tela inteira, na aba Telas.'
      : 'Não foi possível compartilhar a tela.';
  }
}

/** Fonte transmitida agora (seletor do Line), para o "Trocar tela" já abrir com ela marcada. */
let currentSource: { id: string; audio: boolean } | null = null;
let currentFps: Fps | null = null;
export function currentScreenSource() {
  return getV().screen ? currentSource : null;
}

/** Ajusta taxa, fps e redução em todas as conexões que recebem a tela. */
function retuneScreen() {
  const screen = getV().screen;
  if (!screen) return;
  const video = screen.getVideoTracks()[0];
  const { resolution, fps } = getV().screenQuality;
  if (video) video.contentHint = fps >= 60 ? 'motion' : 'detail';
  for (const [id, { pc }] of peers) {
    if (!watchers.has(id)) continue;
    for (const sender of pc.getSenders()) if (video && sender.track === video) void retuneScreenSender(sender, resolution, fps);
  }
}

/**
 * Troca a janela/tela transmitida (ou só a qualidade) sem parar: as trilhas novas entram no mesmo
 * stream e nas mesmas conexões (replaceTrack), então quem assiste continua assistindo.
 */
export async function switchScreen(source?: { id: string; audio: boolean }, auto = false): Promise<string | null> {
  const screen = getV().screen;
  if (!screen) return toggleScreen(source);
  const { fps } = getV().screenQuality;
  // Mesma fonte e mesmo fps: só muda resolução/taxa no envio, sem reabrir a captura (reabrir no
  // meio deixava a imagem travando para quem assiste).
  if (
    source &&
    currentSource &&
    source.id === currentSource.id &&
    source.audio === currentSource.audio &&
    fps === currentFps &&
    hasNativeScreen()
  ) {
    retuneScreen();
    setV((v) => ({ mediaRev: v.mediaRev + 1 }));
    return null;
  }
  const previous = currentSource;
  const gen = ++screenGen;
  const oldStop = nativeStop;
  let opened: Awaited<ReturnType<typeof openScreen>>;
  try {
    opened = await openScreen(source, gen);
  } catch (err) {
    if (source && hasNativeScreen()) {
      // O Rust só captura uma fonte por vez: a antiga já parou ao tentar a nova. Tenta voltar
      // para o que estava antes; se nem isso der, encerra a transmissão.
      if (previous && previous.id !== source.id && getV().screen === screen) {
        oldStop?.(true);
        const back = await switchScreenTo(screen, previous, ++screenGen).catch(() => false);
        if (back) return 'Não foi possível capturar essa janela. A transmissão continuou com a anterior.';
      }
      if (getV().screen === screen) stopScreen();
      return 'Não foi possível trocar a tela.';
    }
    // Cancelou ou falhou no seletor do navegador: continua transmitindo o que já estava.
    if (screenGen === gen) screenGen = gen - 1;
    return (err as Error).name === 'NotAllowedError' ? null : 'Não foi possível trocar a tela.';
  }
  // Parou de transmitir (ou saiu) enquanto abria: solta a captura nova.
  if (getV().screen !== screen) {
    opened.stop?.();
    stopStream(opened.stream);
    return null;
  }
  // A captura antiga sai sem desligar a nova no Rust (que já trocou de fonte ao começar a nova).
  oldStop?.(true);
  applySwitch(screen, opened, source);
  if (!auto) watchGame(source);
  return null;
}

// ---------- seguir o jogo ----------
// Jogos com mais de uma janela (no League: o cliente e a partida são programas diferentes). Se a
// transmissão começou numa janela do jogo, ela troca sozinha para a outra quando a atual fecha ou
// fica minimizada, sem precisar compartilhar de novo a cada partida.

let nativePaused: (() => number | null) | null = null;
let followGame: string | null = null;
let followTimer: ReturnType<typeof setInterval> | null = null;
let followBusy = false;

function stopFollow() {
  followGame = null;
  if (followTimer) clearInterval(followTimer);
  followTimer = null;
}

/** Descobre se a fonte escolhida é a janela do jogo aberto e, se for, passa a seguir o jogo. */
function watchGame(source?: { id: string; audio: boolean }) {
  stopFollow();
  if (!source?.id.startsWith('window:') || !hasGameDetection()) return;
  void detectGame().then((g) => {
    if (!g || g.windowId !== source.id || currentSource?.id !== source.id || !getV().screen) return;
    followGame = g.name;
    followTimer = setInterval(() => void checkFollow(), 3000);
  });
}

/** Outra janela do mesmo jogo, aberta e diferente da transmitida agora. */
async function otherGameWindow() {
  const g = await detectGame();
  if (!g || g.name !== followGame || !currentSource || g.windowId === currentSource.id) return null;
  return g.windowId;
}

async function followTo(id: string) {
  if (!currentSource) return false;
  followBusy = true;
  try {
    const err = await switchScreen({ id, audio: currentSource.audio }, true);
    return !err;
  } finally {
    followBusy = false;
  }
}

/** A janela transmitida ficou minimizada por um tempo (começou a partida): vai para a outra. */
async function checkFollow() {
  if (followBusy || !followGame || !getV().screen) return;
  const since = nativePaused?.();
  if (since == null || performance.now() - since < 3000) return;
  const id = await otherGameWindow();
  if (id && !followBusy) await followTo(id);
}

/** A janela transmitida fechou (acabou a partida): espera a outra janela do jogo aparecer. */
async function followAfterClose(gen: number, source: { id: string; audio: boolean }) {
  const screen = getV().screen;
  for (let i = 0; i < 20; i++) {
    if (gen !== screenGen || getV().screen !== screen) return;
    const id = await otherGameWindow().catch(() => null);
    if (gen !== screenGen || getV().screen !== screen) return;
    if (id && (await followTo(id))) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (gen !== screenGen || getV().screen !== screen || currentSource?.id !== source.id) return;
  stopScreen();
  toast('A janela transmitida foi fechada. A transmissão terminou.');
}

/** Reabre uma fonte anterior depois de uma troca que falhou. */
async function switchScreenTo(screen: MediaStream, source: { id: string; audio: boolean }, gen: number) {
  const opened = await openScreen(source, gen);
  if (getV().screen !== screen) {
    opened.stop?.();
    stopStream(opened.stream);
    return false;
  }
  applySwitch(screen, opened, source);
  return true;
}

/** Põe as trilhas da captura nova no stream da tela e nas conexões de quem assiste. */
function applySwitch(screen: MediaStream, opened: Awaited<ReturnType<typeof openScreen>>, source?: { id: string; audio: boolean }) {
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
  for (const t of oldTracks) t.stop();
  nativeStop = opened.stop;
  nativePaused = opened.pausedSince;
  currentSource = source ?? null;
  currentFps = fps;
  startThumbs(screen, source?.id);
  setV((v) => ({ mediaRev: v.mediaRev + 1 }));
}

/**
 * Teto de fps do codificador um pouco acima do escolhido. A captura já sai no ritmo certo; com o teto
 * exatamente igual, o limitador do WebRTC descartava todo quadro que chegava alguns ms adiantado
 * (60 fps viravam 30 a 45). 10 a mais: 60 → 70 e 30 → 40.
 */
const encoderFps = (fps: number) => fps + 10;

/** Depois de trocar a fonte: ajusta taxa, fps e redução ao tamanho da tela nova. */
async function retuneScreenSender(sender: RTCRtpSender, resolution: Resolution, fps: Fps) {
  try {
    const params = sender.getParameters();
    const enc = params.encodings?.[0];
    if (!enc) return;
    enc.maxBitrate = capKbps(resolution, fps) * 1000;
    enc.maxFramerate = encoderFps(fps);
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
  dropPausedScreens();
  watchers.clear();
  if (myId) {
    const me = myId;
    setV((v) => {
      const screenViewers = { ...v.screenViewers };
      delete screenViewers[me];
      return { screenViewers };
    });
  }
  playSfx('streamEnded');
  stopThumbs();
  stopStream(screen);
  nativeStop?.();
  nativeStop = null;
  nativePaused = null;
  stopFollow();
  screenSize = null;
  currentSource = null;
  currentFps = null;
  screenSqueeze = 1;
  calmTicks = 0;
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

const sendSignal = (to: string, signal: VoiceSignal) => send(to, signal);
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
  const peer: Peer = {
    pc,
    polite: (myId ?? '') > peerId,
    makingOffer: false,
    ignoreOffer: false,
    streamIds: new Set(),
    createdAt: Date.now(),
    offerSeq: 0,
    offerRetries: 0,
    lastIceRestart: 0,
    iceRestarts: 0,
  };
  peers.set(peerId, peer);

  pc.onnegotiationneeded = () => void makeOffer(peerId, peer);

  pc.onicecandidate = ({ candidate }) => send(peerId, { type: 'candidate', candidate: candidate ? candidate.toJSON() as never : null });

  // Conexão nova com quem eu já assistia (F5, reconexão): avisa de novo para a tela voltar.
  // Só depois de conectar: avisar antes fazia quem transmite abrir uma segunda negociação junto com a
  // minha, e a tela não chegava. Se mesmo assim ela não vier, pede de novo (quem transmite ignora repetido).
  let rewatched = false;
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    clearTimeout(peer.iceTimer);
    if (state === 'connected') peer.iceRestarts = 0;
    // Caiu de vez: reconecta já. Oscilou: espera um pouco, quase sempre volta sozinho.
    if (state === 'failed') void restartPeerIce(peerId, peer);
    else if (state === 'disconnected')
      peer.iceTimer = setTimeout(() => {
        if (peers.get(peerId) === peer && pc.connectionState === 'disconnected') void restartPeerIce(peerId, peer);
      }, ICE_DISCONNECTED_MS);
    if (state !== 'connected' || rewatched || !getV().watching[peerId]) return;
    rewatched = true;
    send(peerId, { type: 'watch', on: true });
    setTimeout(() => {
      const v = getV();
      const sid = v.states[peerId]?.screenStreamId;
      if (peers.get(peerId)?.pc === pc && v.watching[peerId] && sid && !v.streams[sid]) send(peerId, { type: 'watch', on: true });
    }, 5000);
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

  if (mic) for (const t of mic.getTracks()) preferRed(pc, pc.addTrack(t, mic));
  const { camera, screen } = getV();
  if (camera) addStream(pc, camera);
  if (screen && watchers.has(peerId)) addStream(pc, screen);
  // Quem chega vê a miniatura da minha tela antes de escolher assistir.
  if (screen && lastThumb) {
    const thumb = lastThumb;
    setTimeout(() => send(peerId, { type: 'thumb', data: thumb, game: thumbGame }), 500);
  }
  if (screen && watchers.size) setTimeout(() => sendViewers(peerId), 500);
  return peer;
}

async function onSignal(from: string, signal: VoiceSignal) {
  const mine = getV().channelId;
  // O servidor só repassa sinais entre pessoas do mesmo canal; o estado local pode ainda não ter chegado.
  if (!mine) return;
  if (signal.type === 'reset') {
    // O outro lado refez a conexão comigo do zero: descarta a minha; a oferta nova chega logo atrás.
    if (peers.has(from)) dropPeerKeepingWatch(from);
    return;
  }
  if (signal.type === 'resync' && !peers.has(from)) {
    resetPeer(from);
    return;
  }
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
  if (signal.type === 'resync') {
    onResync(from, peer, !!signal.screen, !!signal.hard);
    return;
  }
  if (signal.type === 'senderStats') {
    const s = signal.stats;
    if (s && typeof s === 'object' && typeof s.fps === 'number') {
      useScreenStats.setState((st) => ({ sender: { ...st.sender, [from]: { ...s, encoder: String(s.encoder ?? '').slice(0, 80) } } }));
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
      if (others(ids).some((id) => !before.includes(id))) playSfx('streamJoin');
      else if (others(before).some((id) => !ids.includes(id))) playSfx('streamLeave');
    }
    setV((v) => ({ screenViewers: { ...v.screenViewers, [from]: ids } }));
    return;
  }
  if (signal.type === 'watch') {
    const { screen } = getV();
    if (signal.on) {
      // Já assistia e a tela já está nesta conexão: nada a fazer. Conexão nova (a pessoa deu F5): manda de novo.
      if (watchers.has(from) && (!screen || sendsStream(pc, screen))) return;
      watchers.add(from);
      if (screen) {
        // Voltou a assistir: religa os envios pausados (sem renegociar); se não der, envia do zero.
        if (!resumeScreen(peer, screen)) addStream(pc, screen);
        playSfx('streamJoin');
        sendViewers();
      }
    } else {
      if (!watchers.delete(from)) return;
      if (screen) {
        // Só pausa (replaceTrack null): sair e voltar a assistir não mexe na negociação, que quebrava a tela.
        pauseScreen(peer, screen);
        playSfx('streamLeave');
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
  await makeOffer(peerId, peer);
}

// ---------- recuperação automática da conexão ----------
// Numa chamada longa, uma oferta pode se perder (socket oscilou), a rede pode mudar ou a conexão pode
// cair sem ninguém notar. Antes, a câmera ou a tela ligada depois disso não chegava e era preciso sair e
// voltar. Agora cada lado vigia a própria negociação e quem não recebe o vídeo anunciado pede de novo.

/** Sem resposta para a oferta nesse tempo: desfaz e manda outra. */
const OFFER_TIMEOUT_MS = 10_000;
const OFFER_MAX_RETRIES = 4;
/** Conexão "desconectada" por mais que isso: reconecta (ICE restart). */
const ICE_DISCONNECTED_MS = 5000;
const ICE_RETRY_MS = 15_000;
const ICE_MAX_RESTARTS = 3;
const HEALTH_MS = 3000;
/** Vídeo anunciado e não chegou nesse tempo: começa a pedir de novo (o prazo dobra a cada tentativa). */
const MISSING_GRACE_MS = 6000;
const MISSING_MAX_TRIES = 4;

async function makeOffer(peerId: string, peer: Peer, iceRestart = false, retry = false) {
  const { pc } = peer;
  if (peer.makingOffer || pc.signalingState === 'closed') return;
  // Já há uma oferta esperando resposta: o vigia dela cuida (desfazer agora atropelaria a resposta a caminho).
  if (!retry && pc.signalingState !== 'stable') return;
  const seq = ++peer.offerSeq;
  try {
    peer.makingOffer = true;
    // Oferta antiga sem resposta travava todas as próximas (negotiationneeded só dispara em "stable").
    if (pc.signalingState === 'have-local-offer') await pc.setLocalDescription({ type: 'rollback' });
    if (pc.signalingState !== 'stable') return;
    if (iceRestart) pc.restartIce();
    await pc.setLocalDescription();
    if (pc.localDescription) send(peerId, { type: 'description', description: pc.localDescription.toJSON() });
  } catch (err) {
    console.warn('Falha na negociação de voz', err);
  } finally {
    peer.makingOffer = false;
  }
  clearTimeout(peer.offerTimer);
  peer.offerTimer = setTimeout(() => {
    if (peers.get(peerId) !== peer || peer.offerSeq !== seq || pc.signalingState !== 'have-local-offer') {
      if (pc.signalingState === 'stable') peer.offerRetries = 0;
      return;
    }
    if (++peer.offerRetries > OFFER_MAX_RETRIES) return;
    void makeOffer(peerId, peer, pc.connectionState !== 'connected', true);
  }, OFFER_TIMEOUT_MS);
}

/** Reconecta a rota (ICE restart), com a senha do TURN renovada se ela já está velha. */
async function restartPeerIce(peerId: string, peer: Peer) {
  const { pc } = peer;
  if (peers.get(peerId) !== peer || pc.signalingState === 'closed') return;
  if (Date.now() - peer.lastIceRestart < ICE_RETRY_MS) return;
  peer.lastIceRestart = Date.now();
  // Reconectar várias vezes sem sucesso: refaz a conexão do zero (só um dos lados, para não colidir).
  if (++peer.iceRestarts > ICE_MAX_RESTARTS) {
    if (!peer.polite) resetPeer(peerId);
    else send(peerId, { type: 'resync', hard: true });
    return;
  }
  const servers = await freshIceServers();
  try {
    pc.setConfiguration({ ...pc.getConfiguration(), iceServers: servers });
  } catch {
    // configuração recusada: reconecta com a que já tinha
  }
  await makeOffer(peerId, peer, true);
}

/** Fecha a conexão com alguém sem tirar essa pessoa de quem assiste à minha tela (ela volta na conexão nova). */
function dropPeerKeepingWatch(peerId: string) {
  const watched = watchers.has(peerId);
  closePeer(peerId);
  // O aviso de "quem assiste" sai num microtask: voltando a pessoa antes dele, ninguém ouve sair/entrar.
  if (watched) watchers.add(peerId);
}

/** Refaz do zero a conexão com alguém, como sair e voltar, mas só entre nós dois e sem som. */
function resetPeer(peerId: string) {
  if (!getV().channelId) return;
  if (peers.has(peerId)) dropPeerKeepingWatch(peerId);
  send(peerId, { type: 'reset' });
  createPeer(peerId);
}

/** Alguém não está recebendo o meu vídeo: confere o que mando e negocia de novo. */
function onResync(from: string, peer: Peer, wantsScreen: boolean, hard: boolean) {
  const { pc } = peer;
  if (hard) {
    // Conexão nova há pouco: é a própria recuperação ainda chegando.
    if (Date.now() - peer.createdAt > OFFER_TIMEOUT_MS) resetPeer(from);
    return;
  }
  const { camera, screen } = getV();
  let changed = false;
  if (camera && !sendsStream(pc, camera)) {
    addStream(pc, camera);
    changed = true;
  }
  if (wantsScreen && screen) {
    // O "assistir" pode ter se perdido no caminho: vale como se tivesse chegado agora.
    if (!watchers.has(from)) {
      watchers.add(from);
      sendViewers();
    }
    if (!sendsStream(pc, screen) && !resumeScreen(peer, screen)) {
      addStream(pc, screen);
      changed = true;
    }
  }
  // Nada faltava do meu lado: manda uma oferta nova (reconectando a rota se ela não está boa).
  if (!changed) void makeOffer(from, peer, pc.connectionState !== 'connected');
}

let healthTimer: ReturnType<typeof setInterval> | null = null;
/** Vídeo anunciado que não chegou, por pessoa + stream. */
const missingVideo = new Map<string, { tries: number; next: number }>();

function startHealthLoop() {
  if (healthTimer) return;
  healthTimer = setInterval(checkCallHealth, HEALTH_MS);
}

function stopHealthLoop() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
  missingVideo.clear();
}

/** 'ok' = chegando; 'muted' = a faixa existe mas está sem quadros; 'none' = nem chegou. */
function videoState(stream: MediaStream | undefined): 'ok' | 'muted' | 'none' {
  const live = stream?.getVideoTracks().filter((t) => t.readyState === 'live') ?? [];
  if (!live.length) return 'none';
  return live.some((t) => !t.muted) ? 'ok' : 'muted';
}

function checkCallHealth() {
  const v = getV();
  const here = v.channelId;
  if (!here || v.connecting) return;
  const now = Date.now();
  const seen = new Set<string>();
  for (const [peerId, peer] of peers) {
    const st = v.states[peerId];
    if (!st || st.channelId !== here) continue;
    const { pc } = peer;
    // Conexão caída que não voltou: tenta de novo.
    if (pc.connectionState === 'failed') void restartPeerIce(peerId, peer);
    const wanted: [string, boolean, 'muted' | 'none'][] = [];
    const check = (streamId: string | null | undefined, isScreen: boolean) => {
      const got = streamId ? videoState(v.streams[streamId]) : 'ok';
      if (streamId && got !== 'ok') wanted.push([streamId, isScreen, got]);
    };
    check(st.cameraStreamId, false);
    if (v.watching[peerId]) check(st.screenStreamId, true);
    for (const [streamId, isScreen, got] of wanted) {
      const key = `${peerId}:${streamId}`;
      seen.add(key);
      const m = missingVideo.get(key);
      if (!m) {
        missingVideo.set(key, { tries: 0, next: now + MISSING_GRACE_MS });
        continue;
      }
      if (now < m.next || m.tries >= MISSING_MAX_TRIES) continue;
      m.tries++;
      m.next = now + MISSING_GRACE_MS * 2 ** m.tries;
      if (m.tries < 3) {
        // Pede para quem manda conferir e negociar de novo.
        send(peerId, { type: 'resync', screen: isScreen });
      } else if (got === 'muted' && pc.connectionState === 'connected') {
        // A faixa chegou e a conexão está boa: pode ser só uma imagem parada. Não derruba a conexão por isso.
        m.tries = MISSING_MAX_TRIES;
      } else if (!peer.polite) {
        // Ainda nada: refaz a conexão entre nós dois (o lado "educado" pede para o outro fazer).
        resetPeer(peerId);
      } else send(peerId, { type: 'resync', hard: true });
    }
  }
  for (const key of missingVideo.keys()) if (!seen.has(key)) missingVideo.delete(key);
}

/**
 * Tela recebida: guarda ~50 ms a mais antes de mostrar. Dá tempo de o reenvio (NACK) repor um
 * pacote perdido e de reordenar os que chegam trocados, em vez de travar ou borrar o quadro.
 * Quem está longe (RTT alto) ganha mais buffer no laço de estatísticas (screenBufferFor), senão o
 * pacote reenviado chega depois do prazo. Voz e câmera ficam sem buffer extra (latência da conversa).
 */
const SCREEN_BUFFER_MS = 50;
const SCREEN_BUFFER_MAX_MS = 300;
/** Buffer aplicado em cada receptor de tela. */
const screenBuffers = new WeakMap<RTCRtpReceiver, number>();

function setScreenBuffer(receiver: RTCRtpReceiver, ms: number) {
  const r = receiver as unknown as { jitterBufferTarget?: number | null; playoutDelayHint?: number };
  try {
    // jitterBufferTarget em ms (Chromium/WebView2 novos); playoutDelayHint em segundos (antigos, WebKit).
    if ('jitterBufferTarget' in receiver) r.jitterBufferTarget = ms;
    else r.playoutDelayHint = ms / 1000;
    screenBuffers.set(receiver, ms);
  } catch {
    // navegador sem esse ajuste: segue com o buffer automático
  }
}

/** Buffer para a distância e a perda atuais: um RTT a mais dá tempo de um reenvio chegar. */
function screenBufferFor(rttMs: number | null, lossPct: number) {
  const base = SCREEN_BUFFER_MS + Math.max(0, (rttMs ?? 0) - 40);
  const extra = lossPct >= 2 ? 40 : 0;
  return Math.min(SCREEN_BUFFER_MAX_MS, Math.round(base + extra));
}
function bufferScreen(peerId: string, stream: MediaStream, track: MediaStreamTrack, receiver: RTCRtpReceiver) {
  const state = getV().states[peerId];
  const isScreen =
    stream.id === state?.screenStreamId || (track.kind === 'video' && !!state && stream.id !== state.cameraStreamId);
  if (!isScreen) return;
  setScreenBuffer(receiver, SCREEN_BUFFER_MS);
}

/**
 * Voz com redundância (Opus RED): cada pacote leva também o pedaço anterior, então um pacote perdido
 * não vira picote. Custa ~30 kbps a mais. Só onde o WebRTC oferece audio/red (Chromium/WebView2);
 * se o outro lado não aceitar, a negociação fica no Opus normal.
 */
function preferRed(pc: RTCPeerConnection, sender: RTCRtpSender) {
  if ((window as unknown as { __lineRtc?: { adapter?: boolean } }).__lineRtc?.adapter) return;
  const transceiver = pc.getTransceivers().find((t) => t.sender === sender);
  const codecs = RTCRtpReceiver.getCapabilities?.('audio')?.codecs;
  if (!transceiver?.setCodecPreferences || !codecs?.some((c) => c.mimeType.toLowerCase() === 'audio/red')) return;
  const rank = (c: { mimeType: string }) => {
    const m = c.mimeType.toLowerCase();
    return m === 'audio/red' ? 0 : m === 'audio/opus' ? 1 : 2;
  };
  try {
    transceiver.setCodecPreferences([...codecs].sort((a, b) => rank(a) - rank(b)));
  } catch {
    // navegador não deixou escolher: fica com o Opus normal
  }
}

// ---------- estatísticas e ajustes da tela ----------

const STATS_MS = 2000;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let statsBusy = false;
/** Leituras seguidas com a perda baixa em todo mundo que assiste (para devolver a qualidade). */
let calmTicks = 0;

function startStatsLoop() {
  if (statsTimer) return;
  statsTimer = setInterval(() => void statsTick(), STATS_MS);
}

function stopStatsLoop() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  forgetSamples();
  clearHistory();
  screenSqueeze = 1;
  calmTicks = 0;
  useScreenStats.setState({ send: {}, recv: {}, sender: {} });
}

/** Diagnóstico da transmissão para copiar: últimas leituras + como a minha tela está configurada. */
export function screenDiagnostics() {
  const { screenQuality, screen } = getV();
  return diagnosticsText({
    qualidade: screenQuality,
    transmitindo: !!screen,
    captura: currentSource ? (hasNativeScreen() ? 'nativa' : 'navegador') : screen ? 'navegador' : null,
    fonte: currentSource?.id.split(':')[0] ?? null,
    tamanhoCaptura: screenSize,
    codecsPlaca: [...hwCodecs],
    tetoComum: screenSqueeze,
    espectadores: watchers.size,
  });
}

async function statsTick() {
  if (statsBusy) return;
  statsBusy = true;
  try {
    await Promise.all([sendTick(), recvTick()]);
    const { send, recv, sender } = useScreenStats.getState();
    pushHistory(send, recv, sender);
  } catch {
    // conexão fechou no meio da leitura: tenta de novo na próxima
  } finally {
    statsBusy = false;
  }
}

/** Minha tela: lê o envio para cada pessoa que assiste e aperta/solta o teto comum. */
async function sendTick() {
  const video = getV().screen?.getVideoTracks()[0];
  if (!video || !watchers.size) {
    if (screenSqueeze !== 1) screenSqueeze = 1;
    calmTicks = 0;
    if (Object.keys(useScreenStats.getState().send).length) useScreenStats.setState({ send: {} });
    return;
  }
  const { resolution, fps } = getV().screenQuality;
  const send: Record<string, SendStat> = {};
  await Promise.all(
    [...watchers].map(async (id) => {
      const pc = peers.get(id)?.pc;
      if (!pc || pc.connectionState === 'closed') return;
      const st = await readSend(pc, video.id, id).catch(() => null);
      if (st) send[id] = { ...st, capKbps: capKbps(resolution, fps) };
    }),
  );
  const list = Object.values(send);
  // Só com duas ou mais pessoas: com uma só, o controle de banda do WebRTC já resolve sozinho.
  if (list.length >= 2) {
    const hurt = list.filter((s) => s.lossPct >= 5 || (s.lossPct >= 2 && s.limit === 'bandwidth')).length;
    const before = screenSqueeze;
    if (hurt >= 2) {
      screenSqueeze = Math.max(0.4, screenSqueeze * 0.85);
      calmTicks = 0;
    } else if (list.every((s) => s.lossPct < 0.5)) {
      // 3 leituras calmas seguidas (6 s) para subir 5%: volta devagar e não fica oscilando.
      if (++calmTicks >= 3 && screenSqueeze < 1) {
        screenSqueeze = Math.min(1, screenSqueeze + 0.05);
        calmTicks = 0;
      }
    } else {
      calmTicks = 0;
    }
    if (screenSqueeze !== before) retuneScreen();
  } else if (screenSqueeze !== 1) {
    screenSqueeze = 1;
    calmTicks = 0;
    retuneScreen();
  }
  useScreenStats.setState({ send });
  // Quem assiste vê no painel dele como está o meu envio (captura, codificador, limite).
  const capture = currentSource && hasNativeScreen() ? 'nativa' : 'navegador';
  const signalTo = sendSignal;
  for (const [id, st] of Object.entries(send)) {
    signalTo(id, {
      type: 'senderStats',
      stats: {
        srcFps: st.diag.srcFps,
        fps: st.fps,
        width: st.width,
        height: st.height,
        kbps: st.kbps,
        capKbps: st.capKbps,
        bweKbps: st.diag.bweKbps,
        encoder: st.encoder.slice(0, 80),
        hw: st.hw,
        limit: st.limit,
        encodeMs: st.diag.encodeMs,
        qp: st.diag.qp,
        capture,
        placa: [...hwCodecs],
      },
    });
  }
}

/** Telas que eu assisto: lê a chegada e ajusta o buffer pela distância de quem transmite. */
async function recvTick() {
  const { states, streams, watching } = getV();
  const recv: Record<string, RecvStat> = {};
  await Promise.all(
    Object.keys(watching).map(async (userId) => {
      if (!watching[userId]) return;
      const sid = states[userId]?.screenStreamId;
      const track = sid ? streams[sid]?.getVideoTracks()[0] : undefined;
      const pc = peers.get(userId)?.pc;
      if (!track || !pc || pc.connectionState === 'closed') return;
      const st = await readRecv(pc, track.id, userId).catch(() => null);
      if (!st) return;
      const receiver = pc.getReceivers().find((r) => r.track === track);
      let bufferMs = receiver ? (screenBuffers.get(receiver) ?? SCREEN_BUFFER_MS) : SCREEN_BUFFER_MS;
      if (receiver) {
        const want = screenBufferFor(st.rttMs, st.lossPct);
        // Só mexe quando muda bastante (o buffer pulando a toda hora dá trancos na imagem).
        if (Math.abs(want - bufferMs) >= 20) {
          setScreenBuffer(receiver, want);
          bufferMs = screenBuffers.get(receiver) ?? bufferMs;
        }
      }
      recv[userId] = { ...st, bufferMs };
    }),
  );
  // Resumo de quem parou de transmitir (ou que eu parei de assistir) sai junto.
  useScreenStats.setState((s) => ({
    recv,
    sender: Object.fromEntries(Object.entries(s.sender).filter(([id]) => recv[id])),
  }));
}

function closePeer(peerId: string) {
  // Quem assistia saiu da chamada: os outros que assistem ficam sabendo.
  if (watchers.delete(peerId) && getV().screen) queueMicrotask(() => sendViewers());
  const peer = peers.get(peerId);
  if (!peer) return;
  clearTimeout(peer.offerTimer);
  clearTimeout(peer.iceTimer);
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
          maxBitrate: capKbps(resolution, fps) * 1000,
          maxFramerate: encoderFps(fps),
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

/**
 * Teto de cada pessoa que assiste. Com várias pessoas, cada conexão manda a sua própria cópia pelo
 * mesmo upload: quando duas ou mais perdem pacote ao mesmo tempo, o upload encheu, e o teto de todas
 * desce junto (screenSqueeze) até a perda sumir; depois volta aos poucos. Não substitui o controle de
 * banda do WebRTC, que continua decidindo abaixo desse teto.
 */
let screenSqueeze = 1;
function capKbps(resolution: Resolution, fps: Fps) {
  return Math.round(RESOLUTIONS[resolution].kbps[fps] * screenSqueeze);
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
 * Sem isto o WebRTC começa a estimar a banda em ~300 kbps e sobe aos poucos: os primeiros
 * segundos saem em blocos. Na descrição do outro lado (que vale para o meu envio) marca a taxa
 * inicial da conexão para a qualidade escolhida. Só no Chromium/WebView2/WebKit (libwebrtc); o adaptador do Linux ignora.
 */
function tuneScreenSdp(sdp: string, peerId: string) {
  if (!getV().screen || !watchers.has(peerId)) return sdp;
  if ((window as unknown as { __lineRtc?: { adapter?: boolean } }).__lineRtc?.adapter) return sdp;
  const { resolution, fps } = getV().screenQuality;
  const cap = RESOLUTIONS[resolution].kbps[fps];
  // Começo alto mas sem passar de 8 Mbps somando todo mundo que assiste (upload mais fraco não engasga
  // logo no início).
  // Piso moderado (x-google-min-bitrate, 30% do teto, no máximo 4,5 Mbps somando quem assiste): em cena
  // parada o codificador manda pouco e a estimativa de banda do WebRTC encolhe junto (~1,5x do que está
  // saindo). Na troca brusca (Alt+Tab, menu de jogo) sobravam 2-3 Mbps para um quadro todo novo, o QP ia
  // a 45-49 e a imagem virava blocos com pedaços da tela anterior. O diagnóstico de 2026-11-20 mostrou
  // isso com perda 0%. O piso fica baixo o bastante para a maioria dos uploads.
  const n = Math.max(1, watchers.size);
  const extra = `x-google-start-bitrate=${Math.round(Math.min(cap * 0.6, 8000 / n))};x-google-min-bitrate=${Math.round(Math.min(cap * 0.3, 4500 / n))}`;
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
    // Sempre manter a resolução: com maintain-framerate o codificador encolhia a imagem (1080p ↔ 1440×804)
    // a cada aperto, e cada troca de tamanho gera quadro-chave e congelamento (14 em 30 s no diagnóstico).
    // Agora, no aperto, ele pula um quadro em vez de borrar ou mudar de tamanho.
    void fps;
    params.degradationPreference = 'maintain-resolution';
    await sender.setParameters(params);
  } catch {
    // Alguns navegadores só aceitam depois da negociação: tenta de novo quando a conexão já subiu.
    if (retry) setTimeout(() => void tuneScreenSender(sender, fps, false), 3000);
  }
}

function removeStreamFromPeers(stream: MediaStream) {
  for (const { pc } of peers.values()) removeStreamFrom(pc, stream);
}

function pauseScreen(peer: Peer, screen: MediaStream) {
  const ids = new Set(screen.getTracks().map((t) => t.id));
  const senders = peer.pc.getSenders().filter((sender) => !!sender.track && ids.has(sender.track.id));
  for (const sender of senders) void sender.replaceTrack(null).catch(() => {});
  peer.pausedScreen = [...(peer.pausedScreen ?? []), ...senders];
}

function resumeScreen(peer: Peer, screen: MediaStream): boolean {
  const paused = peer.pausedScreen ?? [];
  peer.pausedScreen = [];
  const tracks = screen.getTracks();
  const pick = (kind: string) => paused.find((sender) => {
    const t = peer.pc.getTransceivers().find((x) => x.sender === sender);
    return t && t.currentDirection !== 'stopped' && sender.track === null && t.receiver.track.kind === kind;
  });
  const plan = tracks.map((track) => [track, pick(track.kind)] as const);
  if (!plan.length || plan.some(([, sender]) => !sender)) {
    retirePaused(peer.pc, paused);
    return false;
  }
  const { resolution, fps } = getV().screenQuality;
  for (const [track, sender] of plan) {
    void sender!.replaceTrack(track).catch(() => {});
    if (track.kind === 'video') void retuneScreenSender(sender!, resolution, fps);
  }
  retirePaused(peer.pc, paused.filter((sender) => !plan.some(([, s]) => s === sender)));
  return true;
}

/** Envios pausados que não vão mais voltar: desliga o canal, e do outro lado a tela velha some. */
function retirePaused(pc: RTCPeerConnection, senders: RTCRtpSender[]) {
  for (const sender of senders) {
    const t = pc.getTransceivers().find((x) => x.sender === sender);
    if (t && t.currentDirection !== 'stopped' && pc.signalingState !== 'closed') t.direction = 'inactive';
  }
}

function dropPausedScreens() {
  for (const peer of peers.values()) {
    retirePaused(peer.pc, peer.pausedScreen ?? []);
    peer.pausedScreen = [];
  }
}

function sendsStream(pc: RTCPeerConnection, stream: MediaStream) {
  const ids = new Set(stream.getTracks().map((t) => t.id));
  return pc.getSenders().some((sender) => !!sender.track && ids.has(sender.track.id));
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

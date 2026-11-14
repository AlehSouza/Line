'use client';

import type { ClientToServerEvents, ServerToClientEvents, VoiceModeration, VoiceSignal, VoiceState } from '@line/shared';
import type { Socket } from 'socket.io-client';
import { create } from 'zustand';
import { disposeNoiseSuppressor, suppressNoise } from './noise';
import { api } from './api';
import { hasNativeScreen, startNativeScreen } from './nativeScreen';
import { hasPerm, Perm } from '@line/shared';
import { permsOf, useLine } from './store';

/** Pode isso no canal de voz (de servidor) atual ou no indicado? DM pode tudo. */
function voiceCan(flag: number, channelId = getV().channelId): boolean {
  const s = useLine.getState();
  const serverId = channelId ? s.channels[channelId]?.serverId : null;
  return hasPerm(permsOf(s, serverId, s.me?.id), flag);
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

export const RESOLUTIONS: Record<Resolution, { label: string; width: number; height: number; kbps: Record<Fps, number> }> = {
  '720': { label: '720p', width: 1280, height: 720, kbps: { 30: 2500, 60: 4000 } },
  '1080': { label: '1080p', width: 1920, height: 1080, kbps: { 30: 6000, 60: 9000 } },
  '1440': { label: '1440p', width: 2560, height: 1440, kbps: { 30: 10000, 60: 15000 } },
  '2160': { label: '4K', width: 3840, height: 2160, kbps: { 30: 16000, 60: 25000 } },
};

// ---------- preferências (ficam salvas no PC) ----------

interface VoicePrefs {
  noiseSuppression: boolean;
  inputId: string | null;
  outputId: string | null;
  screenQuality: ScreenQuality;
}

const PREFS_KEY = 'line.voice';
const defaultPrefs: VoicePrefs = {
  noiseSuppression: true,
  inputId: null,
  outputId: null,
  screenQuality: { resolution: '1080', fps: 60 },
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
  const { noiseSuppression, inputId, outputId, screenQuality } = getV();
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ noiseSuppression, inputId, outputId, screenQuality }));
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
        const screenViewers = { ...v.screenViewers };
        delete screenViewers[uid];
        return { watching: { ...v.watching, [uid]: false }, screenThumbs, screenViewers };
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

// ---------- entrar / sair ----------

export async function joinVoice(channelId: string) {
  if (!socket) return;
  const current = getV();
  if (current.channelId === channelId) return;
  if (current.channelId) await leaveVoice();

  if (typeof RTCPeerConnection === 'undefined') {
    setV({
      error:
        'Chamadas não funcionam neste app no Linux (o WebKit da sua distro veio sem WebRTC). Abra o Line pelo Chrome ou Firefox no endereço do servidor.',
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
  const { muted, deafened, states } = getV();
  const forced = myId ? states[myId] : undefined;
  const silent = muted || deafened || !!forced?.serverMuted || !!forced?.serverDeafened;
  for (const s of [rawMic, mic]) s?.getAudioTracks().forEach((t) => (t.enabled = !silent));
  for (const el of audioEls.values()) applyPeerAudio(el);
}

/** Ensurdecido (por mim ou pelo servidor), silenciado localmente e volume de cada pessoa. */
function applyPeerAudio(el: HTMLAudioElement) {
  const { deafened, states, localMuted, userVolume, screenVolume, screenMuted, watching } = getV();
  const peer = el.dataset.peer ?? '';
  const forced = myId ? states[myId]?.serverDeafened : false;
  // O áudio da tela vem no mesmo stream do vídeo da tela; o resto é a voz.
  const isScreen = !!states[peer]?.screenStreamId && el.dataset.stream === states[peer]?.screenStreamId;
  const off = deafened || !!forced || (isScreen ? !!screenMuted[peer] || !watching[peer] : !!localMuted[peer]);
  const volume = Math.min(2, Math.max(0, (isScreen ? screenVolume[peer] : userVolume[peer]) ?? 1));
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
  const { inputId, noiseSuppression } = getV();
  const audio: MediaTrackConstraints = {
    deviceId: inputId ? { exact: inputId } : undefined,
    echoCancellation: true,
    // Com o nosso supressor ligado, o do navegador sai do caminho (os dois juntos deixam a voz "metálica").
    noiseSuppression: !noiseSuppression,
    autoGainControl: true,
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
  if (noiseSuppression) {
    try {
      mic = await suppressNoise(rawMic);
    } catch (err) {
      console.warn('Supressor de ruído indisponível', err);
      setV({ noiseSuppression: false, error: 'Não deu para ligar o supressor de ruído neste PC.' });
    }
  }
}

/** Reabre o microfone (trocou o dispositivo ou o supressor) sem derrubar a chamada. */
async function reopenMic() {
  if (!getV().channelId) return;
  const old = mic;
  const oldRaw = rawMic;
  mic = null;
  rawMic = null;
  disposeNoiseSuppressor();
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
  setV({ noiseSuppression: on });
  savePrefs();
  await reopenMic();
}

export async function setInputDevice(deviceId: string | null) {
  setV({ inputId: deviceId });
  savePrefs();
  await reopenMic();
}

export function setOutputDevice(deviceId: string | null) {
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
let nativeStop: (() => void) | null = null;
let screenSize: { width: number; height: number } | null = null;

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
  const { resolution, fps } = getV().screenQuality;
  try {
    let stream: MediaStream;
    if (source && hasNativeScreen() && !window.line?.screen) {
      const native = await startNativeScreen(source.id, {
        fps,
        audio: source.audio,
        height: RESOLUTIONS[resolution].height,
        onEnded: stopScreen,
      });
      // Saiu da chamada enquanto abria: solta a captura.
      if (!getV().channelId) {
        native.stop();
        return;
      }
      stream = native.stream;
      nativeStop = native.stop;
      screenSize = { width: native.width, height: native.height };
    } else {
      const r = RESOLUTIONS[resolution];
      // Linux (Electron): avisa qual fonte foi escolhida no seletor do Line antes de pedir a tela.
      if (source && window.line?.screen) await window.line.screen.select(source.id);
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: r.width, max: r.width },
          height: { ideal: r.height, max: r.height },
          frameRate: { ideal: fps, max: fps },
        },
        audio: true,
        // Pede o áudio do sistema já marcado no seletor (Chromium/WebView2). No Windows ele vem ao compartilhar a tela inteira.
        systemAudio: 'include',
        windowAudio: 'system',
        // Tira do áudio capturado o som do próprio Line, para os outros não ouvirem a própria voz de volta.
        restrictOwnAudio: true,
      } as DisplayMediaStreamOptions);
      screenSize = null;
    }
    const video = stream.getVideoTracks()[0];
    // 60fps = jogo/vídeo (prioriza fluidez); 30fps = texto/código (prioriza nitidez).
    if (video) video.contentHint = fps >= 60 ? 'motion' : 'detail';
    video?.addEventListener('ended', stopScreen);
    setV({ screen: stream });
    addStreamToPeers(stream);
    startThumbs(stream);
    socket?.emit('voice:state', { screenStreamId: stream.id });
    playCallSound('start_transmission');
  } catch (err) {
    if ((err as Error).name !== 'NotAllowedError') setV({ error: 'Não foi possível compartilhar a tela.' });
  }
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

/** Tira um quadro pequeno da minha tela e manda para quem ainda não assiste (a cada 10 s). */
function startThumbs(stream: MediaStream) {
  stopThumbs();
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
    for (const id of peers.keys()) if (!watchers.has(id)) send(id, { type: 'thumb', data });
  };
  setTimeout(tick, 1500);
  thumbTimer = setInterval(tick, 10_000);
}

function captureThumb(): string | null {
  const v = thumbVideo;
  if (!v || !v.videoWidth || !v.videoHeight) return null;
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

  pc.ontrack = ({ track, streams }) => {
    const stream = streams[0] ?? new MediaStream([track]);
    peer.streamIds.add(stream.id);
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
    setTimeout(() => send(peerId, { type: 'thumb', data: thumb }), 500);
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
      setV((v) => ({ screenThumbs: { ...v.screenThumbs, [from]: signal.data } }));
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
      await pc.setRemoteDescription(desc);
      if (desc.type === 'offer') {
        await pc.setLocalDescription();
        if (pc.localDescription) send(from, { type: 'description', description: pc.localDescription.toJSON() });
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

/**
 * Em 60fps (jogos) e acima de 1080p, prefere H.264, que a placa de vídeo codifica: o VP8 em
 * software disputa a CPU com o jogo e acaba derrubando fps e qualidade. Se o outro lado não
 * aceitar H.264, a negociação cai para o próximo da lista.
 */
function preferHardwareCodec(transceiver: RTCRtpTransceiver, resolution: Resolution, fps: Fps) {
  if ((fps < 60 && (resolution === '720' || resolution === '1080')) || !transceiver.setCodecPreferences) return;
  const codecs = RTCRtpSender.getCapabilities?.('video')?.codecs;
  if (!codecs) return;
  const rank = (c: { mimeType: string }) => {
    const m = c.mimeType.toLowerCase();
    return m === 'video/h264' ? 0 : m === 'video/vp9' ? 1 : m === 'video/av1' ? 2 : 3;
  };
  try {
    transceiver.setCodecPreferences([...codecs].sort((a, b) => rank(a) - rank(b)));
  } catch {
    // navegador não deixou escolher: fica com o padrão
  }
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
  disposeNoiseSuppressor();
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
    if (mic && myId && !v.muted && !v.deafened) {
      const e = analyserFor('local', myId, mic);
      if (e && isSpeaking(myId, level(e), now)) next[myId] = true;
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

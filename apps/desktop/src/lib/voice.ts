'use client';

import type { ClientToServerEvents, ServerToClientEvents, VoiceSignal, VoiceState } from '@line/shared';
import type { Socket } from 'socket.io-client';
import { create } from 'zustand';
import { disposeNoiseSuppressor, suppressNoise } from './noise';
import { api } from './api';

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

export interface VoiceStore {
  /** Estados de voz visíveis, por usuário. */
  states: Record<string, VoiceState>;
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
    setV((v) => {
      const states = { ...v.states };
      if (state) states[uid] = state;
      else if (states[uid]?.channelId === channelId) delete states[uid];
      return { states };
    });
    if (uid === myId) return;
    const mine = getV().channelId;
    if (!mine) return;
    // Quem chega é quem abre a conexão (no rejoin). Se os dois lados criassem a conexão ao mesmo tempo,
    // as ofertas colidiam e a câmera/tela de quem já estava na sala podia nunca chegar ao novato.
    if ((!state || state.channelId !== mine) && peers.has(uid)) closePeer(uid);
  });

  s.on('voice:signal', ({ from, signal }) => void onSignal(from, signal));

  s.on('voice:kicked', () => {
    void leaveVoice(false);
  });
}

export function unbindVoice() {
  void leaveVoice(false);
  socket = null;
  myId = null;
  setV({ states: {} });
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
  setV({ channelId, connecting: true, error: null });
  try {
    await refreshIceServers();
    if (!mic) await openMic();
    applyMute();
    await rejoin(channelId);
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
  if (notify) socket?.emit('voice:leave');
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
  setV(next);
  applyMute();
  socket?.emit('voice:state', next);
}

export function toggleDeafen() {
  const deafened = !getV().deafened;
  const next = { deafened, muted: deafened ? true : false };
  setV(next);
  applyMute();
  socket?.emit('voice:state', next);
}

function applyMute() {
  const { muted, deafened } = getV();
  for (const s of [rawMic, mic]) s?.getAudioTracks().forEach((t) => (t.enabled = !muted && !deafened));
  for (const el of audioEls.values()) el.muted = deafened;
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

export async function toggleCamera() {
  const { camera } = getV();
  if (camera) {
    removeStreamFromPeers(camera);
    stopStream(camera);
    setV({ camera: null });
    socket?.emit('voice:state', { cameraStreamId: null });
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    setV({ camera: stream });
    addStreamToPeers(stream);
    socket?.emit('voice:state', { cameraStreamId: stream.id });
  } catch (err) {
    setV({ error: (err as Error).name === 'NotAllowedError' ? 'Sem permissão para usar a câmera.' : 'Não foi possível abrir a câmera.' });
  }
}

/** Liga/desliga o compartilhamento de tela. Sem `sourceId`, o seletor é o do próprio sistema (WebView2/navegador). */
export async function toggleScreen(sourceId?: string) {
  const { screen } = getV();
  if (screen) {
    stopScreen();
    return;
  }
  try {
    if (sourceId) await window.line?.selectScreenSource?.(sourceId);
    const { resolution, fps } = getV().screenQuality;
    const r = RESOLUTIONS[resolution];
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: r.width, max: r.width },
        height: { ideal: r.height, max: r.height },
        frameRate: { ideal: fps, max: fps },
      },
      audio: true,
    });
    const video = stream.getVideoTracks()[0];
    // 60fps = jogo/vídeo (prioriza fluidez); 30fps = texto/código (prioriza nitidez).
    if (video) video.contentHint = fps >= 60 ? 'motion' : 'detail';
    video?.addEventListener('ended', stopScreen);
    setV({ screen: stream });
    addStreamToPeers(stream);
    socket?.emit('voice:state', { screenStreamId: stream.id });
  } catch (err) {
    if ((err as Error).name !== 'NotAllowedError') setV({ error: 'Não foi possível compartilhar a tela.' });
  }
}

function stopScreen() {
  const { screen } = getV();
  if (!screen) return;
  removeStreamFromPeers(screen);
  stopStream(screen);
  setV({ screen: null });
  socket?.emit('voice:state', { screenStreamId: null });
}

export function clearVoiceError() {
  setV({ error: null });
}

// ---------- WebRTC ----------

function send(to: string, signal: VoiceSignal) {
  socket?.emit('voice:signal', { to, signal });
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
  if (screen) addStream(pc, screen);
  return peer;
}

async function onSignal(from: string, signal: VoiceSignal) {
  const mine = getV().channelId;
  // O servidor só repassa sinais entre pessoas do mesmo canal; o estado local pode ainda não ter chegado.
  if (!mine) return;
  const peer = peers.get(from) ?? createPeer(from);
  const { pc } = peer;
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
  for (const { pc } of peers.values()) addStream(pc, stream);
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
      sendEncodings: [{ maxBitrate: RESOLUTIONS[resolution].kbps[fps] * 1000, maxFramerate: fps }],
    });
    preferHardwareCodec(transceiver, resolution);
    void tuneScreenSender(transceiver.sender, fps);
  }
}

/** Acima de 1080p, prefere H.264 (codificado pela placa de vídeo) para aguentar 1440p/4K a 60fps. */
function preferHardwareCodec(transceiver: RTCRtpTransceiver, resolution: Resolution) {
  if (resolution === '720' || resolution === '1080' || !transceiver.setCodecPreferences) return;
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

async function tuneScreenSender(sender: RTCRtpSender, fps: Fps) {
  try {
    const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
    params.degradationPreference = fps >= 60 ? 'maintain-framerate' : 'maintain-resolution';
    await sender.setParameters(params);
  } catch {
    // alguns navegadores não aceitam antes da negociação; os limites de sendEncodings já valem
  }
}

function removeStreamFromPeers(stream: MediaStream) {
  const ids = new Set(stream.getTracks().map((t) => t.id));
  for (const { pc } of peers.values()) {
    for (const sender of pc.getSenders()) if (sender.track && ids.has(sender.track.id)) pc.removeTrack(sender);
  }
}

function attachAudio(peerId: string, stream: MediaStream) {
  if (audioEls.has(stream.id)) return;
  const el = document.createElement('audio');
  el.autoplay = true;
  el.srcObject = stream;
  el.muted = getV().deafened;
  el.dataset.peer = peerId;
  applySink(el);
  document.body.appendChild(el);
  void el.play().catch(() => {});
  audioEls.set(stream.id, el);
}

function dropRemoteStream(id: string) {
  const el = audioEls.get(id);
  if (el) {
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

function startSpeakingLoop() {
  if (loop) return;
  void audioCtx?.resume();
  loop = setInterval(() => {
    const v = getV();
    const next: Record<string, boolean> = {};
    if (mic && myId && !v.muted && !v.deafened) {
      const e = analyserFor('local', myId, mic);
      if (e) next[myId] = level(e) > 0.04;
    }
    for (const [peerId, peer] of peers) {
      const screenId = v.states[peerId]?.screenStreamId;
      for (const sid of peer.streamIds) {
        if (sid === screenId) continue; // áudio da tela não conta como fala
        const stream = v.streams[sid];
        if (!stream) continue;
        const e = analyserFor(sid, peerId, stream);
        if (e && level(e) > 0.04) next[peerId] = true;
      }
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
}

/** Participantes de um canal, em ordem de chegada. */
export function participants(states: Record<string, VoiceState>, channelId: string): VoiceState[] {
  return Object.values(states)
    .filter((s) => s.channelId === channelId)
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
}

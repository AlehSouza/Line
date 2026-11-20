'use client';

import { create } from 'zustand';
import type { SenderSummary } from '@line/shared';

/**
 * Números reais da transmissão de tela, lidos do WebRTC (getStats) a cada 2 s.
 * Mostram o que de fato chega (resolução, fps, bitrate, perda), não a qualidade escolhida.
 */

export interface SendStat {
  kbps: number;
  fps: number;
  width: number;
  height: number;
  /** Perda informada por quem assiste nos últimos 2 s, em %. */
  lossPct: number;
  rttMs: number | null;
  /** Por que o codificador não entrega a qualidade cheia: banda, CPU ou nada. */
  limit: string;
  encoder: string;
  /** Codificando pela placa de vídeo. */
  hw: boolean;
  codec: string;
  relay: boolean;
  /** Teto de bits que o Line deu para essa pessoa agora. */
  capKbps: number;
  diag: SendDiag;
}

/**
 * Diagnóstico por etapa (envio). Valores do intervalo entre duas leituras, a não ser os totais.
 * QP é a quantização média: quanto maior, mais "blocos" (H.264 vai de 0 a 51; VP8/VP9 até 127; AV1 até 255).
 */
export interface SendDiag {
  /** Quadros por segundo que a captura entrega ao WebRTC. */
  srcFps: number;
  qp: number | null;
  /** Tempo médio para codificar um quadro. */
  encodeMs: number | null;
  /** Quadros que saíram da captura e o codificador não mandou, no intervalo. */
  encDropped: number;
  /** Totais da sessão. */
  keyframes: number;
  pli: number;
  fir: number;
  nack: number;
  /** Quadros enormes (troca brusca de imagem) enviados no total. */
  huge: number;
  /** Bits de reenvio no intervalo. */
  retxKbps: number;
  /** Banda que o WebRTC acha que tem para essa pessoa agora. */
  bweKbps: number;
  /** Alvo do codificador (o que ele tenta gerar). */
  targetKbps: number;
}

export interface RecvStat {
  kbps: number;
  fps: number;
  width: number;
  height: number;
  lossPct: number;
  jitterMs: number;
  rttMs: number | null;
  /** Congelamentos (quadro parado por muito tempo) desde que comecei a assistir. */
  freezes: number;
  dropped: number;
  decoder: string;
  hw: boolean;
  codec: string;
  relay: boolean;
  bufferMs: number;
  diag: RecvDiag;
}

/** Diagnóstico por etapa (recebimento). */
export interface RecvDiag {
  qp: number | null;
  decodeMs: number | null;
  /** Quadros no intervalo: recebidos, decodificados e descartados antes de aparecer. */
  received: number;
  decoded: number;
  droppedNow: number;
  /** Tempo total congelado na sessão. */
  freezeMs: number;
  /** Totais da sessão: quadros-chave recebidos e pedidos de quadro-chave/reenvio que eu fiz. */
  keyframes: number;
  pli: number;
  fir: number;
  nack: number;
}

interface ScreenStatsStore {
  /** Por pessoa que assiste à minha tela. */
  send: Record<string, SendStat>;
  /** Resumo que cada pessoa que transmite me manda do próprio envio. */
  sender: Record<string, SenderSummary>;
  /** Por pessoa cuja tela eu assisto. */
  recv: Record<string, RecvStat>;
  /** Painel de estatísticas aberto. Só vale para mim. */
  open: boolean;
}

const OPEN_KEY = 'line.screenStats.open';
function loadOpen() {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

export const useScreenStats = create<ScreenStatsStore>(() => ({ send: {}, recv: {}, sender: {}, open: loadOpen() }));

export function toggleScreenStats() {
  const open = !useScreenStats.getState().open;
  useScreenStats.setState({ open });
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    // sem armazenamento: só vale até fechar
  }
}

type Report = Map<string, Record<string, unknown>>;
type Sample = { t: number; bytes: number; packets: number; lost: number };
/** Último valor dos contadores de cada fluxo, para calcular a taxa entre duas leituras. */
const samples = new Map<string, Sample>();
/** Leitura anterior inteira de cada fluxo (para os contadores do diagnóstico). */
const prevRaw = new Map<string, Record<string, unknown>>();

export function forgetSamples() {
  samples.clear();
  prevRaw.clear();
}

/** Diferença de um contador desde a leitura anterior do mesmo fluxo. */
function differ(key: string, cur: Record<string, unknown>) {
  const prev = prevRaw.get(key);
  prevRaw.set(key, cur);
  return (field: string) => (prev ? Math.max(0, num(cur[field]) - num(prev[field])) : 0);
}

async function read(pc: RTCPeerConnection): Promise<Report> {
  const out: Report = new Map();
  const r = await pc.getStats();
  r.forEach((s: Record<string, unknown>) => out.set(s.id as string, s));
  return out;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Par de candidatos em uso: RTT da conexão e se passa pelo TURN. */
function transport(report: Report) {
  let pair: Record<string, unknown> | undefined;
  for (const s of report.values()) {
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId as string);
  }
  if (!pair) {
    for (const s of report.values()) {
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) pair = s;
    }
  }
  if (!pair) return { rttMs: null, relay: false, bweKbps: 0 };
  const local = report.get(pair.localCandidateId as string);
  const remote = report.get(pair.remoteCandidateId as string);
  const rtt = typeof pair.currentRoundTripTime === 'number' ? pair.currentRoundTripTime * 1000 : null;
  return {
    rttMs: rtt,
    relay: local?.candidateType === 'relay' || remote?.candidateType === 'relay',
    bweKbps: Math.round(num(pair.availableOutgoingBitrate) / 1000),
  };
}

function codecName(report: Report, codecId: unknown) {
  const c = typeof codecId === 'string' ? report.get(codecId) : undefined;
  return typeof c?.mimeType === 'string' ? c.mimeType.replace(/^video\//i, '') : '';
}

/** Taxa entre a leitura anterior e esta (kbps) e perda em % no intervalo. */
function delta(key: string, t: number, bytes: number, packets: number, lost: number) {
  const prev = samples.get(key);
  samples.set(key, { t, bytes, packets, lost });
  if (!prev || t <= prev.t) return { kbps: 0, lossPct: 0 };
  const kbps = ((bytes - prev.bytes) * 8) / (t - prev.t);
  const dp = packets - prev.packets;
  const dl = Math.max(0, lost - prev.lost);
  return { kbps: Math.max(0, Math.round(kbps)), lossPct: dp + dl > 0 ? (dl / (dp + dl)) * 100 : 0 };
}

/** Envio da minha tela numa conexão (a trilha de vídeo da tela). */
export async function readSend(pc: RTCPeerConnection, trackId: string, key: string): Promise<Omit<SendStat, 'capKbps'> | null> {
  const report = await read(pc);
  let source: string | undefined;
  for (const s of report.values()) if (s.type === 'media-source' && s.kind === 'video' && s.trackIdentifier === trackId) source = s.id as string;
  if (!source) return null;
  let out: Record<string, unknown> | undefined;
  for (const s of report.values()) if (s.type === 'outbound-rtp' && s.mediaSourceId === source) out = s;
  if (!out) return null;
  let remote: Record<string, unknown> | undefined;
  for (const s of report.values()) if (s.type === 'remote-inbound-rtp' && s.localId === out.id) remote = s;
  const t = num(out.timestamp);
  const { kbps, lossPct } = delta(`send:${key}:${out.id}`, t, num(out.bytesSent), num(out.packetsSent), num(remote?.packetsLost));
  const link = transport(report);
  const rtt = typeof remote?.roundTripTime === 'number' ? remote.roundTripTime * 1000 : link.rttMs;
  const src = report.get(source) ?? {};
  const dOut = differ(`sendraw:${key}:${out.id}`, out);
  const dSrc = differ(`srcraw:${key}:${source}`, src);
  const encoded = dOut('framesEncoded');
  const dtMs = dOut('timestamp');
  const diag: SendDiag = {
    srcFps: Math.round(num(src.framesPerSecond)),
    qp: encoded > 0 && out.qpSum != null ? Math.round(dOut('qpSum') / encoded) : null,
    encodeMs: encoded > 0 ? Math.round((dOut('totalEncodeTime') / encoded) * 10000) / 10 : null,
    encDropped: Math.max(0, dSrc('frames') - encoded),
    keyframes: num(out.keyFramesEncoded),
    pli: num(out.pliCount),
    fir: num(out.firCount),
    nack: num(out.nackCount),
    huge: num(out.hugeFramesSent),
    retxKbps: dtMs > 0 ? Math.round((dOut('retransmittedBytesSent') * 8) / dtMs) : 0,
    bweKbps: link.bweKbps,
    targetKbps: Math.round(num(out.targetBitrate) / 1000),
  };
  return {
    diag,
    kbps,
    fps: Math.round(num(out.framesPerSecond)),
    width: num(out.frameWidth),
    height: num(out.frameHeight),
    lossPct,
    rttMs: rtt,
    limit: typeof out.qualityLimitationReason === 'string' ? out.qualityLimitationReason : 'none',
    encoder: typeof out.encoderImplementation === 'string' ? out.encoderImplementation : '',
    hw: typeof out.powerEfficientEncoder === 'boolean' ? out.powerEfficientEncoder : isHardware(String(out.encoderImplementation ?? '')),
    codec: codecName(report, out.codecId),
    relay: link.relay,
  };
}

/** Tela que eu recebo numa conexão. */
export async function readRecv(pc: RTCPeerConnection, trackId: string, key: string): Promise<Omit<RecvStat, 'bufferMs'> | null> {
  const report = await read(pc);
  let inb: Record<string, unknown> | undefined;
  for (const s of report.values()) if (s.type === 'inbound-rtp' && s.kind === 'video' && s.trackIdentifier === trackId) inb = s;
  if (!inb) return null;
  const t = num(inb.timestamp);
  const { kbps, lossPct } = delta(`recv:${key}:${inb.id}`, t, num(inb.bytesReceived), num(inb.packetsReceived), num(inb.packetsLost));
  const link = transport(report);
  const dIn = differ(`recvraw:${key}:${inb.id}`, inb);
  const decoded = dIn('framesDecoded');
  const diag: RecvDiag = {
    qp: decoded > 0 && inb.qpSum != null ? Math.round(dIn('qpSum') / decoded) : null,
    decodeMs: decoded > 0 ? Math.round((dIn('totalDecodeTime') / decoded) * 10000) / 10 : null,
    received: dIn('framesReceived'),
    decoded,
    droppedNow: dIn('framesDropped'),
    freezeMs: Math.round(num(inb.totalFreezesDuration) * 1000),
    keyframes: num(inb.keyFramesDecoded),
    pli: num(inb.pliCount),
    fir: num(inb.firCount),
    nack: num(inb.nackCount),
  };
  return {
    diag,
    kbps,
    fps: Math.round(num(inb.framesPerSecond)),
    width: num(inb.frameWidth),
    height: num(inb.frameHeight),
    lossPct,
    jitterMs: Math.round(num(inb.jitter) * 1000),
    rttMs: link.rttMs,
    freezes: num(inb.freezeCount),
    dropped: num(inb.framesDropped),
    decoder: typeof inb.decoderImplementation === 'string' ? inb.decoderImplementation : '',
    hw: typeof inb.powerEfficientDecoder === 'boolean' ? inb.powerEfficientDecoder : isHardware(String(inb.decoderImplementation ?? '')),
    codec: codecName(report, inb.codecId),
    relay: link.relay,
  };
}

// ---------- histórico para o botão "Copiar diagnóstico" ----------

interface DiagEntry {
  t: string;
  send: Record<string, SendStat>;
  recv: Record<string, RecvStat>;
  sender: Record<string, SenderSummary>;
}
const HISTORY_MAX = 150; // 5 minutos com leituras a cada 2 s
const history: DiagEntry[] = [];

export function pushHistory(send: Record<string, SendStat>, recv: Record<string, RecvStat>, sender: Record<string, SenderSummary>) {
  if (!Object.keys(send).length && !Object.keys(recv).length) return;
  history.push({ t: new Date().toISOString(), send, recv, sender });
  if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
}

export function clearHistory() {
  history.length = 0;
}

/** Texto com as últimas leituras e o ambiente, para colar na conversa e analisar. */
export function diagnosticsText(extra: Record<string, unknown>) {
  return JSON.stringify({ app: extra, userAgent: navigator.userAgent, leituras: history }, null, 1);
}

/** Codificador/decodificador por placa de vídeo? (nomes que o Chromium e o WebKit usam) */
export function isHardware(impl: string) {
  return /External|MediaFoundation|VideoToolbox|D3D11|Vaapi|NVENC|QSV|AMF|V4L2/i.test(impl);
}

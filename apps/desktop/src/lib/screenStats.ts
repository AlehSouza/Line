'use client';

import { create } from 'zustand';

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
}

interface ScreenStatsStore {
  /** Por pessoa que assiste à minha tela. */
  send: Record<string, SendStat>;
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

export const useScreenStats = create<ScreenStatsStore>(() => ({ send: {}, recv: {}, open: loadOpen() }));

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

export function forgetSamples() {
  samples.clear();
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
  if (!pair) return { rttMs: null, relay: false };
  const local = report.get(pair.localCandidateId as string);
  const remote = report.get(pair.remoteCandidateId as string);
  const rtt = typeof pair.currentRoundTripTime === 'number' ? pair.currentRoundTripTime * 1000 : null;
  return { rttMs: rtt, relay: local?.candidateType === 'relay' || remote?.candidateType === 'relay' };
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
  return {
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
  return {
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

/** Codificador/decodificador por placa de vídeo? (nomes que o Chromium e o WebKit usam) */
export function isHardware(impl: string) {
  return /External|MediaFoundation|VideoToolbox|D3D11|Vaapi|NVENC|QSV|AMF|V4L2/i.test(impl);
}

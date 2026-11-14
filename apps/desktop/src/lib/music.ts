'use client';

import type { ClientToServerEvents, MusicControl, MusicState, ServerToClientEvents } from '@line/shared';
import type { Socket } from 'socket.io-client';
import { create } from 'zustand';
import { useVoice } from './voice';

// Bot de música ("ouvir junto"): o servidor guarda a fila e a posição; cada app toca o player
// oficial do YouTube (IFrame API) em sincronia. Só toca para quem está no canal de voz.

type LineSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
export type LiveMusic = MusicState & { receivedAt: number };

const VOLUME_KEY = 'line.musicVolume';
const MUTED_KEY = 'line.musicMuted';

function loadVolume() {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(v) && localStorage.getItem(VOLUME_KEY) !== null ? Math.min(100, Math.max(0, v)) : 60;
  } catch {
    return 60;
  }
}

function loadMuted() {
  try {
    return localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    return false;
  }
}

export const useMusic = create<{ states: Record<string, LiveMusic>; volume: number; muted: boolean }>(() => ({
  states: {},
  volume: typeof window === 'undefined' ? 60 : loadVolume(),
  muted: typeof window === 'undefined' ? false : loadMuted(),
}));

let socket: LineSocket | null = null;

export function bindMusicSocket(s: LineSocket) {
  socket = s;
  s.on('music:snapshot', (list) => {
    const now = Date.now();
    useMusic.setState({ states: Object.fromEntries(list.map((m) => [m.channelId, { ...m, receivedAt: now }])) });
  });
  s.on('music:state', ({ channelId, state }) => {
    useMusic.setState((m) => {
      const states = { ...m.states };
      if (state) states[channelId] = { ...state, receivedAt: Date.now() };
      else delete states[channelId];
      return { states };
    });
  });
  startEngine();
}

export async function syncMusic() {
  const s = socket;
  if (!s?.connected) return;
  const list = await s.timeout(10_000).emitWithAck('music:sync').catch(() => null);
  if (!list || socket !== s) return;
  const now = Date.now();
  useMusic.setState({ states: Object.fromEntries(list.map((m: MusicState) => [m.channelId, { ...m, receivedAt: now }])) });
}

export function musicControl(c: MusicControl) {
  socket?.emit('music:control', c);
}

export function setMusicVolume(v: number) {
  useMusic.setState({ volume: v, muted: false });
  try {
    localStorage.setItem(VOLUME_KEY, String(v));
    localStorage.setItem(MUTED_KEY, '0');
  } catch {
    /* ignora */
  }
  reconcile();
}

/** Silencia a música só para mim (clique direito no bot). */
export function toggleMusicMute() {
  const muted = !useMusic.getState().muted;
  useMusic.setState({ muted });
  try {
    localStorage.setItem(MUTED_KEY, muted ? '1' : '0');
  } catch {
    /* ignora */
  }
  reconcile();
}

/** Para a música do canal de voz em que estou (só quem deu o /play ou quem gerencia o servidor). */
export function stopMusic(channelId: string) {
  musicControl({ channelId, action: 'stop' });
}

/** Posição atual da faixa em ms. */
export function positionOf(m: LiveMusic, now = Date.now()) {
  const p = m.positionMs + (m.paused ? 0 : now - m.receivedAt);
  const d = m.tracks[m.index]?.duration;
  return d ? Math.min(p, d * 1000) : p;
}

export function formatDuration(secs: number | null | undefined) {
  if (secs == null || !Number.isFinite(secs)) return '--:--';
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export const thumbOf = (videoId: string) => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

// ---------- player do YouTube ----------

/* eslint-disable @typescript-eslint/no-explicit-any */
let apiPromise: Promise<any> | null = null;
let player: any = null;
let playerReady = false;
let loadedUid: string | null = null;
let loadedChannel: string | null = null;
let reportedDuration: string | null = null;
let engineStarted = false;

function loadApi(): Promise<any> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    const w = window as any;
    if (w.YT?.Player) return resolve(w.YT);
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(w.YT);
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.onerror = () => {
      apiPromise = null;
    };
    document.head.appendChild(tag);
  });
  return apiPromise;
}

async function ensurePlayer() {
  if (player) return;
  const YT = await loadApi();
  if (player) return;
  let host = document.getElementById('line-music-player');
  if (!host) {
    const box = document.createElement('div');
    // O player fica fora da vista: só o áudio interessa, a capa aparece no card do Line.
    box.style.cssText = 'position:fixed;left:-10000px;bottom:0;width:320px;height:180px;pointer-events:none;opacity:0;';
    host = document.createElement('div');
    host.id = 'line-music-player';
    box.appendChild(host);
    document.body.appendChild(box);
  }
  player = new YT.Player('line-music-player', {
    width: 320,
    height: 180,
    playerVars: { autoplay: 1, controls: 0, disablekb: 1, playsinline: 1, rel: 0, fs: 0, iv_load_policy: 3 },
    events: {
      onReady: () => {
        playerReady = true;
        reconcile();
      },
      onStateChange: (e: any) => {
        const st = current();
        if (!st) return;
        const t = st.tracks[st.index];
        if (!t || t.uid !== loadedUid) return;
        if (e.data === 0) socket?.emit('music:report', { channelId: st.channelId, uid: t.uid, kind: 'ended' });
        if (e.data === 1 && t.duration == null && reportedDuration !== t.uid) {
          const d = player.getDuration?.();
          if (d > 0) {
            reportedDuration = t.uid;
            socket?.emit('music:report', { channelId: st.channelId, uid: t.uid, kind: 'duration', duration: d });
          }
        }
      },
      onError: () => {
        const st = current();
        const t = st?.tracks[st.index];
        if (st && t && t.uid === loadedUid) socket?.emit('music:report', { channelId: st.channelId, uid: t.uid, kind: 'error' });
      },
    },
  });
}

/** Sessão do canal de voz em que estou (é a que toca para mim). */
function current(): LiveMusic | null {
  const ch = useVoice.getState().channelId;
  return ch ? (useMusic.getState().states[ch] ?? null) : null;
}

function reconcile() {
  const st = current();
  if (!st) {
    if (player && playerReady && loadedUid) {
      try {
        player.stopVideo();
      } catch {
        /* ignora */
      }
    }
    loadedUid = null;
    loadedChannel = null;
    return;
  }
  if (!player) {
    void ensurePlayer();
    return;
  }
  if (!playerReady) return;
  const t = st.tracks[st.index];
  if (!t) return;
  const pos = positionOf(st) / 1000;
  const { deafened } = useVoice.getState();
  try {
    if (deafened || useMusic.getState().muted) player.mute();
    else {
      player.unMute();
      player.setVolume(useMusic.getState().volume);
    }
    if (loadedUid !== t.uid || loadedChannel !== st.channelId) {
      loadedUid = t.uid;
      loadedChannel = st.channelId;
      if (st.paused) player.cueVideoById({ videoId: t.videoId, startSeconds: pos });
      else player.loadVideoById({ videoId: t.videoId, startSeconds: pos });
      return;
    }
    const state = player.getPlayerState();
    if (st.paused) {
      if (state === 1 || state === 3) player.pauseVideo();
      return;
    }
    // Acabou: o servidor passa para a próxima (a não ser que tenham voltado para o começo).
    if (state === 0 && (!t.duration || pos >= t.duration - 3)) return;
    if (state !== 1 && state !== 3) player.playVideo();
    const now = player.getCurrentTime?.() ?? 0;
    if (Math.abs(now - pos) > 2.5) player.seekTo(pos, true);
  } catch {
    /* player ainda carregando */
  }
}

function startEngine() {
  if (engineStarted || typeof window === 'undefined') return;
  engineStarted = true;
  useMusic.subscribe(reconcile);
  useVoice.subscribe((v, prev) => {
    if (v.channelId !== prev.channelId || v.deafened !== prev.deafened) reconcile();
  });
  setInterval(reconcile, 4000);
}

/**
 * Painel de efeitos sonoros: sons curtos (até 5 s) de cada servidor, tocados para todos da chamada.
 * O servidor só repassa o som de quem está na voz e desmutado; cada um toca o arquivo no próprio app.
 * Favoritos, recentes e o volume dos efeitos ficam neste aparelho.
 */
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  Sound,
} from "@line/shared";
import type { Socket } from "socket.io-client";
import { create } from "zustand";
import { api, fileUrl } from "./api";
import { useVoice } from "./voice";

type LineSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const PREFS_KEY = "line.soundboard";
/** Duração máxima de cada som (o servidor confere também). */
export const MAX_SOUND_SECONDS = 5;

interface Prefs {
  favorites: string[];
  recents: string[];
  /** 0 a 1: volume dos efeitos que eu ouço. */
  volume: number;
}

interface SoundsStore extends Prefs {
  sounds: Sound[];
  loaded: boolean;
  /** Som tocando agora (id → quem tocou), para destacar o botão. */
  playing: Record<string, string>;
  /** Efeito que cada pessoa acabou de tocar (userId → emoji): brilho roxo e emoji subindo no quadro. */
  effects: Record<string, { emoji: string; key: number }>;
}

function loadPrefs(): Prefs {
  try {
    const raw =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(PREFS_KEY)
        : null;
    const p = raw ? JSON.parse(raw) : {};
    return {
      favorites: Array.isArray(p.favorites) ? p.favorites : [],
      recents: Array.isArray(p.recents) ? p.recents : [],
      volume: typeof p.volume === "number" ? p.volume : 0.1,
    };
  } catch {
    return { favorites: [], recents: [], volume: 0.1 };
  }
}

export const useSounds = create<SoundsStore>(() => ({
  sounds: [],
  loaded: false,
  playing: {},
  effects: {},
  ...loadPrefs(),
}));
const set = useSounds.setState;
const get = useSounds.getState;

function savePrefs() {
  const { favorites, recents, volume } = get();
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ favorites, recents, volume }),
    );
  } catch {
    /* sem localStorage */
  }
}

let socket: LineSocket | null = null;
let loading: Promise<void> | null = null;

export function loadSounds(force = false) {
  if (loading && !force) return loading;
  loading = api
    .soundboard()
    .then((sounds) => set({ sounds, loaded: true }))
    .catch(() => {
      loading = null;
    });
  return loading;
}

export function bindSoundsSocket(s: LineSocket) {
  socket = s;
  s.on("sounds:update", () => {
    if (get().loaded) void loadSounds(true);
  });
  s.on("voice:sound", ({ userId, channelId, sound }) => {
    const v = useVoice.getState();
    if (v.channelId !== channelId) return;
    showEffect(userId, sound.emoji || "🔊", sound.duration);
    if (v.deafened) return;
    playLocal(sound.url, sound.volume * get().volume, sound.id, userId);
  });
}

let effectSeq = 0;

/** Marca quem tocou o som enquanto ele toca (no mínimo 2 s, para dar tempo da animação). */
function showEffect(userId: string, emoji: string, duration = 2) {
  const key = ++effectSeq;
  set((s) => ({ effects: { ...s.effects, [userId]: { emoji, key } } }));
  setTimeout(
    () =>
      set((s) => {
        if (s.effects[userId]?.key !== key) return s;
        const effects = { ...s.effects };
        delete effects[userId];
        return { effects };
      }),
    Math.max(2, duration || 0) * 1000 + 200,
  );
}

export function toggleFavorite(id: string) {
  set((s) => ({
    favorites: s.favorites.includes(id)
      ? s.favorites.filter((f) => f !== id)
      : [id, ...s.favorites],
  }));
  savePrefs();
}

export function setSoundboardVolume(volume: number) {
  set({ volume: Math.max(0, Math.min(1, volume)) });
  savePrefs();
}

/** Toca o som para todos da chamada. Só vale desmutado (o servidor confere também). */
export function playSound(sound: Sound): string | null {
  const v = useVoice.getState();
  if (!v.channelId)
    return "Entre numa chamada de voz para usar os efeitos sonoros.";
  if (v.muted || v.deafened)
    return "Ative o microfone para usar os efeitos sonoros.";
  socket?.emit("voice:sound", { soundId: sound.id });
  set((s) => ({
    recents: [sound.id, ...s.recents.filter((r) => r !== sound.id)].slice(
      0,
      12,
    ),
  }));
  savePrefs();
  return null;
}

/** Prévia só para mim (configurações do servidor), no volume do som. */
export function previewSound(url: string, volume: number) {
  playLocal(url, volume);
}

function playLocal(url: string, volume: number, id?: string, by?: string) {
  try {
    const el = new Audio(fileUrl(url));
    el.volume = Math.max(0, Math.min(1, volume));
    const out = useVoice.getState().outputId;
    const sink = (
      el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
    ).setSinkId;
    if (out && sink) void sink.call(el, out).catch(() => {});
    if (id && by) {
      set((s) => ({ playing: { ...s.playing, [id]: by } }));
      el.onended = el.onerror = () =>
        set((s) => {
          const playing = { ...s.playing };
          delete playing[id];
          return { playing };
        });
    }
    void el.play().catch(() => {});
  } catch {
    /* sem áudio */
  }
}

// ---------- preparar o arquivo enviado ----------

/** Lê qualquer áudio (ou vídeo) que o navegador saiba tocar. */
export async function decodeFile(file: File): Promise<AudioBuffer> {
  const data = await file.arrayBuffer();
  const ctx = new AudioContext();
  try {
    return await ctx.decodeAudioData(data);
  } finally {
    void ctx.close();
  }
}

/** Picos para desenhar a forma de onda (0 a 1). */
export function waveform(buf: AudioBuffer, bars: number): number[] {
  const ch = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(ch.length / bars));
  const out: number[] = [];
  let max = 0;
  for (let i = 0; i < bars; i++) {
    let peak = 0;
    for (let j = i * step; j < Math.min(ch.length, (i + 1) * step); j += 4)
      peak = Math.max(peak, Math.abs(ch[j]));
    out.push(peak);
    max = Math.max(max, peak);
  }
  return out.map((p) => (max ? p / max : 0));
}

/** Corta o trecho [start, end] (segundos), mistura em mono e grava um WAV 16 bits. */
export function trimToWav(buf: AudioBuffer, start: number, end: number): Blob {
  const rate = buf.sampleRate;
  const from = Math.max(0, Math.floor(start * rate));
  const to = Math.min(buf.length, Math.floor(end * rate));
  const n = Math.max(0, to - from);
  const chans = Array.from({ length: buf.numberOfChannels }, (_, i) =>
    buf.getChannelData(i),
  );
  const out = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o: number, s: string) =>
    [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  out.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  str(36, "data");
  out.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const c of chans) v += c[from + i];
    v = Math.max(-1, Math.min(1, v / chans.length));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([out], { type: "audio/wav" });
}

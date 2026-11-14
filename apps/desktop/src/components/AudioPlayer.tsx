'use client';

import * as L from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cx } from './ui';

export function formatClock(s: number) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60)
    .toString()
    .padStart(2, '0');
  return `${m}:${sec}`;
}

/** Mensagens de voz gravadas no Line têm esse começo de nome. */
export const isVoiceMessage = (filename: string) => filename.startsWith('mensagem-de-voz');

const BARS = 48;
const peaksCache = new Map<string, Promise<{ peaks: number[]; duration: number }>>();

/** Lê o áudio inteiro e tira a forma de onda (picos normalizados de 0 a 1) e a duração. */
function loadPeaks(url: string) {
  let p = peaksCache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()))
      .then(async (buf) => {
        const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        try {
          const audio = await ctx.decodeAudioData(buf);
          const data = audio.getChannelData(0);
          const step = Math.max(1, Math.floor(data.length / BARS));
          const peaks: number[] = [];
          for (let i = 0; i < BARS; i++) {
            let max = 0;
            for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j += 16) max = Math.max(max, Math.abs(data[j]));
            peaks.push(max);
          }
          const top = Math.max(...peaks, 0.01);
          return { peaks: peaks.map((v) => v / top), duration: audio.duration };
        } finally {
          void ctx.close();
        }
      });
    p.catch(() => peaksCache.delete(url));
    peaksCache.set(url, p);
  }
  return p;
}

/** Só um áudio toca por vez no chat. */
let current: HTMLAudioElement | null = null;

function useAudio(src: string) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [error, setError] = useState(false);

  useEffect(() => {
    const a = new Audio();
    a.preload = 'metadata';
    a.src = src;
    ref.current = a;
    const dur = () => Number.isFinite(a.duration) && setDuration(a.duration);
    const on: [string, () => void][] = [
      ['play', () => setPlaying(true)],
      ['pause', () => setPlaying(false)],
      ['ended', () => {
        setPlaying(false);
        setTime(0);
        a.currentTime = 0;
      }],
      ['timeupdate', () => setTime(a.currentTime)],
      ['loadedmetadata', dur],
      ['durationchange', dur],
      ['error', () => setError(true)],
    ];
    for (const [e, f] of on) a.addEventListener(e, f);
    return () => {
      for (const [e, f] of on) a.removeEventListener(e, f);
      a.pause();
      if (current === a) current = null;
      a.src = '';
    };
  }, [src]);

  // Atualiza o tempo de forma suave enquanto toca (o timeupdate é espaçado demais).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      if (ref.current) setTime(ref.current.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const toggle = () => {
    const a = ref.current;
    if (!a) return;
    if (a.paused) {
      if (current && current !== a) current.pause();
      current = a;
      void a.play().catch(() => setError(true));
    } else a.pause();
  };
  const seek = (t: number) => {
    const a = ref.current;
    if (!a) return;
    a.currentTime = Math.max(0, t);
    setTime(a.currentTime);
  };
  const cycleRate = () => {
    const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
    if (ref.current) ref.current.playbackRate = next;
    setRate(next);
  };
  return { ref, playing, time, duration, setDuration, rate, error, toggle, seek, cycleRate };
}

function PlayButton({ playing, onClick, disabled }: { playing: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={playing ? 'Pausar' : 'Tocar'}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent transition hover:brightness-110 disabled:opacity-40"
    >
      {playing ? <L.Pause size={16} fill="currentColor" /> : <L.Play size={16} fill="currentColor" className="translate-x-px" />}
    </button>
  );
}

/** Pega a posição (0 a 1) de um clique/arraste dentro do elemento. */
function useScrub(onSeek: (fraction: number) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const at = (x: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || !r.width) return;
    onSeek(Math.min(1, Math.max(0, (x - r.left) / r.width)));
  };
  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    at(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) at(e.clientX);
  };
  return { ref, onPointerDown, onPointerMove };
}

/** Mensagem de voz: botão de play, forma de onda clicável, duração e velocidade. */
export function VoicePlayer({ src }: { src: string }) {
  const a = useAudio(src);
  const [peaks, setPeaks] = useState<number[] | null>(null);

  useEffect(() => {
    let alive = true;
    loadPeaks(src)
      .then((r) => {
        if (!alive) return;
        setPeaks(r.peaks);
        // Gravações do navegador (webm) às vezes não informam a duração.
        if (Number.isFinite(r.duration)) a.setDuration((d) => d || r.duration);
      })
      .catch(() => alive && setPeaks([]));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const progress = a.duration ? a.time / a.duration : 0;
  const scrub = useScrub((f) => a.duration && a.seek(f * a.duration));
  const bars = peaks && peaks.length ? peaks : Array.from({ length: BARS }, () => 0.15);

  return (
    <div className="flex w-[340px] max-w-full items-center gap-3 rounded-full border border-edge bg-raise py-1.5 pr-3 pl-1.5">
      <PlayButton playing={a.playing} onClick={a.toggle} disabled={a.error} />
      <div
        {...scrub}
        className={cx('flex h-8 min-w-0 flex-1 cursor-pointer touch-none items-center gap-[2px]', !peaks && 'animate-pulse')}
        title="Mensagem de voz"
      >
        {bars.map((v, i) => (
          <span
            key={i}
            className={cx('min-w-0 flex-1 rounded-full transition-colors', (i + 0.5) / bars.length <= progress ? 'bg-accent' : 'bg-muted/50')}
            style={{ height: `${Math.max(12, v * 100)}%` }}
          />
        ))}
      </div>
      <span className="w-9 shrink-0 text-right font-mono text-xs text-soft">
        {a.error ? '--:--' : formatClock(a.playing || a.time ? a.time : a.duration)}
      </span>
      <button onClick={a.cycleRate} title="Velocidade" className="w-9 shrink-0 rounded-full bg-hover py-0.5 text-[11px] font-bold text-soft hover:text-fg">
        {String(a.rate).replace('.', ',')}x
      </button>
    </div>
  );
}

/** Arquivo de áudio (mp3, ogg, wav…): nome, play, barra de progresso, tempo, volume e download. */
export function AudioPlayer({ src, filename, size }: { src: string; filename: string; size: string }) {
  const a = useAudio(src);
  const [volume, setVolume] = useState(1);
  const progress = a.duration ? Math.min(1, a.time / a.duration) : 0;
  const scrub = useScrub((f) => a.duration && a.seek(f * a.duration));

  const setVol = (v: number) => {
    setVolume(v);
    if (a.ref.current) a.ref.current.volume = v;
  };

  return (
    <div className="w-[420px] max-w-full rounded-xl border border-edge bg-raise p-3">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
          <L.Music size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <a href={src} target="_blank" rel="noreferrer" className="block truncate font-medium text-fg hover:underline" title={filename}>
            {filename}
          </a>
          <span className="text-xs text-muted">{size}</span>
        </div>
        <a href={src} target="_blank" rel="noreferrer" download={filename} title="Baixar" className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg">
          <L.Download size={18} />
        </a>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <PlayButton playing={a.playing} onClick={a.toggle} disabled={a.error} />
        <span className="w-9 shrink-0 font-mono text-xs text-soft">{formatClock(a.time)}</span>
        <div {...scrub} className="group relative flex h-4 min-w-0 flex-1 cursor-pointer touch-none items-center">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-hover">
            <div className="h-full rounded-full bg-accent" style={{ width: `${progress * 100}%` }} />
          </div>
          <span
            className="absolute h-3 w-3 -translate-x-1/2 rounded-full bg-fg opacity-0 shadow transition-opacity group-hover:opacity-100"
            style={{ left: `${progress * 100}%` }}
          />
        </div>
        <span className="w-9 shrink-0 font-mono text-xs text-muted">{a.error ? '--:--' : formatClock(a.duration)}</span>
        <button onClick={a.cycleRate} title="Velocidade" className="w-9 shrink-0 rounded-full bg-hover py-0.5 text-[11px] font-bold text-soft hover:text-fg">
          {String(a.rate).replace('.', ',')}x
        </button>
        <span className="group/vol relative flex shrink-0 items-center">
          <button onClick={() => setVol(volume ? 0 : 1)} title={volume ? 'Silenciar' : 'Ativar som'} className="text-soft hover:text-fg">
            {volume === 0 ? <L.VolumeX size={18} /> : volume < 0.5 ? <L.Volume1 size={18} /> : <L.Volume2 size={18} />}
          </button>
          <span className="absolute bottom-full left-1/2 hidden -translate-x-1/2 pb-2 group-hover/vol:block">
            <span className="flex h-24 w-8 items-center justify-center rounded-lg border border-edge bg-rail shadow-xl">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                onChange={(e) => setVol(Number(e.target.value))}
                className="w-20 -rotate-90 accent-[var(--color-accent)]"
                aria-label="Volume"
              />
            </span>
          </span>
        </span>
      </div>
      {a.error && <p className="mt-2 text-xs text-danger">Não deu para tocar este áudio aqui. Baixe para ouvir.</p>}
    </div>
  );
}

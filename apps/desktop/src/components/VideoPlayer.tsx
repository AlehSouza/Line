'use client';

import * as L from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cx } from './ui';

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

function formatTime(s: number) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60)
    .toString()
    .padStart(2, '0');
  return h ? `${h}:${m.toString().padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

const speedLabel = (r: number) => (r === 1 ? 'Normal' : `${String(r).replace('.', ',')}x`);

/**
 * Player de vídeo do Line: controles próprios no tema do app (grafite + violeta),
 * com barra de progresso arrastável, volume, tela cheia e menu de opções.
 */
export function VideoPlayer({ src, filename, className }: { src: string; filename?: string; className?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [idle, setIdle] = useState(false);
  const [menu, setMenu] = useState<null | 'main' | 'speed'>(null);
  const [error, setError] = useState(false);

  const pipAvailable = typeof document !== 'undefined' && 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled;

  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) void v.play().catch(() => {});
    else v.pause();
  }, []);

  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration)) return;
    v.currentTime = Math.min(Math.max(t, 0), v.duration);
    setTime(v.currentTime);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void wrapRef.current?.requestFullscreen().catch(() => {});
  }, []);

  const setVol = (val: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = val;
    v.muted = val === 0;
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.muted || v.volume === 0) {
      v.muted = false;
      if (v.volume === 0) v.volume = 0.5;
    } else v.muted = true;
  };

  // Esconde os controles quando o vídeo está rodando e o mouse fica parado.
  const poke = useCallback(() => {
    setIdle(false);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setIdle(true), 2500);
  }, []);
  useEffect(() => () => clearTimeout(hideTimer.current), []);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // Fecha o menu ao clicar fora.
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest('[data-video-menu]')) setMenu(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menu]);

  // Arraste na barra de progresso.
  const timeAt = (clientX: number) => {
    const bar = barRef.current;
    if (!bar || !duration) return 0;
    const r = bar.getBoundingClientRect();
    return (Math.min(Math.max(clientX - r.left, 0), r.width) / r.width) * duration;
  };
  const onBarDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setScrubbing(true);
    seek(timeAt(e.clientX));
  };
  const onBarMove = (e: React.PointerEvent) => {
    const bar = barRef.current;
    if (!bar) return;
    const r = bar.getBoundingClientRect();
    const t = timeAt(e.clientX);
    setHover({ x: Math.min(Math.max(e.clientX - r.left, 0), r.width), t });
    if (scrubbing) seek(t);
  };
  const onBarUp = () => setScrubbing(false);

  const onKey = (e: React.KeyboardEvent) => {
    const v = videoRef.current;
    if (!v) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'k') toggle();
    else if (k === 'arrowright' || k === 'l') seek(v.currentTime + 5);
    else if (k === 'arrowleft' || k === 'j') seek(v.currentTime - 5);
    else if (k === 'arrowup') setVol(Math.min(1, v.volume + 0.1));
    else if (k === 'arrowdown') setVol(Math.max(0, v.volume - 0.1));
    else if (k === 'm') toggleMute();
    else if (k === 'f') toggleFullscreen();
    else if (k === 'escape' && menu) setMenu(null);
    else return;
    e.preventDefault();
    e.stopPropagation();
    poke();
  };

  const togglePip = async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      /* sem suporte */
    }
    setMenu(null);
  };

  const pct = duration ? (time / duration) * 100 : 0;
  const bufPct = duration ? (buffered / duration) * 100 : 0;
  const vol = muted ? 0 : volume;
  const showControls = !playing || !idle || scrubbing || menu !== null;
  const VolIcon = vol === 0 ? L.VolumeX : vol < 0.5 ? L.Volume1 : L.Volume2;

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      onKeyDown={onKey}
      onPointerMove={poke}
      onPointerLeave={() => playing && setIdle(true)}
      className={cx(
        'group/video relative overflow-hidden bg-black outline-none select-none focus-visible:ring-2 focus-visible:ring-accent',
        fullscreen ? 'flex h-full w-full items-center justify-center' : 'rounded-lg border border-edge',
        !showControls && 'cursor-none',
        !fullscreen && className,
      )}
    >
      <video
        ref={videoRef}
        src={src}
        preload="metadata"
        playsInline
        loop={loop}
        onClick={() => {
          if (menu) setMenu(null);
          else toggle();
        }}
        onDoubleClick={toggleFullscreen}
        onPlay={() => {
          setPlaying(true);
          setStarted(true);
          poke();
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => !scrubbing && setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onProgress={(e) => {
          const b = e.currentTarget.buffered;
          if (b.length) setBuffered(b.end(b.length - 1));
        }}
        onVolumeChange={(e) => {
          setVolume(e.currentTarget.volume);
          setMuted(e.currentTarget.muted);
        }}
        onRateChange={(e) => setRate(e.currentTarget.playbackRate)}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onError={() => setError(true)}
        className={cx('block', fullscreen ? 'max-h-full max-w-full' : 'max-h-[inherit] w-full')}
      />

      {/* Botão central grande antes de começar / quando pausado. */}
      {!playing && !error && (
        <button
          onClick={toggle}
          aria-label="Reproduzir"
          className="absolute top-1/2 left-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-accent/90 text-on-accent shadow-lg shadow-black/40 transition hover:scale-105 hover:bg-accent"
        >
          <L.Play size={26} fill="currentColor" className="ml-0.5" />
        </button>
      )}

      {waiting && playing && (
        <span className="pointer-events-none absolute top-1/2 left-1/2 h-10 w-10 -translate-x-1/2 -translate-y-1/2 animate-spin rounded-full border-[3px] border-white/20 border-t-accent" />
      )}

      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-rail/90 text-sm text-muted">
          <L.VideoOff size={28} />
          Não foi possível carregar o vídeo.
        </div>
      )}

      {/* Barra de controles. */}
      <div
        className={cx(
          'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/50 to-transparent px-3 pt-8 pb-2 transition-opacity duration-200',
          showControls && (started || !playing) ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        {/* Progresso */}
        <div
          ref={barRef}
          onPointerDown={onBarDown}
          onPointerMove={onBarMove}
          onPointerUp={onBarUp}
          onPointerCancel={onBarUp}
          onPointerLeave={() => setHover(null)}
          className="group/bar relative flex h-4 cursor-pointer items-center"
        >
          <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/20 transition-[height] group-hover/bar:h-1.5">
            <div className="absolute inset-y-0 left-0 bg-white/30" style={{ width: `${bufPct}%` }} />
            <div className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${pct}%` }} />
          </div>
          <span
            className={cx(
              'pointer-events-none absolute h-3 w-3 -translate-x-1/2 rounded-full bg-white shadow ring-2 ring-accent transition-transform',
              scrubbing ? 'scale-100' : 'scale-0 group-hover/bar:scale-100',
            )}
            style={{ left: `${pct}%` }}
          />
          {hover && duration > 0 && (
            <span
              className="pointer-events-none absolute bottom-5 -translate-x-1/2 rounded-md bg-raise px-1.5 py-0.5 text-[11px] font-semibold text-fg shadow"
              style={{ left: hover.x }}
            >
              {formatTime(hover.t)}
            </span>
          )}
        </div>

        <div className="mt-1 flex items-center gap-1 text-white">
          <CtrlButton label={playing ? 'Pausar (k)' : 'Reproduzir (k)'} onClick={toggle}>
            {playing ? <L.Pause size={18} fill="currentColor" /> : <L.Play size={18} fill="currentColor" />}
          </CtrlButton>

          <div className="group/vol flex items-center">
            <CtrlButton label={vol === 0 ? 'Ativar som (m)' : 'Silenciar (m)'} onClick={toggleMute}>
              <VolIcon size={18} />
            </CtrlButton>
            <div className="w-0 overflow-hidden transition-[width] duration-200 group-hover/vol:w-20 group-focus-within/vol:w-20">
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={vol}
                onChange={(e) => setVol(Number(e.target.value))}
                aria-label="Volume"
                className="line-range mx-1 w-[72px]"
                style={{ '--fill': `${vol * 100}%` } as React.CSSProperties}
              />
            </div>
          </div>

          <span className="ml-1 text-xs font-medium tabular-nums text-white/90">
            {formatTime(time)} <span className="text-white/50">/ {formatTime(duration)}</span>
          </span>

          <div className="flex-1" />

          {rate !== 1 && <span className="rounded bg-accent/25 px-1.5 text-[11px] font-bold text-accent">{speedLabel(rate)}</span>}

          <div className="relative" data-video-menu>
            <CtrlButton label="Opções" onClick={() => setMenu((m) => (m ? null : 'main'))} active={menu !== null}>
              <L.Settings size={18} className={cx('transition-transform', menu && 'rotate-45')} />
            </CtrlButton>
            {menu && (
              <div className="absolute right-0 bottom-10 z-10 w-56 overflow-hidden rounded-lg border border-edge bg-side py-1 text-sm text-fg shadow-xl shadow-black/50">
                {menu === 'main' ? (
                  <>
                    <MenuItem icon={<L.Gauge size={16} />} onClick={() => setMenu('speed')} right={<span className="text-muted">{speedLabel(rate)} ›</span>}>
                      Velocidade
                    </MenuItem>
                    <MenuItem
                      icon={<L.Repeat size={16} />}
                      onClick={() => setLoop((l) => !l)}
                      right={
                        <span className={cx('relative h-4 w-7 rounded-full transition', loop ? 'bg-accent' : 'bg-edge')}>
                          <span className={cx('absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all', loop ? 'left-3.5' : 'left-0.5')} />
                        </span>
                      }
                    >
                      Repetir
                    </MenuItem>
                    {pipAvailable && (
                      <MenuItem icon={<L.PictureInPicture2 size={16} />} onClick={togglePip}>
                        Picture-in-picture
                      </MenuItem>
                    )}
                    <div className="my-1 border-t border-edge" />
                    <MenuItem icon={<L.Download size={16} />} href={src} download={filename ?? true} onClick={() => setMenu(null)}>
                      Baixar
                    </MenuItem>
                    <MenuItem icon={<L.ExternalLink size={16} />} href={src} onClick={() => setMenu(null)}>
                      Abrir em nova aba
                    </MenuItem>
                  </>
                ) : (
                  <>
                    <MenuItem icon={<L.ChevronLeft size={16} />} onClick={() => setMenu('main')}>
                      <span className="font-semibold">Velocidade</span>
                    </MenuItem>
                    <div className="my-1 border-t border-edge" />
                    {SPEEDS.map((s) => (
                      <MenuItem
                        key={s}
                        icon={rate === s ? <L.Check size={16} className="text-accent" /> : <span className="w-4" />}
                        onClick={() => {
                          if (videoRef.current) videoRef.current.playbackRate = s;
                          setMenu(null);
                        }}
                      >
                        <span className={cx(rate === s && 'font-semibold text-accent')}>{speedLabel(s)}</span>
                      </MenuItem>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>

          <CtrlButton label={fullscreen ? 'Sair da tela cheia (f)' : 'Tela cheia (f)'} onClick={toggleFullscreen}>
            {fullscreen ? <L.Minimize size={18} /> : <L.Maximize size={18} />}
          </CtrlButton>
        </div>
      </div>
    </div>
  );
}

function CtrlButton({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cx('flex h-8 w-8 items-center justify-center rounded-md transition hover:bg-white/15 hover:text-white', active ? 'bg-white/15 text-accent' : 'text-white/90')}
    >
      {children}
    </button>
  );
}

function MenuItem({
  icon,
  right,
  onClick,
  href,
  download,
  children,
}: {
  icon: React.ReactNode;
  right?: React.ReactNode;
  onClick?: () => void;
  href?: string;
  download?: string | boolean;
  children: React.ReactNode;
}) {
  const cls = 'flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-accent hover:text-on-accent [&:hover_.text-muted]:text-on-accent/80 [&:hover_.text-accent]:text-on-accent';
  const body = (
    <>
      <span className="flex w-4 shrink-0 justify-center">{icon}</span>
      <span className="flex-1">{children}</span>
      {right}
    </>
  );
  if (href)
    return (
      <a href={href} target="_blank" rel="noreferrer" download={download === true ? '' : download || undefined} onClick={onClick} className={cls}>
        {body}
      </a>
    );
  return (
    <button type="button" onClick={onClick} className={cls}>
      {body}
    </button>
  );
}

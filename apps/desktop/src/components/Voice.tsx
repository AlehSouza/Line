'use client';

import { CallLookAvatar, CallLookLayers, useCallLook } from './CallLook';
import { mobile } from '@/lib/mobile';
import { MobileBack } from './Mobile';

import { CallMusicBar, MusicBotInVoice } from './Music';
import { UserTagBadge } from './ServerTag';
import { useMusic } from '@/lib/music';

import type { Channel, PublicUser, VoiceState } from '@line/shared';
import { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type SyntheticEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { actions, displayNameIn, dmTitle, useLine } from '@/lib/store';
import { StyledName } from '@/lib/nameStyle';
import {
  clearVoiceError,
  type Fps,
  joinVoice,
  leaveVoice,
  listAudioDevices,
  participants,
  type Resolution,
  RESOLUTIONS,
  setInputDevice,
  setNoiseSuppression,
  setOutputDevice,
  setScreenQuality,
  setScreenVolume,
  setWatching,
  requestStageFocus,
  startCamera,
  switchCamera,
  switchScreen,
  currentScreenSource,
  toggleCamera,
  toggleDeafen,
  toggleMute,
  toggleScreen,
  toggleScreenMute,
  useVoice,
} from '@/lib/voice';
import { Avatar, Button, cx, Icons, Modal, Select, Slider, useAvatarTint } from './ui';
import { InviteToVoiceItem, VoiceStatusLine } from './VoiceInvite';
import { Item as MenuItem, Sep as MenuSep, VoiceUserMenu } from './VoiceUserMenu';
import { DeviceMenu } from './UserPanel';
import { SoundboardButton } from './Soundboard';
import { useSounds } from '@/lib/sounds';
import { EMOJI_FONT } from './EmojiPicker';
import { fileUrl } from '@/lib/api';
import { toast } from './Dialogs';
import { hasNativeScreen, listScreenSources, type ScreenSource } from '@/lib/nativeScreen';

/** Ping até o servidor (useline.tech), medido a cada 5 s com uma requisição leve. */
function usePing(active: boolean) {
  const [ms, setMs] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const measure = async () => {
      const t0 = performance.now();
      try {
        await fetch(fileUrl('/api/health'), { cache: 'no-store' });
        if (alive) setMs(Math.round(performance.now() - t0));
      } catch {
        if (alive) setMs(null);
      }
    };
    void measure();
    const t = setInterval(measure, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [active]);
  return ms;
}


// ---------- vídeo ----------

function Video({
  stream,
  mirror,
  contain,
  onAspect,
  detectPause,
}: {
  stream: MediaStream;
  mirror?: boolean;
  contain?: boolean;
  onAspect?: (aspect: number) => void;
  /** Transmissão de tela: mostra "Transmissão pausada" quando a janela de quem transmite é minimizada. */
  detectPause?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const paused = usePausedFrames(ref, !!detectPause);
  // Troquei câmera/tela sem parar: mesmo stream com trilha nova, então reaplica na prévia.
  const rev = useVoice((v) => v.mediaRev);
  const lastRev = useRef(rev);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    else if (lastRev.current !== rev) {
      el.srcObject = null;
      el.srcObject = stream;
    }
    lastRev.current = rev;
  }, [stream, rev]);
  const report = () => {
    const v = ref.current;
    // Quadro minúsculo (janela minimizada do outro lado) não muda o tamanho do quadro.
    if (v && v.videoWidth >= 100 && v.videoHeight >= 100) onAspect?.(v.videoWidth / v.videoHeight);
  };
  return (
    <>
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      onLoadedMetadata={report}
      onResize={report}
      onPlaying={report}
      className={cx('h-full w-full bg-black', contain ? 'object-contain' : 'object-cover', mirror && '-scale-x-100')}
    />
    {paused && <PausedScreen />}
    </>
  );
}

/**
 * Janela minimizada do outro lado: o navegador continua mandando quadros, mas lisos (só cinza ou preto)
 * ou minúsculos. Uma amostra por segundo em 32x18; liso por 3 s seguidos vira "Transmissão pausada".
 */
function usePausedFrames(ref: { current: HTMLVideoElement | null }, on: boolean) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    setPaused(false);
    if (!on) return;
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 18;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    let since: number | null = null;
    const t = setInterval(() => {
      const v = ref.current;
      if (!v || !ctx || v.readyState < 2 || !v.videoWidth) return;
      let flat = v.videoWidth < 100 || v.videoHeight < 100;
      if (!flat) {
        try {
          ctx.drawImage(v, 0, 0, 32, 18);
          const d = ctx.getImageData(0, 0, 32, 18).data;
          const lo = [255, 255, 255];
          const hi = [0, 0, 0];
          for (let i = 0; i < d.length; i += 4) {
            for (let k = 0; k < 3; k++) {
              if (d[i + k] < lo[k]) lo[k] = d[i + k];
              if (d[i + k] > hi[k]) hi[k] = d[i + k];
            }
          }
          flat = hi.every((h, k) => h - lo[k] <= 6);
        } catch {
          return;
        }
      }
      const now = performance.now();
      since = flat ? (since ?? now) : null;
      setPaused(since !== null && now - since >= 3000);
    }, 1000);
    return () => clearInterval(t);
  }, [ref, on]);
  return paused;
}

/** Mesmo visual do quadro "Transmissão pausada" que o app do Windows manda. */
function PausedScreen() {
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] @container">
    <div
      className="flex h-full w-full flex-col items-center justify-center bg-[#0e0e11] text-center"
      style={{ backgroundImage: 'radial-gradient(circle at center, rgba(255,255,255,0.045), rgba(255,255,255,0) 55%)' }}
    >
      <Icons.MonitorPause className="h-[9cqw] w-[9cqw] min-h-8 min-w-8 text-[#e4e4e7]" />
      <p className="mt-[2cqw] text-[max(13px,1.7cqw)] font-medium text-[#e4e4e7]">Transmissão pausada</p>
      <p className="mt-[0.6cqw] text-[max(11px,1.15cqw)] text-[#71717a]">A imagem volta assim que a janela reabrir</p>
    </div>
    </div>
  );
}

interface Tile {
  key: string;
  kind: 'person' | 'screen';
  state: VoiceState;
  user: PublicUser | undefined;
  stream: MediaStream | null;
  isMe: boolean;
}

function useTiles(channelId: string) {
  const states = useVoice((v) => v.states);
  const streams = useVoice((v) => v.streams);
  const camera = useVoice((v) => v.camera);
  const screen = useVoice((v) => v.screen);
  const users = useLine((s) => s.users);
  const meId = useLine((s) => s.me?.id);
  const hiddenVideo = useVoice((v) => v.hiddenVideo);
  const watching = useVoice((v) => v.watching);
  const showNoVideo = useVoice((v) => v.showNoVideo);
  const showMyCamera = useVoice((v) => v.showMyCamera);
  const showMyScreen = useVoice((v) => v.showMyScreen);
  const showUnwatched = useVoice((v) => v.showUnwatched);

  return useMemo(() => {
    const list = participants(states, channelId);
    const tiles: Tile[] = [];
    for (const p of list) {
      const isMe = p.userId === meId;
      // Tela dos outros aparece mesmo antes de eu assistir (com "Assistir transmissão"), a não ser que eu desligue
      // "Mostrar transmissões não assistidas"; a minha some com "Mostrar minha transmissão" desligado.
      const scr = isMe ? screen : p.screenStreamId && watching[p.userId] ? (streams[p.screenStreamId] ?? null) : null;
      if (p.screenStreamId && (isMe ? scr && showMyScreen : watching[p.userId] || showUnwatched)) {
        tiles.push({ key: `screen:${p.userId}`, kind: 'screen', state: p, user: users[p.userId], stream: scr, isMe });
      }
    }
    for (const p of list) {
      const isMe = p.userId === meId;
      const cam = isMe ? camera : p.cameraStreamId && !hiddenVideo[p.userId] ? (streams[p.cameraStreamId] ?? null) : null;
      // "Mostrar Minha Própria Câmera" desligado tira o meu quadro com câmera; "Mostrar participantes sem vídeo" desligado tira quem está sem câmera.
      if (isMe && cam && !showMyCamera) continue;
      if (!cam && !showNoVideo) continue;
      tiles.push({ key: `person:${p.userId}`, kind: 'person', state: p, user: users[p.userId], stream: p.cameraStreamId ? cam : null, isMe });
    }
    return { tiles, count: list.length };
  }, [states, streams, camera, screen, users, meId, channelId, hiddenVideo, watching, showNoVideo, showMyCamera, showMyScreen, showUnwatched]);
}

/** Menu de 3 pontinhos no canto da tela que eu assisto: parar de assistir, silenciar e volume. Só mudam para mim. */
function ScreenMenu({ userId }: { userId: string }) {
  const muted = useVoice((v) => !!v.screenMuted[userId]);
  const volume = useVoice((v) => v.screenVolume[userId] ?? 1);
  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pos) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !btn.current?.contains(t)) setPos(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPos(null);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [pos]);
  const stop = (e: SyntheticEvent) => e.stopPropagation();
  return (
    <div onClick={stop} onContextMenu={stop} onKeyDown={stop}>
      <button
        ref={btn}
        title="Mais opções"
        onClick={() => {
          const r = btn.current?.getBoundingClientRect();
          if (!r) return;
          setPos((p) => (p ? null : { right: window.innerWidth - r.right, bottom: window.innerHeight - r.top + 6 }));
        }}
        className={cx(
          'absolute right-2 bottom-2 z-20 items-center justify-center rounded-full bg-black/70 p-1.5 text-white hover:bg-black/90',
          pos ? 'flex' : 'hidden group-hover:flex',
        )}
      >
        <Icons.More size={18} />
      </button>
      {pos && (
        <div
          ref={box}
          style={pos}
          className="fixed z-50 w-56 cursor-default space-y-0.5 rounded-lg border border-edge bg-rail p-1.5 text-sm shadow-2xl"
        >
          <MenuItem onClick={() => setWatching(userId, false)}>Parar de assistir</MenuItem>
          <MenuItem onClick={() => toggleScreenMute(userId)} check={muted}>
            Silenciar
          </MenuItem>
          <MenuSep />
          <div className="px-2.5 py-1.5">
            <p className="mb-1.5 flex justify-between font-medium text-soft">
              Volume da transmissão
              <span className="text-xs text-muted">{muted ? 0 : Math.round(volume * 100)}%</span>
            </p>
            <Slider value={muted ? 0 : Math.round(volume * 100)} onChange={(v) => setScreenVolume(userId, v / 100)} className="w-full" label="Volume da transmissão" />
          </div>
        </div>
      )}
    </div>
  );
}

/** Ícone de pessoas acima da tela (por fora), no hover: quantos e quem está assistindo agora. */
function ScreenViewers({ userId, serverId }: { userId: string; serverId: string | null }) {
  const ids = useVoice((v) => v.screenViewers[userId]);
  const users = useLine((s) => s.users);
  const members = useLine((s) => (serverId ? s.members[serverId] : undefined));
  const people = (ids ?? []).map((id) => ({
    id,
    name: members?.[id]?.nickname || users[id]?.displayName || 'Alguém',
    user: users[id],
  }));
  return (
    <div className="group/viewers relative">
      <span title="Quem está assistindo" className="flex h-[22px] items-center gap-1 rounded-md bg-black/60 px-1.5 text-xs font-semibold text-white hover:bg-black/80">
        <Icons.Users size={14} /> {people.length}
      </span>
      {/* pt-1.5 faz a ponte até a lista: o mouse passa do ícone para ela sem ela sumir. */}
      <div className="absolute top-full left-0 hidden pt-1.5 group-hover/viewers:block">
      <div className="w-52 rounded-lg border border-edge bg-rail p-1.5 text-sm shadow-2xl">
        <p className="px-1.5 pb-1 text-xs font-bold tracking-wide text-muted uppercase">Assistindo agora</p>
        {people.length === 0 ? (
          <p className="px-1.5 py-1 text-muted">Ninguém assistindo ainda.</p>
        ) : (
          people.map((p) => (
            <div key={p.id} className="flex items-center gap-2 rounded-md px-1.5 py-1">
              <Avatar name={p.name} color={p.user?.avatarColor ?? '#3a3a42'} src={p.user?.avatarUrl} size={22} />
              <span className="truncate text-soft">{p.name}</span>
            </div>
          ))
        )}
      </div>
      </div>
    </div>
  );
}

const ZOOM_MAX = 6;

/**
 * Zoom (roda do mouse ou botões + / −) e arrastar na transmissão de outra pessoa. Só muda para mim.
 * Arrastar com zoom não conta como clique no quadro.
 */
function ZoomBox({ enabled, children, controls }: { enabled: boolean; children: ReactNode; controls: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [z, setZ] = useState({ s: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null);
  const moved = useRef(false);
  const clamp = (s: number, x: number, y: number) => {
    const el = ref.current;
    if (!el || s <= 1.001) return { s: 1, x: 0, y: 0 };
    const mx = (el.clientWidth * (s - 1)) / 2;
    const my = (el.clientHeight * (s - 1)) / 2;
    return { s, x: Math.max(-mx, Math.min(mx, x)), y: Math.max(-my, Math.min(my, y)) };
  };
  // Zoom em direção ao ponto (cx, cy) da tela; sem ponto, no centro.
  const zoomBy = (factor: number, cx?: number, cy?: number) =>
    setZ((p) => {
      const el = ref.current;
      if (!el) return p;
      const s = Math.min(ZOOM_MAX, Math.max(1, p.s * factor));
      const r = el.getBoundingClientRect();
      const ox = cx === undefined ? 0 : cx - r.left - r.width / 2;
      const oy = cy === undefined ? 0 : cy - r.top - r.height / 2;
      const k = s / p.s;
      return clamp(s, ox - (ox - p.x) * k, oy - (oy - p.y) * k);
    });
  const zoomRef = useRef(zoomBy);
  zoomRef.current = zoomBy;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomRef.current(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [enabled]);
  useEffect(() => {
    if (!enabled) setZ({ s: 1, x: 0, y: 0 });
  }, [enabled]);
  const stop = (e: SyntheticEvent) => e.stopPropagation();
  const zoomed = z.s > 1;
  return (
    <div
      ref={ref}
      className={cx('relative h-full w-full overflow-hidden', enabled && zoomed && (dragging ? 'cursor-grabbing' : 'cursor-grab'))}
      onPointerDown={(e) => {
        if (!enabled || !zoomed || e.button !== 0) return;
        drag.current = { px: e.clientX, py: e.clientY, x: z.x, y: z.y, moved: false };
        moved.current = false;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.px;
        const dy = e.clientY - d.py;
        if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = moved.current = true;
        setZ((p) => clamp(p.s, d.x + dx, d.y + dy));
      }}
      onPointerUp={() => {
        drag.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
      onClickCapture={(e) => {
        if (moved.current) {
          moved.current = false;
          e.stopPropagation();
        }
      }}
    >
      <div
        className={cx('h-full w-full', !dragging && 'transition-transform duration-100')}
        style={zoomed ? { transform: `translate(${z.x}px, ${z.y}px) scale(${z.s})` } : undefined}
      >
        {children}
      </div>
      {enabled && (
        <div
          onClick={stop}
          onPointerDown={stop}
          onDoubleClick={stop}
          className={cx('absolute bottom-2 left-1/2 z-20 -translate-x-1/2 items-center gap-0.5 rounded-full bg-black/70 p-1 text-white', controls)}
        >
          <button title="Diminuir zoom" disabled={!zoomed} onClick={() => zoomBy(1 / 1.25)} className="rounded-full p-1 hover:bg-white/15 disabled:opacity-40">
            <Icons.ZoomOut size={16} />
          </button>
          <button
            title="Voltar ao tamanho normal"
            onClick={() => setZ({ s: 1, x: 0, y: 0 })}
            className="min-w-12 rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums hover:bg-white/15"
          >
            {Math.round(z.s * 100)}%
          </button>
          <button title="Aumentar zoom" disabled={z.s >= ZOOM_MAX} onClick={() => zoomBy(1.25)} className="rounded-full p-1 hover:bg-white/15 disabled:opacity-40">
            <Icons.ZoomIn size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Tela cheia total: só a transmissão, por cima de tudo (canais, barra da chamada, barra de título).
 * No app, a janela também entra em tela cheia; na web, usa a tela cheia do navegador. Esc sai.
 */
function StreamFullscreen({ tile, name, onClose }: { tile: Tile; name: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wake = () => {
    setIdle(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), 2500);
  };
  useEffect(() => {
    wake();
    const native = window.line?.window?.setFullscreen;
    if (native) void native(true).catch(() => {});
    else void ref.current?.requestFullscreen?.().catch(() => {});
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    // Na web, o Esc sai da tela cheia do navegador antes de chegar aqui: sai do modo junto.
    const onFs = () => !native && !document.fullscreenElement && close.current();
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFs);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      if (native) void native(false).catch(() => {});
      else if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!tile.stream) return null;
  return createPortal(
    <div
      ref={ref}
      onMouseMove={wake}
      onPointerDown={wake}
      className={cx('fixed inset-0 z-[300] bg-black', idle && 'cursor-none')}
    >
      <ZoomBox enabled={!tile.isMe} controls={idle ? 'hidden' : 'flex'}>
        <Video stream={tile.stream} contain detectPause />
      </ZoomBox>
      <div
        className={cx(
          'absolute top-3 right-3 left-3 z-30 flex items-center justify-between gap-2 transition-opacity duration-200',
          idle ? 'pointer-events-none opacity-0' : 'opacity-100',
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden rounded-md bg-black/60 px-2 py-0.5 text-sm font-medium whitespace-nowrap text-white">
          <Icons.Screen size={14} className="shrink-0" /> <span className="min-w-0 truncate">Tela de {name}</span>
        </span>
        <button
          title="Sair da tela cheia (Esc)"
          onClick={() => close.current()}
          className="flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-sm font-semibold text-white hover:bg-black/90"
        >
          <Icons.ExitFullscreen size={16} /> Sair
        </button>
      </div>
    </div>,
    document.body,
  );
}

function TileView({
  tile,
  big,
  onClick,
  onAspect,
  onFullscreen,
}: {
  tile: Tile;
  big?: boolean;
  onClick?: () => void;
  onAspect?: (aspect: number) => void;
  onFullscreen?: () => void;
}) {
  const speaking = useVoice((v) => !!v.speaking[tile.state.userId]);
  const effect = useSounds((s) => (tile.kind === 'person' ? s.effects[tile.state.userId] : undefined));
  const hidden = useVoice((v) => tile.kind === 'screen' && !tile.isMe && !v.watching[tile.state.userId]);
  const nick = useLine((s) => (tile.state.serverId ? s.members[tile.state.serverId]?.[tile.state.userId]?.nickname : null));
  const name = nick || tile.user?.displayName || 'Alguém';
  // Foto do perfil do servidor por cima da principal, igual ao cartão e à lista de membros.
  const serverAvatar = useLine((s) => (tile.state.serverId ? s.members[tile.state.serverId]?.[tile.state.userId]?.profile?.avatarUrl : null));
  const avatarUrl = serverAvatar || tile.user?.avatarUrl;
  // Só dá para assistir à tela de quem está na mesma chamada que eu.
  const inSameCall = useVoice((v) => !!v.channelId && v.channelId === tile.state.channelId);
  const thumb = useVoice((v) => (tile.kind === 'screen' ? v.screenThumbs[tile.state.userId] : undefined));
  const tint = useAvatarTint(avatarUrl, tile.user?.avatarColor ?? '#3a3a42');
  const look = useCallLook(tile.kind === 'person' ? tile.state.userId : undefined);
  // Clique direito no quadro: o mesmo menu da pessoa na lista do canal de voz.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Tela de alguém da minha chamada: no hover, mostra por fora (acima) quem está assistindo.
  const showViewers = tile.kind === 'screen' && inSameCall;
  return (
    <div className={cx('group/stream relative', big && 'h-full')}>
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ') && onClick?.()}
      className={cx(
        'group relative flex aspect-video w-full cursor-pointer items-center justify-center overflow-hidden rounded-xl transition-colors',
        big && 'aspect-auto h-full',
      )}
      style={{ background: tile.kind === 'screen' ? '#000' : tint }}
    >
      {/* Borda de "falando" desenhada por dentro do tile, para a grade (overflow-hidden) não cortar. Some e aparece suave. */}
      {tile.kind === 'person' && (
        <span
          className={cx(
            'pointer-events-none absolute inset-0 z-10 rounded-xl ring-[3px] ring-inset transition-opacity ease-out',
            effect ? 'ring-[#a855f7]' : 'ring-online',
            speaking || effect ? 'opacity-100 duration-150' : 'opacity-0 duration-500',
          )}
        />
      )}
      {/* Efeito sonoro: o emoji sobe na frente da foto de quem tocou. */}
      {effect && (
        <span
          key={effect.key}
          className="line-sound-rise pointer-events-none absolute z-20 leading-none drop-shadow-lg"
          style={{ fontFamily: EMOJI_FONT, fontSize: big ? 120 : 72 }}
        >
          {effect.emoji}
        </span>
      )}
      {hidden ? (
        <div className="flex flex-col items-center gap-2 text-center">
          {/* Miniatura estática e borrada da tela por trás do botão. */}
          {thumb && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={thumb}
              alt=""
              draggable={false}
              // A miniatura tem a proporção do vídeo: o quadro borrado fica do mesmo tamanho da transmissão.
              onLoad={(e) => {
                const i = e.currentTarget;
                if (i.naturalWidth && i.naturalHeight) onAspect?.(i.naturalWidth / i.naturalHeight);
              }}
              className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover blur-xl"
            />
          )}
          <span className="pointer-events-none absolute inset-0 bg-black/30" />
          <button
            disabled={!inSameCall}
            title={inSameCall ? undefined : 'Entre na chamada para assistir'}
            onClick={(e) => {
              e.stopPropagation();
              if (inSameCall) setWatching(tile.state.userId, true);
            }}
            className="relative flex items-center gap-1.5 rounded-full bg-white/60 px-4 py-1.5 text-sm font-semibold text-[#141418] backdrop-blur-sm transition-colors hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-white/60"
          >
            <Icons.Eye size={14} /> Assistir transmissão
          </button>
          {!inSameCall && big && <p className="relative text-xs text-white/80">Entre na chamada para assistir.</p>}
        </div>
      ) : tile.stream && tile.kind === 'screen' ? (
        <ZoomBox enabled={!!big && !tile.isMe} controls="hidden group-hover:flex">
          <Video stream={tile.stream} contain onAspect={onAspect} detectPause />
        </ZoomBox>
      ) : tile.stream ? (
        <Video
          stream={tile.stream}
          mirror={tile.isMe && tile.kind === 'person'}
          // Em destaque a câmera também mantém a proporção original (sem esticar nem cortar), igual à tela.
          contain={tile.kind === 'screen' || big}
          onAspect={tile.kind === 'screen' ? onAspect : undefined}
        />
      ) : (
        <>
          {tile.kind === 'person' && <CallLookLayers look={look} />}
          <CallLookAvatar look={tile.kind === 'person' ? look : null}>
            <Avatar name={name} color={tile.user?.avatarColor ?? '#3a3a42'} src={avatarUrl} size={big ? 112 : 72} />
          </CallLookAvatar>
        </>
      )}
      <span className="absolute bottom-2 left-2 flex max-w-[calc(100%-3rem)] items-center gap-1.5 overflow-hidden rounded-md bg-black/60 px-2 py-0.5 whitespace-nowrap text-sm font-medium">
        {tile.kind === 'screen' && <Icons.Screen size={14} className="shrink-0" />}
        <span className="min-w-0 truncate">
          {tile.kind === 'screen' ? `Tela de ${name}` : <StyledName user={tile.user}>{name}</StyledName>}
        </span>
        {tile.kind === 'person' && tile.state.deafened ? (
          <Icons.HeadphonesOff size={14} className="shrink-0 text-danger" />
        ) : tile.kind === 'person' && tile.state.muted ? (
          <Icons.MicOff size={14} className="shrink-0 text-danger" />
        ) : null}
      </span>
      {tile.kind === 'screen' && !tile.isMe && !hidden && <ScreenMenu userId={tile.state.userId} />}
      {menu && (
        // O menu fica dentro do quadro no React: barra o clique para não focar/desfocar o quadro.
        <div onClick={(e) => e.stopPropagation()}>
          <VoiceUserMenu
            userId={tile.state.userId}
            channelId={tile.state.channelId}
            screen={tile.kind === 'screen'}
            x={menu.x}
            y={menu.y}
            onClose={() => setMenu(null)}
          />
        </div>
      )}
    </div>
    {/* Linha de ações no canto: quem assiste, tela cheia, destacar e sair da transmissão. */}
    {showViewers && (
      <div className="absolute top-2 left-2 z-30 hidden text-white group-hover/stream:block">
        <ScreenViewers userId={tile.state.userId} serverId={tile.state.serverId ?? null} />
      </div>
    )}
    <div className="absolute top-2 right-2 z-30 hidden items-center gap-1 text-white group-hover/stream:flex">
      {onFullscreen && tile.kind === 'screen' && tile.stream && !hidden && (
        <button title="Tela cheia (só a transmissão)" onClick={onFullscreen} className="rounded-md bg-black/60 p-1 hover:bg-black/80">
          <Icons.Fullscreen size={14} />
        </button>
      )}
      {onClick && (
        <button title={big ? 'Sair do destaque' : 'Destacar'} onClick={onClick} className="rounded-md bg-black/60 p-1 hover:bg-black/80">
          {big ? <Icons.Shrink size={14} /> : <Icons.Expand size={14} />}
        </button>
      )}
      {tile.kind === 'screen' && !tile.isMe && !hidden && (
        <button title="Sair da transmissão" onClick={() => setWatching(tile.state.userId, false)} className="rounded-md bg-black/60 p-1 hover:bg-black/80">
          <Icons.MonitorX size={14} />
        </button>
      )}
    </div>
    </div>
  );
}

// ---------- palco da chamada ----------

/** Área principal de um canal de voz (ou o topo de uma DM em chamada). */
const GAP = 12;

/** Quadros 16:9 centralizados e do maior tamanho que cabe no espaço, sem barra de rolagem. */
function TileGrid({ tiles, onFocus }: { tiles: Tile[]; onFocus: (key: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Testa cada número de colunas e fica com o que deixa os quadros maiores.
  const n = Math.max(1, tiles.length);
  let width = 0;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const byW = (box.w - GAP * (cols - 1)) / cols;
    const byH = ((box.h - GAP * (rows - 1)) / rows) * (16 / 9);
    width = Math.max(width, Math.min(byW, byH));
  }
  width = Math.floor(Math.min(width, 960));

  return (
    // Sem overflow-hidden: o ícone de quem assiste fica por fora, acima da tela.
    <div ref={ref} className="flex min-h-0 flex-1 flex-wrap content-center items-center justify-center" style={{ gap: GAP }}>
      {width > 0 &&
        tiles.map((t) => (
          <div key={t.key} style={{ width }}>
            <TileView tile={t} onClick={() => onFocus(t.key)} />
          </div>
        ))}
    </div>
  );
}

/** Fileira embaixo do destaque: mostra só os quadros que cabem; o resto vira um quadrado "+N" que volta para a grade. */
function TileStrip({ tiles, onFocus, onShowAll }: { tiles: Tile[]; onFocus: (key: string) => void; onShowAll: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 112; // h-28
  const tileW = (H * 16) / 9;
  const fit = Math.max(1, Math.floor((w + GAP) / (tileW + GAP)));
  const overflow = tiles.length > fit;
  const shown = overflow ? tiles.slice(0, fit - 1) : tiles;
  const rest = tiles.length - shown.length;

  return (
    <div ref={ref} className="flex h-28 shrink-0 justify-center" style={{ gap: GAP }}>
      {w > 0 &&
        shown.map((t) => (
          <div key={t.key} className="h-full shrink-0" style={{ aspectRatio: '16 / 9' }}>
            <TileView tile={t} onClick={() => onFocus(t.key)} />
          </div>
        ))}
      {w > 0 && overflow && (
        <button
          onClick={onShowAll}
          title="Ver todos"
          className="flex h-full shrink-0 items-center justify-center rounded-xl bg-raise text-2xl font-bold text-soft transition-colors hover:bg-hover hover:text-fg"
          style={{ aspectRatio: shown.length ? '1 / 1' : '16 / 9' }}
        >
          +{rest}
        </button>
      )}
    </div>
  );
}

/** Quadro em destaque: com a proporção do vídeo conhecida, encolhe até o tamanho do vídeo (sem faixas pretas). */
function FitBox({ aspect, children, className }: { aspect: number | null; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  let size: { width: number | string; height: number | string } = { width: '100%', height: '100%' };
  if (aspect && box.w && box.h) {
    const width = Math.min(box.w, box.h * aspect);
    size = { width: Math.floor(width), height: Math.floor(width / aspect) };
  }
  return (
    <div ref={ref} className={cx('flex min-h-0 flex-1 items-center justify-center', className)}>
      <div style={size}>{children}</div>
    </div>
  );
}

export function VoiceStage({ channel, compact }: { channel: Channel; compact?: boolean }) {
  const inCall = useVoice((v) => v.channelId === channel.id);
  const connecting = useVoice((v) => v.connecting && v.channelId === channel.id);
  const error = useVoice((v) => v.error);
  const { tiles, count } = useTiles(channel.id);
  const [focus, setFocus] = useState<string | null>(null);
  const [emptyMenu, setEmptyMenu] = useState<{ x: number; y: number } | null>(null);
  const meId = useLine((s) => s.me?.id);
  const users = useLine((s) => s.users);
  const title = channel.serverId ? channel.name : dmTitle(channel, meId, users);

  // Foca automaticamente numa tela compartilhada nova.
  const firstScreen = tiles.find((t) => t.kind === 'screen')?.key ?? null;
  useEffect(() => {
    if (firstScreen) setFocus((f) => f ?? firstScreen);
  }, [firstScreen]);
  // Veio do mini player: abre com aquela tela em destaque.
  const stageFocus = useVoice((v) => v.stageFocus);
  useEffect(() => {
    if (!stageFocus) return;
    setFocus(stageFocus);
    requestStageFocus(null);
  }, [stageFocus]);
  const focused = tiles.find((t) => t.key === focus);
  // Tela cheia total de uma transmissão (some quando ela acaba).
  const [full, setFull] = useState<string | null>(null);
  const fullTile = tiles.find((t) => t.key === full && t.kind === 'screen' && t.stream);
  const fullNick = useLine((s) => (fullTile?.state.serverId ? s.members[fullTile.state.serverId]?.[fullTile.state.userId]?.nickname : null));
  const [aspect, setAspect] = useState<number | null>(null);
  useEffect(() => setAspect(null), [focus]);
  const others = focused ? tiles.filter((t) => t !== focused) : tiles;

  // Canal vazio: tela de espera colorida, com o convite para entrar no centro.
  if (count === 0 && !inCall) {
    return (
      <div
        className={cx('relative flex flex-col overflow-hidden', compact ? 'h-[45%] min-h-64 border-b border-edge' : 'min-h-0 flex-1')}
        style={{
          background:
            'radial-gradient(120% 80% at 50% 110%, color-mix(in srgb, var(--color-accent) 70%, transparent) 0%, color-mix(in srgb, var(--color-accent) 25%, transparent) 45%, transparent 75%), linear-gradient(to bottom, var(--color-rail), color-mix(in srgb, var(--color-accent) 18%, var(--color-rail)))',
        }}
      >
        {!compact && (
          <header className="flex h-12 shrink-0 items-center gap-2 px-4">
            <MobileBack />
            <Icons.Speaker size={20} className="text-soft" />
            <h1 className="font-bold">{title}</h1>
            {channel.topic && (
              <>
                <span className="mx-2 h-6 w-px bg-edge max-md:hidden" />
                <p className="truncate text-sm text-muted max-md:hidden">{channel.topic}</p>
              </>
            )}
          </header>
        )}
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <h2 className="text-3xl font-bold text-white drop-shadow">{title}</h2>
          <p className="text-soft">Ninguém está em voz no momento.</p>
          <button
            disabled={connecting}
            onClick={() => joinVoice(channel.id)}
            className="mt-4 rounded-full bg-white px-6 py-2.5 text-sm font-semibold text-[#141418] shadow-lg transition hover:scale-[1.03] hover:bg-white/90 disabled:opacity-60"
          >
            {connecting ? 'Conectando…' : 'Entrar na chamada de voz'}
          </button>
          {error && (
            <p className="mt-3 flex items-center gap-2 rounded-lg bg-danger/15 px-3 py-1.5 text-sm text-danger">
              {error}
              <button onClick={clearVoiceError} className="hover:text-fg">
                <Icons.X size={14} />
              </button>
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={cx('flex flex-col bg-rail', compact ? 'h-[45%] min-h-64 border-b border-edge' : 'min-h-0 flex-1')}>
      {fullTile && (
        <StreamFullscreen
          key={fullTile.key}
          tile={fullTile}
          name={fullNick || fullTile.user?.displayName || 'Alguém'}
          onClose={() => setFull(null)}
        />
      )}
      {!compact && (
        <header className="relative flex h-12 shrink-0 items-center gap-2 px-4">
          <MobileBack />
          <Icons.Speaker size={20} className="text-muted" />
          <h1 className="font-bold">{title}</h1>
          {channel.topic && (
            <>
              <span className="mx-2 h-6 w-px bg-edge max-md:hidden" />
              <p className="truncate text-sm text-muted max-md:hidden">{channel.topic}</p>
            </>
          )}
          <CallMusicBar channelId={channel.id} />
        </header>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 max-md:p-2">
        {count === 0 && !inCall ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-raise text-accent">
              <Icons.Speaker size={40} />
            </div>
            <h2 className="text-2xl font-bold">{title}</h2>
            <p className="text-muted">Ninguém por aqui ainda. Entre e chame a galera.</p>
          </div>
        ) : focused ? (
          <>
            {/* Tela em destaque: espaço acima para o ícone de quem está assistindo. */}
            {/* Antes de saber a proporção da tela (aberta pelo chat, sem miniatura), usa 16:9 em vez de ocupar a largura toda. */}
            {/* Pessoa em destaque: sempre 16:9, com ou sem câmera, para o quadro não mudar de tamanho. */}
            <FitBox aspect={focused.kind === 'screen' ? (aspect ?? 16 / 9) : 16 / 9} >
              <TileView tile={focused} big onClick={() => setFocus(null)} onAspect={setAspect} onFullscreen={() => setFull(focused.key)} />
            </FitBox>
            {others.length > 0 && <TileStrip tiles={others} onFocus={setFocus} onShowAll={() => setFocus(null)} />}
          </>
        ) : others.length === 0 && count > 0 ? (
          <div
            className="flex flex-1 items-center justify-center text-center text-sm text-muted"
            onContextMenu={(e) => {
              e.preventDefault();
              if (meId) setEmptyMenu({ x: e.clientX, y: e.clientY });
            }}
          >
            Ninguém com vídeo agora. Clique com o direito aqui para mostrar quem está sem vídeo.
            {emptyMenu && meId && (
              <VoiceUserMenu userId={meId} channelId={channel.id} x={emptyMenu.x} y={emptyMenu.y} onClose={() => setEmptyMenu(null)} />
            )}
          </div>
        ) : (
          <TileGrid tiles={others} onFocus={setFocus} />
        )}

        {error && (
          <p className="mx-auto flex items-center gap-2 rounded-lg bg-danger/15 px-3 py-1.5 text-sm text-danger">
            {error}
            <button onClick={clearVoiceError} className="hover:text-fg">
              <Icons.X size={14} />
            </button>
          </p>
        )}

        <div className="flex shrink-0 justify-center pb-6 max-md:pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {inCall ? (
            <VoiceControls large />
          ) : (
            <Button
              disabled={connecting}
              onClick={() => joinVoice(channel.id)}
              className="bg-online px-6 py-2.5 text-white hover:bg-online hover:brightness-110"
            >
              <Icons.Phone size={18} />
              {connecting ? 'Conectando…' : count > 0 ? 'Entrar na chamada' : 'Entrar no canal de voz'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- mini player ----------

/**
 * Assistindo a uma transmissão e fui para outro canal: a tela continua num quadro pequeno no canto
 * superior direito. Clicar volta para o canal de voz com ela em destaque.
 */
export function MiniStream({ viewingChannelId }: { viewingChannelId: string | null }) {
  const myChannel = useVoice((v) => (v.connecting ? null : v.channelId));
  const watching = useVoice((v) => v.watching);
  const states = useVoice((v) => v.states);
  const streams = useVoice((v) => v.streams);
  const users = useLine((s) => s.users);
  const [closed, setClosed] = useState<string | null>(null);
  if (!myChannel || viewingChannelId === myChannel) return null;
  const target = Object.keys(watching).find((uid) => {
    const st = states[uid];
    return watching[uid] && st?.channelId === myChannel && st.screenStreamId && streams[st.screenStreamId];
  });
  if (!target) return null;
  const state = states[target]!;
  const stream = streams[state.screenStreamId!]!;
  // Fechei este mini player: só volta numa transmissão nova.
  if (closed === state.screenStreamId) return null;
  const name = displayNameIn(useLine.getState(), state.serverId, target) || users[target]?.displayName || 'alguém';
  const open = () => {
    requestStageFocus(`screen:${target}`);
    if (state.serverId) actions.goServer(state.serverId, state.channelId);
    else actions.goHome(state.channelId);
  };
  return (
    <FloatingCorner onClick={open} title="Voltar para a transmissão (arraste para mudar de lugar)">
      <Video stream={stream} contain detectPause />
      <span className="absolute bottom-2 left-2 flex max-w-[calc(100%-3rem)] items-center gap-1.5 overflow-hidden rounded-md bg-black/60 px-2 py-0.5 whitespace-nowrap text-xs font-medium text-white">
        <Icons.Screen size={12} className="shrink-0" /> <span className="min-w-0 truncate">Tela de {name}</span>
      </span>
      <button
        title="Fechar"
        onClick={(e) => {
          e.stopPropagation();
          setClosed(state.screenStreamId ?? null);
        }}
        className="absolute top-2 right-2 hidden rounded-md bg-black/60 p-1 text-white hover:bg-black/80 group-hover:block"
      >
        <Icons.X size={14} />
      </button>
    </FloatingCorner>
  );
}

/** Lado da área central em que o quadro fica grudado e onde nele (0 = começo, 1 = fim). */
type Spot = { edge: 'l' | 'r' | 't' | 'b'; at: number };
const SPOT_KEY = 'line.miniStream.spot';
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function spotXY(spot: Spot, b: ReturnType<typeof floatBounds>) {
  const along = (min: number, max: number) => min + spot.at * Math.max(0, max - min);
  if (spot.edge === 'l') return { x: b.minX, y: along(b.minY, b.maxY) };
  if (spot.edge === 'r') return { x: b.maxX, y: along(b.minY, b.maxY) };
  if (spot.edge === 't') return { x: along(b.minX, b.maxX), y: b.minY };
  return { x: along(b.minX, b.maxX), y: b.maxY };
}

/** Solto em qualquer lugar: gruda na borda mais perto (nunca fica no meio). */
function nearestSpot(x: number, y: number, b: ReturnType<typeof floatBounds>): Spot {
  const d = { l: x - b.minX, r: b.maxX - x, t: y - b.minY, b: b.maxY - y };
  const edge = (Object.keys(d) as Spot['edge'][]).reduce((a, k) => (d[k] < d[a] ? k : a), 'r');
  const ratio = (v: number, min: number, max: number) => (max > min ? clamp01((v - min) / (max - min)) : 0);
  return { edge, at: edge === 'l' || edge === 'r' ? ratio(y, b.minY, b.maxY) : ratio(x, b.minX, b.maxX) };
}
const EDGE = 16;
const TOP = 64; // abaixo do cabeçalho do canal

/** Onde o quadro pode ir sem cobrir a caixa de texto do canal (se houver). */
function floatBounds(box: HTMLElement) {
  const parent = box.offsetParent as HTMLElement | null;
  const pr = parent?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  let bottom = pr.height - EDGE;
  const composer = parent?.querySelector<HTMLElement>('textarea[data-composer]');
  if (composer) {
    // Sobe até o bloco inteiro da caixa (anexos, respostas, barra de digitando).
    const block = (composer.closest('form') as HTMLElement | null) ?? composer.parentElement ?? composer;
    bottom = Math.min(bottom, block.getBoundingClientRect().top - pr.top - EDGE);
  }
  const w = box.offsetWidth;
  const h = box.offsetHeight;
  return { minX: EDGE, maxX: pr.width - w - EDGE, minY: TOP, maxY: Math.max(TOP, bottom - h) };
}

/**
 * Quadro flutuante que se arrasta e gruda na borda mais perto da área central (laterais, topo ou base), sem tampar a
 * caixa de texto. Um clique sem arrastar chama onClick.
 */
function FloatingCorner({ children, onClick, title }: { children: ReactNode; onClick: () => void; title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<Spot>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(SPOT_KEY) ?? 'null') as Spot | null;
      if (v && ['l', 'r', 't', 'b'].includes(v.edge) && typeof v.at === 'number') return { edge: v.edge, at: clamp01(v.at) };
    } catch {
      // começa no canto de cima, à direita
    }
    return { edge: 'r', at: 0 };
  });
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const moved = useRef(false);

  // Recalcula a posição quando a área muda (janela, caixa de texto crescendo, troca de canal).
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const place = () => {
      const b = floatBounds(box);
      const { x, y } = spotXY(spot, b);
      setPos((p) => (p && p.x === x && p.y === y ? p : { x, y }));
    };
    place();
    const parent = box.offsetParent as HTMLElement | null;
    const ro = new ResizeObserver(place);
    if (parent) ro.observe(parent);
    const composer = parent?.querySelector('textarea[data-composer]');
    if (composer) ro.observe(composer);
    const mo = parent ? new MutationObserver(place) : null;
    if (parent) mo!.observe(parent, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo?.disconnect();
    };
  }, [spot]);

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !pos) return;
    if ((e.target as HTMLElement).closest('button')) return;
    moved.current = false;
    const start = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y };
    const box = ref.current!;
    box.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.px;
      const dy = ev.clientY - start.py;
      if (!moved.current && Math.hypot(dx, dy) < 5) return;
      moved.current = true;
      const b = floatBounds(box);
      setDrag({ x: Math.min(Math.max(start.x + dx, b.minX), b.maxX), y: Math.min(Math.max(start.y + dy, b.minY), b.maxY) });
    };
    const up = (ev: PointerEvent) => {
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', up);
      box.removeEventListener('pointercancel', up);
      if (!moved.current) return;
      const b = floatBounds(box);
      const x = start.x + ev.clientX - start.px;
      const y = start.y + ev.clientY - start.py;
      const next = nearestSpot(Math.min(Math.max(x, b.minX), b.maxX), Math.min(Math.max(y, b.minY), b.maxY), b);
      setDrag(null);
      setSpot(next);
      setPos(spotXY(next, b));
      try {
        localStorage.setItem(SPOT_KEY, JSON.stringify(next));
      } catch {
        // só não lembra onde ficou
      }
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', up);
  };

  const at = drag ?? pos;
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      title={title}
      onPointerDown={down}
      onClick={() => {
        if (moved.current) {
          moved.current = false;
          return;
        }
        onClick();
      }}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onClick()}
      style={at ? { left: at.x, top: at.y } : { right: EDGE, top: TOP, visibility: 'hidden' }}
      className={cx(
        'group absolute z-30 aspect-video w-80 cursor-pointer touch-none overflow-hidden rounded-xl border border-edge bg-black shadow-2xl select-none max-md:hidden',
        drag ? 'cursor-grabbing' : 'transition-[left,top] duration-200 ease-out',
      )}
    >
      {children}
    </div>
  );
}

// ---------- controles ----------

export function VoiceControls({ large }: { large?: boolean }) {
  const muted = useVoice((v) => v.muted);
  const deafened = useVoice((v) => v.deafened);
  const camera = useVoice((v) => !!v.camera);
  const screen = useVoice((v) => !!v.screen);
  const [picker, setPicker] = useState<false | 'start' | 'switch'>(false);
  const [camPicker, setCamPicker] = useState(false);

  const [devMenu, setDevMenu] = useState<'input' | 'output' | 'camera' | null>(null);
  const size = large ? 22 : 18;

  const shareScreen = () => (screen ? void toggleScreen() : setPicker('start'));
  const camClick = () => (camera ? void toggleCamera() : setCamPicker(true));
  const modals = (
    <>
      {camPicker && <CameraModal onClose={() => setCamPicker(false)} />}
      {picker && <ScreenShareModal switching={picker === 'switch' && screen} onClose={() => setPicker(false)} />}
    </>
  );

  if (large) {
    // Dentro da chamada: grupos separados (mic + fone, câmera + tela) e o desligar sozinho à direita.
    const group = 'relative flex items-center gap-0.5 rounded-xl border border-edge bg-rail/90 p-1 shadow-lg';
    // No celular: sem as setinhas de dispositivo (o sistema escolhe) e botões um pouco menores para caber.
    const key = (state: 'off' | 'on' | 'danger') =>
      cx(
        'flex h-11 w-11 items-center justify-center rounded-lg transition-colors max-md:h-10 max-md:w-10',
        state === 'danger' ? 'bg-danger/15 text-danger hover:bg-danger/25' : state === 'on' ? 'bg-fg text-rail' : 'text-fg hover:bg-hover',
      );
    const arrow = (danger: boolean, open: boolean) =>
      cx(
        'flex h-11 w-6 items-center justify-center rounded-lg transition-colors max-md:hidden',
        danger ? 'bg-danger/15 text-danger hover:bg-danger/25' : 'text-muted hover:bg-hover hover:text-fg',
        open && 'bg-hover',
      );
    const toggleMenu = (k: 'input' | 'output' | 'camera') => setDevMenu((m) => (m === k ? null : k));
    return (
      <div className="flex items-center gap-3 max-md:gap-2">
        <div className={group}>
          <button title={muted ? 'Ativar microfone' : 'Silenciar microfone'} onClick={toggleMute} className={key(muted ? 'danger' : 'off')}>
            {muted ? <Icons.MicOff size={size} /> : <Icons.Mic size={size} />}
          </button>
          <button title="Escolher microfone" onClick={() => toggleMenu('input')} className={arrow(muted, devMenu === 'input')}>
            <Icons.Chevron size={14} />
          </button>
          <span className="mx-1 h-6 w-px bg-edge max-md:mx-0.5" />
          <button title={deafened ? 'Voltar a ouvir' : 'Ensurdecer'} onClick={toggleDeafen} className={key(deafened ? 'danger' : 'off')}>
            {deafened ? <Icons.HeadphonesOff size={size} /> : <Icons.Headphones size={size} />}
          </button>
          <button title="Escolher saída de áudio" onClick={() => toggleMenu('output')} className={arrow(deafened, devMenu === 'output')}>
            <Icons.Chevron size={14} />
          </button>
          {devMenu && devMenu !== 'camera' && <DeviceMenu kind={devMenu} onClose={() => setDevMenu(null)} className="left-0 w-64" />}
        </div>
        <div className={group}>
          <button title={camera ? 'Desligar câmera' : 'Ligar câmera'} onClick={camClick} className={key(camera ? 'on' : 'off')}>
            {camera ? <Icons.Video size={size} /> : <Icons.VideoOff size={size} />}
          </button>
          <button title="Escolher câmera" onClick={() => toggleMenu('camera')} className={arrow(false, devMenu === 'camera')}>
            <Icons.Chevron size={14} />
          </button>
          <span className="mx-1 h-6 w-px bg-edge max-md:mx-0.5" />
          <button title={screen ? 'Parar de compartilhar' : 'Compartilhar tela'} onClick={shareScreen} className={key(screen ? 'danger' : 'off')}>
            {screen ? <Icons.MonitorX size={size} /> : <Icons.Screen size={size} />}
          </button>
          <button
            title={screen ? 'Trocar tela ou janela' : 'Escolher tela'}
            onClick={() => {
              setDevMenu(null);
              setPicker(screen ? 'switch' : 'start');
            }}
            className={arrow(false, !!picker)}
          >
            <Icons.Chevron size={14} />
          </button>
          <span className="mx-1 h-6 w-px bg-edge max-md:mx-0.5" />
          <SoundboardButton className={key('off')} size={size} />
          {devMenu === 'camera' && (
            <CameraMenu
              onClose={() => setDevMenu(null)}
              onOpenModal={() => {
                setDevMenu(null);
                setCamPicker(true);
              }}
            />
          )}
        </div>
        <button
          title="Sair da chamada"
          onClick={() => leaveVoice()}
          className="flex h-[54px] items-center justify-center rounded-xl bg-danger px-7 text-white shadow-lg transition hover:brightness-110 max-md:h-[50px] max-md:px-5"
        >
          <Icons.PhoneOff size={size} />
        </button>
        {modals}
      </div>
    );
  }

  const btn = (active: boolean, danger = false) =>
    cx(
      'flex items-center justify-center rounded-full transition-colors',
      large ? 'h-12 w-12' : 'h-8 w-8 rounded-md',
      danger ? 'bg-danger text-white hover:brightness-110' : active ? 'bg-fg text-rail' : large ? 'bg-raise text-fg hover:bg-hover' : 'text-soft hover:bg-hover hover:text-fg',
    );

  return (
    <div className={cx('flex items-center', large ? 'gap-3 rounded-2xl bg-side/80 p-2' : 'gap-1')}>
      <button title={muted ? 'Ativar microfone' : 'Silenciar microfone'} onClick={toggleMute} className={btn(false, muted && large)}>
        {muted ? <Icons.MicOff size={size} className={large ? '' : 'text-danger'} /> : <Icons.Mic size={size} />}
      </button>
      <button title={deafened ? 'Voltar a ouvir' : 'Ensurdecer'} onClick={toggleDeafen} className={btn(false, deafened && large)}>
        {deafened ? <Icons.HeadphonesOff size={size} className={large ? '' : 'text-danger'} /> : <Icons.Headphones size={size} />}
      </button>
      <button title={camera ? 'Desligar câmera' : 'Ligar câmera'} onClick={camClick} className={btn(camera)}>
        {camera ? <Icons.Video size={size} /> : <Icons.VideoOff size={size} />}
      </button>
      <button title={screen ? 'Parar de compartilhar' : 'Compartilhar tela'} onClick={shareScreen} className={btn(false, screen)}>
        {screen ? <Icons.MonitorX size={size} /> : <Icons.Screen size={size} />}
      </button>
      <button title="Sair da chamada" onClick={() => leaveVoice()} className={btn(false, true)}>
        <Icons.PhoneOff size={size} />
      </button>
      {modals}
    </div>
  );
}

// ---------- transmitir tela: qualidade ----------

/** Escolhe resolução e fps antes de abrir o seletor de tela do sistema. */
const CAMERA_KEY = 'line.cameraId';

/** Escolher a câmera com prévia ao vivo antes de entrar na chamada. Fechar sem confirmar solta a câmera. */
export function CameraModal({ onClose }: { onClose: () => void }) {
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>(() => {
    try {
      return localStorage.getItem(CAMERA_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState('');
  const handed = useRef(false);
  const current = useRef<MediaStream | null>(null);

  useEffect(() => {
    let alive = true;
    setError('');
    navigator.mediaDevices
      .getUserMedia({
        video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false,
      })
      .then(async (s) => {
        if (!alive) return s.getTracks().forEach((t) => t.stop());
        current.current?.getTracks().forEach((t) => t.stop());
        current.current = s;
        setStream(s);
        // Os nomes das câmeras só aparecem depois da permissão.
        const all = await navigator.mediaDevices.enumerateDevices();
        if (alive) setCameras(all.filter((d) => d.kind === 'videoinput'));
      })
      .catch((err) => {
        if (!alive) return;
        if (deviceId) setDeviceId('');
        else setError((err as Error).name === 'NotAllowedError' ? 'Sem permissão para usar a câmera.' : 'Nenhuma câmera encontrada.');
      });
    return () => {
      alive = false;
    };
  }, [deviceId]);

  // Fechou sem confirmar: solta a câmera.
  useEffect(
    () => () => {
      if (!handed.current) current.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const activeId = stream?.getVideoTracks()[0]?.getSettings().deviceId ?? deviceId;
  const confirm = () => {
    if (!stream) return;
    handed.current = true;
    try {
      localStorage.setItem(CAMERA_KEY, activeId);
    } catch {}
    startCamera(stream);
    onClose();
  };

  return (
    <Modal
      title="Transmitir câmera"
      subtitle="Confira como você vai aparecer antes de entrar."
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={confirm} disabled={!stream}>
            <Icons.Video size={16} /> Ligar câmera
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-black">
          {stream ? <Video stream={stream} mirror /> : <p className="text-sm text-muted">{error || 'Abrindo a câmera…'}</p>}
        </div>
        {cameras.length > 0 && (
          <div>
            <span className="mb-1.5 block text-xs font-bold tracking-wide text-muted uppercase">Câmera</span>
            <Select
              value={activeId}
              onChange={setDeviceId}
              options={cameras.map((c, i) => ({ value: c.deviceId, label: c.label || `Câmera ${i + 1}` }))}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Seta da câmera: lista as câmeras. Ligada, troca na hora; desligada, abre a prévia com a escolhida. */
function CameraMenu({ onClose, onOpenModal }: { onClose: () => void; onOpenModal: () => void }) {
  const camera = useVoice((v) => v.camera);
  useVoice((v) => v.mediaRev);
  const [list, setList] = useState<MediaDeviceInfo[] | null>(null);
  useEffect(() => {
    navigator.mediaDevices
      .enumerateDevices()
      .then((all) => setList(all.filter((d) => d.kind === 'videoinput')))
      .catch(() => setList([]));
  }, []);
  let saved = '';
  try {
    saved = localStorage.getItem(CAMERA_KEY) ?? '';
  } catch {}
  const current = camera?.getVideoTracks()[0]?.getSettings().deviceId ?? saved;
  const pick = (id: string) => {
    try {
      localStorage.setItem(CAMERA_KEY, id);
    } catch {}
    if (camera) {
      onClose();
      if (id !== current) void switchCamera(id);
    } else onOpenModal();
  };
  const item = (active: boolean) =>
    cx('flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-hover', active && 'text-accent');
  return (
    <div className="absolute bottom-full left-0 z-30 mb-2 w-64 rounded-lg border border-edge bg-rail p-1.5 shadow-xl" onMouseLeave={onClose}>
      <p className="px-2.5 pt-1 pb-1.5 text-[11px] font-bold tracking-wide text-muted uppercase">Câmera</p>
      {list === null ? (
        <p className="px-2.5 py-1.5 text-sm text-muted">Procurando câmeras…</p>
      ) : list.length === 0 ? (
        <p className="px-2.5 py-1.5 text-sm text-muted">Nenhuma câmera encontrada.</p>
      ) : (
        list.map((d, i) => (
          <button key={d.deviceId || i} onClick={() => pick(d.deviceId)} className={item(current === d.deviceId)}>
            <span className="flex-1 truncate">{d.label || `Câmera ${i + 1}`}</span>
            {current === d.deviceId && <Icons.Check size={14} />}
          </button>
        ))
      )}
    </div>
  );
}

export function ScreenShareModal({
  onClose,
  switching = false,
  preselect,
  preselectName,
}: {
  onClose: () => void;
  switching?: boolean;
  /** Janela que já vem marcada (ex.: o jogo aberto, pelo cartão do painel). */
  preselect?: string;
  /** Nome do que vem marcado (o jogo), para avisar se a janela não aparecer na lista. */
  preselectName?: string;
}) {
  const quality = useVoice((v) => v.screenQuality);
  const [resolution, setResolution] = useState<Resolution>(quality.resolution);
  const [fps, setFps] = useState<Fps>(quality.fps);
  // App do Windows: seletor próprio com janelas e telas. Web/macOS/Linux: o do navegador.
  const native = useMemo(() => hasNativeScreen(), []);
  // Trocando: já abre com o que está sendo transmitido marcado.
  const [current] = useState(() => (switching ? currentScreenSource() : null));
  const wanted = preselect ?? current?.id;
  const [tab, setTab] = useState<'apps' | 'screens'>(() => (wanted?.startsWith('screen:') ? 'screens' : 'apps'));
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  const [selected, setSelected] = useState<string | null>(wanted ?? null);
  const [audio, setAudio] = useState(current?.audio ?? true);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const [listError, setListError] = useState<string | null>(null);
  const load = () => {
    setSources(null);
    setListError(null);
    listScreenSources()
      .then((list) => {
        // A janela já marcada vai para o começo da lista, para aparecer sem precisar procurar.
        const pre = wanted ? list.find((s) => s.id === wanted) : undefined;
        setSources(pre ? [pre, ...list.filter((s) => s !== pre)] : list);
        if (pre) {
          setTab(pre.isScreen ? 'screens' : 'apps');
        } else if (wanted) {
          // A janela do jogo não aparece (ex.: jogo em tela cheia exclusiva): marca a tela inteira.
          const screen = list.find((s) => s.isScreen);
          setSelected((cur) => (cur === wanted ? (screen?.id ?? null) : cur));
          setTab('screens');
          if (preselect)
            setNotice(
              `Não encontramos a janela${preselectName ? ` de ${preselectName}` : ' do jogo'}. Marcamos a tela inteira para transmitir.`,
            );
        } else if (!list.some((s) => !s.isScreen)) setTab('screens'); // sem janelas abertas, já mostra as telas
      })
      .catch((err) => {
        setSources([]);
        setListError(typeof err === 'string' ? err : 'Não foi possível listar as janelas e telas.');
      });
  };
  useEffect(() => {
    if (native) load();
  }, [native]);

  const visible = (sources ?? []).filter((s) => s.isScreen === (tab === 'screens'));
  // Fica aberto até a transmissão começar: se falhar, mostra o aviso e dá para escolher outra.
  const go = async (id: string | null) => {
    if (busy || (native && !id)) return;
    setScreenQuality({ resolution, fps });
    const src = native && id ? { id, audio } : undefined;
    setBusy(true);
    const err = await (switching ? switchScreen(src) : toggleScreen(src)).catch(() => 'Não foi possível compartilhar a tela.');
    if (!alive.current) {
      if (err) toast(err, 'error');
      return;
    }
    setBusy(false);
    if (!err) onClose();
    else {
      toast(err, 'error');
      if (native && id?.startsWith('window:')) setTab('screens');
    }
  };
  const start = () => void go(selected);
  const choice = (active: boolean) =>
    cx(
      'flex-1 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors',
      active ? 'border-accent bg-accent/15 text-fg' : 'border-edge text-soft hover:bg-hover hover:text-fg',
    );
  const tabBtn = (t: 'apps' | 'screens', label: string, Icon: typeof Icons.Monitor) => (
    <button
      onClick={() => setTab(t)}
      className={cx(
        'flex items-center gap-1.5 border-b-2 px-1 pb-2 text-sm font-semibold transition-colors',
        tab === t ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
      )}
    >
      <Icon size={16} /> {label}
    </button>
  );

  return (
    <Modal
      title={switching ? 'Trocar tela' : 'Transmitir tela'}
      subtitle={
        switching
          ? 'Escolha a nova janela ou tela. A transmissão continua, sem parar.'
          : native
          ? 'Escolha uma janela ou tela para a galera assistir.'
          : 'Escolha a qualidade. Depois o sistema pergunta qual tela ou janela mostrar (e se o áudio vai junto).'
      }
      onClose={onClose}
      width={native ? 760 : 480}
      fixedBody={native}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={start} disabled={busy || (native && !selected)}>
            <Icons.Screen size={16} /> {busy ? 'Abrindo…' : switching ? 'Trocar' : 'Transmitir'}
          </Button>
        </>
      }
    >
      {/* Abas e opções ficam paradas; só a lista de janelas/telas rola. */}
      <div className={cx(native ? 'flex min-h-0 flex-1 flex-col gap-4' : 'space-y-4')}>
        {notice && <p className="shrink-0 rounded-lg bg-accent/10 px-3 py-2 text-sm text-soft">{notice}</p>}
        {native && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="mb-3 flex shrink-0 items-center gap-5 border-b border-edge">
              {tabBtn('apps', 'Aplicativos', Icons.AppWindow)}
              {tabBtn('screens', 'Telas', Icons.Monitor)}
              <button title="Atualizar lista" onClick={load} className="ml-auto mb-2 rounded-md p-1 text-muted hover:bg-hover hover:text-fg">
                <Icons.Refresh size={16} />
              </button>
            </div>
            {/* Grade fixa 3x2: cada página tem 6 quadros do mesmo tamanho; mais que isso rola para o lado. */}
            <div className="-mx-1 shrink-0 px-1">
            {!sources ? (
              <div className="grid grid-cols-3 grid-rows-2 gap-3">
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className="aspect-video animate-pulse rounded-lg bg-raise" />
                ))}
              </div>
            ) : listError ? (
              <p className="rounded-lg bg-danger/10 px-3 py-6 text-center text-sm text-danger">{listError}</p>
            ) : visible.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted">
                {tab === 'apps' ? 'Nenhuma janela aberta para transmitir.' : 'Nenhuma tela encontrada.'}
              </p>
            ) : (
              <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2">
                {Array.from({ length: Math.ceil(visible.length / 6) }, (_, page) => visible.slice(page * 6, page * 6 + 6)).map((items, page) => (
                <div key={page} className="grid w-full shrink-0 snap-start grid-cols-3 grid-rows-2 gap-3">
                {items.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSelected(s.id)}
                    onDoubleClick={() => {
                      setSelected(s.id);
                      void go(s.id);
                    }}
                    title={s.name}
                    className={cx(
                      'group min-w-0 rounded-xl border-2 p-1.5 text-left transition-colors',
                      selected === s.id ? 'border-accent bg-accent/10' : 'border-transparent hover:bg-hover',
                    )}
                  >
                    <div className="flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-rail">
                      {s.thumbnail ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={s.thumbnail} alt="" className="h-full w-full object-contain" />
                      ) : s.isScreen ? (
                        <Icons.Monitor size={28} className="text-muted" />
                      ) : (
                        <Icons.AppWindow size={28} className="text-muted" />
                      )}
                    </div>
                    <p className={cx('mt-1.5 truncate px-0.5 text-center text-xs font-semibold', selected === s.id ? 'text-fg' : 'text-soft')}>
                      {s.name}
                    </p>
                  </button>
                ))}
                </div>
                ))}
              </div>
            )}
            </div>
          </div>
        )}
        <div className={cx(native && 'grid shrink-0 gap-4 sm:grid-cols-2')}>
          <div>
            <p className="mb-2 text-xs font-bold tracking-wide text-muted uppercase">Resolução</p>
            <div className="flex gap-2">
              {(Object.keys(RESOLUTIONS) as Resolution[]).map((r) => (
                <button key={r} onClick={() => setResolution(r)} className={choice(resolution === r)}>
                  {RESOLUTIONS[r].label}
                </button>
              ))}
            </div>
          </div>
          <div className={cx(!native && 'mt-4')}>
            <p className="mb-2 text-xs font-bold tracking-wide text-muted uppercase">Taxa de quadros</p>
            <div className="flex gap-2">
              {([30, 60] as Fps[]).map((f) => (
                <button key={f} onClick={() => setFps(f)} className={choice(fps === f)}>
                  {f} fps
                </button>
              ))}
            </div>
          </div>
        </div>
        {/* No Linux a captura pelo X não traz o som do sistema. */}
        {native && window.line?.platform !== 'linux' && (
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-soft">
            <input
              type="checkbox"
              checked={audio}
              onChange={(e) => setAudio(e.target.checked)}
              className="h-4 w-4 shrink-0 accent-[var(--color-accent)]"
            />
            {tab === 'apps' ? 'Transmitir o som do aplicativo' : 'Transmitir o som do computador (sem o som do Line)'}
          </label>
        )}
        <p className="shrink-0 text-xs text-muted">
          Até {(RESOLUTIONS[resolution].kbps[fps] / 1000).toLocaleString('pt-BR')} Mbps para cada pessoa na chamada.
          {resolution === '2160' && ' Em 4K, sua internet de upload e a placa de vídeo precisam aguentar; com muita gente na call, prefira 1440p.'}
        </p>
      </div>
    </Modal>
  );
}

// ---------- configurações de voz ----------

export function VoiceSettingsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Voz e áudio" onClose={onClose} width={480}>
      <VoiceSettingsPanel />
    </Modal>
  );
}

/** Microfone, saída de áudio e supressão de ruído. */
export function VoiceSettingsPanel() {
  const inputId = useVoice((v) => v.inputId);
  const outputId = useVoice((v) => v.outputId);
  const noise = useVoice((v) => v.noiseSuppression);
  const [devices, setDevices] = useState<Awaited<ReturnType<typeof listAudioDevices>> | null>(null);
  useEffect(() => {
    const load = () => void listAudioDevices().then(setDevices).catch(() => setDevices({ inputs: [], outputs: [] }));
    load();
    navigator.mediaDevices?.addEventListener?.('devicechange', load);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', load);
  }, []);

  return (
    <div className="space-y-4">
        <NoiseToggle on={noise} />
        <div>
          <span className="mb-1.5 block text-xs font-bold tracking-wide text-muted uppercase">Microfone</span>
          <Select
            value={inputId ?? ''}
            onChange={(v) => void setInputDevice(v || null)}
            options={[{ value: '', label: 'Padrão do sistema' }, ...(devices?.inputs ?? []).map((d) => ({ value: d.id, label: d.label }))]}
          />
        </div>
        <div>
          <span className="mb-1.5 block text-xs font-bold tracking-wide text-muted uppercase">Saída de áudio</span>
          <Select
            value={outputId ?? ''}
            onChange={(v) => setOutputDevice(v || null)}
            options={[{ value: '', label: 'Padrão do sistema' }, ...(devices?.outputs ?? []).map((d) => ({ value: d.id, label: d.label }))]}
          />
        </div>
    </div>
  );
}

function NoiseToggle({ on }: { on: boolean }) {
  return (
    <button
      onClick={() => void setNoiseSuppression(!on)}
      className="flex w-full items-center gap-3 rounded-lg border border-edge bg-rail px-3 py-2.5 text-left hover:bg-hover"
    >
      <Icons.Waves size={20} className={on ? 'text-accent' : 'text-muted'} />
      <span className="flex-1">
        <span className="block text-sm font-semibold">Supressor de ruído</span>
        <span className="block text-xs text-muted">Tira teclado, ventilador e barulho de fundo da sua voz.</span>
      </span>
      <span className={cx('relative h-5 w-9 rounded-full transition-colors', on ? 'bg-accent' : 'bg-edge')}>
        <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all', on ? 'left-[18px]' : 'left-0.5')} />
      </span>
    </button>
  );
}

const METER_BARS = 24;

/** Popover da supressão de ruído: liga/desliga, explicação e teste do microfone com medidor ao vivo. */
function NoisePopover({ onClose }: { onClose: () => void }) {
  const on = useVoice((v) => v.noiseSuppression);
  const inputId = useVoice((v) => v.inputId);
  const ref = useRef<HTMLDivElement>(null);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Teste: abre o microfone à parte e mede o volume, sem mandar nada para a chamada.
  useEffect(() => {
    if (!testing) return;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let alive = true;
    navigator.mediaDevices
      .getUserMedia({ audio: { deviceId: inputId ? { exact: inputId } : undefined, noiseSuppression: on, echoCancellation: true } })
      .then((s) => {
        if (!alive) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(s).connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let peak = 0;
          for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
          setLevel(Math.min(1, peak / 64));
          raf = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch(() => setTesting(false));
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
      setLevel(0);
    };
  }, [testing, inputId, on]);

  const lit = Math.round(level * METER_BARS);
  return (
    <div ref={ref} className="absolute bottom-full left-2 z-40 mb-2 w-72 space-y-3 rounded-xl border border-edge bg-rail p-4 shadow-2xl">
      <div className="flex items-center justify-between">
        <span className="font-bold">Supressão de ruído</span>
        <button
          role="switch"
          aria-checked={on}
          onClick={() => void setNoiseSuppression(!on)}
          className={cx('relative h-6 w-11 rounded-full transition-colors', on ? 'bg-accent' : 'bg-edge')}
        >
          <span className={cx('absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all', on ? 'left-[22px]' : 'left-0.5')} />
        </button>
      </div>
      <p className="text-sm text-soft">
        Tira teclado, ventilador e outros barulhos de fundo da sua voz. Tente bater palmas enquanto fala: a galera só vai ouvir você.
      </p>
      <div>
        <p className="mb-2 font-semibold">Teste do microfone</p>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setTesting((v) => !v)}
            className={cx('shrink-0 rounded-lg px-3 py-1.5 text-sm font-semibold', testing ? 'bg-accent text-white' : 'bg-raise hover:bg-hover')}
          >
            {testing ? 'Parar' : 'Testar'}
          </button>
          <div className="flex h-6 flex-1 items-center gap-[3px]">
            {Array.from({ length: METER_BARS }, (_, i) => (
              <span key={i} className={cx('h-full flex-1 rounded-full transition-colors', i < lit ? 'bg-online' : 'bg-edge')} />
            ))}
          </div>
        </div>
      </div>
      <div className="border-t border-edge pt-3">
        <p className="text-xs text-muted">Fornecido por</p>
        <p className="text-sm font-semibold">RNNoise</p>
        <p className="text-xs text-muted">Rede neural de código aberto que roda no seu próprio computador. Sua voz não sai daqui para ser filtrada.</p>
      </div>
    </div>
  );
}

// ---------- barra "voz conectada" na lateral ----------

export function VoiceBar() {
  const channelId = useVoice((v) => v.channelId);
  const connecting = useVoice((v) => v.connecting);
  const ping = usePing(!connecting);
  const noise = useVoice((v) => v.noiseSuppression);
  const camera = useVoice((v) => !!v.camera);
  const screen = useVoice((v) => !!v.screen);
  const quality = useVoice((v) => v.screenQuality);
  const channel = useLine((s) => (channelId ? s.channels[channelId] : undefined));
  const server = useLine((s) => (channel?.serverId ? s.servers[channel.serverId] : undefined));
  const meId = useLine((s) => s.me?.id);
  const users = useLine((s) => s.users);
  const [modal, setModal] = useState<'screen' | 'camera' | null>(null);
  const [noiseOpen, setNoiseOpen] = useState(false);
  if (!channelId) return null;

  const label = channel ? (channel.serverId ? `${channel.name} / ${server?.name ?? ''}` : dmTitle(channel, meId, users)) : '';
  const go = () => {
    if (!channel) return;
    if (channel.serverId) actions.goServer(channel.serverId, channel.id);
    else actions.goHome(channel.id);
    mobile.showMain();
  };
  const tile = (active: boolean) =>
    cx(
      'flex h-9 items-center justify-center gap-1.5 rounded-lg border text-xs font-semibold transition-colors',
      active ? 'border-accent/60 bg-accent/20 text-fg' : 'border-edge bg-raise text-soft hover:bg-hover hover:text-fg',
    );

  return (
    <div className="relative space-y-2.5 border-b border-edge p-2.5">
      <div className="flex items-center gap-1">
        <button onClick={go} className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-hover">
          <span className="flex" data-tip={connecting ? 'Conectando…' : ping != null ? `${ping} ms` : '…'}>
            <Icons.Signal
              size={20}
              className={connecting ? 'text-sun' : ping == null || ping < 150 ? 'text-online' : ping < 300 ? 'text-sun' : 'text-danger'}
            />
          </span>
          <span className="min-w-0">
            <span className={cx('block truncate text-[13px] font-bold', connecting ? 'text-sun' : 'text-online')}>
              {connecting ? 'Conectando…' : 'Voz conectada'}
            </span>
            <span className="block truncate text-xs text-muted">{label}</span>
          </span>
        </button>
        {/* Sem "relative" aqui: o popover se ancora no painel e abre para cima e para a direita. */}
        <span>
          <button
            title="Supressão de ruído"
            onClick={() => setNoiseOpen((v) => !v)}
            className={cx('rounded-md p-1.5 hover:bg-hover', noise ? 'text-accent' : 'text-muted hover:text-fg', noiseOpen && 'bg-hover')}
          >
            <Icons.Waves size={18} />
          </button>
          {noiseOpen && <NoisePopover onClose={() => setNoiseOpen(false)} />}
        </span>
        <button title="Sair da chamada" onClick={() => leaveVoice()} className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-danger">
          <Icons.PhoneOff size={18} />
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <button title={camera ? 'Desligar câmera' : 'Ligar câmera'} onClick={() => (camera ? void toggleCamera() : setModal('camera'))} className={tile(camera)}>
          {camera ? <Icons.Video size={16} /> : <Icons.VideoOff size={16} />}
        </button>
        <button
          title={screen ? 'Parar transmissão' : 'Transmitir tela'}
          onClick={() => (screen ? void toggleScreen() : setModal('screen'))}
          className={tile(screen)}
        >
          <Icons.Screen size={16} />
          {screen && <span>{RESOLUTIONS[quality.resolution].label}</span>}
        </button>
        <SoundboardButton className={tile(false)} />
      </div>
      {modal === 'screen' && <ScreenShareModal onClose={() => setModal(null)} />}
      {modal === 'camera' && <CameraModal onClose={() => setModal(null)} />}
    </div>
  );
}

// ---------- participantes embaixo do canal de voz ----------

/** Selo AO VIVO: com o mouse em cima, mostra a prévia da transmissão (e o jogo, se for um). */
function LiveBadge({ userId, channelId }: { userId: string; channelId: string }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thumb = useVoice((v) => v.screenThumbs[userId]);
  const game = useVoice((v) => v.screenGames[userId]);
  const inSameCall = useVoice((v) => v.channelId === channelId && !v.connecting);
  const meId = useLine((s) => s.me?.id);
  const isMe = userId === meId;
  const show = (e: ReactMouseEvent) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    const r = e.currentTarget.getBoundingClientRect();
    setAt((old) => old ?? { x: r.right + 12, y: r.top + r.height / 2 });
  };
  const hide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setAt(null), 150);
  };
  useEffect(() => () => void (hideTimer.current && clearTimeout(hideTimer.current)), []);
  // Clicou em qualquer outro lugar (ex.: no nome, para abrir o perfil): some na hora, sem esperar.
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return;
    const down = (e: PointerEvent) => {
      if (popRef.current?.contains(e.target as Node)) return;
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setAt(null);
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [at]);
  // Assistir: abre o canal de voz com a transmissão em destaque (não fica no chat de texto).
  // A própria transmissão também abre em destaque (sem pedir para "assistir" a si mesmo).
  const watch = () => {
    if (!isMe) setWatching(userId, true);
    setAt(null);
    requestStageFocus(`screen:${userId}`);
    const st = useVoice.getState().states[userId];
    const serverId = st?.serverId ?? useLine.getState().channels[channelId]?.serverId;
    if (serverId) actions.goServer(serverId, channelId);
    else actions.goHome(channelId);
  };
  return (
    <>
      <span onMouseEnter={show} onMouseLeave={hide} className="rounded bg-danger px-1 text-[10px] font-bold text-white">
        AO VIVO
      </span>
      {at &&
        createPortal(
          <div
            ref={popRef}
            onMouseEnter={() => hideTimer.current && clearTimeout(hideTimer.current)}
            onMouseLeave={hide}
            // O portal ainda borbulha no React: não deixa o clique abrir o cartão do usuário.
            onClick={(e) => e.stopPropagation()}
            style={{ left: at.x, top: at.y }}
            className="fixed z-50 w-64 -translate-y-1/2 overflow-hidden rounded-xl border border-edge bg-rail p-2.5 shadow-2xl"
          >
            {game && (
              <div className="mb-2 flex items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-raise">
                  {game.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={game.icon} alt="" className="h-6 w-6 object-contain" />
                  ) : (
                    <Icons.Gamepad size={16} className="text-muted" />
                  )}
                </span>
                <span className="truncate text-sm font-semibold">{game.name}</span>
              </div>
            )}
            <div
              // Clicar na miniatura também abre a transmissão, igual ao botão.
              onClick={inSameCall ? watch : undefined}
              className={cx(
                'relative flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-black',
                inSameCall && 'cursor-pointer',
              )}
            >
              {thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={thumb} alt="" draggable={false} className="h-full w-full object-contain" />
              ) : (
                <Icons.Screen size={28} className="text-muted" />
              )}
            </div>
            {inSameCall ? (
              <button
                onClick={watch}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-white/90 py-1.5 text-sm font-semibold text-[#141418] transition-colors hover:bg-white"
              >
                <Icons.Eye size={14} /> {isMe ? 'Ver minha transmissão' : 'Assistir transmissão'}
              </button>
            ) : (
              <>
                <p className="mt-2 text-center text-sm font-semibold">Assistir transmissão</p>
                <p className="text-center text-xs text-muted">Entre na chamada para assistir.</p>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

export function VoiceChannelMembers({ channelId, serverId }: { channelId: string; serverId?: string }) {
  const states = useVoice((v) => v.states);
  const speaking = useVoice((v) => v.speaking);
  const effects = useSounds((s) => s.effects);
  const myChannel = useVoice((v) => v.channelId);
  const users = useLine((s) => s.users);
  const serverMembers = useLine((s) => (serverId ? s.members[serverId] : undefined)); // apelidos e foto do servidor
  const list = participants(states, channelId);
  const canInvite = !!serverId && myChannel === channelId;
  const [menu, setMenu] = useState<{ userId: string; x: number; y: number } | null>(null);
  const hasMusic = useMusic((m) => !!m.states[channelId]);
  if (!list.length && !canInvite && !hasMusic) return null;
  return (
    <div className="ml-6 space-y-1 pt-0.5 pb-2">
      <VoiceStatusLine channelId={channelId} />
      <MusicBotInVoice channelId={channelId} serverId={serverId} />
      {list.map((p) => {
        const u = users[p.userId];
        return (
          <button
            key={p.userId}
            onClick={(e) => actions.openModal({ kind: 'user', userId: p.userId, at: { x: e.clientX, y: e.clientY } })}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ userId: p.userId, x: e.clientX, y: e.clientY });
            }}
            className={cx(
              'flex w-full items-center gap-2.5 rounded-md px-1.5 py-1 text-left text-[15px] text-soft hover:bg-hover',
              menu?.userId === p.userId && 'bg-hover',
            )}
          >
            {/* Caixa fixa 24x24; o anel de "falando" fica 2px em volta, sempre redondo e centralizado. */}
            <span className="relative flex h-6 w-6 shrink-0 items-center justify-center">
              <Avatar name={u?.displayName ?? '?'} color={u?.avatarColor ?? '#3a3a42'} src={serverMembers?.[p.userId]?.profile?.avatarUrl || u?.avatarUrl} size={24} />
              {(speaking[p.userId] || effects[p.userId]) && (
                <span
                  className={cx(
                    'pointer-events-none absolute -inset-[3px] rounded-full border-2',
                    effects[p.userId] ? 'border-[#a855f7]' : 'border-online',
                  )}
                />
              )}
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <StyledName user={u} className="truncate">
                {displayNameIn(useLine.getState(), p.serverId, p.userId)}
              </StyledName>
              {u && <UserTagBadge user={u} />}
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-muted">
              {p.screenStreamId && <LiveBadge userId={p.userId} channelId={channelId} />}
              {p.cameraStreamId && <Icons.Video size={15} />}
              {(p.muted || p.deafened || p.serverMuted || p.serverDeafened) && (
                <span
                  title={
                    p.serverDeafened || p.serverMuted
                      ? 'Silenciado pelo servidor'
                      : p.deafened
                        ? 'Microfone e áudio desativados'
                        : 'Microfone desativado'
                  }
                  className="flex items-center gap-1.5"
                >
                  <Icons.MicOff size={15} className={cx((p.serverMuted || p.serverDeafened) && 'text-danger')} />
                  {(p.deafened || p.serverDeafened) && <Icons.HeadphonesOff size={15} className={cx(p.serverDeafened && 'text-danger')} />}
                </span>
              )}
            </span>
          </button>
        );
      })}
      {canInvite && <InviteToVoiceItem serverId={serverId} channelId={channelId} />}
      {menu && <VoiceUserMenu {...menu} channelId={channelId} onClose={() => setMenu(null)} />}
    </div>
  );
}

// ---------- chamada recebida (DM) ----------

export function IncomingCall() {
  const states = useVoice((v) => v.states);
  const myChannel = useVoice((v) => v.channelId);
  const channels = useLine((s) => s.channels);
  const users = useLine((s) => s.users);
  const meId = useLine((s) => s.me?.id);
  const dnd = useLine((s) => s.me?.status === 'dnd');
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});

  // Uma DM com gente em chamada, onde eu não estou.
  const ringing = Object.values(states).find(
    (s) => !s.serverId && s.channelId !== myChannel && s.userId !== meId && channels[s.channelId] && !dismissed[s.channelId],
  );

  useEffect(() => {
    if (!ringing) return;
    window.line?.requestAttention();
    if (!dnd && typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
      const caller = users[ringing.userId]?.displayName ?? 'Alguém';
      new Notification(`${caller} está te ligando`, { body: 'Abra o Line para atender.', tag: `call${ringing.channelId}`, data: `${ringing.channelId}:` });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ringing?.channelId]);

  // Quando a chamada acaba, esquece o "ignorar" para tocar de novo na próxima.
  useEffect(() => {
    setDismissed((d) => {
      const active = new Set(Object.values(states).map((s) => s.channelId));
      const next = Object.fromEntries(Object.entries(d).filter(([cid]) => active.has(cid)));
      return Object.keys(next).length === Object.keys(d).length ? d : next;
    });
  }, [states]);

  if (!ringing || dnd) return null;
  const channel = channels[ringing.channelId]!;
  const caller = users[ringing.userId];

  return (
    <div className="fixed right-6 bottom-6 z-40 flex w-72 flex-col items-center gap-3 rounded-2xl border border-edge bg-side p-5 shadow-2xl">
      <span className="animate-pulse rounded-full ring-4 ring-accent/50">
        <Avatar name={caller?.displayName ?? '?'} color={caller?.avatarColor ?? '#3a3a42'} src={caller?.avatarUrl} size={64} />
      </span>
      <div className="text-center">
        <p className="font-bold">{channel.type === 'group_dm' ? dmTitle(channel, meId, users) : caller?.displayName}</p>
        <p className="text-sm text-muted">Chamada em andamento…</p>
      </div>
      <div className="flex gap-3">
        <button
          title="Ignorar"
          onClick={() => setDismissed((d) => ({ ...d, [channel.id]: true }))}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-danger text-white hover:brightness-110"
        >
          <Icons.PhoneOff size={20} />
        </button>
        <button
          title="Atender"
          onClick={() => {
            actions.goHome(channel.id);
            mobile.showMain();
            void joinVoice(channel.id);
          }}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-accent text-on-accent hover:bg-accent-strong"
        >
          <Icons.Phone size={20} />
        </button>
      </div>
    </div>
  );
}

/**
 * Linha compacta de um canal de voz quando a categoria está recolhida:
 * ícone de alto-falante e só os avatares de quem está conectado, sobrepostos.
 * Com 5 ou mais pessoas mostra os 4 primeiros e um "+N" com o restante.
 */
export function CollapsedVoiceChannel({ channel, active, onOpen }: { channel: Channel; active: boolean; onOpen: () => void }) {
  const states = useVoice((v) => v.states);
  const speaking = useVoice((v) => v.speaking);
  const users = useLine((s) => s.users);
  const serverMembers = useLine((s) => (channel.serverId ? s.members[channel.serverId] : undefined));
  const list = participants(states, channel.id);
  if (!list.length) return null;
  const MAX = 4;
  const shown = list.length > MAX ? list.slice(0, MAX) : list;
  const rest = list.length - shown.length;
  return (
    <button
      onClick={onOpen}
      title={channel.name}
      className={cx(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
        active ? 'bg-hover text-fg' : 'text-muted hover:bg-hover hover:text-soft',
      )}
    >
      <Icons.Speaker size={18} className="shrink-0 opacity-70" />
      <span className="flex items-center">
        {shown.map((p, i) => {
          const u = users[p.userId];
          return (
            <span
              key={p.userId}
              className={cx(
                'relative flex shrink-0 rounded-full ring-2 ring-side',
                i > 0 && '-ml-1.5',
                speaking[p.userId] && 'ring-online',
              )}
              style={{ zIndex: shown.length - i }}
            >
              <Avatar name={u?.displayName ?? '?'} color={u?.avatarColor ?? '#3a3a42'} src={serverMembers?.[p.userId]?.profile?.avatarUrl || u?.avatarUrl} size={22} />
            </span>
          );
        })}
        {rest > 0 && (
          <span className="-ml-1.5 flex h-[22px] min-w-[22px] shrink-0 items-center justify-center rounded-full bg-hover px-1 text-[11px] font-semibold text-soft ring-2 ring-side">
            +{rest}
          </span>
        )}
      </span>
    </button>
  );
}

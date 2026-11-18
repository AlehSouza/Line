'use client';

import type { PublicUser } from '@line/shared';
import * as L from 'lucide-react';
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { formatDuration, musicControl, positionOf, setMusicVolume, stopMusic, thumbOf, toggleMusicMute, useMusic, type LiveMusic } from '@/lib/music';
import { actions, displayNameIn, useLine } from '@/lib/store';
import { StyledName } from '@/lib/nameStyle';
import { joinVoice, useVoice } from '@/lib/voice';
import { hasPerm, Perm } from '@line/shared';
import { toast } from './Dialogs';
import { VoiceUserMenu } from './VoiceUserMenu';
import { Avatar, cx, Slider } from './ui';
import { permsOf } from '@/lib/store';

// ---------- quem pode o quê ----------

function useIsDj(m: LiveMusic | null | undefined) {
  const meId = useLine((s) => s.me?.id);
  const manage = useLine((s) => (m ? hasPerm(permsOf(s, m.serverId, s.me?.id), Perm.ManageAgent) : false));
  return !!m && (m.djId === meId || manage);
}

function isDj(m: LiveMusic) {
  const s = useLine.getState();
  return m.djId === s.me?.id || hasPerm(permsOf(s, m.serverId, s.me?.id), Perm.ManageAgent);
}

/** `/stop` no chat: para a música do canal de voz em que estou. Devolve true se parou. */
export function stopCommand(serverId: string) {
  const voice = useVoice.getState().channelId;
  const m = voice ? useMusic.getState().states[voice] : undefined;
  if (!m || m.serverId !== serverId) {
    toast('Não tem música tocando no seu canal de voz.');
    return false;
  }
  if (!isDj(m)) {
    toast(`Só ${displayNameIn(useLine.getState(), serverId, m.djId)} pode parar a música.`);
    return false;
  }
  stopMusic(m.channelId);
  return true;
}

/** `/pular`, `/pausar`, `/voltar` no chat: controla a música do canal de voz em que estou. */
export function controlCommand(serverId: string, action: 'skip' | 'pause' | 'prev') {
  const voice = useVoice.getState().channelId;
  const m = voice ? useMusic.getState().states[voice] : undefined;
  if (!m || m.serverId !== serverId) {
    toast('Não tem música tocando no seu canal de voz.');
    return false;
  }
  musicControl({ channelId: m.channelId, action });
  if (!isDj(m)) toast('Seu voto foi contado.');
  return true;
}

/** Bot de música do servidor (pode ainda não existir antes do primeiro /play). */
export function useServerBot(serverId: string | null) {
  return useLine((s) => {
    if (!serverId) return undefined;
    const id = Object.keys(s.members[serverId] ?? {}).find((u) => s.users[u]?.bot);
    return id ? s.users[id] : undefined;
  });
}

function BotBadge({ serverId, size = 18 }: { serverId: string | null; size?: number }) {
  const bot = useServerBot(serverId);
  const name = bot?.displayName ?? 'Música Line';
  return (
    <>
      {bot ? (
        <Avatar name={bot.displayName} color={bot.avatarColor} src={bot.avatarUrl} size={size} />
      ) : (
        <span className="flex shrink-0 items-center justify-center rounded-full bg-accent/20 text-accent" style={{ width: size, height: size }}>
          <L.Music size={size * 0.6} />
        </span>
      )}
      <span className="truncate font-semibold text-fg">{name}</span>
    </>
  );
}

/** Aviso acima da caixa de mensagem enquanto o /play procura a música. */
export function MusicSearching({ serverId }: { serverId: string | null }) {
  return (
    <div className="mb-1.5 flex items-center gap-2 px-1 text-xs text-soft">
      <BotBadge serverId={serverId} />
      <span className="min-w-0 truncate">está procurando sua música... aguarde um instante...</span>
      <L.LoaderCircle size={13} className="shrink-0 animate-spin text-accent" />
    </div>
  );
}

export interface SlashPickerHandle {
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

const COMMANDS = [
  { name: 'play', args: '[link ou nome da música]', desc: 'Toca uma música do YouTube no seu canal de voz (ou põe na fila).' },
  { name: 'pausar', args: '', desc: 'Pausa ou continua a música.' },
  { name: 'pular', args: '', desc: 'Pula para a próxima música da fila.' },
  { name: 'voltar', args: '', desc: 'Volta para a música anterior.' },
  { name: 'stop', args: '', desc: 'Para a música e tira o bot do canal.' },
  { name: 'hoje', args: '[cidade]', desc: 'O agente conta a data, se é feriado, a previsão do tempo e uma curiosidade do dia.' },
];

/** Lista de comandos do bot que aparece ao digitar "/" no começo da mensagem. */
export function SlashPicker({
  serverId,
  text,
  onPick,
  ref,
}: {
  serverId: string | null;
  text: string;
  onPick: (insert: string) => void;
  ref?: Ref<SlashPickerHandle>;
}) {
  const [index, setIndex] = useState(0);
  const [closed, setClosed] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  // Mantém o item selecionado pelas setas sempre visível na lista.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  const m = serverId ? /^\/(\S*)$/.exec(text) : null;
  const query = m ? m[1]!.toLowerCase() : null;
  const options = query === null ? [] : COMMANDS.filter((c) => c.name.startsWith(query));
  const visible = !closed && options.length > 0;
  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    if (query === null) setClosed(false);
  }, [query]);
  const pick = (c: (typeof COMMANDS)[number]) => onPick(`/${c.name} `);

  useImperativeHandle(ref, () => ({
    onKeyDown(e) {
      if (!visible) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setIndex((i) => (i + d + options.length) % options.length);
        return true;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && options[index] && `/${options[index]!.name}` !== text)) {
        e.preventDefault();
        const c = options[Math.min(index, options.length - 1)];
        if (c) pick(c);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setClosed(true);
        return true;
      }
      return false;
    },
  }));

  if (!visible) return null;
  return (
    <div ref={listRef} className="absolute right-0 bottom-full left-0 z-30 mb-2 max-h-80 overflow-y-auto rounded-xl border border-edge bg-rail p-2 shadow-2xl">
      <p className="flex items-center gap-2 px-2 pt-1 pb-1.5 text-xs">
        <BotBadge serverId={serverId} size={16} />
      </p>
      {options.map((c, i) => (
        <button
          key={c.name}
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            pick(c);
          }}
          onMouseEnter={() => setIndex(i)}
          data-active={i === index}
          className={cx('flex w-full flex-col rounded-md px-2 py-1.5 text-left', i === index && 'bg-hover')}
        >
          <span className="text-[15px] font-semibold">
            /{c.name} {c.args && <span className="font-normal text-muted">{c.args}</span>}
          </span>
          <span className="text-xs text-muted">{c.desc}</span>
        </button>
      ))}
    </div>
  );
}

/** Botão de parar a música (player e anúncio no chat). */
function StopButton({ m, compact }: { m: LiveMusic; compact?: boolean }) {
  const dj = useIsDj(m);
  const djName = useLine((s) => displayNameIn(s, m.serverId, m.djId));
  const title = dj ? 'Parar a música e tirar o bot do canal' : `Só ${djName} pode parar a música`;
  if (compact)
    return (
      <button
        title={title}
        disabled={!dj}
        onClick={() => stopMusic(m.channelId)}
        className="flex h-8 w-8 items-center justify-center rounded-full text-soft transition hover:bg-danger/20 hover:text-danger disabled:pointer-events-none disabled:opacity-40"
      >
        <L.Square size={14} fill="currentColor" />
      </button>
    );
  return (
    <button
      title={title}
      disabled={!dj}
      onClick={() => stopMusic(m.channelId)}
      className="flex items-center gap-1.5 rounded-md border border-edge bg-raise px-2.5 py-1 text-xs font-medium text-soft transition hover:border-danger/60 hover:text-danger disabled:opacity-50 disabled:hover:border-edge disabled:hover:text-soft"
    >
      <L.Square size={11} fill="currentColor" />
      Parar
    </button>
  );
}

/** Sessão para mostrar no servidor: a do canal em que estou, senão a primeira que houver. */
function useServerMusic(serverId: string): LiveMusic | null {
  const states = useMusic((m) => m.states);
  const myChannel = useVoice((v) => v.channelId);
  return useMemo(() => {
    const list = Object.values(states).filter((m) => m.serverId === serverId);
    return list.find((m) => m.channelId === myChannel) ?? list[0] ?? null;
  }, [states, myChannel, serverId]);
}

function useTick(on: boolean) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setN((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [on]);
}

function botOf(serverId: string) {
  const s = useLine.getState();
  const id = Object.keys(s.members[serverId] ?? {}).find((u) => s.users[u]?.bot);
  return id ? s.users[id] : undefined;
}

// ---------- player discreto no topo da chamada ----------

/** Player pequeno, centralizado no topo da tela da chamada, enquanto o bot toca no canal em que estou. */
export function CallMusicBar({ channelId }: { channelId: string }) {
  const m = useMusic((s) => s.states[channelId]);
  const inCall = useVoice((v) => v.channelId === channelId);
  const meId = useLine((s) => s.me?.id);
  const dj = useIsDj(m);
  useTick(!!m && !m.paused && inCall);
  if (!m || !inCall) return null;
  const track = m.tracks[m.index];
  if (!track) return null;
  const pos = positionOf(m) / 1000;
  const pct = track.duration ? Math.min(100, (pos / track.duration) * 100) : 0;
  const count = (k: 'skip' | 'pause') => (m.votes[k] ?? []).length;
  const voted = (k: 'skip' | 'pause') => !!meId && (m.votes[k] ?? []).includes(meId);
  const btn = (action: 'skip' | 'pause', icon: React.ReactNode, label: string) => (
    <button
      title={dj ? label : `${label} (votação: ${count(action)}/${m.needed})`}
      onClick={() => musicControl({ channelId, action })}
      className={cx(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-soft transition hover:bg-white/10 hover:text-fg',
        voted(action) && 'text-accent',
      )}
    >
      {icon}
    </button>
  );

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex h-full items-center justify-center max-md:hidden">
      <div className="pointer-events-auto flex max-w-[min(30rem,45%)] items-center gap-2 rounded-full px-2 py-1">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={thumbOf(track.videoId)} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs leading-tight font-semibold" title={`${track.title} — ${track.author}`}>
            {track.title}
          </p>
          <div className="mt-1 h-0.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-accent transition-[width] duration-500 ease-linear" style={{ width: `${pct}%` }} />
          </div>
        </div>
        {btn('pause', m.paused ? <L.Play size={14} fill="currentColor" /> : <L.Pause size={14} fill="currentColor" />, m.paused ? 'Continuar' : 'Pausar')}
        {btn('skip', <L.SkipForward size={14} fill="currentColor" />, 'Pular')}
        <CallVolume />
        {dj && (
          <button
            title="Parar a música e tirar o bot do canal"
            onClick={() => stopMusic(channelId)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-soft transition hover:bg-danger/20 hover:text-danger"
          >
            <L.Square size={12} fill="currentColor" />
          </button>
        )}
      </div>
    </div>
  );
}

/** Volume do agente só para mim, o mesmo do menu "Volume do agente". */
function CallVolume() {
  const volume = useMusic((s) => (s.muted ? 0 : s.volume));
  return (
    <div className="group/vol flex shrink-0 items-center" title="Volume do agente (só para você)">
      <button
        onClick={toggleMusicMute}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-soft transition hover:bg-white/10 hover:text-fg"
      >
        {volume === 0 ? <L.VolumeX size={14} /> : volume < 50 ? <L.Volume1 size={14} /> : <L.Volume2 size={14} />}
      </button>
      <div className="flex w-0 items-center overflow-hidden transition-[width] duration-200 group-hover/vol:w-[5.5rem] group-focus-within/vol:w-[5.5rem]">
        <Slider value={volume} onChange={setMusicVolume} className="line-slider-thin mx-1 my-1 w-20 shrink-0" label="Volume do agente" />
      </div>
    </div>
  );
}

// ---------- player (coluna da direita) ----------

export function MusicPlayer({ serverId }: { serverId: string }) {
  const m = useServerMusic(serverId);
  const myChannel = useVoice((v) => v.channelId);
  const meId = useLine((s) => s.me?.id);
  const channelName = useLine((s) => (m ? s.channels[m.channelId]?.name : ''));
  const volume = useMusic((s) => s.volume);
  const dj = useIsDj(m);
  const [open, setOpen] = useState(false);
  useTick(!!m && !m.paused);
  if (!m) return null;
  const track = m.tracks[m.index];
  if (!track) return null;
  const listening = myChannel === m.channelId;
  const pos = positionOf(m) / 1000;
  const pct = track.duration ? Math.min(100, (pos / track.duration) * 100) : 0;
  const voted = (k: 'skip' | 'prev' | 'pause') => !!meId && (m.votes[k] ?? []).includes(meId);
  const count = (k: 'skip' | 'prev' | 'pause') => (m.votes[k] ?? []).length;
  const upcoming = m.tracks.length - m.index - 1;

  const control = (action: 'skip' | 'prev' | 'pause') => {
    if (!dj && !listening) return toast(`Entre em ${channelName} para votar.`);
    musicControl({ channelId: m.channelId, action });
  };
  const btn = (action: 'skip' | 'prev' | 'pause', icon: React.ReactNode, label: string) => (
    <button
      title={dj ? label : `${label} (votação: ${count(action)}/${m.needed})`}
      onClick={() => control(action)}
      className={cx(
        'relative flex h-8 w-8 items-center justify-center rounded-full text-soft transition hover:bg-hover hover:text-fg',
        voted(action) && 'bg-accent/20 text-accent',
      )}
    >
      {icon}
      {!dj && count(action) > 0 && (
        <span className="absolute -top-1 -right-1 rounded-full bg-accent px-1 text-[9px] leading-[14px] font-bold text-on-accent">
          {count(action)}/{m.needed}
        </span>
      )}
    </button>
  );

  return (
    <div className="shrink-0 border-b border-rail p-2">
      <div className="relative overflow-hidden rounded-xl border border-edge bg-raise/60 p-2.5 shadow-sm">
        {/* fundo com a capa borrada */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={thumbOf(track.videoId)} alt="" className="pointer-events-none absolute inset-0 h-full w-full scale-125 object-cover opacity-15 blur-xl" />
        <div className="relative flex gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={thumbOf(track.videoId)} alt="" className="h-[60px] w-[60px] shrink-0 rounded-lg object-cover shadow" />
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-1">
              <p className="min-w-0 flex-1 truncate text-sm leading-tight font-semibold" title={track.title}>
                {track.title}
              </p>
            </div>
            <p className="truncate text-xs text-soft">
              {track.author}
              <span className="text-muted"> • {formatDuration(track.duration)}</span>
            </p>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-black/40">
              <div className="h-full rounded-full bg-accent transition-[width] duration-500 ease-linear" style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-0.5 flex justify-between text-[10px] text-muted tabular-nums">
              <span>{formatDuration(pos)}</span>
              <span>{formatDuration(track.duration)}</span>
            </div>
          </div>
        </div>
        <div className="relative mt-1 flex items-center justify-center gap-2">
          {btn('prev', <L.SkipBack size={16} fill="currentColor" />, 'Voltar')}
          {btn('pause', m.paused ? <L.Play size={18} fill="currentColor" /> : <L.Pause size={18} fill="currentColor" />, m.paused ? 'Continuar' : 'Pausar')}
          {btn('skip', <L.SkipForward size={16} fill="currentColor" />, 'Pular')}
          <StopButton m={m} compact />
        </div>
        {listening ? (
          <label className="relative mt-1 flex items-center gap-2 text-muted" title="Volume da música (só para você)">
            {volume === 0 ? <L.VolumeX size={13} /> : <L.Volume2 size={13} />}
            <Slider value={volume} onChange={setMusicVolume} className="flex-1" label="Volume da música" />
          </label>
        ) : (
          <button
            onClick={() => void joinVoice(m.channelId)}
            className="relative mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md bg-accent/15 py-1 text-xs font-medium text-accent hover:bg-accent/25"
          >
            <L.Headphones size={13} /> Entrar em {channelName} para ouvir
          </button>
        )}
      </div>

      <button
        onClick={() => setOpen((o) => !o)}
        className="mt-1 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs font-bold tracking-wide text-muted uppercase hover:text-fg"
      >
        <L.ListMusic size={13} />
        <span className="flex-1 text-left">Próximas — {upcoming}</span>
        <L.ChevronDown size={14} className={cx('transition-transform', open && 'rotate-180')} />
      </button>
      {open && <Playlist m={m} dj={dj} />}
    </div>
  );
}

function Playlist({ m, dj }: { m: LiveMusic; dj: boolean }) {
  const meId = useLine((s) => s.me?.id);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  useLine((s) => s.members);
  const st = useLine.getState();
  return (
    // No máximo 5 faixas à mostra (o resto rola), para não esconder a lista de quem está na call.
    <div className="max-h-[208px] space-y-0.5 overflow-y-auto scroll-smooth pr-0.5">
      {m.tracks.map((t, i) => {
        if (i < m.index) return null;
        const current = i === m.index;
        const canDrag = dj && !current;
        const canRemove = dj || t.addedBy === meId;
        return (
          <div
            key={t.uid}
            draggable={canDrag}
            onDragStart={() => setDrag(t.uid)}
            onDragEnd={() => (setDrag(null), setOver(null))}
            onDragOver={(e) => {
              if (drag && i > m.index) {
                e.preventDefault();
                setOver(i);
              }
            }}
            onDrop={() => {
              if (drag && i > m.index) musicControl({ channelId: m.channelId, action: 'move', uid: drag, to: i });
              setDrag(null);
              setOver(null);
            }}
            onDoubleClick={() => dj && !current && musicControl({ channelId: m.channelId, action: 'jump', index: i })}
            className={cx(
              'group flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors',
              current ? 'bg-accent/15' : 'hover:bg-hover',
              canDrag && 'cursor-grab',
              over === i && drag !== t.uid && 'ring-1 ring-accent',
              drag === t.uid && 'opacity-40',
            )}
          >
            <span className="w-4 shrink-0 text-center text-[10px] text-muted tabular-nums">
              {current ? <L.AudioLines size={12} className="text-accent" /> : i - m.index}
            </span>
            {dj && !current ? (
              <button
                title="Tocar agora"
                onClick={() => musicControl({ channelId: m.channelId, action: 'jump', index: i })}
                className="relative h-8 w-8 shrink-0 cursor-pointer overflow-hidden rounded"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={thumbOf(t.videoId)} alt="" className="h-full w-full object-cover" />
                <span className="absolute inset-0 flex items-center justify-center bg-black/55 text-white opacity-0 transition-opacity group-hover:opacity-100">
                  <L.Play size={14} fill="currentColor" />
                </span>
              </button>
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={thumbOf(t.videoId)} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
            )}
            <div className="min-w-0 flex-1">
              <p className={cx('truncate text-xs font-medium', current && 'text-accent')} title={t.title}>
                {t.title}
              </p>
              <p className="truncate text-[10px] text-muted">
                {formatDuration(t.duration)} • {displayNameIn(st, m.serverId, t.addedBy)}
              </p>
            </div>
            <span className="hidden shrink-0 items-center group-hover:flex">
              {canRemove && (
                <button title="Tirar da fila" onClick={() => musicControl({ channelId: m.channelId, action: 'remove', uid: t.uid })} className="p-0.5 text-muted hover:text-danger">
                  <L.Trash2 size={13} />
                </button>
              )}
            </span>
          </div>
        );
      })}
      {m.tracks.length - m.index <= 1 && <p className="px-2 py-2 text-xs text-muted">Nada na fila. Use /play [link ou nome] no chat.</p>}
    </div>
  );
}

// ---------- anúncio no chat ----------

export interface MusicAnnounceData {
  channelId: string;
  uid: string;
  videoId: string;
  duration: number;
  addedBy: string;
  title: string;
  author: string;
}

const ANNOUNCE_RE = /^\[\[musica:([\w-]+):([\w-]+):([\w-]+):(\d+):([\w-]+)\]\]\s?([^\n]*)\n?([^\n]*)$/;

export function musicFromContent(content: string): MusicAnnounceData | null {
  const r = ANNOUNCE_RE.exec(content.trim());
  if (!r) return null;
  return { channelId: r[1]!, uid: r[2]!, videoId: r[3]!, duration: Number(r[4]), addedBy: r[5]!, title: r[6]!, author: r[7]! };
}

export function MusicAnnounceCard({ data, serverId }: { data: MusicAnnounceData; serverId?: string | null }) {
  const live = useMusic((s) => s.states[data.channelId]);
  const myChannel = useVoice((v) => v.channelId);
  const meId = useLine((s) => s.me?.id);
  const channelName = useLine((s) => s.channels[data.channelId]?.name ?? 'canal de voz');
  const addedBy = useLine((s) => displayNameIn(s, serverId ?? null, data.addedBy));
  const dj = useIsDj(live);
  const liveTrack = live?.tracks[live.index];
  const playing = !!live && liveTrack?.uid === data.uid;
  const duration = liveTrack && playing ? liveTrack.duration : data.duration || null;
  const listening = myChannel === data.channelId;

  const vote = (k: 'skip' | 'prev' | 'pause', icon: React.ReactNode, label: string) => {
    const n = (live?.votes[k] ?? []).length;
    const mine = !!meId && (live?.votes[k] ?? []).includes(meId);
    return (
      <button
        disabled={!dj && !listening}
        title={!dj && !listening ? `Entre em ${channelName} para votar` : undefined}
        onClick={() => live && musicControl({ channelId: live.channelId, action: k })}
        className={cx(
          'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition disabled:opacity-50',
          mine ? 'border-accent bg-accent/20 text-accent' : 'border-edge bg-raise text-soft hover:border-accent/60 hover:text-fg',
        )}
      >
        {icon}
        {label}
        {!dj && <span className="text-muted tabular-nums">{n}/{live?.needed ?? 1}</span>}
      </button>
    );
  };

  return (
    <div className="mt-1 max-w-md overflow-hidden rounded-xl border border-edge bg-side">
      <div className="flex gap-3 p-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={thumbOf(data.videoId)} alt="" className="h-[72px] w-[72px] shrink-0 rounded-lg object-cover" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 text-[11px] font-bold tracking-wide text-accent uppercase">
            <L.Music size={11} /> {playing ? 'Tocando agora' : 'Tocou'} em {channelName}
          </p>
          <a
            href={`https://www.youtube.com/watch?v=${data.videoId}`}
            target="_blank"
            rel="noreferrer"
            className="mt-0.5 block truncate font-semibold hover:underline"
            title={data.title}
          >
            {data.title}
          </a>
          <p className="truncate text-xs text-soft">{data.author}</p>
          <p className="mt-0.5 text-xs text-muted">
            {formatDuration(duration)} • adicionada por <span className="text-soft">{addedBy}</span>
          </p>
        </div>
      </div>
      {playing && live && (
        <div className="border-t border-edge bg-black/10 px-3 py-2">
          <div className="flex flex-wrap gap-1.5">
            {vote('prev', <L.SkipBack size={12} />, 'Voltar')}
            {vote('pause', live.paused ? <L.Play size={12} /> : <L.Pause size={12} />, live.paused ? 'Continuar' : 'Pausar')}
            {vote('skip', <L.SkipForward size={12} />, 'Pular')}
            <StopButton m={live} />
          </div>
          <p className="mt-1.5 text-[11px] text-muted">
            {dj
              ? 'Você controla a música: os botões valem na hora.'
              : `Votação: vale a maioria de quem está ouvindo (${live.needed} de ${live.listeners}).`}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------- bot na lista do canal de voz ----------

export function MusicBotInVoice({ channelId, serverId }: { channelId: string; serverId?: string }) {
  const live = useMusic((s) => s.states[channelId]);
  useLine((s) => s.users);
  // Clique direito: o mesmo menu de uma pessoa na voz (volume da música só para mim).
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  if (!live || !serverId) return null;
  const bot = botOf(serverId);
  if (!bot) return null;
  const track = live.tracks[live.index];
  return (
    <>
    <button
      onClick={(e) => actions.openModal({ kind: 'user', userId: bot.id, at: { x: e.clientX, y: e.clientY } })}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1 text-left text-[15px] text-soft hover:bg-hover"
      title={track ? `Tocando: ${track.title}` : undefined}
    >
      <span className="relative flex h-6 w-6 shrink-0 items-center justify-center">
        <Avatar name={bot.displayName} color={bot.avatarColor} src={bot.avatarUrl} size={24} />
        {!live.paused && (
          <span
            className="pointer-events-none absolute -inset-[3px] animate-pulse rounded-full border-2 border-accent"
            style={bot.botStyle?.ringColor ? { borderColor: bot.botStyle.ringColor } : undefined}
          />
        )}
      </span>
      <StyledName user={bot} color={bot.botStyle?.nameColor ?? undefined} className="flex-1 truncate">
        {displayNameIn(useLine.getState(), serverId, bot.id)}
      </StyledName>
      <BotTag user={bot} />
    </button>
    {menu && <VoiceUserMenu userId={bot.id} channelId={channelId} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </>
  );
}

/** Texto claro ou escuro, o que ler melhor sobre a cor. */
function inkOn(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#111114' : '#ffffff';
}

/** Etiqueta do bot, com a cor e o texto ("BOT" ou "B") escolhidos nas configurações do bot. */
export function BotTag({ user, style: given }: { user?: Pick<PublicUser, 'id' | 'botStyle'>; style?: PublicUser['botStyle'] }) {
  const live = useLine((s) => (user ? s.users[user.id]?.botStyle : undefined));
  const style = given ?? live ?? user?.botStyle;
  const color = style?.tagColor;
  return (
    <span
      className={cx('shrink-0 rounded px-1 text-[9px] leading-[14px] font-bold', !color && 'bg-accent text-on-accent')}
      style={color ? { background: color, color: inkOn(color) } : undefined}
    >
      {style?.tagText ?? 'BOT'}
    </span>
  );
}

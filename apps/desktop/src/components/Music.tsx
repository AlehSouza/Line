'use client';

import type { PublicUser } from '@line/shared';
import * as L from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { formatDuration, musicControl, positionOf, setMusicVolume, thumbOf, useMusic, type LiveMusic } from '@/lib/music';
import { actions, displayNameIn, useLine } from '@/lib/store';
import { joinVoice, useVoice } from '@/lib/voice';
import { hasPerm, Perm } from '@line/shared';
import { showError, toast } from './Dialogs';
import { ImageCropper } from './ImageCropper';
import { ProfileCard } from './ProfileEditor';
import { Avatar, Button, cx, ErrorText, Field, Input } from './ui';
import { permsOf } from '@/lib/store';

// ---------- quem pode o quê ----------

function useIsDj(m: LiveMusic | null | undefined) {
  const meId = useLine((s) => s.me?.id);
  const manage = useLine((s) => (m ? hasPerm(permsOf(s, m.serverId, s.me?.id), Perm.ManageServer) : false));
  return !!m && (m.djId === meId || manage);
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
              {dj && (
                <button title="Parar e tirar o bot do canal" onClick={() => musicControl({ channelId: m.channelId, action: 'stop' })} className="-mt-0.5 text-muted hover:text-danger">
                  <L.X size={14} />
                </button>
              )}
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
        </div>
        {listening ? (
          <label className="relative mt-1 flex items-center gap-2 text-muted" title="Volume da música (só para você)">
            {volume === 0 ? <L.VolumeX size={13} /> : <L.Volume2 size={13} />}
            <input
              type="range"
              min={0}
              max={100}
              value={volume}
              onChange={(e) => setMusicVolume(Number(e.target.value))}
              className="h-1 flex-1 cursor-pointer accent-[var(--color-accent)]"
            />
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
    <div className="max-h-[450px] space-y-0.5 overflow-y-auto scroll-smooth pr-0.5 [scrollbar-width:thin]">
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
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={thumbOf(t.videoId)} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
            <div className="min-w-0 flex-1">
              <p className={cx('truncate text-xs font-medium', current && 'text-accent')} title={t.title}>
                {t.title}
              </p>
              <p className="truncate text-[10px] text-muted">
                {formatDuration(t.duration)} • {displayNameIn(st, m.serverId, t.addedBy)}
              </p>
            </div>
            <span className="hidden shrink-0 items-center group-hover:flex">
              {dj && !current && (
                <button title="Tocar agora" onClick={() => musicControl({ channelId: m.channelId, action: 'jump', index: i })} className="p-0.5 text-muted hover:text-fg">
                  <L.Play size={13} />
                </button>
              )}
              {canRemove && (
                <button title="Tirar da fila" onClick={() => musicControl({ channelId: m.channelId, action: 'remove', uid: t.uid })} className="p-0.5 text-muted hover:text-danger">
                  <L.Trash2 size={13} />
                </button>
              )}
            </span>
          </div>
        );
      })}
      {m.tracks.length - m.index <= 1 && <p className="px-2 py-2 text-xs text-muted">Nada na fila. Use /play [link] no chat.</p>}
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
  if (!live || !serverId) return null;
  const bot = botOf(serverId);
  if (!bot) return null;
  const track = live.tracks[live.index];
  return (
    <button
      onClick={(e) => actions.openModal({ kind: 'user', userId: bot.id, at: { x: e.clientX, y: e.clientY } })}
      className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1 text-left text-[15px] text-soft hover:bg-hover"
      title={track ? `Tocando: ${track.title}` : undefined}
    >
      <span className="relative flex h-6 w-6 shrink-0 items-center justify-center">
        <Avatar name={bot.displayName} color={bot.avatarColor} src={bot.avatarUrl} size={24} />
        {!live.paused && <span className="pointer-events-none absolute -inset-[3px] animate-pulse rounded-full border-2 border-accent" />}
      </span>
      <span className="flex-1 truncate">{displayNameIn(useLine.getState(), serverId, bot.id)}</span>
      <BotTag />
    </button>
  );
}

export function BotTag() {
  return <span className="shrink-0 rounded bg-accent px-1 text-[9px] leading-[14px] font-bold text-on-accent">BOT</span>;
}

// ---------- Configurações do servidor → Integrações → Música ----------

type Img = { id: string | null; url: string | null; uploading?: boolean };

export function MusicSettings({ serverId }: { serverId: string }) {
  const [bot, setBot] = useState<PublicUser | null>(null);
  const [name, setName] = useState('');
  const [pronouns, setPronouns] = useState('');
  const [thought, setThought] = useState('');
  const [bio, setBio] = useState('');
  const [color, setColor] = useState('#7c6af2');
  const [avatar, setAvatar] = useState<Img>({ id: null, url: null });
  const [banner, setBanner] = useState<Img>({ id: null, url: null });
  const [changed, setChanged] = useState<{ avatar?: boolean; banner?: boolean }>({});
  const [crop, setCrop] = useState<{ file: File; kind: 'avatar' | 'banner' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .musicBot(serverId)
      .then((b) => {
        setBot(b);
        setName(b.displayName);
        setPronouns(b.pronouns ?? '');
        setThought(b.thought ?? '');
        setBio(b.bio);
        setColor(b.avatarColor);
        setAvatar({ id: null, url: b.avatarUrl ?? null });
        setBanner({ id: null, url: b.bannerUrl ?? null });
      })
      .catch((e) => setError((e as Error).message));
  }, [serverId]);

  async function upload(file: File, kind: 'avatar' | 'banner') {
    if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') return setError('Escolha uma imagem (PNG, JPG, GIF ou WebP).');
    if (file.size > 8 * 1024 * 1024) return setError('A imagem precisa ter até 8 MB.');
    const set = kind === 'avatar' ? setAvatar : setBanner;
    const prev = kind === 'avatar' ? avatar : banner;
    setError('');
    const local = URL.createObjectURL(file);
    set({ id: null, url: local, uploading: true });
    try {
      const a = await api.uploadAttachment(file, file.name || 'imagem');
      set({ id: a.id, url: local });
      setChanged((c) => ({ ...c, [kind]: true }));
    } catch (e) {
      set(prev);
      setError(`Não deu para enviar a imagem: ${(e as Error).message}`);
    }
  }
  const pick = (file: File, kind: 'avatar' | 'banner') =>
    file.type === 'image/gif' || !file.type.startsWith('image/') ? void upload(file, kind) : setCrop({ file, kind });

  async function save() {
    setBusy(true);
    setError('');
    try {
      const b = await api.updateMusicBot(serverId, {
        displayName: name.trim() || 'Line Música',
        bio,
        avatarColor: color,
        pronouns: pronouns.trim(),
        thought: thought.trim() || null,
        ...(changed.avatar ? { avatarId: avatar.id } : {}),
        ...(changed.banner ? { bannerId: banner.id } : {}),
      });
      actions.upsertUsers([b]);
      setBot(b);
      setChanged({});
      toast('Perfil do bot salvo.');
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  const uploading = avatar.uploading || banner.uploading;
  return (
    <div className="max-w-4xl">
      <h2 className="text-xl font-bold">Música</h2>
      <p className="mt-1 mb-6 text-sm text-soft">
        O bot entra no canal de voz quando alguém digita <code className="rounded bg-raise px-1">/play [link do YouTube]</code> num canal de texto. Quem
        começou a tocar controla tudo; os outros votam para pular, voltar ou pausar.
      </p>
      {!bot ? (
        error ? <ErrorText>{error}</ErrorText> : <p className="text-sm text-muted">Carregando…</p>
      ) : (
        <div className="flex flex-col gap-8 lg:flex-row">
          <div className="min-w-0 flex-1 space-y-5">
            <Field label="Nome do bot">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
            </Field>
            <Field label="Pronomes">
              <Input value={pronouns} onChange={(e) => setPronouns(e.target.value)} maxLength={40} />
            </Field>
            <Field label="Pensamento" hint="Balãozinho ao lado da foto.">
              <Input value={thought} onChange={(e) => setThought(e.target.value)} maxLength={80} />
            </Field>
            <Field label="Descrição">
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                maxLength={190}
                rows={3}
                className="w-full resize-none rounded-lg border border-edge bg-rail px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </Field>
            <Field label="Cor do perfil">
              <div className="flex flex-wrap gap-2">
                {['#7c6af2', '#f5c451', '#2b6cff', '#ff5a5f', '#8e4ec6', '#12a594', '#f76b15', '#d6409f', '#b5b5bf'].map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className={cx('h-8 w-8 rounded-full ring-offset-2 ring-offset-side', color === c && 'ring-2 ring-fg')}
                    style={{ background: c }}
                    aria-label={c}
                  />
                ))}
              </div>
            </Field>
            <ErrorText>{error}</ErrorText>
            <div className="flex justify-end">
              <Button disabled={busy || uploading} onClick={save} className="px-6">
                {uploading ? 'Enviando imagem…' : busy ? 'Salvando…' : 'Salvar'}
              </Button>
            </div>
          </div>
          <div className="shrink-0 lg:w-[320px]">
            <p className="mb-2 text-xs font-bold tracking-wide text-muted uppercase">Prévia</p>
            <ProfileCard
              name={name || 'Line Música'}
              username={bot.username}
              pronouns={pronouns}
              thought={thought}
              bio={bio}
              color={color}
              avatarUrl={avatar.url}
              bannerUrl={banner.url}
              onAvatarFile={(f) => pick(f, 'avatar')}
              onBannerFile={(f) => pick(f, 'banner')}
            />
            <p className="mt-2 text-xs text-muted">Clique no banner ou na foto para trocar.</p>
            <div className="mt-1 flex flex-wrap gap-x-3">
              {avatar.url && (
                <button className="text-xs text-soft hover:text-danger hover:underline" onClick={() => (setAvatar({ id: null, url: null }), setChanged((c) => ({ ...c, avatar: true })))}>
                  Remover foto
                </button>
              )}
              {banner.url && (
                <button className="text-xs text-soft hover:text-danger hover:underline" onClick={() => (setBanner({ id: null, url: null }), setChanged((c) => ({ ...c, banner: true })))}>
                  Remover banner
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {crop && (
        <ImageCropper
          file={crop.file}
          kind={crop.kind}
          onCancel={() => setCrop(null)}
          onApply={(f) => {
            const kind = crop.kind;
            setCrop(null);
            void upload(f, kind);
          }}
        />
      )}
    </div>
  );
}

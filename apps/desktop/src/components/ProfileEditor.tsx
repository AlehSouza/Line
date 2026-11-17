'use client';

import type { FavoriteSong, ProfileConnection, ProfileGame, UserProfile } from '@line/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { StyledName } from '@/lib/nameStyle';
import { ActivityList, FullProfile } from './FullProfile';
import { CallLookEditor } from './CallLook';
import { NameStyleModal } from './NameStyleModal';
import { ConnectionsEditor, GamesBoard, SongEditor } from './ProfileExtras';
import { api, fileUrl } from '@/lib/api';
import { actions, useLine } from '@/lib/store';
import { useShallow } from 'zustand/react/shallow';
import { TagIcon } from './ServerTag';
import { Avatar, Button, cx, ErrorText, Field, Icons, Input } from './ui';
import { EmojiInput } from './EmojiField';

const COLORS = ['#7c6af2', '#f5c451', '#2b6cff', '#ff5a5f', '#8e4ec6', '#12a594', '#f76b15', '#d6409f', '#b5b5bf'];

/** Editor de perfil: o cartão do perfil completo, editável na hora, e ao lado as outras opções (salvas pelo botão). */
export function ProfileEditor({ onSaved, onCancel }: { onSaved?: () => void; onCancel?: () => void }) {
  const me = useLine((s) => s.me);
  const [customStatus, setCustomStatus] = useState(me?.customStatus ?? '');
  const [color, setColor] = useState(me?.avatarColor ?? COLORS[0]!);
  const [tagServerId, setTagServerId] = useState<string | null>(me?.tag?.serverId ?? null);
  const taggedServers = useLine(useShallow((s) => Object.values(s.servers).filter((sv) => sv.tag)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [extras, setExtras] = useState<UserProfile | null>(null);
  const [favorite, setFavorite] = useState<ProfileGame | null>(null);
  const [liked, setLiked] = useState<ProfileGame[]>([]);
  const [connections, setConnections] = useState<ProfileConnection[]>([]);
  const [song, setSong] = useState<FavoriteSong | null>(null);
  const [extrasChanged, setExtrasChanged] = useState(false);
  const [nameStyleOpen, setNameStyleOpen] = useState(false);
  const [tab, setTab] = useState<'games' | 'activity'>('games');
  const [left, setLeft] = useState<'card' | 'call'>('card');

  useEffect(() => {
    if (!me) return;
    api.profile(me.id).then((p) => {
      setExtras(p);
      setFavorite(p.favoriteGame);
      setLiked(p.likedGames);
      setConnections(p.connections);
      setSong(p.favoriteSong ?? null);
    }, () => {});
  }, [me?.id]);
  if (!me) return null;
  const changeExtras = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setExtrasChanged(true);
  };

  async function save() {
    setBusy(true);
    setError('');
    try {
      if (extrasChanged) {
        await api.updateProfileExtras({ favoriteGame: favorite, likedGames: liked });
        setExtrasChanged(false);
      }
      setSaved(true);
      onSaved?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
    <div className="flex flex-col gap-8 xl:flex-row xl:items-start">
      <div className="flex w-full shrink-0 flex-col xl:sticky xl:top-5 xl:h-[calc(100cqh-2.5rem)] xl:w-[400px]">
        <div className="mb-4 flex justify-center gap-6 border-b border-edge">
          <>
            {(
              [
                ['card', 'Cartão'],
                ['call', 'Chamada'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setLeft(id)}
                className={cx('-mb-px border-b-2 pb-2 text-sm font-semibold', left === id ? 'border-fg text-fg' : 'border-transparent text-soft hover:text-fg')}
              >
                {label}
              </button>
            ))}
          </>
        </div>
        {left === 'card' ? (
          <FullProfile userId={me.id} embedded onClose={() => {}} />
        ) : (
          <CallLookEditor />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-5">
        <div>
          <div className="mb-3 flex gap-5 border-b border-edge">
            {(
              [
                ['games', 'Jogos'],
                ['activity', 'Atividade'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cx('-mb-px border-b-2 pb-2 text-sm font-semibold', tab === id ? 'border-fg text-fg' : 'border-transparent text-soft hover:text-fg')}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === 'games' ? (
            <GamesBoard favorite={favorite} liked={liked} edit={{ setFavorite: changeExtras(setFavorite), setLiked: changeExtras(setLiked) }} />
          ) : (
            <ActivityList profile={extras} />
          )}
        </div>
      </div>

      {nameStyleOpen && <NameStyleModal onClose={() => setNameStyleOpen(false)} />}
    </div>
      <ErrorText>{error}</ErrorText>
      <div className="flex items-center justify-end gap-2 border-t border-edge pt-4">
        {saved && <span className="mr-auto text-sm text-muted">Perfil salvo.</span>}
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
        )}
        <Button disabled={busy} onClick={save} className="px-6">
          {busy ? 'Salvando…' : 'Salvar'}
        </Button>
      </div>
    </div>
  );
}

/** Área clicável que abre o seletor de imagem, com um véu e ícone ao passar o mouse. */
export function ImagePick({ onFile, className, round, children }: { onFile?: (f: File) => void; className?: string; round?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLInputElement>(null);
  if (!onFile) return <div className={className}>{children}</div>;
  return (
    <button type="button" title="Trocar imagem" onClick={() => ref.current?.click()} className={cx('group/pick relative block cursor-pointer', className)}>
      {children}
      <span
        className={cx(
          'absolute inset-0 flex items-center justify-center bg-black/50 text-white opacity-0 transition-opacity group-hover/pick:opacity-100',
          round && 'rounded-full',
        )}
      >
        <Icons.Camera size={round ? 22 : 26} />
      </span>
      <input
        ref={ref}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
    </button>
  );
}

/** Cartão de perfil (prévia no editor e cartão de outras pessoas). */
export function ProfileCard({
  name,
  username,
  pronouns,
  thought,
  bio,
  status,
  color,
  avatarUrl,
  bannerUrl,
  createdAt,
  nameStyle,
  children,
  onAvatarFile,
  onBannerFile,
}: {
  name: string;
  username: string;
  pronouns?: string;
  thought?: string | null;
  bio?: string;
  status?: string | null;
  color: string;
  avatarUrl?: string | null;
  bannerUrl?: string | null;
  createdAt?: string;
  nameStyle?: import('@line/shared').NameStyle | null;
  children?: ReactNode;
  /** Só no editor: deixa banner e foto clicáveis. */
  onAvatarFile?: (f: File) => void;
  onBannerFile?: (f: File) => void;
}) {
  // Blob local (prévia) ou caminho do servidor.
  const src = (u?: string | null) => (u ? (u.startsWith('blob:') ? u : fileUrl(u)) : null);
  const banner = src(bannerUrl);
  return (
    <div
      className="overflow-hidden rounded-2xl border border-edge shadow-xl"
      style={{ background: `linear-gradient(to bottom, color-mix(in srgb, ${color} 35%, var(--color-rail)), var(--color-rail) 55%)` }}
    >
      <ImagePick onFile={onBannerFile} className="h-28 w-full">
        <div className="h-full w-full" style={banner ? undefined : { background: color }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {banner && <img src={banner} alt="" className="h-full w-full object-cover" />}
        </div>
      </ImagePick>
      <div className="relative px-4 pb-4">
        <div className="-mt-11 flex items-end gap-2">
          <span className="relative rounded-full border-[5px] border-rail">
            <ImagePick onFile={onAvatarFile} round className="rounded-full">
              {avatarUrl?.startsWith('blob:') ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={avatarUrl} alt="" className="h-20 w-20 rounded-full object-cover" />
              ) : (
                <Avatar name={name} color={color} src={avatarUrl} size={80} />
              )}
            </ImagePick>
          </span>
          {thought && (
            <span className="relative mb-6 max-w-[180px] rounded-2xl border border-edge bg-side px-3 py-1.5 text-xs text-soft shadow-lg">
              <span className="absolute -bottom-1.5 left-2 h-3 w-3 rounded-full border border-edge bg-side" />
              {thought}
            </span>
          )}
        </div>
        <p className="mt-2 text-xl font-bold">
          <StyledName style={nameStyle ?? null}>{name}</StyledName>
        </p>
        <p className="text-sm text-soft">
          {username}
          {pronouns && <span className="text-muted"> • {pronouns}</span>}
        </p>
        {status && <p className="mt-1 text-sm text-soft">{status}</p>}
        {children}
        {bio && (
          <div className="mt-4">
            <p className="text-xs font-bold text-muted">Bio</p>
            <p className="mt-0.5 text-sm break-words whitespace-pre-wrap">{bio}</p>
          </div>
        )}
        {createdAt && (
          <div className="mt-3">
            <p className="text-xs font-bold text-muted">Membro desde</p>
            <p className="mt-0.5 text-sm">{new Date(createdAt).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
          </div>
        )}
      </div>
    </div>
  );
}

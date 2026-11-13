'use client';

import { useRef, useState, type ReactNode } from 'react';
import { api, fileUrl } from '@/lib/api';
import { actions, useLine } from '@/lib/store';
import { ImageCropper } from './ImageCropper';
import { Avatar, Button, cx, ErrorText, Field, Icons, Input } from './ui';

const COLORS = ['#7c6af2', '#f5c451', '#2b6cff', '#ff5a5f', '#8e4ec6', '#12a594', '#f76b15', '#d6409f', '#b5b5bf'];

type Image = { id: string | null; url: string | null; uploading?: boolean };

/** Editor de perfil: foto, banner, nome, pronomes, pensamento, bio e conexões, com prévia do cartão ao lado. */
export function ProfileEditor({ onSaved, onCancel }: { onSaved?: () => void; onCancel?: () => void }) {
  const me = useLine((s) => s.me);
  const [displayName, setDisplayName] = useState(me?.displayName ?? '');
  const [pronouns, setPronouns] = useState(me?.pronouns ?? '');
  const [thought, setThought] = useState(me?.thought ?? '');
  const [bio, setBio] = useState(me?.bio ?? '');
  const [customStatus, setCustomStatus] = useState(me?.customStatus ?? '');
  const [color, setColor] = useState(me?.avatarColor ?? COLORS[0]!);
  const [avatar, setAvatar] = useState<Image>({ id: null, url: me?.avatarUrl ?? null });
  const [banner, setBanner] = useState<Image>({ id: null, url: me?.bannerUrl ?? null });
  const [avatarChanged, setAvatarChanged] = useState(false);
  const [bannerChanged, setBannerChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [crop, setCrop] = useState<{ file: File; kind: 'avatar' | 'banner' } | null>(null);
  if (!me) return null;

  /** Escolheu a imagem: abre o recorte (GIF vai direto para manter a animação). */
  function pick(file: File, kind: 'avatar' | 'banner') {
    if (file.type === 'image/gif' || !file.type.startsWith('image/')) return finish(file, kind);
    setCrop({ file, kind });
  }
  function finish(file: File, kind: 'avatar' | 'banner') {
    if (kind === 'avatar') void upload(file, setAvatar, () => setAvatarChanged(true));
    else void upload(file, setBanner, () => setBannerChanged(true));
  }

  async function upload(file: File, set: (i: Image) => void, mark: () => void) {
    if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') return setError('Escolha uma imagem (PNG, JPG, GIF ou WebP).');
    if (file.size > 8 * 1024 * 1024) return setError('A imagem precisa ter até 8 MB.');
    setError('');
    const local = URL.createObjectURL(file);
    set({ id: null, url: local, uploading: true });
    try {
      const a = await api.uploadAttachment(file, file.name || 'imagem');
      set({ id: a.id, url: local });
      mark();
    } catch (e) {
      set({ id: null, url: null });
      setError((e as Error).message);
    }
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      actions.setMe(
        await api.updateMe({
          displayName,
          bio,
          avatarColor: color,
          customStatus: customStatus.trim() || null,
          pronouns: pronouns.trim(),
          thought: thought.trim() || null,
          ...(avatarChanged ? { avatarId: avatar.id } : {}),
          ...(bannerChanged ? { bannerId: banner.id } : {}),
        }),
      );
      setSaved(true);
      onSaved?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const uploading = avatar.uploading || banner.uploading;

  return (
    <div className="flex flex-col gap-8 lg:flex-row">
      <div className="min-w-0 flex-1 space-y-5">
        <Field label="Nome de exibição">
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={32} />
        </Field>
        <Field label="Pronomes">
          <Input value={pronouns} onChange={(e) => setPronouns(e.target.value)} maxLength={40} placeholder="ele/dele, ela/dela…" />
        </Field>
        <Field label="Pensamento" hint="Aparece num balãozinho ao lado da sua foto.">
          <Input value={thought} onChange={(e) => setThought(e.target.value)} maxLength={80} placeholder="No que você está pensando?" />
        </Field>
        <Field label="Status personalizado">
          <Input value={customStatus} onChange={(e) => setCustomStatus(e.target.value)} maxLength={128} placeholder="Jogando, estudando, no rolê…" />
        </Field>
        <Field label="Sobre mim">
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={190}
            rows={3}
            className="w-full resize-none rounded-lg border border-edge bg-rail px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>
        <Field label="Cor do perfil" hint="Usada no avatar sem foto e no fundo do cartão.">
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => (
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

        <div>
          <p className="mb-2 text-xs font-bold tracking-wide text-muted uppercase">Conexões</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {['Spotify', 'Twitch', 'Steam', 'GitHub'].map((n) => (
              <button
                key={n}
                disabled
                title="Em breve"
                className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-edge px-3 py-2.5 text-sm text-muted"
              >
                <Icons.Link size={16} /> {n}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted">Em breve você vai poder conectar suas contas.</p>
        </div>

        <ErrorText>{error}</ErrorText>
        <div className="flex items-center justify-end gap-2">
          {saved && <span className="mr-auto text-sm text-muted">Perfil salvo.</span>}
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              Cancelar
            </Button>
          )}
          <Button disabled={busy || uploading} onClick={save}>
            {uploading ? 'Enviando imagem…' : busy ? 'Salvando…' : 'Salvar'}
          </Button>
        </div>
      </div>

      {crop && (
        <ImageCropper
          file={crop.file}
          kind={crop.kind}
          onCancel={() => setCrop(null)}
          onApply={(f) => {
            setCrop(null);
            finish(f, crop.kind);
          }}
        />
      )}
      <div className="shrink-0 lg:w-[320px]">
        <p className="mb-2 text-xs font-bold tracking-wide text-muted uppercase">Prévia</p>
        <ProfileCard
          name={displayName || me.username}
          username={me.username}
          pronouns={pronouns}
          thought={thought}
          bio={bio}
          status={customStatus}
          color={color}
          avatarUrl={avatar.url}
          bannerUrl={banner.url}
          createdAt={me.createdAt}
          onAvatarFile={(f) => pick(f, 'avatar')}
          onBannerFile={(f) => pick(f, 'banner')}
        />
        <p className="mt-2 text-xs text-muted">Clique no banner ou na foto para trocar.</p>
        <div className="mt-1 flex flex-wrap gap-x-3">
          {avatar.url && (
            <button className="text-xs text-soft hover:text-danger hover:underline" onClick={() => (setAvatar({ id: null, url: null }), setAvatarChanged(true))}>
              Remover foto
            </button>
          )}
          {banner.url && (
            <button className="text-xs text-soft hover:text-danger hover:underline" onClick={() => (setBanner({ id: null, url: null }), setBannerChanged(true))}>
              Remover banner
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Área clicável que abre o seletor de imagem, com um véu e ícone ao passar o mouse. */
function ImagePick({ onFile, className, round, children }: { onFile?: (f: File) => void; className?: string; round?: boolean; children: ReactNode }) {
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
        <p className="mt-2 text-xl font-bold">{name}</p>
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

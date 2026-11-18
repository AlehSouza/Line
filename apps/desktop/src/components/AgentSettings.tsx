'use client';

import type { FavoriteSong, NameStyle, PublicUser } from '@line/shared';
import * as L from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, fileUrl, type AgentReply } from '@/lib/api';
import { DEFAULT_NOW_PLAYING, formatNowPlaying } from '@/lib/music';
import { StyledName } from '@/lib/nameStyle';
import { actions } from '@/lib/store';
import { showError, toast } from './Dialogs';
import { ImageCropper } from './ImageCropper';
import { CardColorButton, cardStyle, SongSlot } from './InlineProfileEdit';
import { BotTag, useServerBot } from './Music';
import { NameStyleModal } from './NameStyleModal';
import { ImagePick } from './ProfileEditor';
import { SongPlayer } from './ProfileExtras';
import { Avatar, Button, cx, ErrorText, Field, SwatchRow } from './ui';
import { EmojiInput, EmojiTextarea } from './EmojiField';

// ---------- Configurações do servidor → Agente → Personalizar ----------

type Img = { id: string | null; url: string | null; uploading?: boolean };
type Presence = 'online' | 'idle' | 'dnd' | 'invisible';

const PROFILE_COLORS = ['#7c6af2', '#f5c451', '#2b6cff', '#ff5a5f', '#8e4ec6', '#12a594', '#f76b15', '#d6409f', '#b5b5bf'];
const PRESENCES = [
  ['online', 'Online', 'bg-online'],
  ['idle', 'Ausente', 'bg-idle'],
  ['dnd', 'Não perturbar', 'bg-danger'],
  ['invisible', 'Invisível', 'bg-muted'],
] as const;
const SAMPLE_TRACK = { title: 'Nome da música', author: 'Artista' };

/**
 * Personalizar agente: igual ao Perfil da pessoa, com as abas Cartão (cartão simples e perfil
 * completo, cores em degradê, estilo do nome, música favorita) e Chamada (anel de fala e status
 * do canal enquanto toca). Textos salvam no botão; cores do cartão, estilo e música salvam na hora.
 */
export function MusicSettings({ serverId }: { serverId: string }) {
  const [bot, setBot] = useState<PublicUser | null>(null);
  const [tab, setTab] = useState<'card' | 'call'>('card');
  const [view, setView] = useState<'simple' | 'full'>('simple');
  const [name, setName] = useState('');
  const [pronouns, setPronouns] = useState('');
  const [thought, setThought] = useState('');
  const [bio, setBio] = useState('');
  const [color, setColor] = useState('#7c6af2');
  const [nameColor, setNameColor] = useState<string | null>(null);
  const [tagColor, setTagColor] = useState<string | null>(null);
  const [tagText, setTagText] = useState<'BOT' | 'B'>('BOT');
  const [ringColor, setRingColor] = useState<string | null>(null);
  const [nowPlaying, setNowPlaying] = useState<string | null>(null);
  const [status, setStatus] = useState<Presence>('online');
  const [customStatus, setCustomStatus] = useState('');
  const [avatar, setAvatar] = useState<Img>({ id: null, url: null });
  const [banner, setBanner] = useState<Img>({ id: null, url: null });
  const [changed, setChanged] = useState<{ avatar?: boolean; banner?: boolean }>({});
  const [crop, setCrop] = useState<{ file: File; kind: 'avatar' | 'banner' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [idle, setIdle] = useState('');
  const [idleDefault, setIdleDefault] = useState('Esperando a próxima banger 😈');
  // Salvos na hora (como no perfil da pessoa).
  const [cardColors, setCardColors] = useState<string[] | null>(null);
  const [song, setSong] = useState<FavoriteSong | null>(null);
  const [nameStyle, setNameStyle] = useState<NameStyle | null>(null);
  const [styleOpen, setStyleOpen] = useState(false);

  useEffect(() => {
    api
      .musicSettings(serverId)
      .then((s) => {
        setIdle(s.idleMessage);
        setIdleDefault(s.defaultIdleMessage);
      })
      .catch(() => {});
    api
      .musicBot(serverId)
      .then((b) => {
        setBot(b);
        setName(b.displayName);
        setPronouns(b.pronouns ?? '');
        setThought(b.thought ?? '');
        setBio(b.bio);
        setColor(b.avatarColor);
        setNameColor(b.botStyle?.nameColor ?? null);
        setTagColor(b.botStyle?.tagColor ?? null);
        setTagText(b.botStyle?.tagText ?? 'BOT');
        setRingColor(b.botStyle?.ringColor ?? null);
        setNowPlaying(b.botStyle?.nowPlaying ?? null);
        setNameStyle(b.nameStyle ?? null);
        setStatus(b.presence === 'offline' ? 'invisible' : b.presence === 'idle' || b.presence === 'dnd' ? b.presence : 'online');
        setCustomStatus(b.customStatus ?? '');
        setAvatar({ id: null, url: b.avatarUrl ?? null });
        setBanner({ id: null, url: b.bannerUrl ?? null });
        api.profile(b.id).then(
          (p) => {
            setCardColors(p.cardColors ?? null);
            setSong(p.favoriteSong ?? null);
          },
          () => {},
        );
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
        botNameColor: nameColor,
        botTagColor: tagColor,
        botTagText: tagText,
        botRingColor: ringColor,
        botNowPlaying: nowPlaying === null ? null : nowPlaying.trim(),
        status,
        customStatus: customStatus.trim() || null,
        ...(changed.avatar ? { avatarId: avatar.id } : {}),
        ...(changed.banner ? { bannerId: banner.id } : {}),
      });
      const s = await api.updateMusicSettings(serverId, { idleMessage: idle.trim() });
      setIdle(s.idleMessage);
      actions.upsertUsers([b]);
      setBot(b);
      setChanged({});
      toast('Agente salvo.');
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  const saveExtras = async (patch: Parameters<typeof api.updateAgentProfile>[1]) => api.updateAgentProfile(serverId, patch);

  const uploading = avatar.uploading || banner.uploading;
  const shownName = name || 'Line Música';
  const preview: AgentLook = {
    name: shownName,
    pronouns,
    thought,
    bio,
    color,
    nameColor,
    nameStyle,
    tag: { nameColor, tagColor, tagText },
    customStatus,
    presence: status,
    avatarUrl: avatar.url,
    bannerUrl: banner.url,
    cardColors,
    song,
  };

  return (
    <div className="max-w-5xl">
      <h2 className="text-xl font-bold">Personalizar agente</h2>
      <p className="mt-1 mb-5 text-sm text-soft">
        Tudo sobre o agente do servidor: perfil, cartão, cores e música. Ele entra no canal de voz quando alguém digita{' '}
        <code className="rounded bg-raise px-1">/play [link ou nome da música]</code> num canal de texto. Quem começou a tocar controla tudo; os outros votam para pular, voltar ou
        pausar.
      </p>
      {!bot ? (
        error ? <ErrorText>{error}</ErrorText> : <p className="text-sm text-muted">Carregando…</p>
      ) : (
        <>
          <div className="mb-5 flex gap-6 border-b border-edge">
            {(
              [
                ['card', 'Cartão'],
                ['call', 'Chamada'],
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
          <div className="flex flex-col gap-8 lg:flex-row-reverse lg:items-start">
            {/* Prévia (à direita no desktop, como no editor de perfil) */}
            <div className="w-full shrink-0 lg:sticky lg:top-0 lg:w-[360px]">
              {tab === 'card' ? (
                <>
                  <div className="mb-3 inline-flex rounded-lg border border-edge bg-rail p-0.5">
                    {(
                      [
                        ['simple', 'Cartão simples'],
                        ['full', 'Perfil completo'],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setView(id)}
                        className={cx('rounded-md px-2.5 py-1 text-xs font-semibold', view === id ? 'bg-accent text-on-accent' : 'text-soft hover:text-fg')}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <AgentCard look={preview} full={view === 'full'} onAvatarFile={(f) => pick(f, 'avatar')} onBannerFile={(f) => pick(f, 'banner')} />
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
                </>
              ) : (
                <AgentCallPreview look={preview} ringColor={ringColor} nowPlaying={nowPlaying} />
              )}
            </div>

            <div className="min-w-0 flex-1 space-y-5">
              {tab === 'card' ? (
                <>
                  <Field label="Nome do agente">
                    <EmojiInput value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
                  </Field>
                  <Field label="Pronomes">
                    <EmojiInput value={pronouns} onChange={(e) => setPronouns(e.target.value)} maxLength={40} />
                  </Field>
                  <Field label="Pensamento" hint="Balãozinho ao lado da foto.">
                    <EmojiInput value={thought} onChange={(e) => setThought(e.target.value)} maxLength={80} />
                  </Field>
                  <Field label="Descrição">
                    <EmojiTextarea
                      value={bio}
                      onChange={(e) => setBio(e.target.value)}
                      maxLength={190}
                      rows={3}
                      className="w-full resize-none rounded-lg border border-edge bg-rail px-3 py-2 text-sm outline-none focus:border-accent"
                    />
                  </Field>
                  <Field label="Status" hint="Como o agente aparece na lista de membros e no cartão." group>
                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-2">
                        {PRESENCES.map(([v, label, dot]) => (
                          <button
                            key={v}
                            type="button"
                            onClick={() => setStatus(v)}
                            className={cx(
                              'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm',
                              status === v ? 'border-accent bg-accent/15 text-fg' : 'border-edge text-soft hover:bg-raise',
                            )}
                          >
                            <span className={cx('h-2.5 w-2.5 rounded-full', dot)} /> {label}
                          </button>
                        ))}
                      </div>
                      <EmojiInput value={customStatus} onChange={(e) => setCustomStatus(e.target.value)} maxLength={128} placeholder="Status personalizado (ex.: Tocando as melhores 🎶)" />
                    </div>
                  </Field>
                  <Field label="Cor do perfil" hint="Fundo da foto e do banner quando não há imagem." group>
                    <div className="flex flex-wrap gap-2">
                      {PROFILE_COLORS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setColor(c)}
                          className={cx('h-8 w-8 rounded-full ring-offset-2 ring-offset-side', color === c && 'ring-2 ring-fg')}
                          style={{ background: c }}
                          aria-label={c}
                        />
                      ))}
                    </div>
                  </Field>
                  <Field label="Cores do cartão" hint="Degradê de cima para baixo, igual ao do seu perfil. Salva ao fechar o seletor." group>
                    <div className="flex items-center gap-3">
                      <CardColorButton
                        colors={cardColors}
                        fallback={color}
                        size="size-9"
                        onPreview={setCardColors}
                        save={(c) => saveExtras({ cardColors: c }).then((r) => setCardColors(r.cardColors ?? null))}
                      />
                      <span className="text-sm text-soft">{cardColors?.length ? 'Degradê personalizado' : 'Padrão (cor do perfil)'}</span>
                    </div>
                  </Field>
                  <Field label="Nome no chat e na lista" hint="Estilo do nome (fonte, efeito e cores) e etiqueta do agente." group>
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 rounded-lg border border-edge bg-rail px-3 py-2.5">
                        <StyledName style={nameStyle} color={nameColor ?? undefined} className="font-semibold">
                          {shownName}
                        </StyledName>
                        <BotTag style={{ nameColor, tagColor, tagText }} />
                        <span className="flex-1" />
                        <Button variant="ghost" onClick={() => setStyleOpen(true)} className="gap-1.5 px-3 py-1 text-xs">
                          <L.Sparkles size={14} /> Estilo do nome
                        </Button>
                      </div>
                      {!nameStyle && (
                        <div>
                          <p className="mb-1.5 text-xs text-muted">Cor do nome (sem estilo)</p>
                          <SwatchRow value={nameColor} onChange={setNameColor} noneLabel="Cor do cargo" />
                        </div>
                      )}
                      <div>
                        <p className="mb-1.5 text-xs text-muted">Cor da etiqueta</p>
                        <SwatchRow value={tagColor} onChange={setTagColor} noneLabel="Padrão" />
                      </div>
                      <div>
                        <p className="mb-1.5 text-xs text-muted">Texto da etiqueta</p>
                        <div className="flex gap-2">
                          {(['BOT', 'B'] as const).map((t) => (
                            <button
                              key={t}
                              type="button"
                              onClick={() => setTagText(t)}
                              className={cx(
                                'rounded-lg border px-3 py-1.5 text-sm font-bold',
                                tagText === t ? 'border-accent bg-accent/15 text-fg' : 'border-edge text-soft hover:bg-raise',
                              )}
                            >
                              {t}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </Field>
                  <Field label="Música favorita" hint="Aparece no cartão do agente, com prévia de 25 segundos." group>
                    <SongSlot song={song} colors={cardColors} onChange={setSong} save={(p) => saveExtras(p)} />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Cor do anel de fala" hint="A bolinha em volta da foto do agente na lista do canal de voz enquanto ele toca." group>
                    <SwatchRow value={ringColor} onChange={setRingColor} noneLabel="Cor de destaque" />
                  </Field>
                  <Field label="Status do canal enquanto toca" hint="Quando ninguém definiu um status no canal de voz, o agente mostra a música tocando." group>
                    <div className="space-y-2">
                      <div className="flex gap-2">
                        {(
                          [
                            [true, 'Mostrar a música'],
                            [false, 'Não mostrar'],
                          ] as const
                        ).map(([on, label]) => {
                          const active = on ? nowPlaying !== '' : nowPlaying === '';
                          return (
                            <button
                              key={label}
                              type="button"
                              onClick={() => setNowPlaying(on ? (nowPlaying === '' ? null : nowPlaying) : '')}
                              className={cx(
                                'rounded-lg border px-3 py-1.5 text-sm',
                                active ? 'border-accent bg-accent/15 text-fg' : 'border-edge text-soft hover:bg-raise',
                              )}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                      {nowPlaying !== '' && (
                        <>
                          <EmojiInput
                            value={nowPlaying ?? ''}
                            onChange={(e) => setNowPlaying(e.target.value || null)}
                            maxLength={100}
                            placeholder={DEFAULT_NOW_PLAYING}
                          />
                          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                            Use
                            {['{musica}', '{artista}'].map((v) => (
                              <button
                                key={v}
                                type="button"
                                onClick={() => setNowPlaying(`${nowPlaying ?? DEFAULT_NOW_PLAYING} ${v}`.trim())}
                                className="rounded bg-raise px-1.5 py-0.5 font-mono text-soft hover:text-fg"
                              >
                                {v}
                              </button>
                            ))}
                            no texto. Vazio usa o padrão <code className="rounded bg-raise px-1">{DEFAULT_NOW_PLAYING}</code>.
                          </p>
                        </>
                      )}
                    </div>
                  </Field>
                  <Field label="Mensagem quando a fila acaba" hint="O agente fica na call e manda isso no chat onde a música foi pedida. Vazio usa a padrão.">
                    <EmojiInput value={idle} onChange={(e) => setIdle(e.target.value)} maxLength={300} placeholder={idleDefault} />
                  </Field>
                </>
              )}
              <ErrorText>{error}</ErrorText>
              <div className="flex justify-end">
                <Button disabled={busy || uploading} onClick={save} className="px-6">
                  {uploading ? 'Enviando imagem…' : busy ? 'Salvando…' : 'Salvar'}
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
      {styleOpen && bot && (
        <NameStyleModal
          target={{ ...bot, displayName: shownName, avatarColor: color, avatarUrl: avatar.url?.startsWith('blob:') ? bot.avatarUrl : avatar.url, nameStyle }}
          onClose={() => setStyleOpen(false)}
          onSave={async (st) => {
            await saveExtras({ nameStyle: st });
            setNameStyle(st);
            actions.upsertUsers([{ ...bot, nameStyle: st }]);
          }}
        />
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

type AgentLook = {
  name: string;
  pronouns: string;
  thought: string;
  bio: string;
  color: string;
  nameColor: string | null;
  nameStyle: NameStyle | null;
  tag: NonNullable<PublicUser['botStyle']>;
  customStatus: string;
  presence: Presence;
  avatarUrl: string | null;
  bannerUrl: string | null;
  cardColors: string[] | null;
  song: FavoriteSong | null;
};

const src = (u?: string | null) => (u ? (u.startsWith('blob:') ? u : fileUrl(u)) : null);

function AgentAvatar({ look, size }: { look: AgentLook; size: number }) {
  const presence = look.presence === 'invisible' ? 'offline' : look.presence;
  return look.avatarUrl?.startsWith('blob:') ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={look.avatarUrl} alt="" className="rounded-full object-cover" style={{ width: size, height: size }} />
  ) : (
    <Avatar name={look.name} color={look.color} src={look.avatarUrl} size={size} presence={presence} />
  );
}

/** Prévia do cartão do agente: simples (o cartão que abre no clique) ou o perfil completo. */
function AgentCard({ look, full, onAvatarFile, onBannerFile }: { look: AgentLook; full: boolean; onAvatarFile: (f: File) => void; onBannerFile: (f: File) => void }) {
  const banner = src(look.bannerUrl);
  const avatar = full ? 96 : 80;
  return (
    <div className="overflow-hidden rounded-2xl border border-edge shadow-xl" style={cardStyle(look.cardColors, look.color)}>
      <ImagePick onFile={onBannerFile} className={cx('w-full', full ? 'h-32' : 'h-[105px]')}>
        <div className="h-full w-full" style={banner ? undefined : { background: look.color }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {banner && <img src={banner} alt="" className="h-full w-full object-cover" />}
        </div>
      </ImagePick>
      <div className="relative px-4 pb-4">
        <div className={cx('flex items-end gap-2', full ? '-mt-12' : '-mt-10')}>
          <span className="relative rounded-full border-[5px] border-rail">
            <ImagePick onFile={onAvatarFile} round className="rounded-full">
              <AgentAvatar look={look} size={avatar} />
            </ImagePick>
          </span>
          {look.thought && (
            <span className="relative mb-6 max-w-[180px] rounded-2xl border border-edge bg-side px-3 py-1.5 text-xs text-soft shadow-lg">
              <span className="absolute -bottom-1.5 left-2 h-3 w-3 rounded-full border border-edge bg-side" />
              {look.thought}
            </span>
          )}
        </div>
        <p className={cx('mt-2 flex min-w-0 items-center gap-2 leading-tight font-bold', full ? 'text-2xl' : 'text-xl')}>
          <StyledName style={look.nameStyle} color={look.nameColor ?? undefined} className="truncate">
            {look.name}
          </StyledName>
          <BotTag style={look.tag} />
        </p>
        <p className="truncate text-sm text-soft">
          Agente do servidor
          {look.pronouns && <span className="text-muted"> • {look.pronouns}</span>}
        </p>
        {look.customStatus && <p className="mt-1.5 text-sm text-soft">{look.customStatus}</p>}
        {look.song && (
          <div className="mt-3">
            <SongPlayer song={look.song} colors={look.cardColors} />
          </div>
        )}
        {look.bio && (
          <Section title={full ? 'Sobre mim' : 'Bio'}>
            <p className="text-sm break-words whitespace-pre-wrap">{look.bio}</p>
          </Section>
        )}
        {full && (
          <Section title="Comandos">
            <p className="text-sm text-soft">
              <code className="rounded bg-black/30 px-1">/play</code> <code className="rounded bg-black/30 px-1">/pausar</code> <code className="rounded bg-black/30 px-1">/pular</code>{' '}
              <code className="rounded bg-black/30 px-1">/voltar</code> <code className="rounded bg-black/30 px-1">/stop</code>
            </p>
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4">
      <p className="text-xs font-bold text-muted">{title}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

/** Prévia da aba Chamada: o canal de voz na barra lateral com o agente tocando. */
function AgentCallPreview({ look, ringColor, nowPlaying }: { look: AgentLook; ringColor: string | null; nowPlaying: string | null }) {
  const status = nowPlaying === '' ? '' : formatNowPlaying(nowPlaying || DEFAULT_NOW_PLAYING, SAMPLE_TRACK.title, SAMPLE_TRACK.author);
  return (
    <div className="space-y-2">
      <p className="text-xs font-bold tracking-wide text-muted uppercase">Prévia</p>
      <div className="rounded-xl border border-edge bg-side px-2 py-2">
        <p className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[15px] text-soft">
          <L.Volume2 size={18} className="text-muted" />
          <span className="truncate">Canal de voz</span>
        </p>
        <div className="ml-6 space-y-1 pt-0.5">
          <p className={cx('truncate px-1.5 py-0.5 text-xs', status ? 'text-soft' : 'text-muted')}>{status || 'Definir um status do canal'}</p>
          <div className="flex items-center gap-2.5 rounded-md px-1.5 py-1 text-[15px] text-soft">
            <span className="relative flex h-6 w-6 shrink-0 items-center justify-center">
              <AgentAvatar look={{ ...look, presence: 'invisible' }} size={24} />
              <span
                className="pointer-events-none absolute -inset-[3px] animate-pulse rounded-full border-2 border-accent"
                style={ringColor ? { borderColor: ringColor } : undefined}
              />
            </span>
            <StyledName style={look.nameStyle} color={look.nameColor ?? undefined} className="flex-1 truncate">
              {look.name}
            </StyledName>
            <BotTag style={look.tag} />
          </div>
        </div>
      </div>
      <p className="text-xs text-muted">Se alguém da chamada definir um status, ele vale no lugar da música.</p>
    </div>
  );
}

// ---------- Configurações do servidor → Agente → Respostas inteligentes ----------

type Row = { key: number; open: boolean };

/**
 * Perguntas e respostas cadastradas pelo dono: quem marcar o agente com uma pergunta parecida
 * recebe a resposta. Com várias, ficam recolhidas mostrando só a pergunta; a nova entra no topo.
 */
export function SmartReplies({ serverId }: { serverId: string }) {
  const [items, setItems] = useState<AgentReply[] | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const nextKey = useRef(0);
  const [uploading, setUploading] = useState<number | null>(null);
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bot = useServerBot(serverId);
  const handle = `@${bot?.displayName ?? 'agente'}`;

  const load = (l: AgentReply[], keepOpen?: Row[]) => {
    setItems(l);
    setSaved(JSON.stringify(l));
    setRows(l.map((_, i) => ({ key: nextKey.current++, open: keepOpen?.[i]?.open ?? l.length === 1 })));
  };

  useEffect(() => {
    api
      .agentReplies(serverId)
      .then((l) => load(l))
      .catch((e) => setError((e as Error).message));
  }, [serverId]);

  async function save() {
    if (!items) return;
    setBusy(true);
    try {
      // Itens vazios são descartados pelo servidor: os que sobram mantêm aberto/fechado.
      const kept = rows.filter((_, i) => items[i]!.q.trim() || items[i]!.a.trim() || items[i]!.media?.length);
      load(await api.setAgentReplies(serverId, items), kept);
      toast('Respostas salvas.');
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  async function addMedia(i: number, files: FileList | null) {
    const list = Array.from(files ?? []).filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
    if (!list.length) return;
    const room = 4 - (items?.[i]?.media?.length ?? 0);
    if (list.length > room) toast('No máximo 4 imagens ou vídeos por resposta.');
    const key = rows[i]?.key;
    setUploading(key ?? null);
    try {
      for (const f of list.slice(0, Math.max(0, room))) {
        const a = await api.uploadAttachment(f, f.name);
        // Acha a linha pela chave: a lista pode ter mudado enquanto enviava.
        const at = rowsRef.current.findIndex((x) => x.key === key);
        if (at >= 0) setItems((l) => l && l.map((it, j) => (j === at ? { ...it, media: [...(it.media ?? []), a] } : it)));
      }
    } catch (e) {
      showError(e);
    } finally {
      setUploading(null);
    }
  }

  const set = (i: number, patch: Partial<AgentReply>) => setItems((l) => l && l.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const toggle = (i: number) => setRows((r) => r.map((x, j) => (j === i ? { ...x, open: !x.open } : x)));
  const remove = (i: number) => {
    setItems((l) => l && l.filter((_, j) => j !== i));
    setRows((r) => r.filter((_, j) => j !== i));
  };
  const add = () => {
    setItems((l) => [{ q: '', a: '' }, ...(l ?? [])]);
    setRows((r) => [{ key: nextKey.current++, open: true }, ...r]);
  };
  const allOpen = rows.length > 0 && rows.every((r) => r.open);
  const dirty = !!items && JSON.stringify(items) !== saved;

  return (
    <div className="max-w-3xl">
      <h2 className="text-xl font-bold">Respostas inteligentes</h2>
      <p className="mt-1 mb-4 text-sm text-soft">
        Cadastre perguntas e o que o agente deve responder. Quando alguém marcar o agente com uma pergunta parecida (ex.:{' '}
        <code className="rounded bg-raise px-1">{handle} qual o dia da próxima RAID?</code>), ele responde no chat com o texto que você colocou.
      </p>
      {!items ? (
        error ? <ErrorText>{error}</ErrorText> : <p className="text-sm text-muted">Carregando…</p>
      ) : (
        <div className="space-y-3">
          <div className="sticky top-0 z-10 -mx-1 flex items-center gap-2 bg-side px-1 py-2">
            <Button variant="ghost" disabled={items.length >= 100} onClick={add} className="gap-1.5">
              <L.Plus size={15} /> Adicionar resposta
            </Button>
            {items.length > 1 && (
              <button
                type="button"
                onClick={() => setRows((r) => r.map((x) => ({ ...x, open: !allOpen })))}
                className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold text-soft hover:bg-hover hover:text-fg"
              >
                {allOpen ? <L.ChevronsDownUp size={14} /> : <L.ChevronsUpDown size={14} />}
                {allOpen ? 'Recolher todas' : 'Expandir todas'}
              </button>
            )}
            <span className="flex-1" />
            <span className="text-xs text-muted">{items.length} / 100</span>
            <Button disabled={busy || !dirty} onClick={save} className="px-6">
              {busy ? 'Salvando…' : 'Salvar'}
            </Button>
          </div>
          {items.length === 0 && <p className="rounded-lg border border-dashed border-edge px-4 py-6 text-center text-sm text-muted">Nenhuma resposta ainda.</p>}
          {items.map((it, i) => {
            const row = rows[i];
            if (!row) return null;
            return row.open ? (
              <div key={row.key} className="space-y-2 rounded-xl border border-edge bg-rail p-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold tracking-wide text-muted uppercase">Pergunta</span>
                  <span className="flex-1" />
                  {items.length > 1 && (
                    <button type="button" title="Recolher" onClick={() => toggle(i)} className="rounded p-1 text-muted hover:bg-hover hover:text-fg">
                      <L.ChevronUp size={15} />
                    </button>
                  )}
                  <button type="button" title="Apagar" onClick={() => remove(i)} className="rounded p-1 text-muted hover:bg-hover hover:text-danger">
                    <L.Trash2 size={15} />
                  </button>
                </div>
                <EmojiInput value={it.q} onChange={(e) => set(i, { q: e.target.value })} maxLength={200} placeholder="qual o dia da próxima RAID?" autoFocus={!it.q && !it.a} />
                <span className="block text-xs font-bold tracking-wide text-muted uppercase">Resposta</span>
                <EmojiTextarea
                  value={it.a}
                  onChange={(e) => set(i, { a: e.target.value })}
                  maxLength={2000}
                  rows={2}
                  placeholder="A próxima RAID é sábado às 21h!"
                  className="w-full resize-y rounded-lg border border-edge bg-side px-3 py-2 text-sm outline-none focus:border-accent"
                />
                <div className="flex flex-wrap items-center gap-2">
                  {(it.media ?? []).map((m) => (
                    <div key={m.id} className="group relative size-16 overflow-hidden rounded-lg border border-edge bg-side">
                      {m.contentType.startsWith('video/') ? (
                        <video src={fileUrl(m.url)} muted className="size-full object-cover" />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={fileUrl(m.url)} alt="" className="size-full object-cover" />
                      )}
                      {m.contentType.startsWith('video/') && <L.Play size={16} className="pointer-events-none absolute inset-0 m-auto text-white drop-shadow" />}
                      <button
                        type="button"
                        title="Tirar"
                        onClick={() => set(i, { media: (it.media ?? []).filter((x) => x.id !== m.id) })}
                        className="absolute top-0.5 right-0.5 rounded-full bg-black/70 p-0.5 text-white"
                      >
                        <L.X size={12} />
                      </button>
                    </div>
                  ))}
                  {(it.media?.length ?? 0) < 4 && (
                    <label
                      title="Adicionar imagem ou vídeo"
                      className={cx(
                        'flex size-16 cursor-pointer items-center justify-center rounded-lg border border-dashed border-edge text-muted hover:bg-hover hover:text-fg',
                        uploading === row.key && 'pointer-events-none opacity-60',
                      )}
                    >
                      {uploading === row.key ? <L.Loader2 size={18} className="animate-spin" /> : <L.ImagePlus size={20} />}
                      <input
                        type="file"
                        accept="image/*,video/*"
                        multiple
                        hidden
                        onChange={(e) => {
                          void addMedia(i, e.target.files);
                          e.target.value = '';
                        }}
                      />
                    </label>
                  )}
                  <span className="text-xs text-muted">Imagens ou vídeos enviados junto com a resposta (até 4).</span>
                </div>
              </div>
            ) : (
              <div key={row.key} className="group flex items-center gap-2 rounded-xl border border-edge bg-rail px-3 py-2.5 hover:bg-hover">
                <button type="button" onClick={() => toggle(i)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                  <L.MessageCircleQuestion size={16} className="shrink-0 text-muted" />
                  <span className={cx('truncate text-sm font-medium', !it.q.trim() && 'text-muted italic')}>{it.q.trim() || 'Pergunta sem texto'}</span>
                  {!!it.media?.length && (
                    <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted">
                      <L.Image size={12} /> {it.media.length}
                    </span>
                  )}
                  <span className="flex-1" />
                  <L.ChevronDown size={15} className="shrink-0 text-muted" />
                </button>
                <button type="button" title="Apagar" onClick={() => remove(i)} className="rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-danger">
                  <L.Trash2 size={15} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

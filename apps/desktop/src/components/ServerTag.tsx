'use client';

import type { PublicUser } from '@line/shared';
import * as L from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, fileUrl, type ServerCardInfo } from '@/lib/api';
import { actions, useLine } from '@/lib/store';
import { mobile } from '@/lib/mobile';
import { showError, toast } from './Dialogs';
import { Button, cx, DefaultServerIcon, ErrorText, Field, Input } from './ui';

/** Ícones do Lucide que dá para escolher para a tag (os que não existirem na versão instalada somem). */
const TAG_ICONS = [
  'Sword', 'Swords', 'Shield', 'Crown', 'Flame', 'Star', 'Heart', 'Zap', 'Skull', 'Gamepad2',
  'Music', 'Ghost', 'Rocket', 'Gem', 'Diamond', 'Trophy', 'Target', 'Sparkles', 'Moon', 'Sun',
  'Leaf', 'Snowflake', 'Feather', 'Cat', 'Dog', 'Bird', 'Fish', 'Coffee', 'Pizza', 'Anchor',
  'Flag', 'Bomb', 'Axe', 'Castle', 'Dice5', 'Headphones', 'Cloud', 'Droplet', 'Flower2', 'Bug',
].filter((n) => n in L);

function lucide(name: string | null | undefined): LucideIcon | null {
  if (!name) return null;
  const icon = (L as unknown as Record<string, LucideIcon | undefined>)[name];
  return icon ?? null;
}

/** O ícone da tag: um ícone do Lucide escolhido, ou a foto do servidor (ou o ícone padrão do Line). */
export function TagIcon({ icon, iconUrl, size = 12 }: { icon?: string | null; iconUrl?: string | null; size?: number }) {
  const Icon = lucide(icon);
  if (Icon) return <Icon size={size} strokeWidth={2.5} className="shrink-0" />;
  return (
    <span className="shrink-0 overflow-hidden rounded-[4px]" style={{ width: size, height: size }}>
      {iconUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={fileUrl(iconUrl)} alt="" className="h-full w-full object-cover" />
      ) : (
        <DefaultServerIcon />
      )}
    </span>
  );
}

/** Tag de servidor ao lado do nome (estilo tag de clã). Clicar abre o cartão do servidor. */
export function UserTagBadge({ user }: { user: Pick<PublicUser, 'id' | 'tag'> }) {
  const live = useLine((s) => s.users[user.id]?.tag);
  const tag = live === undefined ? user.tag : live;
  const server = useLine((s) => (tag ? s.servers[tag.serverId] : undefined));
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keep = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  // Fecha sozinho quando o mouse sai da tag e do cartão (o atraso dá tempo de atravessar o vão entre os dois).
  const leave = () => {
    keep();
    timer.current = setTimeout(() => setAnchor(null), 350);
  };
  useEffect(() => keep, []);
  if (!tag) return null;
  return (
    <>
      {/* span com role=button: a tag fica dentro de outros botões (linha da call, nome no chat). */}
      <span
        ref={ref}
        role="button"
        tabIndex={0}
        title={server ? `Tag do servidor ${server.name}` : 'Tag de servidor'}
        onClick={(e) => {
          e.stopPropagation();
          keep();
          setAnchor(e.currentTarget.getBoundingClientRect());
        }}
        onMouseEnter={() => anchor && keep()}
        onMouseLeave={() => anchor && leave()}
        onContextMenu={(e) => e.stopPropagation()}
        className="inline-flex shrink-0 cursor-pointer items-center gap-1 self-center rounded-md bg-raise px-1 py-px text-[11px] leading-4 font-bold text-soft hover:bg-hover hover:text-fg"
      >
        <TagIcon icon={tag.icon} iconUrl={tag.iconUrl ?? server?.iconUrl} />
        {tag.text}
      </span>
      {anchor && (
        <ServerCardPopover
          serverId={tag.serverId}
          anchor={anchor}
          tagEl={ref.current}
          onEnter={keep}
          onLeave={leave}
          onClose={() => {
            keep();
            setAnchor(null);
          }}
        />
      )}
    </>
  );
}

/** Cartão do servidor logo abaixo da tag (acima, se não couber). Servidor privado (e eu fora dele): só foto e capa acinzentadas. */
function ServerCardPopover({
  serverId,
  anchor,
  tagEl,
  onEnter,
  onLeave,
  onClose,
}: {
  serverId: string;
  anchor: DOMRect;
  tagEl: HTMLElement | null;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<ServerCardInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const W = 300;

  useEffect(() => {
    api.serverCard(serverId).then(setInfo, (e) => setError((e as Error).message));
  }, [serverId]);

  useLayoutEffect(() => {
    const h = box.current?.offsetHeight ?? 320;
    const gap = 6;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - W - 8));
    const below = anchor.bottom + gap;
    const above = anchor.top - gap - h;
    const top = below + h <= window.innerHeight - 8 || above < 8 ? Math.max(8, Math.min(below, window.innerHeight - h - 8)) : above;
    setPos({ left, top });
  }, [anchor, info, error]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    // Clique fora do cartão e da tag fecha.
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || tagEl?.contains(t)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, [onClose, tagEl]);

  const isPrivate = info?.private;
  const full = info && !info.private ? info : null;

  return createPortal(
    // Portal ainda propaga eventos pela árvore do React: não deixa o clique chegar na linha/nome por trás.
    <div onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <div
        ref={box}
        role="dialog"
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        className="fixed z-50 overflow-hidden rounded-2xl border border-edge bg-side shadow-2xl"
        style={{ width: W, left: pos?.left ?? -9999, top: pos?.top ?? 0 }}
      >
        <div className={cx('h-[110px] bg-raise', isPrivate && 'opacity-60 grayscale')}>
          {info?.bannerUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={fileUrl(info.bannerUrl)} alt="" className="h-full w-full object-cover" />
          )}
        </div>
        <div className="px-4 pb-4">
          <span
            className={cx(
              '-mt-9 flex h-[68px] w-[68px] overflow-hidden rounded-[20px] border-4 border-side bg-side',
              isPrivate && 'opacity-60 grayscale',
            )}
          >
            {info?.iconUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={fileUrl(info.iconUrl)} alt="" className="h-full w-full rounded-[16px] object-cover" />
            ) : (
              <span className="h-full w-full overflow-hidden rounded-[16px]">
                <DefaultServerIcon />
              </span>
            )}
          </span>

          {!info && !error && <p className="mt-3 text-sm text-muted">Carregando…</p>}
          <ErrorText>{error}</ErrorText>

          {isPrivate && <p className="mt-4 mb-2 text-center text-sm font-semibold text-soft">Servidor privado.</p>}

          {full && (
            <>
              <p className="mt-2 flex min-w-0 items-center gap-2 text-lg leading-tight font-bold">
                <span className="truncate">{full.name}</span>
                {full.tag && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-raise px-1 py-px text-[11px] leading-4 font-bold text-soft">
                    <TagIcon icon={full.tagIcon} iconUrl={full.iconUrl} />
                    {full.tag}
                  </span>
                )}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-soft">
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-online" /> {full.onlineCount.toLocaleString('pt-BR')} online
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-offline" /> {full.memberCount.toLocaleString('pt-BR')}{' '}
                  {full.memberCount === 1 ? 'membro' : 'membros'}
                </span>
              </p>
              <p className="mt-0.5 text-xs text-muted">
                Desde {new Date(full.createdAt).toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' })}
              </p>
              {full.description && <p className="mt-3 text-sm break-words whitespace-pre-wrap text-soft">{full.description}</p>}
              <Button
                className="mt-4 w-full"
                disabled={busy}
                onClick={async () => {
                  if (full.member) {
                    actions.goServer(full.id);
                    mobile.showNav();
                    return onClose();
                  }
                  setBusy(true);
                  try {
                    const server = await api.joinPublic(full.id);
                    actions.upsertServer(server);
                    actions.goServer(server.id);
                    mobile.showNav();
                    onClose();
                  } catch (e) {
                    showError(e);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {full.member ? 'Abrir servidor' : busy ? 'Entrando…' : 'Juntar-se'}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Configurações do servidor → Tag do servidor: nome (até 4 caracteres) e ícone da badge. */
export function ServerTagSettings({ serverId }: { serverId: string }) {
  const server = useLine((s) => s.servers[serverId]);
  const [tag, setTag] = useState(server?.tag ?? '');
  const [icon, setIcon] = useState(server?.tagIcon ?? '');
  const [busy, setBusy] = useState(false);
  if (!server) return null;
  const dirty = tag !== (server.tag ?? '') || icon !== (server.tagIcon ?? '');

  async function save() {
    setBusy(true);
    try {
      actions.upsertServer(await api.updateServer(serverId, { tag, tagIcon: icon }));
      toast('Tag do servidor salva.');
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-bold">Tag do servidor</h2>
      <p className="mt-1 mb-6 text-sm text-soft">
        Crie uma tag que os membros podem exibir ao lado do nome. Quem clicar nela vê o cartão do servidor. Cada membro ativa a tag em Editar perfil.
      </p>

      <div className="mb-6 flex items-center gap-2 rounded-xl border border-edge bg-rail px-4 py-3">
        <span className="text-xs font-bold tracking-wide text-muted uppercase">Prévia</span>
        <span className="ml-2 font-semibold">Seu nome</span>
        {tag ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-raise px-1 py-px text-[11px] leading-4 font-bold text-soft">
            <TagIcon icon={icon} iconUrl={server.iconUrl} />
            {tag}
          </span>
        ) : (
          <span className="text-xs text-muted">(sem tag)</span>
        )}
      </div>

      <div className="space-y-6">
        <Field label="Nome da tag" hint="Até 4 letras ou números. Deixe vazio para desativar a tag.">
          <Input
            value={tag}
            onChange={(e) => setTag(e.target.value.replace(/[^\p{L}\p{N}]/gu, '').toUpperCase().slice(0, 4))}
            placeholder="Ex.: LINE"
            className="w-32 font-bold tracking-wide"
          />
        </Field>

        <Field label="Ícone da tag">
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setIcon('')}
              title="Foto do servidor"
              className={cx(
                'flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold',
                icon === '' ? 'border-accent bg-accent/15 text-fg' : 'border-edge text-soft hover:bg-raise',
              )}
            >
              <TagIcon iconUrl={server.iconUrl} size={16} /> Foto do servidor
            </button>
            {TAG_ICONS.map((name) => {
              const Icon = lucide(name)!;
              return (
                <button
                  key={name}
                  type="button"
                  title={name}
                  onClick={() => setIcon(name)}
                  className={cx(
                    'flex h-9 w-9 items-center justify-center rounded-lg border',
                    icon === name ? 'border-accent bg-accent/15 text-fg' : 'border-edge text-soft hover:bg-raise hover:text-fg',
                  )}
                >
                  <Icon size={17} />
                </button>
              );
            })}
          </div>
        </Field>

        <div className="flex justify-end border-t border-edge pt-4">
          <Button disabled={busy || !dirty} onClick={save} className="px-6">
            {busy ? 'Salvando…' : 'Salvar'}
          </Button>
        </div>
      </div>
    </div>
  );
}

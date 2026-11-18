'use client';

import type { PublicUser, TagPaint, TagStyle } from '@line/shared';
import * as L from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { api, fileUrl, type ServerCardInfo } from '@/lib/api';
import { actions, useLine } from '@/lib/store';
import { mobile } from '@/lib/mobile';
import { placeAround, useFloating } from '@/lib/floating';
import { showError, toast } from './Dialogs';
import { ColorPicker } from './ColorPicker';
import { Button, cx, DefaultServerIcon, ErrorText, Field, Icons, Input, SWATCHES } from './ui';

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

const WAVE_SECS = { slow: '12s', medium: '6s', fast: '4s' } as const;
const isGrad = (p: TagPaint | undefined): p is string[] => Array.isArray(p) && p.length > 1;
/** Uma cor só (a primeira, se vier lista de uma). */
const solidOf = (p: TagPaint | undefined): string | undefined => (Array.isArray(p) ? p[0] : p) || undefined;
const vertical = (st: TagStyle | null | undefined) => st?.dir === 'v';
const waving = (st: TagStyle | null | undefined) => st?.motion === 'wave';
const waveClass = (st: TagStyle | null | undefined) => (waving(st) ? (vertical(st) ? 'line-name-wave-v' : 'line-name-prism') : '');

/** Fundo em degradê (em onda repete a primeira cor no fim e corre). */
function gradCss(cols: string[], st: TagStyle | null | undefined): CSSProperties {
  const wave = waving(st);
  const v = vertical(st);
  return {
    backgroundImage: `linear-gradient(${v ? '180deg' : '90deg'}, ${(wave ? [...cols, cols[0]!] : cols).join(', ')})`,
    ...(wave ? { backgroundSize: v ? '100% 200%' : '200% 100%', animationDuration: WAVE_SECS[st?.speed ?? 'medium'] } : {}),
  };
}

/** Fundo e cor do texto da badge (o degradê do texto e da borda ficam em TagPill). */
export function tagBadgeStyle(style: TagStyle | null | undefined): CSSProperties | undefined {
  if (!style) return undefined;
  const out: CSSProperties = {};
  if (isGrad(style.bg)) Object.assign(out, gradCss(style.bg, style));
  else if (solidOf(style.bg)) out.background = solidOf(style.bg);
  const fg = solidOf(style.fg);
  if (fg && !isGrad(style.fg) && fg !== 'transparent') out.color = fg;
  const border = solidOf(style.border);
  if (border && !isGrad(style.border) && border !== 'transparent') out.boxShadow = `inset 0 0 0 1px ${border}`;
  return out;
}

/**
 * A badge da tag: ícone + texto com as cores do dono (lisas, degradê ou transparentes).
 * As classes padrão (bg-raise, text-soft…) vêm de quem usa; as cores escolhidas passam por cima.
 */
export function TagPill({
  text,
  icon,
  iconUrl,
  tagStyle,
  className,
  style,
  children,
  hideIcon,
  ...rest
}: {
  text: ReactNode;
  icon?: string | null;
  iconUrl?: string | null;
  tagStyle?: TagStyle | null;
  children?: ReactNode;
  ref?: Ref<HTMLSpanElement>;
  /** Sem ícone (ex.: "Escolher tag"). */
  hideIcon?: boolean;
} & HTMLAttributes<HTMLSpanElement>) {
  const st = tagStyle;
  const bgWave = isGrad(st?.bg) ? waveClass(st) : '';
  return (
    <span {...rest} className={cx('relative', className, bgWave)} style={{ ...tagBadgeStyle(st), ...style }}>
      {isGrad(st?.border) && (
        <span
          aria-hidden
          className={cx('pointer-events-none absolute inset-0 rounded-[inherit] p-px', waveClass(st))}
          style={{
            ...gradCss(st.border, st),
            WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
            WebkitMaskComposite: 'xor',
            maskComposite: 'exclude',
          }}
        />
      )}
      {!hideIcon && <TagIcon icon={icon} iconUrl={iconUrl} style={st} />}
      {isGrad(st?.fg) ? (
        <span
          className={waveClass(st)}
          style={{ ...gradCss(st.fg, st), WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', WebkitTextFillColor: 'transparent' }}
        >
          {text}
        </span>
      ) : (
        text
      )}
      {children}
    </span>
  );
}

/** O ícone da tag: um ícone do Lucide escolhido, ou a foto do servidor (ou o ícone padrão do Line). */
export function TagIcon({
  icon,
  iconUrl,
  size = 12,
  style,
}: {
  icon?: string | null;
  iconUrl?: string | null;
  size?: number;
  /** Cor do ícone e sólido/contorno. */
  style?: TagStyle | null;
}) {
  const gid = useId().replace(/:/g, '');
  const Icon = lucide(icon);
  if (Icon) {
    // Ícone transparente: a tag fica só com o texto.
    if (solidOf(style?.iconColor) === 'transparent') return null;
    const solid = style?.iconStyle === 'solid';
    const grad = isGrad(style?.iconColor) ? style.iconColor : null;
    const paint = grad ? `url(#tg${gid})` : 'currentColor';
    const color = grad ? undefined : solidOf(style?.iconColor);
    return (
      <Icon
        size={size}
        strokeWidth={2.5}
        className="shrink-0"
        style={color ? { color } : undefined}
        stroke={paint}
        fill={solid ? paint : 'none'}
      >
        {grad && (
          <defs>
            <linearGradient id={`tg${gid}`} x1="0" y1="0" x2={vertical(style) ? '0' : '1'} y2={vertical(style) ? '1' : '0'}>
              {grad.map((c, i) => (
                <stop key={i} offset={`${(i / (grad.length - 1)) * 100}%`} stopColor={c} />
              ))}
            </linearGradient>
          </defs>
        )}
      </Icon>
    );
  }
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
      <TagPill
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
        text={tag.text}
        icon={tag.icon}
        iconUrl={tag.iconUrl ?? server?.iconUrl}
        tagStyle={tag.style ?? server?.tagStyle}
      />
      {anchor && (
        <ServerCardPopover
          serverId={tag.serverId}
          badge={
            <TagPill
              className="inline-flex shrink-0 items-center gap-1 rounded-md bg-raise px-1 py-px text-[11px] leading-4 font-bold text-soft"
              text={tag.text}
              icon={tag.icon}
              iconUrl={tag.iconUrl ?? server?.iconUrl}
              tagStyle={tag.style ?? server?.tagStyle}
            />
          }
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

/** Cartão do servidor logo abaixo da tag (acima, se não couber). Servidor privado (e eu fora dele): cartão compacto sem capa, ícone cinza à esquerda e tag + "Servidor privado" à direita. */
function ServerCardPopover({
  serverId,
  badge,
  anchor,
  tagEl,
  onEnter,
  onLeave,
  onClose,
}: {
  serverId: string;
  badge: ReactNode;
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
  const W = 300;

  useEffect(() => {
    api.serverCard(serverId).then(setInfo, (e) => setError((e as Error).message));
  }, [serverId]);

  // Só aparece depois de carregar e medir: abre direto no lado que cabe.
  const { style: placed } = useFloating(box, (w, h, lock) => placeAround(anchor, w, h, { lock }), !!info || !!error);

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
        style={{ width: W, ...placed }}
      >
        {isPrivate ? (
          <div className="flex items-center gap-3 p-4">
            <span className="flex h-[60px] w-[60px] shrink-0 overflow-hidden rounded-[18px] bg-raise opacity-60 grayscale">
              {info?.iconUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={fileUrl(info.iconUrl)} alt="" className="h-full w-full object-cover" />
              ) : (
                <DefaultServerIcon />
              )}
            </span>
            <div className="flex min-w-0 flex-col items-start gap-1.5">
              {badge}
              <p className="text-sm font-semibold text-soft">Servidor privado</p>
            </div>
          </div>
        ) : (
          <>
            <div className="h-[110px] bg-raise">
              {info?.bannerUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={fileUrl(info.bannerUrl)} alt="" className="h-full w-full object-cover" />
              )}
            </div>
            <div className="px-4 pb-4">
              <span className="-mt-9 flex h-[68px] w-[68px] overflow-hidden rounded-[20px] border-4 border-side bg-side">
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

              {full && (
                <>
                  <p className="mt-2 flex min-w-0 items-center gap-2 text-lg leading-tight font-bold">
                    <span className="truncate">{full.name}</span>
                    {full.tag && (
                      <TagPill
                        className="inline-flex shrink-0 items-center gap-1 rounded-md bg-raise px-1 py-px text-[11px] leading-4 font-bold text-soft"
                        text={full.tag}
                        icon={full.tagIcon}
                        iconUrl={full.iconUrl}
                        tagStyle={full.tagStyle}
                      />
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
          </>
        )}
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
  const [style, setStyle] = useState<TagStyle>(server?.tagStyle ?? {});
  const [busy, setBusy] = useState(false);
  if (!server) return null;
  const dirty =
    tag !== (server.tag ?? '') || icon !== (server.tagIcon ?? '') || JSON.stringify(style) !== JSON.stringify(server.tagStyle ?? {});
  const setColor = (key: 'bg' | 'fg' | 'border' | 'iconColor') => (c: TagPaint | null) =>
    setStyle((st) => {
      const next = { ...st };
      if (c) next[key] = c;
      else delete next[key];
      return next;
    });

  async function save() {
    setBusy(true);
    try {
      const saved = await api.updateServer(serverId, { tag, tagIcon: icon, tagStyle: Object.keys(style).length ? style : null });
      actions.upsertServer(saved);
      setStyle(saved.tagStyle ?? {});
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
          <TagPill
            className="inline-flex items-center gap-1 rounded-md bg-raise px-1 py-px text-[11px] leading-4 font-bold text-soft"
            text={tag}
            icon={icon}
            iconUrl={server.iconUrl}
            tagStyle={style}
          />
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

        <Field label="Estilo do ícone" hint="Vale para os ícones; a foto do servidor fica igual.">
          <div className="flex gap-2">
            {(
              [
                ['outline', 'Contorno'],
                ['solid', 'Sólido'],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                onClick={() => setStyle((st) => ({ ...st, iconStyle: v }))}
                className={cx(
                  'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm',
                  (style.iconStyle ?? 'outline') === v ? 'border-accent bg-accent/15 text-fg' : 'border-edge text-soft hover:bg-raise',
                )}
              >
                <L.Star size={15} fill={v === 'solid' ? 'currentColor' : 'none'} /> {label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Cores da tag" group>
          <div className="space-y-4">
            {(
              [
                ['bg', 'Fundo'],
                ['fg', 'Texto'],
                ['border', 'Borda'],
                ['iconColor', 'Ícone'],
              ] as const
            ).map(([key, label]) => (
              <div key={key}>
                <p className="mb-1.5 text-xs text-muted">{label}</p>
                <TagPaintRow value={style[key] ?? null} onChange={setColor(key)} transparent={key !== 'fg'} />
              </div>
            ))}
            {/* Fica no layout mesmo sem degradê, para a página não pular. */}
            <div className={cx('flex flex-wrap items-end gap-3', !(['bg', 'fg', 'border', 'iconColor'] as const).some((k) => isGrad(style[k])) && 'hidden')}>
              <Toggle
                label="Orientação"
                value={style.dir ?? 'h'}
                options={[
                  ['h', 'Horizontal'],
                  ['v', 'Vertical'],
                ]}
                onChange={(dir) => setStyle((st) => ({ ...st, dir }))}
              />
              <Toggle
                label="Movimento"
                value={style.motion ?? 'static'}
                options={[
                  ['static', 'Estático'],
                  ['wave', 'Onda'],
                ]}
                onChange={(motion) => setStyle((st) => ({ ...st, motion }))}
              />
              <span className={cx(!waving(style) && 'invisible')}>
                <Toggle
                  label="Velocidade"
                  value={style.speed ?? 'medium'}
                  options={[
                    ['slow', '0.5x'],
                    ['medium', '1x'],
                    ['fast', '1.5x'],
                  ]}
                  onChange={(speed) => setStyle((st) => ({ ...st, speed }))}
                />
              </span>
            </div>
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

/** Sugestões de degradê para a tag. */
const TAG_GRADIENTS = [
  ['#7c6af2', '#d6409f'],
  ['#f76b15', '#f5c451'],
  ['#12a594', '#2b6cff'],
  ['#ff5a5f', '#8e4ec6', '#2b6cff'],
];
const MAX_TAG_COLORS = 4;
const CHECKER = 'repeating-conic-gradient(#8a8a94 0 25%, #c9c9d1 0 50%) 50% / 8px 8px';

/** Uma linha de cor da tag: Padrão, Sem (transparente, opcional), cores prontas, outra cor e degradê de 2 a 4 cores. */
function TagPaintRow({ value, onChange, transparent }: { value: TagPaint | null; onChange: (p: TagPaint | null) => void; transparent: boolean }) {
  const grad = isGrad(value ?? undefined) ? (value as string[]) : null;
  const single = grad ? null : (solidOf(value ?? undefined) ?? null);
  const custom = single && single !== 'transparent' && !SWATCHES.includes(single);
  const pill = (active: boolean) => cx('rounded-full border px-2.5 py-1 text-xs', active ? 'border-accent text-fg' : 'border-edge text-soft hover:bg-raise');
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => onChange(null)} className={pill(value === null)}>
          Padrão
        </button>
        {transparent && (
          <button type="button" title="Transparente" onClick={() => onChange('transparent')} className={cx(pill(single === 'transparent'), 'flex items-center gap-1.5')}>
            <span className="h-3.5 w-3.5 rounded-full border border-edge" style={{ background: CHECKER }} /> Sem
          </button>
        )}
        {SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            className={cx('h-7 w-7 rounded-full border border-edge ring-offset-2 ring-offset-side', single === c && 'ring-2 ring-fg')}
            style={{ background: c }}
            aria-label={c}
          />
        ))}
        <ColorPicker
          title="Outra cor"
          value={single && single !== 'transparent' ? single : null}
          onChange={onChange}
          className={cx('relative h-7 w-7 cursor-pointer overflow-hidden rounded-full border border-edge ring-offset-2 ring-offset-side', custom && 'ring-2 ring-fg')}
          style={{ background: custom ? single : 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)' }}
        />
        <button
          type="button"
          title="Degradê"
          onClick={() => !grad && onChange([single && single !== 'transparent' ? single : TAG_GRADIENTS[0]![0]!, TAG_GRADIENTS[0]![1]!])}
          className={cx('h-7 rounded-full border border-edge px-2.5 text-xs font-semibold text-white ring-offset-2 ring-offset-side', grad && 'ring-2 ring-fg')}
          style={{ background: 'linear-gradient(90deg, #7c6af2, #d6409f, #f5c451)' }}
        >
          Degradê
        </button>
      </div>
      {grad && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex h-10 items-center gap-1.5 rounded-lg border border-accent px-1.5" style={{ background: `linear-gradient(90deg, ${grad.join(', ')})` }} title="Cores do degradê">
            {grad.map((c, i) => (
              <span key={i} className="group/c relative">
                <ColorPicker
                  value={c}
                  onChange={(hex) => onChange(grad.map((x, j) => (j === i ? hex : x)))}
                  className="relative h-7 w-7 cursor-pointer rounded-md border-2 border-white shadow"
                  style={{ background: c }}
                />
                {grad.length > 2 && (
                  <button
                    type="button"
                    title="Remover cor"
                    onClick={() => onChange(grad.filter((_, j) => j !== i))}
                    className="absolute -top-1.5 -right-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-black text-white group-hover/c:flex"
                  >
                    <Icons.X size={10} />
                  </button>
                )}
              </span>
            ))}
          </span>
          {grad.length < MAX_TAG_COLORS && (
            <button
              type="button"
              title="Adicionar mais uma cor"
              onClick={() => onChange([...grad, grad[grad.length - 1]!])}
              className="flex h-10 w-10 items-center justify-center rounded-lg border-2 border-dashed border-edge text-soft hover:border-accent hover:text-fg"
            >
              <Icons.Plus size={16} />
            </button>
          )}
          {TAG_GRADIENTS.map((p) => (
            <button
              key={p.join()}
              type="button"
              onClick={() => onChange(p)}
              className={cx('h-10 w-10 rounded-lg border-2', p.join() === grad.join() ? 'border-accent' : 'border-transparent')}
              style={{ background: `linear-gradient(135deg, ${p.join(', ')})` }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Toggle<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div>
      <p className="mb-1 text-xs font-bold text-soft">{label}</p>
      <div className="inline-flex rounded-lg border border-edge bg-rail p-0.5">
        {options.map(([id, text]) => (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            className={cx('rounded-md px-2 py-1 text-xs font-semibold whitespace-nowrap', value === id ? 'bg-accent text-on-accent' : 'text-soft hover:text-fg')}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

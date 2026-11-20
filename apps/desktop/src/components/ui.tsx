'use client';

import type { Presence } from '@line/shared';
import * as L from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { fileUrl } from '@/lib/api';
import { placeAround, useFloating } from '@/lib/floating';
import { createPortal } from 'react-dom';
import { ColorPicker } from './ColorPicker';
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';

export function cx(...parts: (string | number | false | null | undefined)[]) {
  return parts.filter((p) => typeof p === 'string' && p).join(' ');
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

/** Logo do Line: uma linha que vira balão de conversa. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect x="1" y="1" width="30" height="30" rx="10" fill="var(--color-accent)" />
      <path
        d="M8 19c3-6 6-6 8-3s5 3 8-3"
        stroke="var(--color-on-accent)"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="24" cy="10" r="2.4" fill="var(--color-on-accent)" opacity="0.7" />
    </svg>
  );
}

/** Ícone padrão de servidor sem imagem: o logo do Line acinzentado, ocupando todo o espaço. */
export function DefaultServerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cx('h-full w-full', className)}>
      <rect width="32" height="32" fill="#4a4a54" />
      <path d="M8 19c3-6 6-6 8-3s5 3 8-3" stroke="#d6d6de" strokeWidth="3" strokeLinecap="round" fill="none" />
      <circle cx="24" cy="10" r="2.4" fill="#d6d6de" opacity="0.7" />
    </svg>
  );
}

const presenceColor: Record<Presence, string> = {
  online: 'bg-online',
  idle: 'bg-idle',
  dnd: 'bg-dnd',
  offline: 'bg-offline',
};

export const presenceLabel: Record<Presence, string> = {
  online: 'Disponível',
  idle: 'Ausente',
  dnd: 'Não perturbar',
  offline: 'Offline',
};

type Ring = 'side' | 'main' | 'rail' | 'raise';
const ringClass: Record<Ring, string> = {
  side: 'ring-side',
  main: 'ring-main',
  rail: 'ring-rail',
  raise: 'ring-raise',
};

export function PresenceDot({
  presence,
  size = 10,
  ring = 'side',
  ringColor,
  className,
}: {
  presence: Presence;
  size?: number;
  ring?: Ring;
  /** Cor livre do anel (no lugar das cores de fundo prontas). */
  ringColor?: string;
  className?: string;
}) {
  return (
    <span
      title={presenceLabel[presence]}
      className={cx('block rounded-full', ringColor ? 'border-[3px]' : cx('ring-[3px]', ringClass[ring]), presenceColor[presence], className)}
      style={{ width: size, height: size, ...(ringColor ? { borderColor: ringColor } : {}) }}
    />
  );
}

const tintCache = new Map<string, string | null>();

/** Cor média de uma imagem (amostra 16x16). null se não der para ler (ex.: sem CORS). */
function averageColor(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 16;
        const ctx = c.getContext('2d');
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, 16, 16);
        const d = ctx.getImageData(0, 0, 16, 16).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 128) continue;
          r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
        }
        resolve(n ? `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})` : null);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Fundo do quadro da chamada: a cor predominante do avatar (ou a cor da pessoa), puxada para o cinza. */
export function useAvatarTint(src: string | null | undefined, color: string) {
  const url = src ? fileUrl(src) : null;
  const [picked, setPicked] = useState<string | null>(() => (url ? (tintCache.get(url) ?? null) : null));
  useEffect(() => {
    if (!url) return setPicked(null);
    if (tintCache.has(url)) return setPicked(tintCache.get(url) ?? null);
    let alive = true;
    void averageColor(url).then((c) => {
      tintCache.set(url, c);
      if (alive) setPicked(c);
    });
    return () => {
      alive = false;
    };
  }, [url]);
  return `color-mix(in srgb, ${picked ?? color} 32%, #26262b)`;
}

export function Avatar({
  name,
  color,
  size = 36,
  presence,
  ring = 'side',
  className,
  src,
  dotSize,
  dotRingColor,
  group,
}: {
  name: string;
  /** DM em grupo: sem foto, mostra o ícone de grupo no lugar do logo do Line. */
  group?: boolean;
  color: string;
  src?: string | null;
  size?: number;
  /** Tamanho da bolinha de status (padrão: 30% do avatar). */
  dotSize?: number;
  presence?: Presence;
  ring?: Ring;
  /** Cor livre do anel da bolinha de status. */
  dotRingColor?: string;
  className?: string;
}) {
  return (
    <span className={cx('relative inline-block shrink-0', className)} style={{ width: size, height: size }}>
      <span
        className="flex h-full w-full items-center justify-center rounded-full font-semibold text-rail select-none"
        // Com foto, sem fundo: a cor vazava como um anel fino na borda.
        style={{ background: src ? 'transparent' : color, fontSize: size * 0.38 }}
        title={src ? undefined : name}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={fileUrl(src)} alt="" className="h-full w-full rounded-full object-cover" draggable={false} />
        ) : group ? (
          <L.UsersRound size={Math.round(size * 0.55)} className="text-soft" strokeWidth={2} />
        ) : (
          // Sem foto: o ícone do Line acinzentado, igual ao dos servidores sem imagem.
          <span className="h-full w-full overflow-hidden rounded-full">
            <DefaultServerIcon />
          </span>
        )}
      </span>
      {presence && (
        <PresenceDot
          presence={presence}
          ring={ring}
          ringColor={dotRingColor}
          size={dotSize ?? Math.max(9, Math.round(size * 0.3))}
          className="absolute -right-0.5 -bottom-0.5"
        />
      )}
    </span>
  );
}

export function Button({
  variant = 'primary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'subtle' }) {
  return (
    <button
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-accent text-on-accent hover:bg-accent-strong',
        variant === 'danger' && 'bg-danger text-white hover:brightness-110',
        variant === 'ghost' && 'text-soft hover:bg-hover hover:text-fg',
        variant === 'subtle' && 'bg-raise text-fg hover:bg-hover',
        className,
      )}
    />
  );
}

/** `group`: vira um div em vez de label. Use quando há vários botões dentro (ex.: SwatchRow),
 * senão clicar num espaço vazio "clica" no primeiro botão (o Padrão). */
export function Field({ label, hint, group, children }: { label: string; hint?: string; group?: boolean; children: ReactNode }) {
  const Tag = group ? 'div' : 'label';
  return (
    <Tag className="block space-y-1.5">
      <span className="block text-xs font-bold tracking-wide text-muted uppercase">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </Tag>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: React.Ref<HTMLInputElement> }) {
  return (
    <input
      {...props}
      className={cx(
        'w-full rounded-lg border border-edge bg-rail px-3 py-2 text-sm text-fg outline-none placeholder:text-muted focus:border-accent',
        className,
      )}
    />
  );
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 440,
  fixedBody,
  tall,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** O corpo não rola inteiro: quem usa escolhe a parte que rola (ex.: só a lista do "Transmitir tela"). */
  fixedBody?: boolean;
  /** Corpo mais alto (formulários longos, ex.: Editar canal). */
  tall?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label={title}
        className="max-h-full w-full overflow-hidden rounded-2xl border border-edge bg-side shadow-2xl"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-2">
          <h2 className="text-xl font-bold">{title}</h2>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        </div>
        <div className={fixedBody ? 'flex max-h-[70vh] min-h-0 flex-col px-6 py-4' : cx(tall ? 'max-h-[80vh]' : 'max-h-[60vh]', 'overflow-y-auto px-6 py-4')}>{children}</div>
        {footer && <div className="flex justify-end gap-2 bg-rail/60 px-6 py-4">{footer}</div>}
      </div>
    </div>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{children}</p>;
}

// ---------- ícones (SVG próprios, traço simples) ----------

type IconProps = { size?: number; className?: string };
/** Ícones do Lucide com o mesmo tamanho padrão e traço do app. */
const icon = (C: LucideIcon) =>
  function Icon({ size = 20, className }: IconProps) {
    return <C size={size} strokeWidth={2} className={className} aria-hidden />;
  };

/** Ícone de um canal na lista: canais base têm o seu; voz = alto-falante; texto = #. */
export function channelIcon(c: { type: string; base?: string; isPrivate?: boolean; nsfw?: boolean }) {
  switch (c.base) {
    case 'rules':
      return Icons.BookCheck;
    case 'announcements':
      return Icons.Megaphone;
    case 'events':
      return Icons.CalendarCheck;
    case 'activity':
      return Icons.Gamepad;
  }
  if (c.type === 'voice') return Icons.Speaker;
  if (c.type === 'text' && c.nsfw) return Icons.HashSensitive;
  if (c.type === 'text' && c.isPrivate) return Icons.HashLock;
  return Icons.Hash;
}

export const Icons = {
  /** Canal de texto (no lugar do #). */
  Hash: icon(L.MessageSquare),
  HashLock: icon(L.MessageSquareLock),
  HashSensitive: icon(L.MessageSquareWarning),
  BookCheck: icon(L.BookCheck),
  MapPin: icon(L.MapPin),
  Calendar: icon(L.Calendar),
  CalendarPlus: icon(L.CalendarPlus),
  Help: icon(L.CircleHelp),
  Megaphone: icon(L.Megaphone),
  ScrollText: icon(L.ScrollText),
  CalendarCheck: icon(L.CalendarCheck2),
  Speaker: icon(L.Volume2),
  SpeakerOff: icon(L.VolumeX),
  Plus: icon(L.Plus),
  Compass: icon(L.Compass),
  Users: icon(L.Users),
  Settings: icon(L.Settings),
  Chevron: icon(L.ChevronDown),
  ChevronRight: icon(L.ChevronRight),
  ChevronLeft: icon(L.ChevronLeft),
  User: icon(L.User),
  Reply: icon(L.Reply),
  X: icon(L.X),
  Edit: icon(L.Pencil),
  Trash: icon(L.Trash2),
  Logout: icon(L.LogOut),
  Link: icon(L.Link),
  Check: icon(L.Check),
  Palette: icon(L.Palette),
  Message: icon(L.MessageCircle),
  Search: icon(L.Search),
  Mic: icon(L.Mic),
  MicOff: icon(L.MicOff),
  Headphones: icon(L.Headphones),
  HeadphonesOff: icon(L.HeadphoneOff),
  Video: icon(L.Video),
  VideoOff: icon(L.VideoOff),
  Screen: icon(L.MonitorUp),
  MonitorX: icon(L.MonitorX),
  Gamepad: icon(L.Gamepad2),
  Trophy: icon(L.Trophy),
  Star: icon(L.Star),
  Soundboard: icon(L.Drum),
  Monitor: icon(L.Monitor),
  AppWindow: icon(L.AppWindow),
  MonitorPause: icon(L.MonitorPause),
  Refresh: icon(L.RefreshCw),
  Phone: icon(L.Phone),
  PhoneOff: icon(L.PhoneOff),
  Expand: icon(L.Maximize2),
  Shrink: icon(L.Minimize2),
  Waves: icon(L.AudioLines),
  Signal: icon(L.Signal),
  Sliders: icon(L.SlidersHorizontal),
  Paperclip: icon(L.Paperclip),
  Thread: icon(L.MessagesSquare),
  File: icon(L.File),
  FileText: icon(L.FileText),
  Download: icon(L.Download),
  Image: icon(L.Image),
  Folder: icon(L.Folder),
  Lock: icon(L.Lock),
  Warning: icon(L.TriangleAlert),
  Shield: icon(L.Shield),
  Grip: icon(L.GripVertical),
  Upload: icon(L.Upload),
  Poll: icon(L.ChartBar),
  Ban: icon(L.Ban),
  Camera: icon(L.Camera),
  AtSign: icon(L.AtSign),
  UserPlus: icon(L.UserPlus),
  UserCheck: icon(L.UserCheck),
  Clock: icon(L.Clock),
  More: icon(L.Ellipsis),
  MoreVertical: icon(L.EllipsisVertical),
  Music: icon(L.Music),
  Mail: icon(L.Mail),
  ShieldAlert: icon(L.ShieldAlert),
  ShieldCheck: icon(L.ShieldCheck),
  Copy: icon(L.Copy),
  ArrowLeft: icon(L.ArrowLeft),
  ZoomIn: icon(L.ZoomIn),
  ZoomOut: icon(L.ZoomOut),
  Fullscreen: icon(L.Maximize),
  ExitFullscreen: icon(L.Minimize),
  UserMinus: icon(L.UserMinus),
  Gif: icon(L.ImagePlay),
  Play: icon(L.Play),
  Pause: icon(L.Pause),
  Send: icon(L.SendHorizontal),
  Smile: icon(L.Smile),
  SmilePlus: icon(L.SmilePlus),
  EyeOff: icon(L.EyeOff),
  Eye: icon(L.Eye),
  Bug: icon(L.Bug),
  Flag: icon(L.Flag),
  Pin: icon(L.Pin),
  Bookmark: icon(L.Bookmark),
  BookmarkCheck: icon(L.BookmarkCheck),
  BookmarkX: icon(L.BookmarkX),
  Forward: icon(L.Forward),
  IdCard: icon(L.IdCard),
  PinOff: icon(L.PinOff),
  Bell: icon(L.Bell),
  BellOff: icon(L.BellOff),
  Inbox: icon(L.Inbox),
};

/** Bloco de carregamento com brilho animado. */
export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div aria-hidden className={cx('skeleton rounded-md', className)} style={style} />;
}

/** Linhas de mensagem fantasma enquanto o histórico carrega. */
export function MessageSkeletons({ count = 7 }: { count?: number }) {
  const widths = [72, 45, 88, 60, 35, 80, 52, 66];
  return (
    <div className="space-y-5 px-4 py-4" aria-label="Carregando mensagens">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex gap-4" style={{ opacity: 1 - i * 0.09 }}>
          <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2 pt-1">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3.5" style={{ width: `${widths[i % widths.length]}%` }} />
            {i % 3 === 1 && <Skeleton className="h-28 w-64 rounded-lg" />}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Lista fantasma (canais, membros, conversas). */
export function ListSkeleton({ count = 6, avatar = false }: { count?: number; avatar?: boolean }) {
  const widths = [70, 55, 80, 45, 65, 50, 75, 60];
  return (
    <div className="space-y-2 px-2 py-1" aria-label="Carregando">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center gap-2.5 px-1 py-1">
          {avatar ? <Skeleton className="h-8 w-8 shrink-0 rounded-full" /> : <Skeleton className="h-4 w-4 shrink-0 rounded" />}
          <Skeleton className="h-3.5" style={{ width: `${widths[i % widths.length]}%` }} />
        </div>
      ))}
    </div>
  );
}

/** Select próprio no padrão do app (a lista nativa não dá para estilizar). */
export function Select({
  value,
  onChange,
  options,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    // Rolar a página (ou o modal) fecha a lista: ela fica fixa na tela e se soltaria da caixa.
    const onScroll = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    // Captura: fecha mesmo quando o clique cai num modal que segura o evento.
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onResize);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('blur', onResize);
    };
  }, [open]);

  // Abre para cima quando não cabe embaixo, decidido antes de aparecer.
  const { style: placed } = useFloating(list, (w, h, lock) => {
    const r = button.current?.getBoundingClientRect();
    return r ? placeAround(r, w, h, { lock }) : null;
  });

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cx(
          'flex w-full items-center gap-3 rounded-lg border bg-rail py-2 pr-3 pl-3 text-left text-sm text-fg outline-none',
          open ? 'border-accent' : 'border-edge hover:border-soft/40',
          className,
        )}
      >
        <span className="min-w-0 flex-1 truncate">{current?.label ?? ''}</span>
        <L.ChevronDown size={18} className={cx('shrink-0 text-muted transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open &&
        createPortal(
          <div
            ref={list}
            role="listbox"
            className="fixed z-[80] max-h-64 overflow-y-auto rounded-lg border border-edge bg-side p-1 shadow-2xl"
            style={{ width: button.current?.offsetWidth, ...placed }}
          >
            {options.map((o) => {
              const active = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={cx(
                    'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm',
                    active ? 'bg-accent/15 text-fg' : 'text-soft hover:bg-accent/10 hover:text-fg',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {active && <L.Check size={16} className="shrink-0 text-accent" aria-hidden />}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}

/** Checkbox no estilo do app. Usa um input real escondido, então funciona dentro de <label>. */
export function Checkbox({ checked, onChange, className }: { checked: boolean; onChange: (checked: boolean) => void; className?: string }) {
  return (
    <span className={cx('relative inline-flex h-5 w-5 shrink-0', className)}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer absolute inset-0 cursor-pointer opacity-0" />
      <span
        aria-hidden
        className={cx(
          'pointer-events-none flex h-5 w-5 items-center justify-center rounded-md border-2 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-accent/60 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-side',
          checked ? 'border-accent bg-accent text-on-accent' : 'border-edge bg-rail peer-hover:border-soft/50',
        )}
      >
        {checked && <L.Check size={14} strokeWidth={3} />}
      </span>
    </span>
  );
}

/** Slider no padrão do Line: trilho fino escuro, preenchido de violeta até o valor. */
export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  className,
  label,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  className?: string;
  label?: string;
}) {
  const pct = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={label}
      onChange={(e) => onChange(Number(e.target.value))}
      className={cx('line-range line-slider', className)}
      style={{ '--fill': `${pct}%` } as React.CSSProperties}
    />
  );
}

export const SWATCHES = ['#7c6af2', '#f5c451', '#2b6cff', '#ff5a5f', '#8e4ec6', '#12a594', '#f76b15', '#d6409f', '#b5b5bf', '#ffffff'];

/** Cores prontas + "nenhuma" (volta ao padrão) + uma cor livre. */
export function SwatchRow({ value, onChange, noneLabel }: { value: string | null; onChange: (c: string | null) => void; noneLabel: string }) {
  const custom = value && !SWATCHES.includes(value);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => onChange(null)}
        className={cx('rounded-full border px-2.5 py-1 text-xs', value === null ? 'border-accent text-fg' : 'border-edge text-soft hover:bg-raise')}
      >
        {noneLabel}
      </button>
      {SWATCHES.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={cx('h-7 w-7 rounded-full border border-edge ring-offset-2 ring-offset-side', value === c && 'ring-2 ring-fg')}
          style={{ background: c }}
          aria-label={c}
        />
      ))}
      <ColorPicker
        title="Outra cor"
        value={value}
        onChange={onChange}
        className={cx('relative h-7 w-7 cursor-pointer overflow-hidden rounded-full border border-edge ring-offset-2 ring-offset-side', custom && 'ring-2 ring-fg')}
        style={{ background: custom ? value : 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)' }}
      />
    </div>
  );
}

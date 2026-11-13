'use client';

import type { Presence } from '@line/shared';
import * as L from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';

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

const presenceColor: Record<Presence, string> = {
  online: 'bg-online',
  idle: 'bg-idle',
  dnd: 'bg-dnd',
  offline: 'bg-offline',
};

export const presenceLabel: Record<Presence, string> = {
  online: 'Disponível',
  idle: 'Ausente',
  dnd: 'Não perturbe',
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
  className,
}: {
  presence: Presence;
  size?: number;
  ring?: Ring;
  className?: string;
}) {
  return (
    <span
      title={presenceLabel[presence]}
      className={cx('block rounded-full ring-[3px]', ringClass[ring], presenceColor[presence], className)}
      style={{ width: size, height: size }}
    />
  );
}

export function Avatar({
  name,
  color,
  size = 36,
  presence,
  ring = 'side',
  className,
}: {
  name: string;
  color: string;
  size?: number;
  presence?: Presence;
  ring?: Ring;
  className?: string;
}) {
  return (
    <span className={cx('relative inline-block shrink-0', className)} style={{ width: size, height: size }}>
      <span
        className="flex h-full w-full items-center justify-center rounded-full font-semibold text-rail select-none"
        style={{ background: color, fontSize: size * 0.38 }}
      >
        {initials(name)}
      </span>
      {presence && (
        <PresenceDot
          presence={presence}
          ring={ring}
          size={Math.max(9, Math.round(size * 0.3))}
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

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-bold tracking-wide text-muted uppercase">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
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
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
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
        <div className="max-h-[60vh] overflow-y-auto px-6 py-4">{children}</div>
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

export const Icons = {
  Hash: icon(L.Hash),
  Speaker: icon(L.Volume2),
  Plus: icon(L.Plus),
  Compass: icon(L.Compass),
  Users: icon(L.Users),
  Settings: icon(L.Settings),
  Chevron: icon(L.ChevronDown),
  User: icon(L.User),
  Reply: icon(L.Reply),
  X: icon(L.X),
  Edit: icon(L.Pencil),
  Trash: icon(L.Trash2),
  Logout: icon(L.LogOut),
  Link: icon(L.Link),
  Check: icon(L.Check),
  Message: icon(L.MessageCircle),
  Search: icon(L.Search),
  Mic: icon(L.Mic),
  MicOff: icon(L.MicOff),
  Headphones: icon(L.Headphones),
  HeadphonesOff: icon(L.HeadphoneOff),
  Video: icon(L.Video),
  VideoOff: icon(L.VideoOff),
  Screen: icon(L.MonitorUp),
  Phone: icon(L.Phone),
  PhoneOff: icon(L.PhoneOff),
  Expand: icon(L.Maximize2),
  Waves: icon(L.AudioLines),
  Signal: icon(L.Signal),
  Sliders: icon(L.SlidersHorizontal),
  Paperclip: icon(L.Paperclip),
  Thread: icon(L.MessagesSquare),
  File: icon(L.File),
  FileText: icon(L.FileText),
  Download: icon(L.Download),
  Folder: icon(L.Folder),
};

'use client';

import type { Presence } from '@line/shared';
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
const icon = (path: ReactNode) =>
  function Icon({ size = 20, className }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden
      >
        {path}
      </svg>
    );
  };

export const Icons = {
  Hash: icon(<path d="M5 9h14M5 15h14M10 3 8 21M16 3l-2 18" />),
  Speaker: icon(
    <>
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />
    </>,
  ),
  Plus: icon(<path d="M12 5v14M5 12h14" />),
  Compass: icon(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" />
    </>,
  ),
  Users: icon(
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6" />
    </>,
  ),
  Settings: icon(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>,
  ),
  Chevron: icon(<path d="m6 9 6 6 6-6" />),
  User: icon(<path d="M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" />),
  X: icon(<path d="M18 6 6 18M6 6l12 12" />),
  Edit: icon(<path d="M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z" />),
  Trash: icon(<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />),
  Logout: icon(<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />),
  Link: icon(<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />),
  Check: icon(<path d="M20 6 9 17l-5-5" />),
  Message: icon(<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12Z" />),
  Search: icon(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>,
  ),
  Mic: icon(
    <>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8" />
    </>,
  ),
  MicOff: icon(
    <>
      <path d="M15 9.3V5a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.7 2.5M5 10a7 7 0 0 0 11.5 5.4M19 10a7 7 0 0 1-.6 2.8M12 17v4M8 21h8M3 3l18 18" />
    </>,
  ),
  Headphones: icon(<path d="M3 18v-6a9 9 0 0 1 18 0v6M21 19a2 2 0 0 1-2 2h-1v-6h3ZM3 19a2 2 0 0 0 2 2h1v-6H3Z" />),
  HeadphonesOff: icon(<path d="M3 18v-6a9 9 0 0 1 14.5-7.1M21 12v6M21 19a2 2 0 0 1-2 2h-1v-6h3ZM3 19a2 2 0 0 0 2 2h1v-6H3ZM3 3l18 18" />),
  Video: icon(
    <>
      <rect x="2" y="6" width="14" height="12" rx="2" />
      <path d="m16 10 6-3v10l-6-3" />
    </>,
  ),
  VideoOff: icon(<path d="M10.7 6H14a2 2 0 0 1 2 2v3.3l1 1 5-2.3v10l-5-2.5M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2M3 3l18 18" />),
  Screen: icon(
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4M12 7v6M9 10l3-3 3 3" />
    </>,
  ),
  Phone: icon(<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z" />),
  PhoneOff: icon(<path d="M10.7 13.3a16 16 0 0 0 3.3 2.5l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 3.1 4.2 2 2 0 0 1 5.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L9 9.8M22 2 2 22" />),
  Expand: icon(<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />),
  Waves: icon(<path d="M2 12h2M6 8v8M10 5v14M14 8v8M18 10v4M22 12h0" />),
  Signal: icon(<path d="M4 20v-3M9 20v-7M14 20V9M19 20V4" />),
  Sliders: icon(<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />),
  Paperclip: icon(<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />),
  Thread: icon(
    <>
      <path d="M21 11.5a7.5 7.5 0 0 1-11 6.6L4 20l1.9-5.5A7.5 7.5 0 1 1 21 11.5Z" />
      <path d="M8.5 10h7M8.5 13.5h4.5" />
    </>,
  ),
  File: icon(
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
      <path d="M14 3v6h6" />
    </>,
  ),
  FileText: icon(
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
      <path d="M14 3v6h6M8 13h8M8 17h5" />
    </>,
  ),
  Download: icon(<path d="M12 3v12M7 10l5 5 5-5M4 21h16" />),
  Folder: icon(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />),
};

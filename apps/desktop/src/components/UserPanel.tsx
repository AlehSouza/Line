'use client';

import type { UserStatus } from '@line/shared';
import { useState } from 'react';
import { api } from '@/lib/api';
import { logout } from '@/lib/session';
import { actions, useLine } from '@/lib/store';
import { Avatar, cx, Icons, PresenceDot } from './ui';

const statusOptions: { value: UserStatus; label: string; hint?: string; presence: 'online' | 'idle' | 'dnd' | 'offline' }[] = [
  { value: 'online', label: 'Disponível', presence: 'online' },
  { value: 'idle', label: 'Ausente', presence: 'idle' },
  { value: 'dnd', label: 'Não perturbe', hint: 'Você não vai receber notificações', presence: 'dnd' },
  { value: 'invisible', label: 'Invisível', hint: 'Você aparece offline, mas usa tudo normalmente', presence: 'offline' },
];

export function UserPanel() {
  const me = useLine((s) => s.me);
  const [open, setOpen] = useState(false);
  if (!me) return null;

  const shownPresence = me.status === 'invisible' ? 'offline' : me.presence === 'offline' ? 'online' : me.presence;

  async function setStatus(status: UserStatus) {
    setOpen(false);
    try {
      actions.setMe(await api.updateMe({ status }));
    } catch (e) {
      alert((e as Error).message);
    }
  }

  return (
    <div className="relative flex h-[52px] items-center gap-2 bg-rail/70 px-2">
      {open && (
        <div
          className="absolute bottom-full left-2 z-30 mb-2 w-60 rounded-lg border border-edge bg-rail p-1.5 shadow-xl"
          onMouseLeave={() => setOpen(false)}
        >
          {statusOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setStatus(opt.value)}
              className={cx(
                'flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left hover:bg-hover',
                me.status === opt.value && 'bg-raise',
              )}
            >
              <PresenceDot presence={opt.presence} ring="rail" className="mt-1.5 shrink-0" />
              <span>
                <span className="block text-sm font-medium">{opt.label}</span>
                {opt.hint && <span className="block text-xs text-muted">{opt.hint}</span>}
              </span>
            </button>
          ))}
          <div className="my-1 h-px bg-edge" />
          <button
            onClick={() => {
              setOpen(false);
              actions.openModal({ kind: 'profile' });
            }}
            className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm hover:bg-hover"
          >
            <Icons.Edit size={16} /> Editar perfil e status
          </button>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-hover"
      >
        <Avatar name={me.displayName} color={me.avatarColor} size={32} presence={shownPresence} ring="rail" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{me.displayName}</span>
          <span className="block truncate text-xs text-muted">{me.customStatus || `@${me.username}`}</span>
        </span>
      </button>
      <button title="Configurações do perfil" onClick={() => actions.openModal({ kind: 'profile' })} className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg">
        <Icons.Settings size={18} />
      </button>
      <button title="Sair da conta" onClick={logout} className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-danger">
        <Icons.Logout size={18} />
      </button>
    </div>
  );
}

'use client';

import { useShallow } from 'zustand/react/shallow';
import { api } from '@/lib/api';
import { actions, dmTitle, useLine } from '@/lib/store';
import { Avatar, cx, Icons } from './ui';

export function DmSidebar() {
  const view = useLine((s) => s.view);
  const me = useLine((s) => s.me);
  const users = useLine((s) => s.users);
  const unread = useLine((s) => s.unread);
  const dms = useLine(useShallow((s) => s.dmOrder.map((id) => s.channels[id]!).filter(Boolean)));
  const activeDm = view.kind === 'home' ? view.dmId : null;
  const pending = useLine((s) => Object.values(s.friends).filter((f) => f.state === 'incoming').length);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center border-b border-rail px-2 shadow-sm">
        <button
          onClick={() => actions.openModal({ kind: 'new-dm' })}
          className="w-full rounded-md bg-rail px-2 py-1.5 text-left text-sm text-muted"
        >
          Iniciar uma conversa
        </button>
      </div>
      <div className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
        <button
          onClick={() => actions.goHome(null)}
          className={cx(
            'flex w-full items-center gap-3 rounded-md px-2 py-2 font-medium',
            view.kind === 'home' && !activeDm ? 'bg-hover text-fg' : 'text-muted hover:bg-hover hover:text-soft',
          )}
        >
          <Icons.Users />
          <span className="flex-1 text-left">Amigos</span>
          {pending > 0 && (
            <span className="rounded-full bg-danger px-1.5 text-xs leading-5 font-bold text-white">{pending}</span>
          )}
        </button>

        <div className="flex items-center justify-between px-2 pt-4 pb-1">
          <span className="text-xs font-bold tracking-wide text-muted uppercase">Mensagens diretas</span>
          <button title="Nova conversa" onClick={() => actions.openModal({ kind: 'new-dm' })} className="text-muted hover:text-fg">
            <Icons.Plus size={16} />
          </button>
        </div>

        {dms.length === 0 && <p className="px-2 py-2 text-xs text-muted">Nenhuma conversa ainda.</p>}

        {dms.map((dm) => {
          const others = (dm.recipients ?? []).filter((r) => r.id !== me?.id);
          const first = others[0] ? (users[others[0].id] ?? others[0]) : me;
          const isGroup = dm.type === 'group_dm';
          const active = activeDm === dm.id;
          const count = unread[dm.id];
          return (
            <div key={dm.id} className="group relative">
              <button
                onClick={() => actions.goHome(dm.id)}
                className={cx(
                  'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left',
                  active ? 'bg-hover text-fg' : count ? 'text-fg hover:bg-hover' : 'text-muted hover:bg-hover hover:text-soft',
                )}
              >
                {first && (
                  <Avatar
                    name={isGroup ? dmTitle(dm, me?.id, users) : first.displayName}
                    color={isGroup ? '#3a3a42' : first.avatarColor}
                    size={32}
                    presence={isGroup ? undefined : (users[first.id]?.presence ?? first.presence)}
                    ring={active ? 'raise' : 'side'}
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className={cx('block truncate text-[15px]', count && 'font-semibold')}>
                    {dmTitle(dm, me?.id, users)}
                  </span>
                  {isGroup ? (
                    <span className="block truncate text-xs text-muted">{dm.recipients?.length} membros</span>
                  ) : (
                    first &&
                    users[first.id]?.customStatus && (
                      <span className="block truncate text-xs text-muted">{users[first.id]?.customStatus}</span>
                    )
                  )}
                </span>
                {!!count && (
                  <span className="rounded-full bg-danger px-1.5 text-xs leading-5 font-bold text-white">{count}</span>
                )}
              </button>
              {isGroup && (
                <button
                  title="Sair do grupo"
                  onClick={async () => {
                    if (confirm('Sair deste grupo?')) await api.leaveGroup(dm.id).catch((e) => alert(e.message));
                  }}
                  className="absolute top-1/2 right-2 hidden -translate-y-1/2 text-muted group-hover:block hover:text-danger"
                >
                  <Icons.X size={16} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

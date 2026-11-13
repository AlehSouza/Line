'use client';

import type { PublicUser } from '@line/shared';
import { useMemo } from 'react';
import { actions, useLine } from '@/lib/store';
import { Avatar, cx, ListSkeleton } from './ui';

export function MemberList({ serverId }: { serverId: string }) {
  const members = useLine((s) => s.members[serverId]);
  const users = useLine((s) => s.users);
  const ownerId = useLine((s) => s.servers[serverId]?.ownerId);

  const { online, offline } = useMemo(() => {
    const list = Object.values(members ?? {})
      .map((m) => ({ ...m, user: users[m.userId] }))
      .filter((m): m is typeof m & { user: PublicUser } => !!m.user)
      .sort((a, b) => (a.nickname ?? a.user.displayName).localeCompare(b.nickname ?? b.user.displayName, 'pt-BR'));
    return {
      online: list.filter((m) => m.user.presence !== 'offline'),
      offline: list.filter((m) => m.user.presence === 'offline'),
    };
  }, [members, users]);

  const section = (label: string, list: typeof online) =>
    list.length > 0 && (
      <div>
        <h3 className="px-2 pb-1 text-xs font-bold tracking-wide text-muted uppercase">
          {label} — {list.length}
        </h3>
        {list.map((m) => (
          <button
            key={m.userId}
            onClick={() => actions.openModal({ kind: 'user', userId: m.userId })}
            className={cx(
              'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-hover',
              m.user.presence === 'offline' && 'opacity-40 hover:opacity-100',
            )}
          >
            <Avatar name={m.user.displayName} color={m.user.avatarColor} src={m.user.avatarUrl} size={32} presence={m.user.presence} />
            <span className="min-w-0">
              <span className="flex items-center gap-1 truncate text-[15px] font-medium" style={{ color: m.user.avatarColor }}>
                {m.nickname ?? m.user.displayName}
                {m.userId === ownerId && (
                  <span title="Dono do servidor" className="text-sun">
                    ★
                  </span>
                )}
              </span>
              {m.user.customStatus && <span className="block truncate text-xs text-muted">{m.user.customStatus}</span>}
            </span>
          </button>
        ))}
      </div>
    );

  return (
    <aside className="hidden w-60 shrink-0 space-y-5 overflow-y-auto bg-side px-2 py-4 lg:block">
      {!members ? (
        <ListSkeleton count={8} avatar />
      ) : (
        <>
          {section('Online', online)}
          {section('Offline', offline)}
        </>
      )}
    </aside>
  );
}

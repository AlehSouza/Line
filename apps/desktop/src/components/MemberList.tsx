'use client';

import type { PublicUser } from '@line/shared';
import { useMemo, useState } from 'react';
import { SearchBox, SearchResults } from './SearchPanel';
import { actions, useLine } from '@/lib/store';
import { openContextMenu, userMenu } from './ContextMenu';
import { Avatar, cx, ListSkeleton } from './ui';

export function MemberList({ serverId }: { serverId: string }) {
  const members = useLine((s) => s.members[serverId]);
  const users = useLine((s) => s.users);
  const ownerId = useLine((s) => s.servers[serverId]?.ownerId);
  const roles = useLine((s) => s.roles[serverId]);
  // Cor do cargo mais alto (com cor) de cada um.
  const colorOf = (roleIds: string[]) => (roles ?? []).find((r) => r.color && roleIds.includes(r.id))?.color ?? undefined;

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
            onClick={(e) => actions.openModal({ kind: 'user', userId: m.userId, at: { x: e.clientX, y: e.clientY } })}
            onContextMenu={(e) => openContextMenu(e, userMenu(m.userId, { x: e.clientX, y: e.clientY }, serverId))}
            className={cx(
              'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-hover',
              m.user.presence === 'offline' && 'opacity-40 hover:opacity-100',
            )}
          >
            <Avatar name={m.user.displayName} color={m.user.avatarColor} src={m.user.avatarUrl} size={32} presence={m.user.presence} />
            <span className="min-w-0">
              <span className="flex items-center gap-1 truncate text-[15px] font-medium" style={{ color: colorOf(m.roleIds) }}>
                {m.nickname || m.user.displayName}
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
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-2 py-4">
      {!members ? (
        <ListSkeleton count={8} avatar />
      ) : (
        <>
          {section('Online', online)}
          {section('Offline', offline)}
        </>
      )}
    </div>
  );
}

/** Coluna da direita do servidor: busca no topo e, embaixo, membros ou resultados. */
export function ServerSidePanel({ serverId }: { serverId: string }) {
  const [query, setQuery] = useState<string | null>(null);
  return (
    <aside className={cx('hidden shrink-0 flex-col bg-side transition-[width] lg:flex', query ? 'w-[420px]' : 'w-60')}>
      <div className="flex h-12 shrink-0 items-center border-b border-rail px-2 shadow-sm">
        <div className="flex-1">
          <SearchBox serverId={serverId} active={!!query} onSearch={setQuery} onClear={() => setQuery(null)} />
        </div>
      </div>
      {query ? <SearchResults key={query} serverId={serverId} query={query} /> : <MemberList serverId={serverId} />}
    </aside>
  );
}

'use client';

import { StyledName } from '@/lib/nameStyle';
import type { PublicUser } from '@line/shared';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { SearchBox, SearchResults } from './SearchPanel';
import { actions, useLine } from '@/lib/store';
import { openContextMenu, userMenu } from './ContextMenu';
import { Avatar, cx, ListSkeleton } from './ui';
import { BotTag, MusicPlayer } from './Music';
import { UserTagBadge } from './ServerTag';
import { ActivitySection } from './Activity';

export function MemberList({ serverId }: { serverId: string }) {
  const members = useLine((s) => s.members[serverId]);
  const users = useLine((s) => s.users);
  const ownerId = useLine((s) => s.servers[serverId]?.ownerId);
  const roles = useLine((s) => s.roles[serverId]);
  // Canal de texto aberto: a lista mostra só quem tem acesso a ele (canal/categoria exclusivos).
  const channelId = useLine((s) => (s.view.kind === 'server' && s.view.serverId === serverId ? s.view.channelId : null));
  const [audience, setAudience] = useState<{ channelId: string; ids: Set<string> | null } | null>(null);
  useEffect(() => {
    if (!channelId) return setAudience(null);
    let alive = true;
    api.channelAudience(channelId).then(
      (r) => alive && setAudience({ channelId, ids: r.userIds ? new Set(r.userIds) : null }),
      () => alive && setAudience(null),
    );
    return () => {
      alive = false;
    };
    // Cargos e membros mudam quem enxerga o canal: busca de novo.
  }, [channelId, roles, members]);
  const allowed = audience && audience.channelId === channelId ? audience.ids : null;
  // Cor do cargo mais alto (com cor) de cada um.
  const colorOf = (roleIds: string[]) => (roles ?? []).find((r) => r.color && roleIds.includes(r.id))?.color ?? undefined;

  // Online: quem tem cargo "exibir separadamente" vai para a seção do mais alto deles (ordem dos cargos);
  // o resto fica em "Online". Offline fica tudo junto.
  const sections = useMemo(() => {
    const list = Object.values(members ?? {})
      .map((m) => ({ ...m, user: users[m.userId] }))
      .filter((m): m is typeof m & { user: PublicUser } => !!m.user && (!allowed || allowed.has(m.userId)))
      .sort((a, b) => (a.nickname ?? a.user.displayName).localeCompare(b.nickname ?? b.user.displayName, 'pt-BR'));
    const hoisted = (roles ?? []).filter((r) => r.hoist && r.id !== serverId);
    const groups = hoisted.map((r) => ({ key: r.id, label: r.name, list: [] as typeof list }));
    const online = { key: 'online', label: 'Online', list: [] as typeof list };
    const offline = { key: 'offline', label: 'Offline', list: [] as typeof list };
    for (const m of list) {
      if (m.user.presence === 'offline') offline.list.push(m);
      else (groups[hoisted.findIndex((r) => m.roleIds.includes(r.id))] ?? online).list.push(m);
    }
    return [...groups, online, offline];
  }, [members, users, roles, serverId, allowed]);

  const section = (key: string, label: string, list: (typeof sections)[number]['list']) =>
    list.length > 0 && (
      <div key={key}>
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
            <Avatar name={m.user.displayName} color={m.user.avatarColor} src={m.profile?.avatarUrl ?? m.user.avatarUrl} size={32} presence={m.user.presence} />
            <span className="min-w-0">
              <span className="flex items-center gap-1 truncate text-[15px] font-medium">
                <StyledName user={m.user} color={m.user.botStyle?.nameColor ?? colorOf(m.roleIds)} className="truncate">
                  {m.nickname || m.user.displayName}
                </StyledName>
                {m.user.bot && <BotTag user={m.user} />}
                <UserTagBadge user={m.user} />
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
          <ActivitySection serverId={serverId} />
          {sections.map((g) => section(g.key, g.label, g.list))}
        </>
      )}
    </div>
  );
}

/** Coluna da direita do servidor: busca no topo e, embaixo, membros ou resultados. */
export function ServerSidePanel({ serverId, drawer }: { serverId: string; drawer?: boolean }) {
  const [query, setQuery] = useState<string | null>(null);
  return (
    <aside
      className={cx(
        'shrink-0 flex-col bg-side',
        drawer ? 'flex h-full w-full' : cx('hidden transition-[width] lg:flex', query ? 'w-[420px]' : 'w-72'),
      )}
    >
      <div className="flex h-12 shrink-0 items-center border-b border-rail px-2 shadow-sm">
        <div className="flex-1">
          <SearchBox serverId={serverId} active={!!query} onSearch={setQuery} onClear={() => setQuery(null)} />
        </div>
      </div>
      {!query && <MusicPlayer serverId={serverId} />}
      {query ? <SearchResults key={query} serverId={serverId} query={query} /> : <MemberList serverId={serverId} />}
    </aside>
  );
}

/** Telas estreitas: membros e busca numa gaveta que desliza da direita por cima do chat. */
export function MembersDrawer({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/50 lg:hidden" onClick={onClose}>
      <div
        className="h-full w-[85%] max-w-[360px] shadow-2xl"
        style={{ animation: 'line-drawer-in 0.18s ease-out' }}
        onClick={(e) => e.stopPropagation()}
      >
        <ServerSidePanel serverId={serverId} drawer />
      </div>
    </div>
  );
}

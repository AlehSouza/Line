'use client';

import { hasPerm, Perm, type Role } from '@line/shared';
import { useEffect, useImperativeHandle, useMemo, useState, type KeyboardEvent, type Ref } from 'react';
import { displayNameIn, permsOf, useLine } from '@/lib/store';
import { Avatar, cx } from './ui';

export interface MentionContext {
  serverId: string | null;
  roles: Role[];
  myRoleIds: string[];
}

const NO_ROLES: Role[] = [];
const NO_IDS: string[] = [];

/** O que o markdown precisa para desenhar menções de cargo. */
export function useMentionContext(serverId: string | null | undefined): MentionContext {
  const roles = useLine((s) => (serverId ? s.roles[serverId] : undefined) ?? NO_ROLES);
  const myRoleIds = useLine((s) => (serverId && s.me ? s.members[serverId]?.[s.me.id]?.roleIds : undefined) ?? NO_IDS);
  return useMemo(() => ({ serverId: serverId ?? null, roles, myRoleIds }), [serverId, roles, myRoleIds]);
}

export interface MentionPickerHandle {
  /** Devolve true se a tecla foi usada pela lista (setas, Enter, Tab, Esc). */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

type Option =
  | { kind: 'user'; id: string; label: string; sub: string; insert: string }
  | { kind: 'special'; id: string; label: string; sub: string; insert: string }
  | { kind: 'role'; id: string; label: string; sub: string; insert: string; color: string | null };

/** Lista que aparece ao digitar @ no campo de mensagem: membros, @everyone/@here e cargos. */
export function MentionPicker({
  serverId,
  channelId,
  text,
  caret,
  onPick,
  ref,
}: {
  serverId: string | null;
  channelId: string;
  text: string;
  caret: number;
  onPick: (start: number, end: number, insert: string) => void;
  ref?: Ref<MentionPickerHandle>;
}) {
  const [index, setIndex] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null);

  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@]{0,32})$/.exec(before);
  const query = m ? m[2]!.toLowerCase() : null;
  const start = m ? caret - m[2]!.length - 1 : -1;
  const open = query !== null && closedAt !== start;

  const options = useMemo<Option[]>(() => {
    if (query === null) return [];
    const state = useLine.getState();
    const meId = state.me?.id;
    const match = (...xs: string[]) => !query || xs.some((x) => x.toLowerCase().includes(query));
    const channel = state.channels[channelId];
    const ids = serverId ? Object.keys(state.members[serverId] ?? {}) : (channel?.recipients ?? []).map((r) => r.id);
    const users: Option[] = ids
      .map((id) => state.users[id])
      .filter((u): u is NonNullable<typeof u> => !!u && u.id !== meId)
      .map((u) => ({ u, name: displayNameIn(state, serverId, u.id) }))
      .filter(({ u, name }) => match(name, u.username, u.displayName))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 8)
      .map(({ u, name }) => ({ kind: 'user', id: u.id, label: name, sub: u.username, insert: `@${u.username} ` }));
    if (!serverId) return users;
    const perms = permsOf(state, serverId, meId);
    const canAll = hasPerm(perms, Perm.MentionEveryone);
    const specials: Option[] = canAll
      ? [
          { kind: 'special' as const, id: 'everyone', label: '@everyone', sub: 'Notificar todos que podem ver este canal.', insert: '@everyone ' },
          { kind: 'special' as const, id: 'here', label: '@here', sub: 'Notificar todos que estão online e podem ver este canal.', insert: '@here ' },
        ].filter((o) => match(o.label.slice(1)))
      : [];
    const roles: Option[] = (state.roles[serverId] ?? [])
      .filter((r) => r.id !== serverId && (r.mentionable || canAll) && match(r.name))
      .slice(0, 10)
      .map((r) => ({
        kind: 'role',
        id: r.id,
        label: `@${r.name}`,
        sub: 'Notificar usuários com este cargo que podem ver este canal.',
        insert: `@${r.name} `,
        color: r.color,
      }));
    return [...users, ...specials, ...roles];
  }, [query, serverId, channelId]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    if (query === null) setClosedAt(null);
  }, [query]);

  const visible = open && options.length > 0;
  const pick = (o: Option) => onPick(start, caret, o.insert);

  useImperativeHandle(ref, () => ({
    onKeyDown(e) {
      if (!visible) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setIndex((i) => (i + d + options.length) % options.length);
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const o = options[Math.min(index, options.length - 1)];
        if (o) pick(o);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setClosedAt(start);
        return true;
      }
      return false;
    },
  }));

  if (!visible) return null;

  const groups: { title?: string; items: Option[] }[] = [
    { title: 'Membros', items: options.filter((o) => o.kind === 'user') },
    { items: options.filter((o) => o.kind === 'special') },
    { title: 'Cargos', items: options.filter((o) => o.kind === 'role') },
  ].filter((g) => g.items.length);

  return (
    <div className="absolute right-0 bottom-full left-0 z-30 mb-2 max-h-80 overflow-y-auto rounded-xl border border-edge bg-rail p-2 shadow-2xl">
      {groups.map((g, gi) => (
        <div key={gi} className={cx(gi > 0 && 'mt-1 border-t border-edge pt-1')}>
          {g.title && <p className="px-2 pt-1 pb-1.5 text-xs font-semibold text-muted">{g.title}</p>}
          {g.items.map((o) => {
            const active = options[index] === o;
            const u = o.kind === 'user' ? useLine.getState().users[o.id] : undefined;
            return (
              <button
                key={`${o.kind}:${o.id}`}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o);
                }}
                onMouseEnter={() => setIndex(options.indexOf(o))}
                className={cx('flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left', active && 'bg-hover')}
              >
                {u && <Avatar name={u.displayName} color={u.avatarColor} src={u.avatarUrl} size={24} presence={u.presence} ring="rail" />}
                <span
                  className="min-w-0 flex-1 truncate text-[15px] font-medium"
                  style={o.kind === 'role' && o.color ? { color: o.color } : undefined}
                >
                  {o.label}
                </span>
                <span className="max-w-[55%] shrink-0 truncate text-xs text-muted">{o.sub}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

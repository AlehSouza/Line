'use client';

import { hasPerm, Perm, type Role } from '@line/shared';
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { actions, displayNameIn, mentionTag, mentionsToText, withoutCardCodes, permsOf, useLine } from '@/lib/store';
import { Avatar, Icons, cx } from './ui';

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
  | { kind: 'role'; id: string; label: string; sub: string; insert: string; color: string | null }
  | { kind: 'channel'; id: string; label: string; sub: string; insert: string };

/** Lista que aparece ao digitar @ no campo de mensagem (membros, @aqui/@todos e cargos) ou # (canais do servidor). */
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
  // #canal só existe dentro de servidor.
  const h = !m && serverId ? /(^|\s)#([^\s#]{0,32})$/.exec(before) : null;
  const hash = !!h;
  const hit = m ?? h;
  const query = hit ? hit[2]!.toLowerCase() : null;
  const start = hit ? caret - hit[2]!.length - 1 : -1;
  const open = query !== null && closedAt !== start;

  const options = useMemo<Option[]>(() => {
    if (query === null) return [];
    const state = useLine.getState();
    const meId = state.me?.id;
    const match = (...xs: string[]) => !query || xs.some((x) => x.toLowerCase().includes(query));
    if (hash && serverId) {
      const starts = (name: string) => (name.toLowerCase().startsWith(query) ? 0 : 1);
      return Object.values(state.channels)
        .filter((c) => c.serverId === serverId && c.type === 'text' && match(c.name))
        .sort((a, b) => starts(a.name) - starts(b.name) || a.position - b.position)
        .slice(0, 12)
        .map((c) => ({ kind: 'channel' as const, id: c.id, label: `#${c.name}`, sub: (c.categoryId && state.categories[c.categoryId]?.name) || '', insert: `#${c.name} ` }));
    }
    const channel = state.channels[channelId];
    const ids = serverId ? Object.keys(state.members[serverId] ?? {}) : (channel?.recipients ?? []).map((r) => r.id);
    const users: Option[] = ids
      .map((id) => state.users[id])
      .filter((u): u is NonNullable<typeof u> => !!u && u.id !== meId)
      .map((u) => ({ u, name: displayNameIn(state, serverId, u.id) }))
      // O agente do servidor aparece sempre, em primeiro, mesmo que não bata com o que foi digitado.
      .filter(({ u, name }) => (serverId && u.bot) || match(name, u.username, u.displayName))
      .sort((a, b) => Number(!!b.u.bot) - Number(!!a.u.bot) || a.name.localeCompare(b.name))
      .slice(0, 9)
      .map(({ u, name }) => ({ kind: 'user', id: u.id, label: name, sub: u.bot ? 'Agente' : u.username, insert: `${mentionTag(state, serverId, u.username)} ` }));
    if (!serverId) return users;
    const perms = permsOf(state, serverId, meId);
    const canAll = hasPerm(perms, Perm.MentionEveryone);
    const specials: Option[] = canAll
      ? [
          { kind: 'special' as const, id: 'aqui', label: '@aqui', sub: 'Notificar todos deste chat.', insert: '@aqui ' },
          { kind: 'special' as const, id: 'todos', label: '@todos', sub: 'Notificar todos do servidor.', insert: '@todos ' },
        ].filter((o) => match(o.label.slice(1), o.id === 'aqui' ? 'here' : 'everyone'))
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
  }, [query, hash, serverId, channelId]);

  useEffect(() => setIndex(0), [query]);
  const listRef = useRef<HTMLDivElement>(null);
  // Mantém o item selecionado pelas setas sempre visível na lista.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index]);
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
    { title: 'Canais de texto', items: options.filter((o) => o.kind === 'channel') },
  ].filter((g) => g.items.length);

  return (
    <div ref={listRef} className="absolute right-0 bottom-full left-0 z-30 mb-2 max-h-80 overflow-y-auto rounded-xl border border-edge bg-rail p-2 shadow-2xl">
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
                data-active={active}
                className={cx('flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left', active && 'bg-hover')}
              >
                {o.kind === 'channel' && <Icons.Hash size={18} className="shrink-0 text-muted" />}
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

/** `<#id>` no texto: tag #canal clicável que abre o canal (ou a conversa). */
export function ChannelMention({ id }: { id: string }) {
  const channel = useLine((s) => s.channels[id]);
  if (!channel) return <span className="rounded px-0.5 font-medium text-muted">#canal-indisponível</span>;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (channel.type === 'thread') actions.openThread(channel.id);
        else if (channel.serverId) actions.goServer(channel.serverId, channel.id);
      }}
      className="rounded bg-accent/15 px-0.5 font-medium text-accent hover:bg-accent/30"
    >
      #{withoutCardCodes(mentionsToText(channel.name, channel.serverId))}
    </button>
  );
}

'use client';

import type { Message } from '@line/shared';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { renderMarkdown } from '@/lib/markdown';
import { jumpToMessage } from '@/lib/session';
import { useLine } from '@/lib/store';
import { Avatar, cx, Icons, MessageSkeletons } from './ui';

type Key = 'de' | 'em' | 'tem' | 'menciona';
const FILTERS: { key: Key; title: string; hint: string; icon: ReactNode }[] = [
  { key: 'de', title: 'De um usuário específico', hint: 'usuário', icon: <Icons.User size={20} /> },
  { key: 'em', title: 'Enviado em um canal específico', hint: 'canal', icon: <Icons.Hash size={20} /> },
  { key: 'tem', title: 'Inclui um tipo específico de dados', hint: 'link, anexo, imagem ou arquivo', icon: <Icons.Paperclip size={20} /> },
  { key: 'menciona', title: 'Menciona um usuário específico', hint: 'usuário', icon: <Icons.AtSign size={20} /> },
];
const HAS = ['link', 'anexo', 'imagem', 'arquivo'];

/** Separa "de:ana em:geral tem:link oi" em filtros e texto livre. */
function parse(input: string) {
  const out: Partial<Record<Key, string>> = {};
  const text = input
    .replace(/(^|\s)(de|em|tem|menciona):(\S+)/gi, (_, sp: string, k: string, v: string) => {
      out[k.toLowerCase() as Key] = v;
      return sp;
    })
    .trim();
  return { ...out, text };
}

/** Campo de busca no topo da coluna da direita. */
export function SearchBox({ serverId, onSearch, onClear, active }: { serverId: string; onSearch: (query: string) => void; onClear: () => void; active: boolean }) {
  const server = useLine((s) => s.servers[serverId]);
  const members = useLine((s) => s.members[serverId]);
  const users = useLine((s) => s.users);
  const channels = useLine((s) => s.channels);
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // Último pedaço digitado: se é "chave:parcial", mostra sugestões.
  const last = value.match(/(?:^|\s)(de|em|tem|menciona):(\S*)$/i);
  const suggestions = useMemo(() => {
    if (!last) return [];
    const key = last[1]!.toLowerCase() as Key;
    const part = last[2]!.toLowerCase();
    if (key === 'tem') return HAS.filter((h) => h.startsWith(part)).map((h) => ({ value: h, label: h, icon: <Icons.Paperclip size={16} /> }));
    if (key === 'em')
      return Object.values(channels)
        .filter((c) => c.serverId === serverId && c.type === 'text' && c.name.toLowerCase().includes(part))
        .slice(0, 8)
        .map((c) => ({ value: c.name, label: c.name, icon: <Icons.Hash size={16} /> }));
    return Object.keys(members ?? {})
      .map((id) => users[id])
      .filter((u) => u && (u.username.includes(part) || u.displayName.toLowerCase().includes(part)))
      .slice(0, 8)
      .map((u) => ({
        value: u!.username,
        label: u!.displayName,
        sub: u!.username,
        icon: <Avatar name={u!.displayName} color={u!.avatarColor} src={u!.avatarUrl} size={20} />,
      }));
  }, [last?.[1], last?.[2], channels, members, users, serverId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setSel(0), [suggestions.length]);

  function complete(v: string) {
    setValue((cur) => cur.replace(/(\S*)$/, (tok) => `${tok.slice(0, tok.indexOf(':') + 1)}${v} `));
    input.current?.focus();
  }
  function addKey(k: Key) {
    setValue((cur) => `${cur.trim() ? `${cur.trimEnd()} ` : ''}${k}:`);
    input.current?.focus();
  }
  function submit() {
    if (!value.trim()) return;
    setFocused(false);
    input.current?.blur();
    onSearch(value.trim());
  }

  const showFilters = focused && !last;
  const showSuggest = focused && !!last && suggestions.length > 0;

  return (
    <div className="relative">
      <label className={cx('flex h-8 items-center gap-2 rounded-md bg-rail px-2.5 text-sm', focused && 'ring-1 ring-accent')}>
        <input
          ref={input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          onKeyDown={(e) => {
            if (showSuggest && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              setSel((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
            } else if (e.key === 'Enter' || e.key === 'Tab') {
              if (showSuggest) {
                e.preventDefault();
                complete(suggestions[sel]!.value);
              } else if (e.key === 'Enter') submit();
            } else if (e.key === 'Escape') input.current?.blur();
          }}
          placeholder={`Buscar ${server?.name ?? ''}`}
          className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-muted"
        />
        {value || active ? (
          <button
            title="Limpar"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setValue('');
              onClear();
            }}
            className="text-muted hover:text-fg"
          >
            <Icons.X size={16} />
          </button>
        ) : (
          <Icons.Search size={16} className="text-muted" />
        )}
      </label>

      {(showFilters || showSuggest) && (
        <div
          onMouseDown={(e) => e.preventDefault()}
          className="absolute top-full right-0 z-40 mt-2 w-[340px] rounded-xl border border-edge bg-side p-2 shadow-2xl"
        >
          {showFilters ? (
            <>
              <p className="px-2 pt-1 pb-2 text-xs font-bold text-muted">Filtros</p>
              {FILTERS.map((f) => (
                <button key={f.key} onClick={() => addKey(f.key)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-accent/10">
                  <span className="text-soft">{f.icon}</span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{f.title}</span>
                    <span className="block text-xs text-muted">
                      <strong className="text-soft">{f.key}:</strong> {f.hint}
                    </span>
                  </span>
                </button>
              ))}
            </>
          ) : (
            suggestions.map((sg, i) => (
              <button
                key={sg.value}
                onClick={() => complete(sg.value)}
                onMouseEnter={() => setSel(i)}
                className={cx('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm', i === sel ? 'bg-accent/15 text-fg' : 'text-soft')}
              >
                <span className="text-muted">{sg.icon}</span>
                <span className="truncate">{sg.label}</span>
                {(sg as { sub?: string }).sub && <span className="truncate text-xs text-muted">{(sg as { sub?: string }).sub}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** Resultados da busca, no lugar da lista de membros. */
export function SearchResults({ serverId, query }: { serverId: string; query: string }) {
  const channels = useLine((s) => s.channels);
  const users = useLine((s) => s.users);
  const myUsername = useLine((s) => s.me?.username);
  const [results, setResults] = useState<Message[] | null>(null);
  const [error, setError] = useState('');
  const [more, setMore] = useState(true);

  const params = useMemo(() => {
    const p = parse(query);
    let channelId: string | undefined;
    if (p.em) {
      const name = p.em.replace(/^#/, '').toLowerCase();
      channelId = Object.values(channels).find((c) => c.serverId === serverId && c.type === 'text' && c.name.toLowerCase() === name)?.id ?? '__none__';
    }
    return { server: serverId, q: p.text, author: p.de, in: channelId, mentions: p.menciona, has: p.tem?.toLowerCase() };
  }, [query, serverId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let live = true;
    setResults(null);
    setError('');
    api
      .search(params)
      .then((r) => live && (setResults(r), setMore(r.length === 25)))
      .catch((e: Error) => live && (setError(e.message), setResults([])));
    return () => {
      live = false;
    };
  }, [params]);

  async function loadMore() {
    if (!results) return;
    const next = await api.search({ ...params, offset: String(results.length) });
    setResults([...results, ...next]);
    setMore(next.length === 25);
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <p className="px-1 pb-2 text-xs font-bold tracking-wide text-muted uppercase">
        {results ? `${results.length}${more && results.length ? '+' : ''} ${results.length === 1 ? 'resultado' : 'resultados'}` : 'Buscando…'}
      </p>
      {!results && <MessageSkeletons count={4} />}
      {error && <p className="px-1 py-6 text-center text-sm text-muted">{error}</p>}
      {results?.length === 0 && !error && (
        <div className="py-12 text-center text-sm text-muted">
          <Icons.Search size={32} className="mx-auto mb-2 opacity-60" />
          Nada encontrado.
        </div>
      )}
      <div className="space-y-2">
        {results?.map((m) => {
          const ch = channels[m.channelId];
          const author = users[m.author.id] ?? m.author;
          return (
            <button
              key={m.id}
              onClick={() => void jumpToMessage(m)}
              className="block w-full rounded-lg border border-edge bg-main/60 p-2.5 text-left hover:border-accent/50 hover:bg-hover"
            >
              <p className="mb-1.5 flex items-center gap-1 truncate text-xs font-semibold text-muted">
                {ch?.type === 'thread' ? <Icons.Thread size={12} /> : <Icons.Hash size={12} />}
                {ch?.name ?? 'canal'}
              </p>
              <div className="flex gap-2.5">
                <Avatar name={author.displayName} color={author.avatarColor} src={author.avatarUrl} size={32} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-baseline gap-2">
                    <span className="truncate text-sm font-semibold" style={{ color: author.avatarColor }}>
                      {author.displayName}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted">
                      {new Date(m.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </p>
                  {m.content && <div className="line-clamp-4 text-sm break-words whitespace-pre-wrap text-soft">{renderMarkdown(m.content, myUsername)}</div>}
                  {m.attachments.length > 0 && (
                    <p className="mt-1 flex items-center gap-1 text-xs text-muted">
                      <Icons.Paperclip size={12} /> {m.attachments.length} {m.attachments.length === 1 ? 'anexo' : 'anexos'}
                    </p>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      {results && more && results.length > 0 && (
        <button onClick={() => void loadMore()} className="mt-3 w-full rounded-lg py-2 text-sm text-accent hover:bg-hover">
          Carregar mais
        </button>
      )}
    </div>
  );
}

'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import * as L from 'lucide-react';
import { cx, Icons } from './ui';

/** [emoji, nome em PT-BR, palavras-chave separadas por espaço] */
type EmojiRow = [string, string, string];
type EmojiGroup = { id: string; name: string; emojis: EmojiRow[] };

/** Fonte para os emojis ficarem coloridos em qualquer sistema. */
export const EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif';

// Os dados (emojibase, nomes em português) só carregam quando o seletor abre pela primeira vez.
let cache: Promise<EmojiGroup[]> | null = null;
function loadEmojis() {
  cache ??= import('@/lib/emoji-data.json').then((m) => (m.default ?? m) as unknown as EmojiGroup[]);
  return cache;
}

const RECENT_KEY = 'line:emoji-recentes';
const RECENT_MAX = 36;

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** Guarda o emoji no topo dos "Recentes" (vale para o seletor e para as reações). */
export function pushRecentEmoji(emoji: string) {
  try {
    const list = [emoji, ...readRecent().filter((e) => e !== emoji)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* sem armazenamento: só não lembra */
  }
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const TAB_ICONS: Record<string, L.LucideIcon> = {
  recentes: L.Clock,
  smileys: L.Smile,
  pessoas: L.PersonStanding,
  natureza: L.PawPrint,
  comida: L.Coffee,
  viagens: L.Car,
  atividades: L.Trophy,
  objetos: L.Lightbulb,
  simbolos: L.Heart,
  bandeiras: L.Flag,
};

const W = 400;
const H = 440;

/**
 * Seletor de emojis padrão do Line: abas por categoria, busca em português e "Recentes".
 * Abre flutuando perto de `anchor` (o botão que o abriu) e fecha com Esc ou clique fora.
 * Segure Shift ao escolher para escolher vários sem fechar.
 */
export function EmojiPicker({
  anchor,
  onPick,
  onClose,
}: {
  anchor: HTMLElement | null;
  onPick: (emoji: string, keepOpen: boolean) => void;
  onClose: () => void;
}) {
  const [groups, setGroups] = useState<EmojiGroup[] | null>(null);
  const [recent, setRecent] = useState<string[]>(() => readRecent());
  const [query, setQuery] = useState('');
  const [active, setActive] = useState('recentes');
  const [hover, setHover] = useState<EmojiRow | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadEmojis().then(setGroups);
  }, []);

  useLayoutEffect(() => {
    const place = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = Math.min(W, vw - 16);
      const h = Math.min(H, vh - 16);
      const r = anchor?.getBoundingClientRect() ?? { left: vw / 2, right: vw / 2, top: vh / 2, bottom: vh / 2 };
      let left = r.right - w;
      if (left < 8) left = Math.min(r.left, vw - w - 8);
      left = Math.max(8, Math.min(left, vw - w - 8));
      let top = r.top - h - 8;
      if (top < 8) top = Math.min(r.bottom + 8, vh - h - 8);
      setPos({ left, top: Math.max(8, top) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  const byChar = useMemo(() => {
    const m = new Map<string, EmojiRow>();
    for (const g of groups ?? []) for (const e of g.emojis) m.set(e[0], e);
    return m;
  }, [groups]);

  const results = useMemo(() => {
    const words = norm(query).trim().split(/\s+/).filter(Boolean);
    if (!words.length || !groups) return null;
    const out: { row: EmojiRow; score: number }[] = [];
    for (const g of groups)
      for (const row of g.emojis) {
        const name = norm(row[1]);
        const all = `${name} ${norm(row[2])}`;
        if (!words.every((w) => all.includes(w))) continue;
        out.push({ row, score: name.startsWith(words[0]!) ? 0 : name.includes(words[0]!) ? 1 : 2 });
      }
    return out.sort((a, b) => a.score - b.score).map((x) => x.row);
  }, [query, groups]);

  const sections: { id: string; name: string; emojis: EmojiRow[] }[] = useMemo(() => {
    const list = [];
    const rec = recent.map((e) => byChar.get(e) ?? ([e, e, ''] as EmojiRow));
    if (rec.length) list.push({ id: 'recentes', name: 'Recentes', emojis: rec });
    return [...list, ...(groups ?? [])];
  }, [recent, byChar, groups]);

  function pick(e: EmojiRow, keepOpen: boolean) {
    pushRecentEmoji(e[0]);
    if (keepOpen) setRecent(readRecent());
    onPick(e[0], keepOpen);
  }

  function jump(id: string) {
    setQuery('');
    setActive(id);
    requestAnimationFrame(() => {
      const el = scroller.current?.querySelector<HTMLElement>(`[data-section="${id}"]`);
      if (el && scroller.current) scroller.current.scrollTop = el.offsetTop - 4;
    });
  }

  function onScroll() {
    const sc = scroller.current;
    if (!sc || results) return;
    let current = sections[0]?.id ?? 'recentes';
    for (const el of sc.querySelectorAll<HTMLElement>('[data-section]')) {
      if (el.offsetTop - sc.scrollTop <= 24) current = el.dataset.section!;
    }
    setActive(current);
  }

  const grid = (rows: EmojiRow[]) => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(40px,1fr))]">
      {rows.map((e) => (
        <button
          key={e[0]}
          title={e[1]}
          onClick={(ev) => pick(e, ev.shiftKey)}
          onMouseEnter={() => setHover(e)}
          className="flex aspect-square items-center justify-center rounded-lg text-[26px] leading-none transition-transform hover:scale-110 hover:bg-raise"
          style={{ fontFamily: EMOJI_FONT }}
        >
          {e[0]}
        </button>
      ))}
    </div>
  );

  let body: ReactNode;
  if (!groups) body = <p className="py-16 text-center text-sm text-muted">Carregando emojis…</p>;
  else if (results)
    body = results.length ? (
      <section>
        <h3 className="px-1 pt-1 pb-1.5 text-xs font-bold text-muted">Resultados</h3>
        {grid(results)}
      </section>
    ) : (
      <p className="py-16 text-center text-sm text-muted">Nenhum emoji encontrado para “{query.trim()}”.</p>
    );
  else
    body = sections.map((s) => (
      <section key={s.id} data-section={s.id} className="pb-2">
        <h3 className="sticky top-0 z-10 bg-side/95 px-1 pt-1 pb-1.5 text-xs font-bold text-muted backdrop-blur">{s.name}</h3>
        {grid(s.emojis)}
      </section>
    ));

  const tabs = [{ id: 'recentes', name: 'Recentes' }, ...(groups ?? []).map((g) => ({ id: g.id, name: g.name }))];

  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-label="Escolher emoji"
      className="fixed z-[80] flex flex-col overflow-hidden rounded-xl border border-edge bg-side shadow-2xl"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: `min(${W}px, calc(100vw - 16px))`, height: `min(${H}px, calc(100vh - 16px))` }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-edge px-2 pt-2">
        {tabs.map((t) => {
          const I = TAB_ICONS[t.id] ?? L.Smile;
          const on = !results && active === t.id;
          return (
            <button
              key={t.id}
              title={t.name}
              onClick={() => jump(t.id)}
              className={cx(
                'flex flex-1 justify-center border-b-2 px-1.5 pt-1 pb-2 transition-colors',
                on ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-soft',
              )}
            >
              <I size={18} strokeWidth={2} aria-hidden />
            </button>
          );
        })}
      </div>
      <div className="shrink-0 p-2.5">
        <label className="flex items-center gap-2 rounded-lg bg-rail px-3 py-2 text-sm text-muted ring-accent focus-within:ring-1">
          <Icons.Search size={16} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results?.[0]) pick(results[0], e.shiftKey);
            }}
            placeholder="Pesquisar emoji"
            className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-muted"
          />
        </label>
      </div>
      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {body}
      </div>
      <div className="flex h-11 shrink-0 items-center gap-2 border-t border-edge bg-rail/60 px-3 text-sm">
        {hover ? (
          <>
            <span className="text-2xl leading-none" style={{ fontFamily: EMOJI_FONT }}>
              {hover[0]}
            </span>
            <span className="truncate font-semibold text-soft">{hover[1]}</span>
          </>
        ) : (
          <span className="text-xs text-muted">Segure Shift para escolher vários</span>
        )}
      </div>
    </div>,
    document.body,
  );
}

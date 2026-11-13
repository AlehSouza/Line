'use client';

import { useEffect, useRef, useState } from 'react';
import { api, type Gif } from '@/lib/api';
import { Icons, Skeleton } from './ui';

/** Link de GIF do GIPHY sozinho na mensagem: mostra como imagem em vez de texto. */
export function gifFromContent(content: string): string | null {
  const t = content.trim();
  return /^https:\/\/media\d*\.giphy\.com\/media\/[\w/.-]+\.(gif|webp)(\?[\w=&.-]*)?$/.test(t) ? t : null;
}

export function GifEmbed({ url }: { url: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="GIF" loading="lazy" className="mt-1 max-h-72 max-w-[min(100%,400px)] rounded-lg" />
  );
}

/** Seletor de GIFs com busca e os em alta. */
export function GifPicker({ onPick, onClose }: { onPick: (gif: Gif) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState<Gif[] | null>(null);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.parentElement?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  useEffect(() => {
    const id = ++seq.current;
    setGifs(null);
    setError('');
    const t = window.setTimeout(() => {
      api
        .gifs(query.trim())
        .then((list) => id === seq.current && setGifs(list))
        .catch((e: Error) => id === seq.current && (setError(e.message), setGifs([])));
    }, 300);
    return () => window.clearTimeout(t);
  }, [query]);

  async function loadMore() {
    if (!gifs || more) return;
    setMore(true);
    const id = seq.current;
    try {
      const next = await api.gifs(query.trim(), gifs.length);
      if (id === seq.current) setGifs((g) => [...(g ?? []), ...next.filter((n) => !g?.some((x) => x.id === n.id))]);
    } catch {
      /* tenta de novo no próximo scroll */
    } finally {
      setMore(false);
    }
  }

  const cols: Gif[][] = [[], []];
  (gifs ?? []).forEach((g, i) => cols[i % 2]!.push(g));

  return (
    <div
      ref={box}
      className="absolute right-0 bottom-full z-30 mb-3 flex h-[440px] w-[420px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-edge bg-side shadow-2xl"
    >
      <div className="border-b border-edge p-3">
        <label className="flex items-center gap-2 rounded-lg bg-rail px-3 py-2 text-sm text-muted focus-within:ring-1 focus-within:ring-accent">
          <Icons.Search size={16} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar no GIPHY"
            className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-muted"
          />
        </label>
        <p className="mt-2 text-xs font-bold tracking-wide text-muted uppercase">{query.trim() ? 'Resultados' : 'Em alta'}</p>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto p-2"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollTop + el.clientHeight > el.scrollHeight - 200) void loadMore();
        }}
      >
        {error && <p className="py-10 text-center text-sm text-muted">{error}</p>}
        {!gifs ? (
          <div className="grid grid-cols-2 gap-2">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="rounded-lg" style={{ height: 90 + ((i * 37) % 70) }} />
            ))}
          </div>
        ) : gifs.length === 0 && !error ? (
          <p className="py-10 text-center text-sm text-muted">Nenhum GIF encontrado.</p>
        ) : (
          <div className="flex gap-2">
            {cols.map((col, c) => (
              <div key={c} className="flex flex-1 flex-col gap-2">
                {col.map((g) => (
                  <button
                    key={g.id}
                    title={g.title}
                    onClick={() => onPick(g)}
                    className="overflow-hidden rounded-lg bg-rail ring-accent transition hover:ring-2"
                    style={{ aspectRatio: g.width && g.height ? `${g.width} / ${g.height}` : undefined }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={g.preview} alt={g.title} loading="lazy" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="border-t border-edge px-3 py-1.5 text-right text-[10px] text-muted">Powered by GIPHY</p>
    </div>
  );
}

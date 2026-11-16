'use client';

import type { ConnectionType, ProfileConnection, ProfileGame } from '@line/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { Button, cx, Icons, Input, Modal } from './ui';

// ---------- conexões ----------

export const CONNECTION_TYPES: { id: ConnectionType; label: string; color: string; abbr: string; url?: (n: string) => string; placeholder: string }[] = [
  { id: 'twitch', label: 'Twitch', color: '#9146ff', abbr: 'Tw', url: (n) => `https://twitch.tv/${n}`, placeholder: 'seu canal' },
  { id: 'youtube', label: 'YouTube', color: '#ff0033', abbr: 'YT', url: (n) => `https://youtube.com/@${n.replace(/^@/, '')}`, placeholder: '@seucanal' },
  { id: 'steam', label: 'Steam', color: '#1b2838', abbr: 'St', url: (n) => `https://steamcommunity.com/id/${n}`, placeholder: 'id do perfil' },
  { id: 'spotify', label: 'Spotify', color: '#1db954', abbr: 'Sp', placeholder: 'seu nome' },
  { id: 'instagram', label: 'Instagram', color: '#e1306c', abbr: 'Ig', url: (n) => `https://instagram.com/${n.replace(/^@/, '')}`, placeholder: '@usuario' },
  { id: 'x', label: 'X', color: '#111111', abbr: 'X', url: (n) => `https://x.com/${n.replace(/^@/, '')}`, placeholder: '@usuario' },
  { id: 'github', label: 'GitHub', color: '#24292f', abbr: 'Gh', url: (n) => `https://github.com/${n}`, placeholder: 'usuario' },
  { id: 'tiktok', label: 'TikTok', color: '#010101', abbr: 'Tk', url: (n) => `https://tiktok.com/@${n.replace(/^@/, '')}`, placeholder: '@usuario' },
  { id: 'xbox', label: 'Xbox', color: '#107c10', abbr: 'Xb', placeholder: 'gamertag' },
  { id: 'playstation', label: 'PlayStation', color: '#0070d1', abbr: 'PS', placeholder: 'ID online' },
  { id: 'epic', label: 'Epic Games', color: '#2a2a2a', abbr: 'Ep', placeholder: 'nome de exibição' },
  { id: 'riot', label: 'Riot Games', color: '#d13639', abbr: 'Ri', placeholder: 'Nome#TAG' },
  { id: 'battlenet', label: 'Battle.net', color: '#148eff', abbr: 'Bn', placeholder: 'Nome#1234' },
  { id: 'site', label: 'Site', color: '#7c6af2', abbr: 'www', url: (n) => (/^https?:\/\//.test(n) ? n : `https://${n}`), placeholder: 'seusite.com' },
];

export function ConnectionIcon({ type, size = 24 }: { type: ConnectionType; size?: number }) {
  const t = CONNECTION_TYPES.find((c) => c.id === type);
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-md font-bold text-white"
      style={{ width: size, height: size, background: t?.color ?? '#555', fontSize: size * (t && t.abbr.length > 2 ? 0.3 : 0.42) }}
    >
      {t?.abbr ?? '?'}
    </span>
  );
}

/** Lista de conexões (perfil). */
export function ConnectionList({ list }: { list: ProfileConnection[] }) {
  return (
    <div className="space-y-2">
      {list.map((c, i) => {
        const t = CONNECTION_TYPES.find((x) => x.id === c.type);
        const href = t?.url?.(c.name);
        return (
          <div key={i} className="flex min-w-0 items-center gap-2.5 text-sm">
            <ConnectionIcon type={c.type} />
            {href ? (
              <a href={href} target="_blank" rel="noreferrer" title={t?.label} className="flex min-w-0 items-center gap-1 font-medium hover:underline">
                <span className="truncate">{c.name}</span>
                <Icons.Link size={13} className="shrink-0 text-muted" />
              </a>
            ) : (
              <span className="truncate font-medium" title={t?.label}>
                {c.name}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Editor das conexões (Editar perfil): escolhe a plataforma e escreve o nome. */
export function ConnectionsEditor({ value, onChange }: { value: ProfileConnection[]; onChange: (v: ProfileConnection[]) => void }) {
  const [type, setType] = useState<ConnectionType | null>(null);
  const [name, setName] = useState('');
  const t = CONNECTION_TYPES.find((c) => c.id === type);
  return (
    <div>
      {value.length > 0 && (
        <div className="mb-3 space-y-1.5">
          {value.map((c, i) => (
            <div key={i} className="flex items-center gap-2.5 rounded-lg border border-edge bg-rail px-2.5 py-2 text-sm">
              <ConnectionIcon type={c.type} />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <button type="button" title="Remover" onClick={() => onChange(value.filter((_, j) => j !== i))} className="text-muted hover:text-danger">
                <Icons.X size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
      {value.length < 10 && (
        <div className="flex flex-wrap gap-1.5">
          {CONNECTION_TYPES.map((c) => (
            <button
              key={c.id}
              type="button"
              title={c.label}
              onClick={() => setType(type === c.id ? null : c.id)}
              className={cx('rounded-lg border p-1', type === c.id ? 'border-accent bg-accent/15' : 'border-edge hover:bg-raise')}
            >
              <ConnectionIcon type={c.id} size={26} />
            </button>
          ))}
        </div>
      )}
      {t && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const n = name.trim();
            if (!n) return;
            onChange([...value, { type: t.id, name: n }]);
            setName('');
            setType(null);
          }}
        >
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder={`${t.label}: ${t.placeholder}`} />
          <Button type="submit" disabled={!name.trim()}>
            Adicionar
          </Button>
        </form>
      )}
    </div>
  );
}

// ---------- jogos do perfil ----------

export function GameCover({ game, size = 88, onRemove, children }: { game: ProfileGame; size?: number; onRemove?: () => void; children?: ReactNode }) {
  return (
    <span className="group/game relative block shrink-0" style={{ width: size }} title={game.name}>
      <span className="flex items-center justify-center overflow-hidden rounded-lg border border-edge bg-raise" style={{ width: size, height: Math.round(size * 1.33) }}>
        {game.cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={game.cover} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="flex flex-col items-center gap-1 px-1.5 text-center text-[11px] leading-tight text-soft">
            <Icons.Gamepad size={20} className="text-muted" />
            {game.name}
          </span>
        )}
      </span>
      {onRemove && (
        <button
          type="button"
          title="Tirar"
          onClick={onRemove}
          className="absolute -top-1.5 -right-1.5 hidden h-6 w-6 items-center justify-center rounded-full border border-edge bg-side text-soft shadow group-hover/game:flex hover:text-danger"
        >
          <Icons.X size={13} />
        </button>
      )}
      {children}
    </span>
  );
}

/** Jogo favorito + jogos que eu gosto (o "mural" do perfil). Com `edit`, dá para trocar. */
export function GamesBoard({
  favorite,
  liked,
  edit,
}: {
  favorite: ProfileGame | null;
  liked: ProfileGame[];
  edit?: { setFavorite: (g: ProfileGame | null) => void; setLiked: (l: ProfileGame[]) => void };
}) {
  const [picking, setPicking] = useState<'favorite' | 'liked' | null>(null);
  if (!edit && !favorite && !liked.length) return null;
  return (
    <div className="space-y-3">
      {(edit || favorite) && (
        <div className="rounded-xl border border-edge bg-rail/70 p-3.5">
          <p className="text-sm font-bold">Jogo favorito</p>
          {edit && <p className="text-xs text-muted">Escolha 1 jogo</p>}
          {favorite ? (
            <div className="mt-2.5 flex items-center gap-3.5">
              <GameCover game={favorite} size={84} onRemove={edit ? () => edit.setFavorite(null) : undefined} />
              <div className="min-w-0">
                <p className="truncate font-semibold">{favorite.name}</p>
                {edit && (
                  <button type="button" onClick={() => setPicking('favorite')} className="mt-1 text-xs text-accent hover:underline">
                    Trocar jogo
                  </button>
                )}
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setPicking('favorite')}
              className="mt-2.5 flex h-28 w-[84px] items-center justify-center rounded-lg border border-dashed border-edge text-muted hover:bg-raise hover:text-fg"
            >
              <Icons.Plus size={20} />
            </button>
          )}
        </div>
      )}
      {(edit || liked.length > 0) && (
        <div className="rounded-xl border border-edge bg-rail/70 p-3.5">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-bold">Jogos que eu gosto</p>
              {edit && <p className="text-xs text-muted">Adicionar até 20 jogos</p>}
            </div>
            {edit && liked.length < 20 && (
              <button type="button" title="Adicionar jogo" onClick={() => setPicking('liked')} className="rounded-lg bg-raise p-1.5 text-soft hover:text-fg">
                <Icons.Plus size={16} />
              </button>
            )}
          </div>
          {liked.length > 0 ? (
            <div className="mt-2.5 flex flex-wrap gap-2.5">
              {liked.map((g) => (
                <GameCover key={g.name} game={g} size={76} onRemove={edit ? () => edit.setLiked(liked.filter((x) => x.name !== g.name)) : undefined} />
              ))}
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted">Nenhum jogo ainda.</p>
          )}
        </div>
      )}
      {picking && edit && (
        <GamePicker
          title={picking === 'favorite' ? 'Jogo favorito' : 'Jogos que eu gosto'}
          taken={picking === 'liked' ? liked.map((g) => g.name.toLowerCase()) : []}
          onClose={() => setPicking(null)}
          onPick={(g) => {
            if (picking === 'favorite') {
              edit.setFavorite(g);
              setPicking(null);
            } else {
              edit.setLiked([...liked, g].slice(0, 20));
              if (liked.length + 1 >= 20) setPicking(null);
            }
          }}
        />
      )}
    </div>
  );
}

/** Busca de jogos (IGDB). Sem IGDB, ou se não achar, dá para usar o nome digitado. */
function GamePicker({ title, taken, onPick, onClose }: { title: string; taken: string[]; onPick: (g: ProfileGame) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const [results, setResults] = useState<ProfileGame[]>([]);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) return setResults([]);
    const n = ++seq.current;
    setLoading(true);
    const t = window.setTimeout(() => {
      api
        .searchGames(q)
        .then((r) => n === seq.current && setResults(r.games))
        .catch(() => n === seq.current && setResults([]))
        .finally(() => n === seq.current && setLoading(false));
    }, 350);
    return () => window.clearTimeout(t);
  }, [text]);

  const typed = text.trim();
  const exact = results.some((r) => r.name.toLowerCase() === typed.toLowerCase());

  return (
    <Modal title={title} subtitle="Procure pelo nome do jogo." onClose={onClose} width={520}>
      <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Ex.: Minecraft, VALORANT, Stardew Valley" maxLength={60} />
      <div className="mt-3 grid grid-cols-4 gap-3 sm:grid-cols-5">
        {results.map((g) => {
          const used = taken.includes(g.name.toLowerCase());
          return (
            <button key={g.name} type="button" disabled={used} onClick={() => onPick(g)} className="text-left disabled:opacity-40">
              <GameCover game={g} size={80} />
              <span className="mt-1 line-clamp-2 block text-xs text-soft">{g.name}</span>
            </button>
          );
        })}
      </div>
      {loading && <p className="mt-2 text-sm text-muted">Procurando…</p>}
      {!loading && typed.length >= 2 && !exact && !taken.includes(typed.toLowerCase()) && (
        <button type="button" onClick={() => onPick({ name: typed, cover: null })} className="mt-3 flex w-full items-center gap-2 rounded-lg border border-dashed border-edge px-3 py-2 text-left text-sm text-soft hover:bg-raise">
          <Icons.Plus size={15} /> Usar “{typed}” sem capa
        </button>
      )}
    </Modal>
  );
}

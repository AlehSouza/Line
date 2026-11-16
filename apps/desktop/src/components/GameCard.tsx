'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, type ServerActivity } from '@/lib/api';
import { actions, displayNameIn, useLine } from '@/lib/store';
import { ago, GameArt } from './Activity';
import { toast, showError } from './Dialogs';
import { EmojiPicker, readRecent, pushRecentEmoji } from './EmojiPicker';
import { Avatar, cx, Icons } from './ui';

// ---------- mensagem com o jogo ----------
// A resposta vai na DM com um marcador na última linha, que o app transforma no cartão do jogo:
//   <texto ou emoji>
//   [[jogo:<id de quem jogou>:<segundos na semana>]] <nome do jogo>|<url da capa>

const GAME_RE = /(?:^|\n)\[\[jogo:([\w-]+):(\d+)\]\] ([^\n|]*)\|?(\S*)$/;

export interface GameShare {
  text: string;
  userId: string;
  weekSecs: number;
  name: string;
  cover: string;
}

export function gameFromContent(content: string): GameShare | null {
  const m = GAME_RE.exec(content);
  if (!m) return null;
  return {
    text: content.slice(0, m.index).trim(),
    userId: m[1]!,
    weekSecs: Number(m[2]),
    name: m[3]!.trim(),
    cover: /^https:\/\//.test(m[4] ?? '') ? m[4]! : '',
  };
}

function gameContent(text: string, a: ServerActivity, weekSecs: number) {
  const name = a.name.replace(/[|\n]/g, ' ');
  const cover = a.cover && /^https:\/\//.test(a.cover) ? a.cover : '';
  return `${text.trim()}\n[[jogo:${a.userId}:${Math.round(weekSecs)}]] ${name}|${cover}`;
}

/** Tempo na semana, contando a sessão aberta. */
function weekOf(a: ServerActivity) {
  const base = a.weekSecs ?? 0;
  if (!a.playing || !a.since) return base;
  return base + Math.max(0, (Date.now() - new Date(a.since).getTime()) / 1000);
}

function hours(secs: number) {
  return secs < 3600 ? `${Math.max(1, Math.round(secs / 60))} min` : `${Math.round(secs / 3600)}h`;
}

function PlayedLine({ weekSecs, fallback }: { weekSecs: number; fallback?: string }) {
  if (weekSecs < 60 && fallback) return <span className="text-xs text-soft">{fallback}</span>;
  return (
    <span className="flex items-center gap-1 text-xs text-soft">
      <Icons.Trophy size={12} className="shrink-0" />
      Mais jogado — {hours(weekSecs)} esta semana
    </span>
  );
}

// ---------- fundo em gradiente na cor da capa ----------

const colorCache = new Map<string, [string, string] | null>();

function useArtColors(src?: string | null): [string, string] | null {
  const [colors, setColors] = useState<[string, string] | null>(() => (src && colorCache.get(src)) || null);
  useEffect(() => {
    if (!src) return setColors(null);
    if (colorCache.has(src)) return setColors(colorCache.get(src)!);
    let alive = true;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      let out: [string, string] | null = null;
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 16;
        const g = c.getContext('2d')!;
        g.drawImage(img, 0, 0, 16, 16);
        const d = g.getImageData(0, 0, 16, 16).data;
        const avg = (y0: number, y1: number) => {
          let r = 0, gg = 0, b = 0, n = 0;
          for (let y = y0; y < y1; y++)
            for (let x = 0; x < 16; x++) {
              const i = (y * 16 + x) * 4;
              if (d[i + 3]! < 128) continue;
              r += d[i]!; gg += d[i + 1]!; b += d[i + 2]!; n++;
            }
          return n ? `${Math.round(r / n)}, ${Math.round(gg / n)}, ${Math.round(b / n)}` : null;
        };
        const a = avg(0, 8), b = avg(8, 16);
        out = a && b ? [a, b] : null;
      } catch {
        out = null;
      }
      colorCache.set(src, out);
      if (alive) setColors(out);
    };
    img.onerror = () => {
      colorCache.set(src, null);
      if (alive) setColors(null);
    };
    img.src = src;
    return () => {
      alive = false;
    };
  }, [src]);
  return colors;
}

function GameBanner({ cover, icon, children, size }: { cover?: string | null; icon?: string | null; children: ReactNode; size: number }) {
  const colors = useArtColors(cover || icon);
  const bg = colors
    ? `linear-gradient(90deg, rgba(${colors[0]}, 0.45), rgba(${colors[1]}, 0.7))`
    : 'linear-gradient(90deg, color-mix(in srgb, var(--color-accent) 22%, transparent), color-mix(in srgb, var(--color-accent) 45%, transparent))';
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/5 p-2.5" style={{ background: bg }}>
      <GameArt cover={cover} icon={icon} size={size} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Cartão do jogo dentro da mensagem da DM. */
export function GameShareCard({ data }: { data: GameShare }) {
  const user = useLine((s) => s.users[data.userId] ?? (s.me?.id === data.userId ? s.me : undefined));
  const big = !!data.text && /^(\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(data.text);
  return (
    <div className="space-y-1.5">
      {data.text && (
        <div className={cx('break-words whitespace-pre-wrap text-soft', big ? 'text-4xl leading-tight' : 'text-[15px] leading-relaxed')}>{data.text}</div>
      )}
      <div className="max-w-md">
        <GameBanner cover={data.cover} size={50}>
          {user && (
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              <Avatar name={user.displayName} color={user.avatarColor} src={user.avatarUrl} size={18} />
              <span className="truncate">{user.displayName}</span>
            </span>
          )}
          <p className="truncate text-[17px] font-medium">{data.name}</p>
          <PlayedLine weekSecs={data.weekSecs} />
        </GameBanner>
      </div>
    </div>
  );
}

// ---------- cartão ao passar o mouse na Atividade ----------

const QUICK = ['🔥', '👍', '😂', '😮', '❤️'];

/**
 * Cartão flutuante de um item da Atividade: capa com gradiente, tempo na semana, reações rápidas e
 * "Conversar em @nome". Reagir ou responder manda na DM da pessoa a mensagem com o cartão do jogo.
 */
export function ActivityHoverCard({
  activity: a,
  serverId,
  anchor,
  onEnter,
  onLeave,
  onClose,
}: {
  activity: ServerActivity;
  serverId: string;
  anchor: DOMRect;
  onEnter: () => void;
  onLeave: (busy: boolean) => void;
  onClose: () => void;
}) {
  const user = useLine((s) => s.users[a.userId]);
  const meId = useLine((s) => s.me?.id);
  const name = useLine((s) => displayNameIn(s, serverId, a.userId));
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(anchor.top);
  const mine = a.userId === meId;
  const week = weekOf(a);
  const quick = [...new Set([...readRecent(), ...QUICK])].slice(0, 5);

  useEffect(() => {
    const h = box.current?.offsetHeight ?? 0;
    setTop(Math.max(8, Math.min(anchor.top, window.innerHeight - h - 8)));
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !picker && onClose();
    const onDown = (e: MouseEvent) => {
      if (picker) return;
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [picker, onClose]);

  async function send(body: string) {
    if (!body.trim() || sending) return;
    setSending(true);
    try {
      const dm = await api.openDm([a.userId]);
      actions.upsertChannel(dm);
      await api.sendMessage(dm.id, gameContent(body, a, week), [], ['game']);
      toast(`Enviado para ${name}`);
      onClose();
    } catch (e) {
      showError(e);
      setSending(false);
    }
  }

  const react = (emoji: string) => {
    pushRecentEmoji(emoji);
    void send(emoji);
  };

  return createPortal(
    <div
      ref={box}
      onMouseEnter={onEnter}
      onMouseLeave={() => onLeave(!!text || !!picker || document.activeElement?.closest('[data-game-card]') != null)}
      data-game-card
      className="fixed z-50 w-[340px] rounded-xl border border-edge bg-rail p-3.5 shadow-2xl"
      style={{ top, right: Math.max(8, window.innerWidth - anchor.left + 10) }}
    >
      <div className="mb-3 flex items-center gap-2">
        {user && <Avatar name={user.displayName} color={user.avatarColor} src={user.avatarUrl} size={22} />}
        <p className="min-w-0 flex-1 truncate text-sm">
          <span className="font-semibold">{name}</span>{' '}
          <span className="text-muted">{a.playing ? 'está jogando' : 'jogou'}</span>
        </p>
        <button
          title="Ver perfil"
          onClick={() => {
            onClose();
            actions.openModal({ kind: 'user', userId: a.userId, at: { x: anchor.left - 10, y: anchor.top } });
          }}
          className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
        >
          <Icons.More size={16} />
        </button>
      </div>

      <GameBanner cover={a.cover} icon={a.icon} size={50}>
        <p className="mb-1 truncate text-[17px] font-semibold">{a.name}</p>
        <PlayedLine weekSecs={week} fallback={a.playing ? 'Jogando agora' : `Jogou ${ago(a.lastPlayed)}`} />
      </GameBanner>

      {!mine && (
        <>
          <div className="my-3 h-px bg-edge" />
          <div className="flex items-center justify-between px-1">
            {quick.map((e) => (
              <button key={e} disabled={sending} onClick={() => react(e)} className="rounded-lg p-1.5 text-2xl leading-none transition hover:scale-110 hover:bg-hover disabled:opacity-50">
                {e}
              </button>
            ))}
            <button
              title="Mais emojis"
              disabled={sending}
              onClick={(e) => setPicker(e.currentTarget)}
              className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-fg"
            >
              <Icons.Smile size={22} />
            </button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(text);
            }}
            className="mt-3 flex items-center gap-2 rounded-lg border border-edge bg-raise px-3 py-2 focus-within:border-accent"
          >
            <Icons.AtSign size={16} className="shrink-0 text-muted" />
            <input
              value={text}
              disabled={sending}
              onChange={(e) => setText(e.target.value)}
              placeholder={`Conversar em @${name}`}
              maxLength={1500}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
            />
          </form>
        </>
      )}

      {picker && (
        <EmojiPicker
          anchor={picker}
          onClose={() => setPicker(null)}
          onPick={(emoji) => {
            setPicker(null);
            react(emoji);
          }}
        />
      )}
    </div>,
    document.body,
  );
}

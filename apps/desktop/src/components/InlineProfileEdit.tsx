'use client';

import { RotateCcw, Shuffle } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { FavoriteSong, Server } from '@line/shared';
import { useShallow } from 'zustand/react/shallow';
import { api, fileUrl } from '@/lib/api';
import { actions, useLine } from '@/lib/store';
import { TagPill } from './ServerTag';
import { showError, toast } from './Dialogs';
import { EmojiButton } from './EmojiField';
import { ColorPicker } from './ColorPicker';
import { ImageCropper } from './ImageCropper';
import { SongPlayer } from './ProfileExtras';
import { cx, DefaultServerIcon, Icons } from './ui';

/** Texto do próprio perfil que vira campo ao clicar. Enter ou sair do campo salva, Esc cancela. */
export function InlineText({
  value,
  placeholder,
  maxLength,
  multiline,
  emoji,
  onSave,
  className,
  inputClassName,
  children,
}: {
  value: string;
  placeholder: string;
  maxLength: number;
  multiline?: boolean;
  /** Botão de emojis no campo. */
  emoji?: boolean;
  onSave: (v: string) => Promise<unknown>;
  className?: string;
  inputClassName?: string;
  /** Como o valor aparece fora da edição (padrão: o próprio texto). */
  children?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  useEffect(() => {
    if (editing) {
      done.current = false;
      ref.current?.select();
    }
  }, [editing]);

  // Com o seletor de emoji aberto o campo perde o foco, mas a edição continua.
  const pickerOpen = () => !!document.querySelector('[role="dialog"][aria-label="Escolher emoji"]');
  const onBlur = () =>
    setTimeout(() => {
      if (document.activeElement === ref.current || pickerOpen()) return;
      commit();
    }, 0);
  const done = useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const v = draft.trim();
    if (v === value.trim()) return;
    onSave(v).catch((e) => {
      setDraft(value);
      showError(e);
    });
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      done.current = true;
      setDraft(value);
      setEditing(false);
    } else if (e.key === 'Enter' && (!multiline || !e.shiftKey)) {
      e.preventDefault();
      commit();
    }
  };

  if (editing) {
    const common = {
      ref,
      value: draft,
      maxLength,
      placeholder,
      onBlur,
      onKeyDown,
      className: cx('w-full rounded-md border border-accent bg-rail px-2 py-1 outline-none', inputClassName),
    };
    const field = multiline ? (
      <textarea {...common} onChange={(e) => setDraft(e.target.value)} rows={Math.min(6, Math.max(2, draft.split('\n').length))} style={{ resize: 'none' }} />
    ) : (
      <input {...common} onChange={(e) => setDraft(e.target.value)} />
    );
    if (!emoji) return field;
    return (
      <span className="relative block w-full [&>input]:pr-9">
        {field}
        <EmojiButton target={ref} onPickerClose={() => ref.current?.focus()} className="absolute top-1/2 right-2.5 -translate-y-1/2" />
      </span>
    );
  }
  return (
    <button
      type="button"
      title="Clique para editar"
      onClick={() => setEditing(true)}
      className={cx('max-w-full rounded-md text-left outline-none hover:bg-hover/60 focus-visible:ring-2 focus-visible:ring-accent', className)}
    >
      {value ? children ?? value : <span className="text-muted italic">{placeholder}</span>}
    </button>
  );
}

type Target = { serverId: string | null };

/** Salva um campo do perfil ativo: do servidor (quando aberto num servidor) ou o principal. */
export const saveProfile = {
  async name({ serverId }: Target, meId: string, v: string) {
    if (serverId) return actions.upsertMember(await api.setNickname(serverId, meId, v || null));
    if (!v) throw new Error('O nome de exibição não pode ficar vazio.');
    actions.setMe(await api.updateMe({ displayName: v }));
  },
  async bio({ serverId }: Target, v: string) {
    if (serverId) return actions.upsertMember(await api.setServerProfile(serverId, { bio: v }));
    actions.setMe(await api.updateMe({ bio: v }));
  },
  async image({ serverId }: Target, kind: 'avatar' | 'banner', id: string | null) {
    const patch = kind === 'avatar' ? { avatarId: id } : { bannerId: id };
    if (serverId) return actions.upsertMember(await api.setServerProfile(serverId, patch));
    actions.setMe(await api.updateMe(patch));
  },
};

/** Lápis do banner (e da foto, ao passar o mouse): trocar e remover faixa e avatar. */
export function ImageEditMenu({
  serverId,
  hasBanner,
  hasAvatar,
  onClose,
  anchor,
  align = 'left',
  saveImage,
}: {
  serverId: string | null;
  /** Onde salvar (o agente usa a rota dele); padrão: o meu perfil (ou o do servidor). */
  saveImage?: (kind: 'avatar' | 'banner', id: string | null) => Promise<unknown>;
  hasBanner: boolean;
  hasAvatar: boolean;
  onClose: () => void;
  /** Botão que abriu o menu: o menu flutua abaixo dele, fora do cartão. */
  anchor: HTMLElement;
  align?: 'left' | 'right';
}) {
  const box = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<'avatar' | 'banner'>('banner');
  const [crop, setCrop] = useState<File | null>(null);

  useEffect(() => {
    const down = (e: MouseEvent) => !crop && !box.current?.contains(e.target as Node) && !anchor.contains(e.target as Node) && onClose();
    window.addEventListener('mousedown', down, true);
    return () => window.removeEventListener('mousedown', down, true);
  }, [onClose, crop, anchor]);

  const pick = (k: 'avatar' | 'banner') => {
    setKind(k);
    file.current?.click();
  };
  async function upload(f: File) {
    if (!f.type.startsWith('image/') || f.type === 'image/svg+xml') return showError(new Error('Escolha uma imagem (PNG, JPG, GIF ou WebP).'));
    if (f.size > 8 * 1024 * 1024) return showError(new Error('A imagem precisa ter até 8 MB.'));
    onClose();
    try {
      toast('Enviando imagem…');
      const a = await api.uploadAttachment(f, f.name || 'imagem');
      await (saveImage ? saveImage(kind, a.id) : saveProfile.image({ serverId }, kind, a.id));
      toast(kind === 'avatar' ? 'Avatar atualizado.' : 'Faixa atualizada.');
    } catch (e) {
      showError(e);
    }
  }
  const remove = (k: 'avatar' | 'banner') => {
    onClose();
    (saveImage ? saveImage(k, null) : saveProfile.image({ serverId }, k, null)).catch(showError);
  };

  return (
    <Floating anchor={anchor} align={align} boxRef={box} className="w-52 p-1.5">
      <MenuItem onClick={() => pick('banner')}>Mudar faixa</MenuItem>
      <MenuItem onClick={() => pick('avatar')}>Alterar avatar</MenuItem>
      {(hasBanner || hasAvatar) && <div className="mx-1.5 my-1 border-t border-edge" />}
      {hasBanner && (
        <MenuItem danger onClick={() => remove('banner')}>
          Remover faixa
        </MenuItem>
      )}
      {hasAvatar && (
        <MenuItem danger onClick={() => remove('avatar')}>
          Remover avatar
        </MenuItem>
      )}
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          // GIF vai direto para manter a animação.
          if (f.type === 'image/gif') void upload(f);
          else setCrop(f);
        }}
      />
      {crop && (
        <ImageCropper
          file={crop}
          kind={kind}
          onCancel={() => setCrop(null)}
          onApply={(f) => {
            setCrop(null);
            void upload(f);
          }}
        />
      )}
    </Floating>
  );
}

/** Menu solto na tela (portal), preso abaixo do botão, para não ser cortado nem empurrar o cartão. */
function Floating({ anchor, align, boxRef, className, children }: { anchor: HTMLElement; align: 'left' | 'right'; boxRef: RefObject<HTMLDivElement | null>; className?: string; children: ReactNode }) {
  const [, redraw] = useState(0);
  useEffect(() => {
    const on = () => redraw((n) => n + 1);
    window.addEventListener('resize', on);
    window.addEventListener('scroll', on, true);
    return () => {
      window.removeEventListener('resize', on);
      window.removeEventListener('scroll', on, true);
    };
  }, []);
  const r = anchor.getBoundingClientRect();
  // Perto do fim da tela abre para cima, para não precisar rolar.
  const up = window.innerHeight - r.bottom < 300 && r.top > window.innerHeight - r.bottom;
  const style = {
    ...(up
      ? { bottom: window.innerHeight - r.top + 6, maxHeight: r.top - 12 }
      : { top: r.bottom + 6, maxHeight: window.innerHeight - r.bottom - 18 }),
    ...(align === 'right' ? { right: Math.max(8, window.innerWidth - r.right) } : { left: Math.max(8, Math.min(r.left, window.innerWidth - 340)) }),
  };
  return createPortal(
    <div
      ref={boxRef}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={style}
      className={cx('fixed z-[200] overflow-y-auto rounded-xl border border-edge bg-rail text-sm shadow-2xl', className)}
    >
      {children}
    </div>,
    document.body,
  );
}

function MenuItem({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'flex w-full items-center rounded-md px-2.5 py-2 text-left font-medium',
        danger ? 'text-danger hover:bg-danger hover:text-white' : 'text-soft hover:bg-accent hover:text-on-accent',
      )}
    >
      {children}
    </button>
  );
}


/** Tag do servidor no próprio perfil: chip com seta que abre a lista (com busca) das tags dos meus servidores. Salva ao escolher. */
export function TagPicker() {
  const me = useLine((s) => s.me);
  const servers = useLine(useShallow((s) => s.serverOrder.map((id) => s.servers[id]).filter((sv): sv is Server => !!sv && !!sv.tag && !sv.suspended)));
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', down, true);
    return () => window.removeEventListener('mousedown', down, true);
  }, [open]);

  if (!me) return null;
  const current = me.tag ? servers.find((sv) => sv.id === me.tag!.serverId) : undefined;
  const list = servers.filter((sv) => !q.trim() || `${sv.name} ${sv.tag}`.toLowerCase().includes(q.trim().toLowerCase()));
  const choose = (id: string | null) => {
    setOpen(false);
    setQ('');
    if (id === (me.tag?.serverId ?? null)) return;
    api.updateMe({ tagServerId: id }).then((u) => actions.setMe(u), showError);
  };

  return (
    <span ref={box} className="relative inline-flex">
      <button type="button" onClick={() => setOpen((v) => !v)} className="group/tag inline-flex rounded-md">
        <TagPill
          className={cx(
            'inline-flex items-center gap-1 rounded-md bg-raise px-1.5 py-0.5 text-[11px] leading-4 font-bold text-soft group-hover/tag:bg-hover group-hover/tag:text-fg',
            open && 'text-fg',
          )}
          text={current ? current.tag : <span className="font-medium italic">Escolher tag</span>}
          icon={current?.tagIcon}
          iconUrl={current ? current.iconUrl : undefined}
          tagStyle={current?.tagStyle}
          hideIcon={!current}
        >
          <Icons.Chevron size={13} className={cx('transition-transform', open && 'rotate-180')} />
        </TagPill>
      </button>
      {open && box.current && (
        <Floating anchor={box.current} align="left" boxRef={pop} className="w-80 p-2">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setOpen(false);
              }
            }}
            placeholder="Buscar"
            className="mb-1.5 w-full rounded-lg border border-edge bg-side px-3 py-2 outline-none focus:border-accent"
          />
          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            <TagRow active={!me.tag} onClick={() => choose(null)}>
              <span className="text-muted italic">Nenhuma tag do servidor</span>
            </TagRow>
            {list.map((sv) => (
              <TagRow key={sv.id} active={me.tag?.serverId === sv.id} onClick={() => choose(sv.id)}>
                <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-side">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {sv.iconUrl ? <img src={fileUrl(sv.iconUrl)} alt="" className="h-full w-full object-cover" /> : <DefaultServerIcon />}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium text-fg">{sv.name}</span>
                <TagPill
                  className="inline-flex shrink-0 items-center gap-1 rounded-md bg-raise px-1.5 py-px text-[11px] leading-4 font-bold text-soft"
                  text={sv.tag}
                  icon={sv.tagIcon}
                  iconUrl={sv.iconUrl}
                  tagStyle={sv.tagStyle}
                />
              </TagRow>
            ))}
            {!servers.length && <p className="px-2.5 py-2 text-xs text-muted">Nenhum servidor seu tem tag ainda. O dono cria em Configurações do servidor → Visão geral.</p>}
            {!!servers.length && !list.length && <p className="px-2.5 py-2 text-xs text-muted">Nada encontrado.</p>}
          </div>
        </Floating>
      )}
    </span>
  );
}

function TagRow({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cx('flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-hover', active && 'bg-hover')}>
      {children}
    </button>
  );
}

/** Música favorita no próprio perfil: placeholder pontilhado quando não tem; o player com trocar/remover quando tem. */
type SongSave = (patch: { favoriteSong: string | null }) => Promise<{ favoriteSong?: FavoriteSong | null }>;

export function SongSlot({
  song,
  onChange,
  colors,
  save = api.updateProfileExtras,
}: {
  song: FavoriteSong | null;
  onChange: (s: FavoriteSong | null) => void;
  colors?: string[] | null;
  /** Onde salvar (o agente usa a rota dele); padrão: o meu perfil. */
  save?: SongSave;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {song ? (
        <div>
          <SongPlayer song={song} colors={colors} onRemove={() => save({ favoriteSong: null }).then(() => onChange(null), showError)} />
          <button type="button" onClick={() => setOpen(true)} className="mt-1 text-xs text-soft hover:text-fg hover:underline">
            Trocar música
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="group flex w-full items-center gap-2.5 text-left">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-xl border-2 border-dashed border-edge text-muted group-hover:border-accent group-hover:text-fg">
            <Icons.Music size={20} />
          </span>
          <span className="flex h-12 min-w-0 flex-1 items-center gap-2 rounded-xl border-2 border-dashed border-edge px-3 text-sm text-muted group-hover:border-accent group-hover:text-fg">
            <Icons.Plus size={15} /> Adicionar música favorita
          </span>
        </button>
      )}
      {open && <SongSearchModal current={song} save={save} onClose={() => setOpen(false)} onPick={onChange} />}
    </>
  );
}

/** Modal de busca da música favorita: link do YouTube ou nome da música (o servidor acha no YouTube). */
function SongSearchModal({ current, save, onClose, onPick }: { current: FavoriteSong | null; save: SongSave; onClose: () => void; onPick: (s: FavoriteSong | null) => void }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [found, setFound] = useState<FavoriteSong | null>(current);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  async function search() {
    const t = q.trim();
    if (!t) return;
    setBusy(true);
    setError('');
    try {
      const r = await save({ favoriteSong: t });
      setFound(r.favoriteSong ?? null);
      onPick(r.favoriteSong ?? null);
      if (!r.favoriteSong) setError('Não achei essa música no YouTube.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="Música favorita"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex w-full max-w-[380px] flex-col gap-3 rounded-xl border border-edge bg-side p-3 shadow-2xl"
      >
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            maxLength={200}
            placeholder="Pesquisar no YouTube: nome da música ou link"
            className="h-9 min-w-0 flex-1 rounded-lg border border-edge bg-rail px-3 text-sm outline-none focus:border-accent"
          />
          <button
            type="submit"
            title="Pesquisar"
            disabled={busy || !q.trim()}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-on-accent hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <Icons.Search size={16} />}
          </button>
        </form>
        <div>
          {error && <p className="mb-2 text-sm text-danger">{error}</p>}
          {found ? (
            <>
              <p className="mb-2 text-xs font-bold text-soft">No perfil</p>
              <SongPlayer song={found} />
              <p className="mt-2 text-xs text-muted">Pesquise de novo para trocar.</p>
            </>
          ) : (
            !error && <p className="py-4 text-center text-xs text-muted">Pesquise uma música para colocar no perfil.</p>
          )}
        </div>
        <div className="flex justify-end">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-xs font-semibold text-soft hover:bg-hover hover:text-fg">
            Pronto
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Degradê sorteado: um tom mais vivo em cima e um escuro puxado para o lado embaixo. */
function randomCard(): [string, string] {
  const h = Math.floor(Math.random() * 360);
  const hex = (h: number, s: number, l: number) => {
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
        .toString(16)
        .padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  };
  return [hex(h, 0.55 + Math.random() * 0.3, 0.25 + Math.random() * 0.15), hex((h + 20 + Math.random() * 40) % 360, 0.5, 0.06 + Math.random() * 0.06)];
}

/** Sugestões de degradê para o cartão (cima, baixo). */
const CARD_PRESETS: [string, string][] = [
  ['#5a1020', '#1a0508'],
  ['#3b2a8f', '#0f0b24'],
  ['#0f5e5a', '#06201f'],
  ['#8f3b0f', '#24100a'],
  ['#7a1f6b', '#1f0a24'],
  ['#2b2b33', '#0d0d10'],
];

/** CSS do cartão do perfil: degradê das cores escolhidas com uma bordinha no mesmo degradê; sem cores, o visual de antes. */
export function cardStyle(colors: string[] | null | undefined, fallback: string): React.CSSProperties {
  if (!colors?.length) return { background: `linear-gradient(to bottom, color-mix(in srgb, ${fallback} 30%, var(--color-rail)), var(--color-rail) 45%)` };
  const [a, b = a] = colors as [string, string?];
  return {
    border: '2px solid transparent',
    background: `linear-gradient(to bottom, color-mix(in srgb, ${a} 55%, var(--color-rail)), color-mix(in srgb, ${b} 55%, var(--color-rail))) padding-box, linear-gradient(to bottom, ${a}, ${b}) border-box`,
  };
}

/** Bolinha no fim do cartão: escolhe o degradê do cartão. Mostra na hora e salva ao fechar. */
export function CardColorButton({
  colors,
  fallback,
  onPreview,
  save,
  size = 'size-6',
}: {
  colors: string[] | null | undefined;
  fallback: string;
  onPreview: (c: string[] | null) => void;
  /** Onde salvar ao fechar (o agente usa a rota dele); padrão: o meu perfil. */
  save?: (c: string[] | null) => Promise<unknown>;
  size?: string;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const start = useRef<string[] | null>(null);
  const cur = useRef<string[] | null>(colors ?? null);
  cur.current = colors ?? null;
  const [a, b] = colors?.length ? [colors[0]!, colors[1] ?? colors[0]!] : [fallback, '#0d0d10'];

  const close = () => {
    setOpen(false);
    const next = cur.current;
    if (JSON.stringify(next) === JSON.stringify(start.current)) return;
    if (save) return void save(next).catch(showError);
    api
      .updateProfileExtras({ cardColors: next })
      .then(async () => {
        if (next?.[0]) actions.setMe(await api.updateMe({ avatarColor: next[0] }));
      })
      .catch(showError);
  };

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Element;
      if (btn.current?.contains(t) || pop.current?.contains(t) || t.closest?.('[data-color-panel]')) return;
      close();
    };
    window.addEventListener('mousedown', down, true);
    return () => window.removeEventListener('mousedown', down, true);
  });

  return (
    <>
      <button
        ref={btn}
        type="button"
        title="Cor do cartão"
        onClick={() => {
          if (open) return close();
          start.current = colors ?? null;
          setOpen(true);
        }}
        className={cx(size, 'rounded-full border-2 border-white/70 shadow ring-offset-2 hover:ring-2 hover:ring-accent')}
        style={{ background: `linear-gradient(to bottom, ${a}, ${b})` }}
      />
      {open && btn.current && (
        <Floating anchor={btn.current} align="right" boxRef={pop} className="w-72 p-3">
          <div className="mb-2.5 flex items-center gap-1">
            <p className="flex-1 text-xs font-bold text-soft">Cor do cartão</p>
            <button type="button" title="Sortear cores" onClick={() => onPreview(randomCard())} className="rounded-md p-1.5 text-soft hover:bg-hover hover:text-fg">
              <Shuffle size={15} />
            </button>
            <button
              type="button"
              title="Voltar ao padrão"
              disabled={!colors?.length}
              onClick={() => onPreview(null)}
              className="rounded-md p-1.5 text-soft hover:bg-hover hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <RotateCcw size={15} />
            </button>
          </div>
          <div className="flex items-center gap-3">
            {(['Cima', 'Baixo'] as const).map((label, i) => (
              <label key={label} className="flex items-center gap-2 text-xs text-soft">
                <ColorPicker
                  value={i ? b : a}
                  onChange={(c) => onPreview(i ? [a, c] : [c, b])}
                  className="size-8 rounded-lg border-2 border-white/70 shadow"
                  style={{ background: i ? b : a }}
                />
                {label}
              </label>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {CARD_PRESETS.map((p) => (
              <button
                key={p.join()}
                type="button"
                onClick={() => onPreview(p)}
                className={cx('size-8 rounded-full border-2', p[0] === a && p[1] === b ? 'border-accent' : 'border-transparent')}
                style={{ background: `linear-gradient(to bottom, ${p[0]}, ${p[1]})` }}
              />
            ))}
          </div>
        </Floating>
      )}
    </>
  );
}

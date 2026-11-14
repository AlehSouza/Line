'use client';

import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import { api } from '@/lib/api';
import { actions, permsOf, useLine } from '@/lib/store';
import { hasPerm, Perm } from '@line/shared';
import { joinVoice } from '@/lib/voice';
import { cx, Icons } from './ui';
import { showError } from './Dialogs';

/**
 * Menus do clique direito do Line. O menu nativo do navegador/WebView2 (Voltar, Recarregar,
 * Inspecionar...) fica desligado; cada lugar do app monta a própria lista de ações.
 * Em build de dev, Shift + clique direito ainda abre o menu nativo (para o "Inspecionar").
 */

export type MenuEntry =
  | {
      label: string;
      icon?: ReactNode;
      onClick: () => unknown;
      danger?: boolean;
      disabled?: boolean;
    }
  | 'sep'
  | null
  | false
  | ''
  | undefined;

type MenuState = { x: number; y: number; items: MenuEntry[] } | null;

const useMenu = create<{ menu: MenuState }>(() => ({ menu: null }));

const DEV = process.env.NODE_ENV === 'development';

/** Abre um menu do Line no lugar do clique. Use no onContextMenu de cada elemento. */
export function openContextMenu(e: ReactMouseEvent | MouseEvent, items: MenuEntry[]) {
  if (DEV && e.shiftKey) return;
  e.preventDefault();
  e.stopPropagation();
  const target = e.target as HTMLElement;
  const extra: MenuEntry[] = [...selectionItems(), ...linkItems(target)];
  const all = extra.length ? [...extra, 'sep' as const, ...items] : items;
  if (!clean(all).length) return;
  useMenu.setState({ menu: { x: e.clientX, y: e.clientY, items: all } });
}

export function closeContextMenu() {
  useMenu.setState({ menu: null });
}

function clean(items: MenuEntry[]) {
  const out: Exclude<MenuEntry, null | false | '' | undefined>[] = [];
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep' && (!out.length || out[out.length - 1] === 'sep')) continue;
    out.push(it);
  }
  while (out[out.length - 1] === 'sep') out.pop();
  return out;
}

const copy = (text: string) => navigator.clipboard.writeText(text).catch(() => {});

function selectionItems(): MenuEntry[] {
  const text = window.getSelection()?.toString();
  return text ? [{ label: 'Copiar', icon: <Icons.Copy size={15} />, onClick: () => copy(text) }] : [];
}

function linkItems(target: HTMLElement): MenuEntry[] {
  const a = target.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!a || !/^https?:/.test(a.href)) return [];
  return [
    { label: 'Abrir link', icon: <Icons.Link size={15} />, onClick: () => window.open(a.href, '_blank', 'noopener') },
    { label: 'Copiar link', icon: <Icons.Copy size={15} />, onClick: () => copy(a.href) },
  ];
}

function isEditable(el: HTMLElement | null): el is HTMLInputElement | HTMLTextAreaElement | HTMLElement {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement)
    return !el.readOnly && !el.disabled && /^(text|search|email|url|tel|password|number|)$/.test(el.type);
  return el.isContentEditable;
}

function textFieldItems(el: HTMLElement): MenuEntry[] {
  const field = el as HTMLInputElement | HTMLTextAreaElement;
  const hasSel =
    'selectionStart' in field && field.selectionStart !== null
      ? field.selectionStart !== field.selectionEnd
      : !!window.getSelection()?.toString();
  const isPassword = field instanceof HTMLInputElement && field.type === 'password';
  return [
    { label: 'Recortar', disabled: !hasSel || isPassword, onClick: () => document.execCommand('cut') },
    { label: 'Copiar', disabled: !hasSel || isPassword, onClick: () => document.execCommand('copy') },
    {
      label: 'Colar',
      onClick: async () => {
        el.focus();
        try {
          const text = await navigator.clipboard.readText();
          // insertText mantém o desfazer e avisa o React da mudança.
          if (text && !document.execCommand('insertText', false, text)) document.execCommand('paste');
        } catch {
          document.execCommand('paste');
        }
      },
    },
    'sep',
    {
      label: 'Selecionar tudo',
      onClick: () => {
        el.focus();
        if ('select' in field) field.select();
        else document.execCommand('selectAll');
      },
    },
  ];
}

/** Fica montado uma vez no app: desliga o menu nativo e desenha o menu aberto. */
export function ContextMenuHost() {
  const menu = useMenu((s) => s.menu);

  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      if (e.defaultPrevented || (DEV && e.shiftKey)) return;
      e.preventDefault();
      const target = e.target as HTMLElement;
      const field = target.closest?.('input, textarea, [contenteditable="true"]') as HTMLElement | null;
      if (isEditable(field)) {
        useMenu.setState({ menu: { x: e.clientX, y: e.clientY, items: textFieldItems(field!) } });
        return;
      }
      const items = [...selectionItems(), ...linkItems(target)];
      useMenu.setState({ menu: items.length ? { x: e.clientX, y: e.clientY, items } : null });
    };
    document.addEventListener('contextmenu', onContext);
    return () => document.removeEventListener('contextmenu', onContext);
  }, []);

  if (!menu) return null;
  return <MenuBox key={`${menu.x}:${menu.y}`} {...menu} />;
}

function MenuBox({ x, y, items }: { x: number; y: number; items: MenuEntry[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const list = clean(items);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && closeContextMenu();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeContextMenu();
    const onBlur = () => closeContextMenu();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    document.addEventListener('scroll', onBlur, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
      document.removeEventListener('scroll', onBlur, true);
    };
  }, []);

  return (
    <div
      ref={ref}
      style={pos}
      role="menu"
      className="fixed z-[60] min-w-52 max-w-72 space-y-0.5 rounded-lg border border-edge bg-rail p-1.5 text-sm shadow-2xl"
      onContextMenu={(e) => e.preventDefault()}
      // Não tira o foco do campo de texto (senão recortar/copiar perdem a seleção).
      onMouseDown={(e) => e.preventDefault()}
    >
      {list.map((it, i) =>
        it === 'sep' ? (
          <div key={i} className="mx-1.5 my-1 border-t border-edge" />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              closeContextMenu();
              Promise.resolve()
                .then(it.onClick)
                .catch(showError);
            }}
            className={cx(
              'flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left font-medium disabled:pointer-events-none disabled:opacity-40',
              it.danger ? 'text-danger hover:bg-danger hover:text-white' : 'text-soft hover:bg-accent hover:text-on-accent',
            )}
          >
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.icon && <span className="shrink-0 opacity-80">{it.icon}</span>}
          </button>
        ),
      )}
    </div>
  );
}

// ---------- menus prontos ----------

const id = (label: string, value: string): MenuEntry => ({
  label,
  icon: <Icons.Copy size={15} />,
  onClick: () => copy(value),
});

/** Menu de um usuário (lista de membros, autor de mensagem, DMs). */
export function userMenu(userId: string, at: { x: number; y: number }, serverId?: string | null): MenuEntry[] {
  const s = useLine.getState();
  const user = s.users[userId];
  const isMe = s.me?.id === userId;
  // Bot (ex.: música): sem DM, chamada, amizade nem ID.
  const isBot = !!user?.bot;
  const friend = s.friends[userId];
  const openDm = async () => {
    const dm = await api.openDm([userId]);
    actions.upsertChannel(dm);
    actions.goHome(dm.id);
    return dm;
  };
  return [
    { label: 'Perfil', icon: <Icons.User size={15} />, onClick: () => actions.openModal({ kind: 'user', userId, at }) },
    user && {
      label: 'Mencionar',
      icon: <Icons.AtSign size={15} />,
      onClick: () => window.dispatchEvent(new CustomEvent('line:mention', { detail: `@${user.username} ` })),
    },
    !isMe && !isBot && { label: 'Mensagem', icon: <Icons.Message size={15} />, onClick: openDm },
    !isMe && !isBot && {
      label: 'Iniciar chamada',
      icon: <Icons.Phone size={15} />,
      onClick: async () => joinVoice((await openDm()).id),
    },
    !isMe && !isBot && user && friend?.state !== 'friends' && friend?.state !== 'blocked' && friend?.state !== 'outgoing' && {
      label: friend?.state === 'incoming' ? 'Aceitar amizade' : 'Adicionar amigo',
      icon: <Icons.UserPlus size={15} />,
      onClick: () => (friend?.state === 'incoming' ? api.acceptFriend(userId) : api.addFriend(user.username)),
    },
    serverId &&
      (hasPerm(permsOf(s, serverId, s.me?.id), Perm.ManageNicknames) ||
        (isMe && hasPerm(permsOf(s, serverId, s.me?.id), Perm.ChangeNickname))) && {
      label: 'Alterar apelido',
      icon: <Icons.Edit size={15} />,
      onClick: () => actions.openModal({ kind: 'nickname', serverId, userId }),
    },
    !isBot && 'sep',
    !isBot && id('Copiar ID do usuário', userId),
  ];
}

'use client';

import { create } from 'zustand';

/** Preferências da lista de conversas diretas, guardadas neste aparelho. */
type DmPrefs = {
  /** Conversas fixadas no topo de "Mensagens diretas". */
  pinned: string[];
  /** Conversas na seção "Favoritos". */
  favorites: string[];
  /** Conversas fechadas: somem da lista até chegar mensagem nova (id → quando fechou). */
  closed: Record<string, string>;
  /** Apelidos de amigos, só para mim (id do usuário → apelido). */
  nicks: Record<string, string>;
};

const KEY = 'line:dm-prefs';
/** No máximo 5 conversas fixadas (pessoas ou grupos). */
export const MAX_PINNED = 5;
const EMPTY: DmPrefs = { pinned: [], favorites: [], closed: {}, nicks: {} };

function load(): DmPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<DmPrefs>) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

export const useDmPrefs = create<DmPrefs>(() => (typeof window === 'undefined' ? EMPTY : load()));

function save(patch: Partial<DmPrefs>) {
  useDmPrefs.setState(patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(useDmPrefs.getState()));
  } catch {
    /* sem armazenamento: vale só nesta sessão */
  }
}

const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [id, ...list]);

export const dmPrefs = {
  /** Fixa ou desafixa; devolve false quando já há o máximo de fixadas. */
  togglePinned: (id: string) => {
    const { pinned } = useDmPrefs.getState();
    if (!pinned.includes(id) && pinned.length >= MAX_PINNED) return false;
    save({ pinned: toggle(pinned, id) });
    return true;
  },
  toggleFavorite: (id: string) => save({ favorites: toggle(useDmPrefs.getState().favorites, id) }),
  close: (id: string) => save({ closed: { ...useDmPrefs.getState().closed, [id]: new Date().toISOString() } }),
  reopen: (id: string) => {
    const { [id]: _, ...rest } = useDmPrefs.getState().closed;
    save({ closed: rest });
  },
  setNick: (userId: string, nick: string) => {
    const { [userId]: _, ...rest } = useDmPrefs.getState().nicks;
    save({ nicks: nick.trim() ? { ...rest, [userId]: nick.trim() } : rest });
  },
};

/** Apelido de amigo que eu dei (ou nada). */
export function friendNick(userId: string): string | undefined {
  return useDmPrefs.getState().nicks[userId];
}

/** Conversa fechada e sem mensagem nova depois disso. */
export function isClosed(closedAt: string | undefined, lastMessageAt: string | null | undefined) {
  return !!closedAt && (!lastMessageAt || lastMessageAt <= closedAt);
}

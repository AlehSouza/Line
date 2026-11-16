'use client';

import { create } from 'zustand';
import { useLine, type View } from './store';

/**
 * Histórico de navegação do app (Voltar/Avançar da barra de título, Alt+← / Alt+→ e os botões
 * laterais do mouse). Guarda as telas visitadas (servidor/canal, DM, amigos, explorar).
 */
type Nav = { back: View[]; forward: View[] };
export const useNav = create<Nav>(() => ({ back: [], forward: [] }));

const MAX = 50;
const same = (a: View, b: View) => JSON.stringify(a) === JSON.stringify(b);
let moving = false;
let started = false;

/** Começa a registrar as trocas de tela (uma vez só). */
export function startHistory() {
  if (started) return;
  started = true;
  useLine.subscribe((s, prev) => {
    if (moving || s.view === prev.view || same(s.view, prev.view)) return;
    // Trocar de canal só porque o servidor abriu no primeiro canal não conta como passo.
    const p = prev.view;
    const n = s.view;
    if (p.kind === 'server' && n.kind === 'server' && p.serverId === n.serverId && !p.channelId) return;
    // Saiu da conta: zera.
    if (!s.token) {
      useNav.setState({ back: [], forward: [] });
      return;
    }
    useNav.setState((h) => ({ back: [...h.back, p].slice(-MAX), forward: [] }));
  });
}

function go(to: View) {
  moving = true;
  try {
    // Servidor que saí/foi apagado: cai na tela inicial.
    const gone = to.kind === 'server' && !useLine.getState().servers[to.serverId];
    useLine.setState({ view: gone ? { kind: 'home', dmId: null } : to, threadId: null });
  } finally {
    moving = false;
  }
}

export function goBack() {
  const { back, forward } = useNav.getState();
  const to = back[back.length - 1];
  if (!to) return;
  const current = useLine.getState().view;
  useNav.setState({ back: back.slice(0, -1), forward: [current, ...forward].slice(0, MAX) });
  go(to);
}

export function goForward() {
  const { back, forward } = useNav.getState();
  const to = forward[0];
  if (!to) return;
  const current = useLine.getState().view;
  useNav.setState({ back: [...back, current].slice(-MAX), forward: forward.slice(1) });
  go(to);
}

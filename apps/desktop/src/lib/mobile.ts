'use client';

import { create } from 'zustand';

/**
 * Navegação no celular (tela estreita): uma coluna por vez.
 * "nav" mostra servidores + canais; "main" mostra o chat/voz em tela cheia.
 * No computador nada disso aparece: os estilos só valem abaixo de md (768px).
 */
type MobileState = { pane: 'nav' | 'main'; members: boolean };

export const useMobile = create<MobileState>(() => ({ pane: 'nav', members: false }));

export const mobile = {
  showMain: () => useMobile.setState({ pane: 'main', members: false }),
  showNav: () => useMobile.setState({ pane: 'nav', members: false }),
  openMembers: () => useMobile.setState({ members: true }),
  closeMembers: () => useMobile.setState({ members: false }),
};

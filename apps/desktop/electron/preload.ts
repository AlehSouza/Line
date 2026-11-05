import { contextBridge, ipcRenderer } from 'electron';

/**
 * Ponte mínima entre a interface (Next) e o Electron.
 * Tudo que a interface puder fazer com APIs web (Notification, fetch, WebSocket) fica no navegador.
 */
const bridge = {
  isDesktop: true,
  platform: process.platform,
  /** Pisca o ícone na barra de tarefas quando a janela não está em foco. */
  requestAttention: () => ipcRenderer.send('line:attention'),
  setBadge: (count: number) => ipcRenderer.send('line:badge', count),
  /** Lista telas e janelas para o seletor de compartilhamento. */
  getScreenSources: (): Promise<{ id: string; name: string; thumbnail: string; isScreen: boolean }[]> =>
    ipcRenderer.invoke('line:screen-sources'),
  /** Escolhe a fonte que o próximo getDisplayMedia vai usar. */
  selectScreenSource: (id: string): Promise<void> => ipcRenderer.invoke('line:screen-select', id),
};

contextBridge.exposeInMainWorld('line', bridge);

export type LineBridge = typeof bridge;

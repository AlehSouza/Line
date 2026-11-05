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
};

contextBridge.exposeInMainWorld('line', bridge);

export type LineBridge = typeof bridge;

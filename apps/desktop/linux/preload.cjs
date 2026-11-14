// Ponte entre a interface (a mesma do app web) e o casco Electron do Linux.
// Mesmo formato do bridge.js do Tauri: a interface só conhece `window.line`.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('line:info') || {};

contextBridge.exposeInMainWorld('line', {
  isDesktop: true,
  version: info.version,
  platform: 'linux',
  requestAttention: () => ipcRenderer.send('line:attention'),
  setBadge: (count) => ipcRenderer.send('line:badge', count),
  /** Login com Google pelo navegador do sistema; devolve o código para /api/auth/google/finish. */
  googleLogin: (serverUrl) => ipcRenderer.invoke('line:google-login', serverUrl),
  // Sem `window`: o Linux usa a barra de título do próprio sistema.
  // Sem `updates`: a interface vem do servidor, então "Atualizar" só recarrega a página.
  screen: {
    /** No Wayland o sistema mostra o próprio seletor (portal), então o do Line fica de fora. */
    picker: !info.wayland,
    sources: () => ipcRenderer.invoke('line:screen-sources'),
    select: (id) => ipcRenderer.invoke('line:screen-select', id),
  },
});

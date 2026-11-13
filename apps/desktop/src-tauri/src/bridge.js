// Ponte mínima entre a interface (Next) e o casco em Rust.
// Tudo que a interface puder fazer com APIs web (Notification, fetch, WebSocket, getDisplayMedia) fica no navegador.
(() => {
  const invoke = (cmd, args) => {
    const internals = window.__TAURI_INTERNALS__;
    return internals ? internals.invoke(cmd, args).catch(() => {}) : Promise.resolve();
  };
  const ua = navigator.userAgent;
  window.line = {
    isDesktop: true,
    platform: ua.includes('Windows') ? 'win32' : ua.includes('Mac') ? 'darwin' : 'linux',
    /** Pisca o ícone na barra de tarefas quando a janela não está em foco. */
    requestAttention: () => void invoke('request_attention'),
    setBadge: (count) => void invoke('set_badge', { count: Math.max(0, Number(count) || 0) }),
    /** Controles da janela para a barra de título desenhada pela interface. */
    updates: {
      check: () => invoke('update_check').then((v) => v || null),
      install: () => (internals ? internals.invoke('update_install') : Promise.reject(new Error('indisponível'))),
    },
    window: {
      minimize: () => void invoke('window_minimize'),
      toggleMaximize: () => invoke('window_toggle_maximize'),
      isMaximized: () => invoke('window_is_maximized').then((v) => !!v),
      close: () => void invoke('window_close'),
    },
    // Sem getScreenSources: o compartilhamento usa o seletor do próprio WebView2/Windows,
    // que já oferece telas, janelas e "compartilhar áudio do sistema".
  };
})();

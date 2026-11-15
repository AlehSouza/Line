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
    /** Versão instalada do app (o Rust troca o marcador ao abrir a janela). */
    version: '__LINE_VERSION__',
    platform: ua.includes('Windows') ? 'win32' : ua.includes('Mac') ? 'darwin' : 'linux',
    /** Seletor de tela do Line (captura em Rust). No Linux só no X11; no Wayland vale o do sistema. */
    nativeScreen: __LINE_NATIVE_SCREEN__,
    /** Pisca o ícone na barra de tarefas quando a janela não está em foco. */
    requestAttention: () => void invoke('request_attention'),
    /** Contagem no ícone da barra de tarefas/dock. No Windows desenhamos a pílula vermelha ("9+"). */
    setBadge: (count) => {
      count = Math.max(0, Number(count) || 0);
      let rgba = null;
      if (count > 0 && ua.includes('Windows')) {
        try {
          const S = 32;
          const c = document.createElement('canvas');
          c.width = c.height = S;
          const g = c.getContext('2d');
          const text = count > 9 ? '9+' : String(count);
          g.fillStyle = '#e5484d';
          g.beginPath();
          g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = '#fff';
          g.font = `bold ${text.length > 1 ? 18 : 22}px "Segoe UI", sans-serif`;
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.fillText(text, S / 2, S / 2 + 1);
          rgba = Array.from(g.getImageData(0, 0, S, S).data);
        } catch {
          rgba = null;
        }
      }
      void invoke('set_badge', { count, rgba });
    },
    /** Controles da janela para a barra de título desenhada pela interface. */
    updates: {
      check: () => invoke('update_check').then((v) => v || null),
      // Sem o catch do invoke(): o erro precisa chegar na interface para mostrar o motivo.
      install: () => {
        const internals = window.__TAURI_INTERNALS__;
        return internals ? internals.invoke('update_install') : Promise.reject(new Error('indisponível'));
      },
      /** Abre a janelinha que procura, baixa e instala a atualização. */
      run: () => {
        const internals = window.__TAURI_INTERNALS__;
        return internals ? internals.invoke('update_run') : Promise.reject(new Error('indisponível'));
      },
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

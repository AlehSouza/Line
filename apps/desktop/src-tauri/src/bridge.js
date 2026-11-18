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
    /** Notificação nativa (Windows). Resolve false quando não deu. */
    notify: (opts) => invoke('notify_show', opts).then((v) => v === true),
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
    /** Iniciar com o computador. get() devolve null quando não dá (versão da Store). */
    startup: {
      get: () => {
        const internals = window.__TAURI_INTERNALS__;
        return internals ? internals.invoke('startup_get') : Promise.resolve(null);
      },
      set: (enabled, minimized) => {
        const internals = window.__TAURI_INTERNALS__;
        return internals ? internals.invoke('startup_set', { enabled, minimized }) : Promise.reject(new Error('indisponível'));
      },
    },
    /** Aceleração de hardware. get() devolve null quando o sistema decide (macOS). */
    gpu: {
      get: () => {
        const internals = window.__TAURI_INTERNALS__;
        return internals ? internals.invoke('gpu_get') : Promise.resolve(null);
      },
      set: (enabled, restart) => {
        const internals = window.__TAURI_INTERNALS__;
        return internals ? internals.invoke('gpu_set', { enabled, restart: !!restart }) : Promise.reject(new Error('indisponível'));
      },
    },
    window: {
      minimize: () => void invoke('window_minimize'),
      toggleMaximize: () => invoke('window_toggle_maximize'),
      isMaximized: () => invoke('window_is_maximized').then((v) => !!v),
      setFullscreen: (on) => invoke('window_set_fullscreen', { on }),
      close: () => void invoke('window_close'),
    },
  };

  // Windows: a Notification do WebView2 aparece como "tauri.localhost". Toda notificação
  // (inclusive a de chamada e as de bibliotecas) passa pelo toast nativo com o nome "Line".
  if (window.line.platform === 'win32') {
    const notify = window.line.notify;
    let seq = 0;
    class LineNotification extends EventTarget {
      constructor(title, opts = {}) {
        super();
        this.title = String(title ?? '');
        this.body = String(opts.body ?? '');
        this.tag = String(opts.tag ?? '');
        this.data = opts.data ?? null;
        this.icon = opts.icon ?? '';
        this.silent = !!opts.silent;
        this.onclick = this.onshow = this.onclose = this.onerror = null;
        void notify({
          title: this.title,
          body: this.body,
          tag: this.tag || `n${Date.now()}${seq++}`,
          data: typeof this.data === 'string' ? this.data : '',
          avatar: null,
          avatarKey: null,
          reply: false,
        });
      }
      close() {}
      static get permission() {
        return 'granted';
      }
      static get maxActions() {
        return 0;
      }
      static requestPermission(cb) {
        if (typeof cb === 'function') cb('granted');
        return Promise.resolve('granted');
      }
    }
    try {
      Object.defineProperty(window, 'Notification', { value: LineNotification, configurable: true, writable: true });
    } catch {
      window.Notification = LineNotification;
    }
  }
})();

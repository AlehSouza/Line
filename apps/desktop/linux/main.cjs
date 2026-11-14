// Casco do Line para Linux (Electron).
//
// Windows e macOS usam o Tauri, mas o WebKitGTK das distros vem compilado sem WebRTC: lá não
// existe RTCPeerConnection e as chamadas não funcionam. Aqui o Chromium do Electron faz voz,
// vídeo e tela com o mesmo motor do WebView2 do Windows.
//
// A interface é a mesma do app web (useline.tech/app), carregada direto do servidor: sai junto
// com cada merge, então o app do Linux fica sempre na versão mais nova sem atualizador.
'use strict';

const { app, BrowserWindow, desktopCapturer, ipcMain, Menu, session, shell } = require('electron');
const http = require('node:http');
const path = require('node:path');

const SERVER = 'https://useline.tech';
const APP_URL = `${SERVER}/app/`;
const WAYLAND = (process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland' || !!process.env.WAYLAND_DISPLAY;

// No Wayland a captura de tela passa pelo portal do sistema (PipeWire), que mostra o próprio seletor.
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
// Não frear a página quando o Line fica atrás de outra janela (áudio e tela da chamada).
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

/** @type {BrowserWindow | null} */
let win = null;
/** Fonte escolhida no seletor do Line; usada no próximo getDisplayMedia. */
let pickedSource = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
  app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
}

function showMain() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function isAppUrl(url) {
  try {
    const u = new URL(url);
    return u.origin === SERVER && (u.pathname === '/app' || u.pathname.startsWith('/app/') || u.pathname.startsWith('/api/'));
  } catch {
    return false;
  }
}

function openExternal(url) {
  if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
}

function start() {
  Menu.setApplicationMenu(null);
  const ses = session.defaultSession;

  // Microfone, câmera, tela e notificações sem perguntar: o app inteiro é nosso.
  ses.setPermissionRequestHandler((wc, _perm, cb, details) => cb(isAppUrl(details.requestingUrl || wc.getURL())));
  ses.setPermissionCheckHandler((_wc, _perm, origin) => origin === SERVER || isAppUrl(origin));

  // getDisplayMedia: no X11 usa a fonte escolhida no seletor do Line; no Wayland o pedido de
  // fontes abre o seletor do sistema e devolve só a que a pessoa escolheu.
  ses.setDisplayMediaRequestHandler(async (_req, cb) => {
    const wanted = pickedSource;
    pickedSource = null;
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const source = (wanted && sources.find((s) => s.id === wanted)) || sources[0];
      // Sem fonte (cancelou o seletor do sistema): nega, e a interface ignora o NotAllowedError.
      cb(source ? { video: source } : {});
    } catch {
      cb({});
    }
  });

  win = new BrowserWindow({
    title: 'Line',
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    show: false,
    backgroundColor: '#0a0a0c',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: true,
    },
  });
  ses.setSpellCheckerLanguages(['pt-BR']);

  win.once('ready-to-show', () => win?.show());
  win.on('focus', () => win?.flashFrame(false));
  win.on('closed', () => {
    win = null;
  });

  // Links externos abrem no navegador padrão; só o app fica na janela.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    openExternal(url);
  });

  // Sem internet ou servidor fora do ar: tela simples com "tentar de novo".
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMain) => {
    if (!isMain || code === -3 || !isAppUrl(url)) return;
    void win?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(offlinePage())}`);
  });

  // F5 recarrega, Ctrl+Shift+I abre as ferramentas de desenvolvedor.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) {
      e.preventDefault();
      void win?.loadURL(APP_URL);
    } else if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      win?.webContents.toggleDevTools();
    }
  });

  void win.loadURL(APP_URL);
}

function offlinePage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Line</title></head>
<body style="font-family:system-ui,sans-serif;background:#0a0a0c;color:#e6e6ea;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;gap:16px">
<h2 style="margin:0">Não foi possível conectar ao Line</h2>
<p style="margin:0;color:#9a9aa5">Confira sua internet e tente de novo.</p>
<button onclick="location.href='${APP_URL}'" style="background:#7c6af2;color:#fff;border:0;border-radius:8px;padding:10px 20px;font-size:15px;font-weight:600;cursor:pointer">Tentar de novo</button>
</body></html>`;
}

// ---- Ponte com a interface (preload.cjs) ----

ipcMain.on('line:info', (e) => {
  e.returnValue = { version: app.getVersion(), wayland: WAYLAND };
});

ipcMain.on('line:attention', () => {
  if (win && !win.isFocused()) win.flashFrame(true);
});

ipcMain.on('line:badge', (_e, count) => {
  app.setBadgeCount(Math.max(0, Number(count) || 0));
});

ipcMain.handle('line:screen-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 480, height: 270 },
  });
  return sources
    .filter((s) => s.name !== 'Line')
    .map((s) => ({
      id: s.id,
      name: s.name,
      isScreen: s.id.startsWith('screen:'),
      thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
    }));
});

ipcMain.handle('line:screen-select', (_e, id) => {
  pickedSource = typeof id === 'string' ? id : null;
});

/**
 * "Entrar com Google": o Google não deixa logar dentro do app, então abre o navegador em
 * {servidor}/api/auth/google/start?port=N e espera ele voltar para http://127.0.0.1:N/?code=...
 * (mesmo fluxo do app do Windows/macOS). Devolve o código para a interface trocar pelo token.
 */
ipcMain.handle('line:google-login', (_e, serverUrl) => {
  const base = String(serverUrl || SERVER).replace(/\/+$/, '');
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('googleError');
      if (!code && !error) {
        res.writeHead(404).end();
        return;
      }
      const msg = code ? 'Pronto! Pode fechar esta aba e voltar para o Line.' : 'Não deu para entrar. Volte para o Line e tente de novo.';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>Line</title></head><body style="font-family:system-ui,sans-serif;background:#0f0f12;color:#e6e6ea;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h2>${msg}</h2></body></html>`,
      );
      clearTimeout(timer);
      server.close();
      showMain();
      if (code) resolve(code);
      else reject(new Error(error || 'Não deu para entrar com o Google.'));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('O login com Google demorou demais. Tente de novo.'));
    }, 5 * 60 * 1000);
    server.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      void shell.openExternal(`${base}/api/auth/google/start?port=${port}`);
    });
  });
});

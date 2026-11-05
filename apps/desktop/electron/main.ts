import { app, BrowserWindow, desktopCapturer, ipcMain, net, protocol, session, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../../server/src/start';

const DEV_URL = process.env.LINE_DEV_URL;
const OUT_DIR = path.join(__dirname, '..', 'out');

// Protocolo próprio para servir o build estático do Next (caminhos /_next/... funcionam como num site).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let mainWindow: BrowserWindow | null = null;
let embeddedServer: Awaited<ReturnType<typeof startServer>> | null = null;

/**
 * Servidor embutido: o próprio app hospeda um servidor Line na porta 4000,
 * com os dados na pasta do usuário. Assim o .exe funciona sozinho, e seus amigos
 * podem se conectar no seu IP. Se a porta já estiver em uso (outro servidor rodando),
 * o app só usa o que já existe. Desligue com LINE_EMBEDDED_SERVER=0.
 */
async function startEmbeddedServer() {
  if (process.env.LINE_EMBEDDED_SERVER === '0') return;
  try {
    embeddedServer = await startServer({
      config: {
        port: Number(process.env.LINE_SERVER_PORT ?? 4000),
        dataDir: path.join(app.getPath('userData'), 'server'),
      },
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EADDRINUSE') console.error('Falha ao iniciar o servidor embutido:', err);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    backgroundColor: '#0b0f0d',
    title: 'Line',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Links externos abrem no navegador padrão.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('focus', () => mainWindow?.flashFrame(false));

  if (DEV_URL) {
    mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadURL('app://line/index.html');
  }
}

function registerAppProtocol() {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    let file = path.normalize(path.join(OUT_DIR, decodeURIComponent(pathname)));
    if (!file.startsWith(OUT_DIR)) return new Response('Not found', { status: 404 });
    if (!path.extname(file)) file = path.join(file, 'index.html');
    return net.fetch(pathToFileURL(file).toString());
  });
}

// ---------- compartilhamento de tela ----------
// O app mostra o próprio seletor (com miniaturas) e avisa qual fonte escolheu antes de chamar getDisplayMedia.
let selectedSourceId: string | null = null;

ipcMain.handle('line:screen-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false,
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    isScreen: s.id.startsWith('screen:'),
  }));
});

ipcMain.handle('line:screen-select', (_e, id: string) => {
  selectedSourceId = typeof id === 'string' ? id : null;
});

function registerDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    const source = sources.find((s) => s.id === selectedSourceId) ?? sources.find((s) => s.id.startsWith('screen:'));
    selectedSourceId = null;
    if (!source) return callback({});
    // No Windows, "loopback" captura o áudio do sistema junto (jogos, vídeos).
    callback(process.platform === 'win32' ? { video: source, audio: 'loopback' } : { video: source });
  });
}

ipcMain.on('line:attention', () => {
  if (mainWindow && !mainWindow.isFocused()) mainWindow.flashFrame(true);
});

ipcMain.on('line:badge', (_e, count: number) => {
  app.setBadgeCount(Math.max(0, Number(count) || 0));
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('app.line.desktop');
    registerAppProtocol();
    registerDisplayMediaHandler();
    await startEmbeddedServer();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    void embeddedServer?.close();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

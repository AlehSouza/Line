'use client';

/**
 * Transmissão de tela capturada pelo Rust (app do Windows, seletor próprio do Line).
 *
 * O Rust escreve cada quadro numa memória compartilhada com a página (SharedBuffer do WebView2)
 * e avisa por `chrome.webview` qual espaço foi preenchido. Aqui cada quadro vira um VideoFrame
 * numa trilha gerada (MediaStreamTrackGenerator), que o WebRTC trata como uma tela qualquer.
 * O áudio (do app escolhido, ou do sistema sem o Line) chega em blocos e vira outra trilha.
 */

export interface ScreenSource {
  id: string;
  name: string;
  isScreen: boolean;
  thumbnail: string;
}

interface WebviewMessageEvent {
  data: unknown;
}
interface SharedBufferEvent {
  additionalData: unknown;
  getBuffer(): ArrayBuffer;
}
interface ChromeWebview {
  addEventListener(type: 'message', fn: (e: WebviewMessageEvent) => void): void;
  addEventListener(type: 'sharedbufferreceived', fn: (e: SharedBufferEvent) => void): void;
  removeEventListener(type: string, fn: (e: never) => void): void;
  releaseBuffer?(buffer: ArrayBuffer): void;
}
type Generator = MediaStreamTrack & { writable: WritableStream };
type GeneratorCtor = new (init: { kind: 'video' | 'audio' }) => Generator;

function webview(): ChromeWebview | undefined {
  return (window as unknown as { chrome?: { webview?: ChromeWebview } }).chrome?.webview;
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string, a?: unknown) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!internals) return Promise.reject(new Error('indisponível'));
  return internals.invoke(cmd, args);
}

/** Seletor próprio só existe no app do Windows (precisa do WebView2 e da captura do Rust). */
export function hasNativeScreen() {
  return (
    typeof window !== 'undefined' &&
    window.line?.platform === 'win32' &&
    !!webview() &&
    'MediaStreamTrackGenerator' in window &&
    'VideoFrame' in window
  );
}

export function listScreenSources(): Promise<ScreenSource[]> {
  return invoke<ScreenSource[]>('screen_sources').catch(() => []);
}

export interface NativeScreen {
  stream: MediaStream;
  /** Tamanho real da fonte (para reduzir até a resolução escolhida no envio). */
  width: number;
  height: number;
  stop: () => void;
}

/** Começa a capturar a fonte e só resolve quando chega o primeiro quadro. */
export async function startNativeScreen(
  id: string,
  opts: { fps: number; audio: boolean; onEnded: () => void },
): Promise<NativeScreen> {
  const wv = webview()!;
  const Gen = (window as unknown as { MediaStreamTrackGenerator: GeneratorCtor }).MediaStreamTrackGenerator;
  const video = new Gen({ kind: 'video' });
  const videoWriter = video.writable.getWriter();
  const audio = opts.audio ? new Gen({ kind: 'audio' }) : null;
  const audioWriter = audio?.writable.getWriter();

  let session = 0;
  let buffer: ArrayBuffer | null = null;
  let layout = { header: 64, slotSize: 0 };
  let stopped = false;
  let first: ((size: { w: number; h: number }) => void) | null = null;
  const firstFrame = new Promise<{ w: number; h: number }>((resolve) => (first = resolve));

  // A memória compartilhada pode chegar antes da resposta do comando: guarda e confere depois.
  const pendingBuffers: { session: number; buf: ArrayBuffer; data: { header: number; slotSize: number } }[] = [];
  const onBuffer = (e: SharedBufferEvent) => {
    const d = e.additionalData as { lineScreen?: string; session: number; header: number; slotSize: number } | null;
    if (d?.lineScreen !== 'buffer') return;
    const buf = e.getBuffer();
    if (session && d.session === session) {
      buffer = buf;
      layout = d;
    } else pendingBuffers.push({ session: d.session, buf, data: d });
  };

  const onMessage = (e: WebviewMessageEvent) => {
    const m = e.data as {
      lineScreen?: string;
      session: number;
      slot: number;
      w: number;
      h: number;
      ts: number;
      rate: number;
      ch: number;
      data: string;
    } | null;
    if (!m?.lineScreen || m.session !== session || stopped) return;
    if (m.lineScreen === 'frame') {
      if (!buffer) return;
      const flags = new Uint32Array(buffer, 0, layout.header / 4);
      try {
        // Pede em microssegundos; o construtor copia os pixels, então o espaço já pode ser reusado.
        const frame = new VideoFrame(new Uint8Array(buffer, layout.header + m.slot * layout.slotSize, m.w * m.h * 4), {
          format: 'BGRX',
          codedWidth: m.w,
          codedHeight: m.h,
          timestamp: m.ts,
        });
        flags[m.slot] = 0;
        first?.({ w: m.w, h: m.h });
        first = null;
        // Encoder atrasado: descarta em vez de acumular (latência baixa vale mais que todo quadro).
        if ((videoWriter.desiredSize ?? 1) <= 0) frame.close();
        else void videoWriter.write(frame).catch(() => frame.close());
      } catch {
        flags[m.slot] = 0;
      }
    } else if (m.lineScreen === 'audio' && audioWriter) {
      const bytes = Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0));
      const frames = bytes.byteLength / 4 / m.ch;
      if (!frames) return;
      const data = new AudioData({
        format: 'f32',
        sampleRate: m.rate,
        numberOfChannels: m.ch,
        numberOfFrames: frames,
        timestamp: m.ts,
        data: bytes,
      });
      if ((audioWriter.desiredSize ?? 1) <= 0) data.close();
      else void audioWriter.write(data).catch(() => data.close());
    } else if (m.lineScreen === 'ended') {
      opts.onEnded();
    }
  };

  wv.addEventListener('sharedbufferreceived', onBuffer);
  wv.addEventListener('message', onMessage);

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    wv.removeEventListener('sharedbufferreceived', onBuffer as never);
    wv.removeEventListener('message', onMessage as never);
    void invoke('screen_stop').catch(() => {});
    if (buffer) wv.releaseBuffer?.(buffer);
    for (const p of pendingBuffers) wv.releaseBuffer?.(p.buf);
    buffer = null;
    void videoWriter.close().catch(() => {});
    void audioWriter?.close().catch(() => {});
  };

  try {
    const res = await invoke<{ session: number }>('screen_start', { id, fps: opts.fps, audio: opts.audio });
    session = res.session;
    const i = pendingBuffers.findIndex((p) => p.session === session);
    if (i >= 0) {
      const [p] = pendingBuffers.splice(i, 1);
      buffer = p.buf;
      layout = p.data;
    }
    const size = await Promise.race([
      firstFrame,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('sem quadros')), 8000)),
    ]);
    const stream = new MediaStream(audio ? [video, audio] : [video]);
    return { stream, width: size.w, height: size.h, stop: cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

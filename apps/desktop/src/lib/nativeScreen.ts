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

/** Seletor próprio: app do Windows (WebView2) e do macOS (WKWebView). Web e Linux usam o do navegador. */
export function hasNativeScreen() {
  if (typeof window === 'undefined' || !window.line?.isDesktop) return false;
  if (window.line.platform === 'win32') return !!webview() && 'MediaStreamTrackGenerator' in window && 'VideoFrame' in window;
  if (window.line.platform === 'darwin') return 'VideoFrame' in window && 'captureStream' in HTMLCanvasElement.prototype;
  return false;
}

/** Lista janelas e telas. Rejeita com a mensagem do sistema (ex.: falta permissão no macOS). */
export function listScreenSources(): Promise<ScreenSource[]> {
  return invoke<ScreenSource[]>('screen_sources').then((list) => list ?? []);
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
  opts: { fps: number; audio: boolean; height: number; onEnded: () => void },
): Promise<NativeScreen> {
  if (window.line?.platform === 'darwin') return startMacScreen(id, opts);
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

/**
 * macOS: o Rust manda os quadros (NV12, já na resolução escolhida) e o áudio por um WebSocket
 * só do 127.0.0.1. Cada quadro é desenhado num canvas, que vira a trilha de vídeo; o áudio
 * passa por um AudioContext até uma trilha de áudio.
 */
async function startMacScreen(
  id: string,
  opts: { fps: number; audio: boolean; height: number; onEnded: () => void },
): Promise<NativeScreen> {
  const res = await invoke<{ session: number; url: string }>('screen_start', {
    id,
    fps: opts.fps,
    audio: opts.audio,
    height: opts.height,
  });
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const video = canvas.captureStream(opts.fps).getVideoTracks()[0];

  let audioCtx: AudioContext | null = null;
  let audioTrack: MediaStreamTrack | null = null;
  const queue: Float32Array[] = [];
  let queued = 0;
  let channels = 2;
  if (opts.audio) {
    audioCtx = new AudioContext({ sampleRate: 48000 });
    const dest = audioCtx.createMediaStreamDestination();
    const node = audioCtx.createScriptProcessor(2048, 0, 2);
    let head: Float32Array | null = null;
    let pos = 0;
    node.onaudioprocess = (e) => {
      const outs = [e.outputBuffer.getChannelData(0), e.outputBuffer.getChannelData(1)];
      for (let i = 0; i < outs[0].length; i++) {
        if (!head || pos >= head.length) {
          head = queue.shift() ?? null;
          if (head) queued -= head.length;
          pos = 0;
        }
        if (!head) {
          outs[0][i] = 0;
          outs[1][i] = 0;
          continue;
        }
        const l = head[pos];
        const r = channels > 1 ? head[pos + 1] : l;
        outs[0][i] = l;
        outs[1][i] = r;
        pos += channels;
      }
    };
    node.connect(dest);
    void audioCtx.resume();
    audioTrack = dest.stream.getAudioTracks()[0] ?? null;
  }

  let first: ((size: { w: number; h: number }) => void) | null = null;
  const firstFrame = new Promise<{ w: number; h: number }>((resolve) => (first = resolve));
  let stopped = false;
  const ws = new WebSocket(res.url);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (e) => {
    if (stopped || !(e.data instanceof ArrayBuffer)) return;
    const buf = e.data;
    const kind = new Uint8Array(buf, 0, 1)[0];
    if (kind === 3) {
      opts.onEnded();
      return;
    }
    if (buf.byteLength < 17) return;
    const dv = new DataView(buf);
    const a = dv.getUint32(1, true);
    const b = dv.getUint32(5, true);
    const ts = Number(dv.getBigUint64(9, true));
    if (kind === 1) {
      const [w, h] = [a, b];
      try {
        const frame = new VideoFrame(new Uint8Array(buf, 17), { format: 'NV12', codedWidth: w, codedHeight: h, timestamp: ts });
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        ctx.drawImage(frame, 0, 0);
        frame.close();
        first?.({ w, h });
        first = null;
      } catch (err) {
        console.warn('quadro da tela inválido', err);
      }
    } else if (kind === 2 && audioCtx) {
      channels = Math.max(1, b);
      // Copia: o início dos dados (byte 17) não é alinhado para Float32Array.
      const samples = new Float32Array(buf.slice(17));
      queue.push(samples);
      queued += samples.length;
      // Mais de ~250ms acumulado: descarta o mais velho para não ficar atrasado.
      while (queued > 48000 * channels * 0.25 && queue.length > 1) queued -= queue.shift()!.length;
    }
  };

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    ws.close();
    void invoke('screen_stop').catch(() => {});
    video.stop();
    audioTrack?.stop();
    void audioCtx?.close().catch(() => {});
  };

  try {
    const size = await Promise.race([
      firstFrame,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('sem quadros')), 8000)),
    ]);
    const stream = new MediaStream(audioTrack ? [video, audioTrack] : [video]);
    return { stream, width: size.w, height: size.h, stop: cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

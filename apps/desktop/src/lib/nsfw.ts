'use client';

/**
 * Detecção automática de imagens +18, feita no próprio aparelho (nada sai do computador).
 *
 * Usa dois modelos do NSFWJS juntos (MobileNetV2Mid, ~5,7 MB, e MobileNetV2, ~3,5 MB),
 * carregados só na primeira vez que alguém anexa uma imagem, GIF ou vídeo. Cada quadro é
 * analisado inteiro, em recortes (centro, metades e cantos) e espelhado; vale a nota mais alta.
 * Basta um modelo achar conteúdo impróprio num recorte para marcar +18.
 */

type Prediction = { className: string; probability: number };
type Input = HTMLImageElement | HTMLCanvasElement;
type Model = { classify: (img: Input) => Promise<Prediction[]> };

let models: Promise<Model[]> | null = null;

function loadModels(): Promise<Model[]> {
  if (!models) {
    models = (async () => {
      const [core, mid, small] = await Promise.all([
        import('nsfwjs/core'),
        import('nsfwjs/models/mobilenet_v2_mid'),
        import('nsfwjs/models/mobilenet_v2'),
      ]);
      const loaded = await Promise.allSettled([
        core.load('MobileNetV2Mid', { modelDefinitions: [mid.MobileNetV2MidModel] }),
        core.load('MobileNetV2', { modelDefinitions: [small.MobileNetV2Model] }),
      ]);
      const ok = loaded.flatMap((r) => (r.status === 'fulfilled' ? [r.value as unknown as Model] : []));
      if (!ok.length) throw new Error('modelo');
      return ok;
    })();
    models.catch(() => {
      models = null;
    });
  }
  return models;
}

/** Explícito (pornografia/hentai) ou erótico (classe "Sexy"): qualquer um marca +18.
 * Limites baixos de propósito: melhor marcar demais do que deixar passar. */
function isExplicit(p: Prediction[]) {
  const prob = (c: string) => p.find((x) => x.className === c)?.probability ?? 0;
  const explicit = prob('Porn') + prob('Hentai');
  const sexy = prob('Sexy');
  return explicit >= 0.3 || sexy >= 0.45 || explicit + sexy >= 0.55;
}

const SIZE = 320;

function canvasOf(source: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, flip = false, max = SIZE) {
  const scale = Math.min(1, max / Math.max(sw, sh, 1));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * scale));
  c.height = Math.max(1, Math.round(sh * scale));
  const ctx = c.getContext('2d')!;
  if (flip) {
    ctx.translate(c.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

/** Inteira, espelhada, quadrado do centro, as duas metades e os quatro cantos (60%). */
function crops(source: CanvasImageSource, w: number, h: number): HTMLCanvasElement[] {
  const out = [canvasOf(source, 0, 0, w, h), canvasOf(source, 0, 0, w, h, true)];
  const side = Math.min(w, h);
  if (Math.max(w, h) > side * 1.15) out.push(canvasOf(source, (w - side) / 2, (h - side) / 2, side, side));
  if (h >= w) {
    out.push(canvasOf(source, 0, 0, w, h / 2), canvasOf(source, 0, h / 2, w, h / 2));
  } else {
    out.push(canvasOf(source, 0, 0, w / 2, h), canvasOf(source, w / 2, 0, w / 2, h));
  }
  const cw = w * 0.6;
  const ch = h * 0.6;
  for (const [x, y] of [
    [0, 0],
    [w - cw, 0],
    [0, h - ch],
    [w - cw, h - ch],
  ] as const)
    out.push(canvasOf(source, x, y, cw, ch));
  return out;
}

function imageFrom(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/** Quadro inteiro de uma fonte qualquer, já no tamanho de análise. */
const frameOf = (source: CanvasImageSource, w: number, h: number, max = SIZE) => canvasOf(source, 0, 0, w, h, false, max);

/** 8 quadros espalhados pelo vídeo (de 5% a 95%). */
async function videoFrames(url: string): Promise<HTMLCanvasElement[]> {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = url;
  await new Promise((resolve, reject) => {
    video.onloadeddata = resolve;
    video.onerror = reject;
  });
  const frames: HTMLCanvasElement[] = [];
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  for (const at of duration ? [0.05, 0.18, 0.31, 0.44, 0.57, 0.7, 0.83, 0.95] : [0]) {
    if (duration) {
      video.currentTime = duration * at;
      await new Promise((resolve) => (video.onseeked = resolve));
    }
    frames.push(frameOf(video, video.videoWidth, video.videoHeight));
  }
  video.removeAttribute('src');
  video.load();
  return frames;
}

type Decoder = {
  tracks: { ready: Promise<void>; selectedTrack?: { frameCount: number } };
  decode: (o: { frameIndex: number }) => Promise<{ image: VideoFrame }>;
  close: () => void;
};

/** GIF, WebP ou PNG animado: até 8 quadros espalhados (ImageDecoder do Chromium/WebView2). */
async function animatedFrames(file: File): Promise<HTMLCanvasElement[] | null> {
  const ImageDecoderCtor = (window as unknown as { ImageDecoder?: new (o: { data: ReadableStream | ArrayBuffer; type: string }) => Decoder }).ImageDecoder;
  if (!ImageDecoderCtor) return null;
  const decoder = new ImageDecoderCtor({ data: await file.arrayBuffer(), type: file.type });
  try {
    await decoder.tracks.ready;
    const count = decoder.tracks.selectedTrack?.frameCount ?? 1;
    if (count <= 1) return null;
    const picks = [...new Set(Array.from({ length: Math.min(8, count) }, (_, i) => Math.floor((i * (count - 1)) / Math.max(1, Math.min(8, count) - 1))))];
    const frames: HTMLCanvasElement[] = [];
    for (const frameIndex of picks) {
      const { image } = await decoder.decode({ frameIndex });
      frames.push(frameOf(image, image.displayWidth, image.displayHeight));
      image.close();
    }
    return frames;
  } finally {
    decoder.close();
  }
}

async function framesOf(file: File, url: string): Promise<HTMLCanvasElement[]> {
  if (file.type.startsWith('video/')) return videoFrames(url);
  if (file.type === 'image/gif' || file.type === 'image/webp' || file.type === 'image/png') {
    const anim = await animatedFrames(file).catch(() => null);
    if (anim?.length) return anim;
  }
  const img = await imageFrom(url);
  // Imagem parada guarda mais resolução para os recortes saírem nítidos.
  return [frameOf(img, img.naturalWidth, img.naturalHeight, 1024)];
}

async function check(file: File): Promise<boolean> {
  const url = URL.createObjectURL(file);
  try {
    const [nets, frames] = await Promise.all([loadModels(), framesOf(file, url)]);
    for (const frame of frames) {
      // Vídeo/GIF têm muitos quadros: neles basta inteira, espelhada e centro.
      const pieces = frames.length > 1 ? crops(frame, frame.width, frame.height).slice(0, 3) : crops(frame, frame.width, frame.height);
      for (const piece of pieces) for (const net of nets) if (isExplicit(await net.classify(piece))) return true;
    }
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** true quando a imagem/GIF/vídeo parece conteúdo +18. Falha ou demora (30 s) conta como não. */
export function looksNsfw(file: File): Promise<boolean> {
  if (!/^(image|video)\//.test(file.type) || file.type === 'image/svg+xml') return Promise.resolve(false);
  return Promise.race([
    check(file).catch(() => false),
    new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 30000)),
  ]);
}

'use client';

/**
 * Detecção automática de imagens +18, feita no próprio aparelho (nada sai do computador).
 * Usa o NSFWJS com o modelo MobileNetV2Mid (uns 5,7 MB, o mais preciso dos leves), carregado só na primeira vez que
 * alguém anexa uma imagem ou vídeo.
 */

type Prediction = { className: string; probability: number };
type Model = { classify: (img: HTMLImageElement | HTMLCanvasElement) => Promise<Prediction[]> };

let model: Promise<Model> | null = null;

function loadModel(): Promise<Model> {
  if (!model) {
    model = (async () => {
      const [core, mobilenet] = await Promise.all([import('nsfwjs/core'), import('nsfwjs/models/mobilenet_v2_mid')]);
      return (await core.load('MobileNetV2Mid', { modelDefinitions: [mobilenet.MobileNetV2MidModel] })) as unknown as Model;
    })();
    model.catch(() => {
      model = null;
    });
  }
  return model;
}

/** Explícito (pornografia/hentai) ou erótico (classe "Sexy"): qualquer um marca +18.
 * Limites baixos de propósito: melhor marcar demais do que deixar passar. */
function isExplicit(p: Prediction[]) {
  const prob = (c: string) => p.find((x) => x.className === c)?.probability ?? 0;
  const explicit = prob('Porn') + prob('Hentai');
  const sexy = prob('Sexy');
  return explicit >= 0.35 || sexy >= 0.5 || explicit + sexy >= 0.6;
}

/** A imagem inteira e o quadrado do centro (o corpo costuma estar no meio e o modelo vê 224x224). */
function crops(source: HTMLImageElement | HTMLCanvasElement): HTMLCanvasElement[] {
  const w = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const h = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  const out: HTMLCanvasElement[] = [];
  const draw = (sx: number, sy: number, sw: number, sh: number) => {
    const scale = Math.min(1, 448 / Math.max(sw, sh, 1));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * scale));
    c.height = Math.max(1, Math.round(sh * scale));
    c.getContext('2d')?.drawImage(source, sx, sy, sw, sh, 0, 0, c.width, c.height);
    out.push(c);
  };
  draw(0, 0, w, h);
  const side = Math.min(w, h);
  if (Math.max(w, h) > side * 1.2) draw((w - side) / 2, (h - side) / 2, side, side);
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
    const scale = Math.min(1, 448 / Math.max(video.videoWidth, video.videoHeight, 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    frames.push(canvas);
  }
  video.removeAttribute('src');
  video.load();
  return frames;
}

async function check(file: File): Promise<boolean> {
  const url = URL.createObjectURL(file);
  try {
    const net = await loadModel();
    const inputs = file.type.startsWith('video/') ? await videoFrames(url) : [await imageFrom(url)];
    for (const input of inputs) for (const crop of crops(input)) if (isExplicit(await net.classify(crop))) return true;
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** true quando a imagem/vídeo parece conteúdo +18. Falha ou demora (25 s) conta como não. */
export function looksNsfw(file: File): Promise<boolean> {
  if (!/^(image|video)\//.test(file.type) || file.type === 'image/svg+xml') return Promise.resolve(false);
  return Promise.race([
    check(file).catch(() => false),
    new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 25000)),
  ]);
}

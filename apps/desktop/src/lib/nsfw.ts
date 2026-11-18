'use client';

/**
 * Detecção automática de imagens +18, feita no próprio aparelho (nada sai do computador).
 * Usa o NSFWJS com o modelo MobileNetV2 (uns 3,5 MB), carregado só na primeira vez que
 * alguém anexa uma imagem ou vídeo.
 */

type Prediction = { className: string; probability: number };
type Model = { classify: (img: HTMLImageElement | HTMLCanvasElement) => Promise<Prediction[]> };

let model: Promise<Model> | null = null;

function loadModel(): Promise<Model> {
  if (!model) {
    model = (async () => {
      const [core, mobilenet] = await Promise.all([import('nsfwjs/core'), import('nsfwjs/models/mobilenet_v2')]);
      return (await core.load('MobileNetV2', { modelDefinitions: [mobilenet.MobileNetV2Model] })) as unknown as Model;
    })();
    model.catch(() => {
      model = null;
    });
  }
  return model;
}

/** Pornografia + hentai acima disso marca o anexo como +18. */
const THRESHOLD = 0.6;

const isExplicit = (p: Prediction[]) =>
  p.filter((x) => x.className === 'Porn' || x.className === 'Hentai').reduce((sum, x) => sum + x.probability, 0) >= THRESHOLD;

function imageFrom(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/** Quadros em 10%, 50% e 90% do vídeo. */
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
  for (const at of duration ? [0.1, 0.5, 0.9] : [0]) {
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
    for (const input of inputs) if (isExplicit(await net.classify(input))) return true;
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** true quando a imagem/vídeo parece conteúdo +18. Falha ou demora (15 s) conta como não. */
export function looksNsfw(file: File): Promise<boolean> {
  if (!/^(image|video)\//.test(file.type) || file.type === 'image/svg+xml') return Promise.resolve(false);
  return Promise.race([
    check(file).catch(() => false),
    new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 15000)),
  ]);
}

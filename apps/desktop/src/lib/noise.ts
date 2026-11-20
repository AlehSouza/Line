'use client';

import type { GtcrnWorkletNode, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';

// Importado só na hora de usar: o pacote estende AudioWorkletNode, que não existe no build do Next.
const lib = () => import('@sapphi-red/web-noise-suppressor');

/**
 * Supressor de ruído do microfone, rodando local (WebAssembly num AudioWorklet), igual no app e na web.
 * - "max": DeepFilterNet3 (rede neural moderna, 48 kHz). Tira teclado, ventilador, cachorro, rua e
 *   conversa de fundo sem deixar a voz metálica. Gasta uns 5% de um núcleo; o arquivo tem 34 MB.
 * - "balanced": GTCRN (rede de 2024, minúscula). Quase o mesmo resultado com bem menos processador.
 * - "light": RNNoise (rede pequena e antiga). Mais leve, mas deixa passar mais ruído e "come" sílabas.
 * Se o DeepFilterNet não abrir (navegador sem WebAssembly SIMD, pouca memória), cai para o RNNoise.
 * Os arquivos ficam em /noise (copiados dos pacotes por scripts/copy-noise.mjs).
 */
export type NoiseModel = 'max' | 'balanced' | 'light';

let ctx: AudioContext | null = null;
let rnWasm: Promise<ArrayBuffer> | null = null;
let rnReady: Promise<void> | null = null;
let gtWasm: Promise<ArrayBuffer> | null = null;
let gtReady: Promise<void> | null = null;
let dfModule: Promise<WebAssembly.Module> | null = null;
let dfReady: Promise<void> | null = null;
type Chain = { source: MediaStreamAudioSourceNode; node: AudioWorkletNode; dest: MediaStreamAudioDestinationNode; destroy: () => void };
/** Uma cadeia por uso: "call" (o microfone da chamada) e "test" (o Teste do microfone nas configurações). */
export type NoiseSlot = 'call' | 'test';
const chains = new Map<NoiseSlot, Chain>();

async function context() {
  // Os dois modelos trabalham a 48 kHz.
  if (!ctx || ctx.state === 'closed') {
    ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    rnReady = null;
    gtReady = null;
    dfReady = null;
  }
  if (ctx.state === 'suspended') await ctx.resume();
  return ctx;
}

async function rnnoiseNode(audio: AudioContext) {
  rnWasm ??= lib().then(({ loadRnnoise }) => loadRnnoise({ url: '/noise/rnnoise.wasm', simdUrl: '/noise/rnnoise_simd.wasm' }));
  rnReady ??= audio.audioWorklet.addModule('/noise/rnnoiseWorklet.js');
  await Promise.all([rnWasm, rnReady]);
  const { RnnoiseWorkletNode } = await lib();
  const node: RnnoiseWorkletNode = new RnnoiseWorkletNode(audio, { maxChannels: 1, wasmBinary: await rnWasm! });
  return { node, destroy: () => node.destroy() };
}

async function gtcrnNode(audio: AudioContext) {
  gtWasm ??= lib().then(({ loadGtcrn }) => loadGtcrn({ url: '/noise/gtcrn.wasm' }));
  gtReady ??= audio.audioWorklet.addModule('/noise/gtcrnWorklet.js');
  await Promise.all([gtWasm, gtReady]);
  const { GtcrnWorkletNode } = await lib();
  const node: GtcrnWorkletNode = new GtcrnWorkletNode(audio, { maxChannels: 1, wasmBinary: await gtWasm! });
  return { node, destroy: () => node.destroy() };
}

async function deepFilterNode(audio: AudioContext) {
  dfModule ??= fetch('/noise/deepfilter.wasm')
    .then((r) => {
      if (!r.ok) throw new Error(`deepfilter.wasm ${r.status}`);
      return r.arrayBuffer();
    })
    .then((bytes) => WebAssembly.compile(bytes));
  dfReady ??= audio.audioWorklet.addModule('/noise/deepfilterWorklet.js');
  let wasmModule: WebAssembly.Module;
  try {
    [wasmModule] = await Promise.all([dfModule, dfReady]);
  } catch (err) {
    // Deixa tentar de novo na próxima vez (ex.: a rede caiu no meio do download na web).
    dfModule = null;
    dfReady = null;
    throw err;
  }
  const node = new AudioWorkletNode(audio, 'deepfilternet-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    // Sem limite de atenuação: tira o ruído todo (o modelo cuida de não cortar a voz).
    processorOptions: { wasmModule, attenuationLimit: 100 },
  });
  // O worklet avisa quando o modelo carregou; sem isso uma falha passaria o som sem filtro.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DeepFilterNet demorou para carregar')), 8000);
    node.port.onmessage = (e: MessageEvent<{ type: string; message?: string }>) => {
      if (e.data?.type === 'ready') {
        clearTimeout(timer);
        resolve();
      } else if (e.data?.type === 'error') {
        clearTimeout(timer);
        reject(new Error(e.data.message || 'DeepFilterNet falhou'));
      }
    };
  }).catch((err) => {
    node.port.postMessage({ type: 'destroy' });
    throw err;
  });
  return { node, destroy: () => node.port.postMessage({ type: 'destroy' }) };
}

/**
 * Devolve um stream novo com a voz limpa e o modelo que ficou valendo
 * (quando um modelo não abre neste aparelho, desce para o RNNoise, que abre em qualquer lugar).
 */
export async function suppressNoise(input: MediaStream, model: NoiseModel = 'max', slot: NoiseSlot = 'call'): Promise<{ stream: MediaStream; model: NoiseModel; dispose: () => void }> {
  disposeNoiseSuppressor(slot);
  const audio = await context();
  let used: NoiseModel = model;
  let made: { node: AudioWorkletNode; destroy: () => void };
  if (model !== 'light') {
    try {
      made = model === 'max' ? await deepFilterNode(audio) : await gtcrnNode(audio);
    } catch (err) {
      console.warn(`Supressor ${model} indisponível, usando RNNoise`, err);
      used = 'light';
      made = await rnnoiseNode(audio);
    }
  } else {
    made = await rnnoiseNode(audio);
  }
  const source = audio.createMediaStreamSource(input);
  // Saída mono de verdade: o RNNoise e o GTCRN devolvem 2 canais com a voz só no esquerdo
  // (o direito vem mudo). Pega só o canal 0, e quem ouve recebe a voz nos dois lados.
  const dest = audio.createMediaStreamDestination();
  dest.channelCount = 1;
  dest.channelCountMode = 'explicit';
  const split = audio.createChannelSplitter(2);
  source.connect(made.node);
  made.node.connect(split);
  split.connect(dest, 0);
  const chain: Chain = { source, node: made.node, dest, destroy: made.destroy };
  chains.set(slot, chain);
  // Desmonta só esta cadeia (se outra já tomou o lugar no slot, não mexe nela).
  const dispose = () => {
    if (chains.get(slot) === chain) chains.delete(slot);
    teardown(chain);
  };
  return { stream: dest.stream, model: used, dispose };
}

export function disposeNoiseSuppressor(slot: NoiseSlot = 'call') {
  const chain = chains.get(slot);
  if (!chain) return;
  chains.delete(slot);
  teardown(chain);
}

function teardown(chain: Chain) {
  try {
    chain.source.disconnect();
    chain.destroy();
    chain.node.disconnect();
  } catch {
    // já desmontada
  }
}

/** O celular suspende o áudio quando a aba vai para segundo plano; ao voltar, religa o supressor. */
export function resumeNoiseSuppressor() {
  if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {});
}

/** Celular ou tablet: começa no equilibrado (menos bateria e sem baixar 34 MB). */
export function defaultNoiseModel(): NoiseModel {
  try {
    return typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches && matchMedia('(max-width: 1024px)').matches ? 'balanced' : 'max';
  } catch {
    return 'max';
  }
}

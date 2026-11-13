'use client';

import type { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';

// Importado só na hora de usar: o pacote estende AudioWorkletNode, que não existe no build do Next.
const lib = () => import('@sapphi-red/web-noise-suppressor');

/**
 * Supressor de ruído com RNNoise (rede neural pequena, roda local em WebAssembly).
 * Tira ventilador, teclado, ar-condicionado e barulho de fundo antes do áudio sair do PC.
 * Os arquivos ficam em /noise (copiados do pacote por scripts/copy-noise.mjs).
 */

let ctx: AudioContext | null = null;
let wasm: Promise<ArrayBuffer> | null = null;
let ready: Promise<void> | null = null;
let chain: { source: MediaStreamAudioSourceNode; node: RnnoiseWorkletNode; dest: MediaStreamAudioDestinationNode } | null = null;

async function context() {
  // O RNNoise trabalha a 48 kHz.
  if (!ctx || ctx.state === 'closed') {
    ctx = new AudioContext({ sampleRate: 48000 });
    ready = null;
  }
  wasm ??= lib().then(({ loadRnnoise }) => loadRnnoise({ url: '/noise/rnnoise.wasm', simdUrl: '/noise/rnnoise_simd.wasm' }));
  ready ??= ctx.audioWorklet.addModule('/noise/rnnoiseWorklet.js');
  await Promise.all([wasm, ready]);
  if (ctx.state === 'suspended') await ctx.resume();
  return ctx;
}

/** Devolve um stream novo com a voz limpa. */
export async function suppressNoise(input: MediaStream): Promise<MediaStream> {
  disposeNoiseSuppressor();
  const audio = await context();
  const source = audio.createMediaStreamSource(input);
  const { RnnoiseWorkletNode } = await lib();
  const node = new RnnoiseWorkletNode(audio, { maxChannels: 1, wasmBinary: await wasm! });
  const dest = audio.createMediaStreamDestination();
  source.connect(node);
  node.connect(dest);
  chain = { source, node, dest };
  return dest.stream;
}

export function disposeNoiseSuppressor() {
  if (!chain) return;
  chain.source.disconnect();
  chain.node.destroy();
  chain.node.disconnect();
  chain = null;
}

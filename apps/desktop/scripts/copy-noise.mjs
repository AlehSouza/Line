// Copia o worklet e o WebAssembly do RNNoise para public/noise (servidos pelo Next e embutidos no app).
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const dist = path.dirname(require.resolve('@sapphi-red/web-noise-suppressor/rnnoise.wasm'));
const out = path.join(import.meta.dirname, '..', 'public', 'noise');
mkdirSync(out, { recursive: true });
copyFileSync(path.join(dist, 'rnnoise', 'workletProcessor.js'), path.join(out, 'rnnoiseWorklet.js'));
for (const f of ['rnnoise.wasm', 'rnnoise_simd.wasm']) copyFileSync(path.join(dist, f), path.join(out, f));

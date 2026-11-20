// Copia os supressores de ruído para public/noise (servidos pelo Next e embutidos no app):
// - RNNoise (leve) e GTCRN (equilibrado): worklets + WebAssembly do @sapphi-red/web-noise-suppressor.
// - DeepFilterNet3 (máximo): WebAssembly com o modelo dentro + worklet do @lofcz/deepfilternet-web.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const out = path.join(import.meta.dirname, '..', 'public', 'noise');
mkdirSync(out, { recursive: true });

const rnnoise = path.dirname(require.resolve('@sapphi-red/web-noise-suppressor/rnnoise.wasm'));
copyFileSync(path.join(rnnoise, 'rnnoise', 'workletProcessor.js'), path.join(out, 'rnnoiseWorklet.js'));
copyFileSync(path.join(rnnoise, 'gtcrn', 'workletProcessor.js'), path.join(out, 'gtcrnWorklet.js'));
for (const f of ['rnnoise.wasm', 'rnnoise_simd.wasm', 'gtcrn.wasm']) copyFileSync(path.join(rnnoise, f), path.join(out, f));

const df = path.dirname(require.resolve('@lofcz/deepfilternet-web/df_bg.wasm'));
copyFileSync(path.join(df, 'df_bg.wasm'), path.join(out, 'deepfilter.wasm'));

// O worklet do pacote ganha três ajustes:
// 1. TextDecoder mínimo (o escopo do AudioWorklet do Chromium/WebView2 não tem um).
// 2. Avisa a página quando o modelo carregou ou falhou (senão a falha passaria o som cru, sem filtro).
// 3. Mensagem "destroy" libera o modelo e encerra o processador ao trocar de microfone.
let worklet = readFileSync(path.join(df, 'worklet.js'), 'utf8');
const patch = (from, to) => {
  if (!worklet.includes(from)) throw new Error(`copy-noise: trecho não encontrado no worklet do DeepFilterNet: ${from}`);
  worklet = worklet.replace(from, to);
};
patch('this.#ready = true;', 'this.#ready = true;\n        this.port.postMessage({ type: "ready" });');
patch(
  '} catch {\n        this.#ready = false;',
  '} catch (err) {\n        this.#ready = false;\n        this.port.postMessage({ type: "error", message: String(err && err.message || err) });',
);
patch(
  'if (event.data.type === "setEnabled") {',
  'if (event.data.type === "destroy") {\n          if (this.#ready) df_free(this.#handle);\n          this.#ready = false;\n          this.#dead = true;\n        }\n        if (event.data.type === "setEnabled") {',
);
patch('#bypass = false;', '#bypass = false;\n    #dead = false;');
patch('process(inputs, outputs) {', 'process(inputs, outputs) {\n      if (this.#dead) return false;');
// df_free só existe no worklet se o pacote o incluir; garante a função.
if (!/function df_free\(/.test(worklet)) {
  patch('function df_get_frame_length(st) {', 'function df_free(st) {\n    wasm.df_free(st);\n  }\n  function df_get_frame_length(st) {');
}
const textDecoder = `// TextDecoder mínimo (UTF-8) para o AudioWorklet, que não tem um.
if (typeof globalThis.TextDecoder === "undefined") {
  globalThis.TextDecoder = class {
    decode(bytes) {
      if (!bytes) return "";
      let s = "";
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      try { return decodeURIComponent(escape(s)); } catch { return s; }
    }
  };
}
`;
writeFileSync(path.join(out, 'deepfilterWorklet.js'), textDecoder + worklet);

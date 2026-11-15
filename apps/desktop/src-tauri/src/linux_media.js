// Correção de mídia do WebKitGTK (só no Linux).
//
// O player do WebKitGTK (GStreamer) não consegue tocar arquivos servidos pelo protocolo do próprio
// app (tauri://): o fetch funciona, mas <audio src="tauri://localhost/sounds/enter.mp3"> falha com
// MEDIA_ERR_SRC_NOT_SUPPORTED. Os sons da chamada (entrar, sair, mutar...) ficavam mudos.
// Aqui, todo áudio/vídeo do próprio app é baixado por fetch e tocado de um blob:, que o WebKit toca.
(() => {
  'use strict';
  if (window.__lineMediaFix) return;
  window.__lineMediaFix = true;

  const proto = HTMLMediaElement.prototype;
  const nativeSrc = Object.getOwnPropertyDescriptor(proto, 'src');
  const nativePlay = proto.play;
  if (!nativeSrc?.set || !nativePlay) return;

  /** URL do app (tauri://...) -> Promise<blob:...>. Os arquivos são pequenos e reaproveitados. */
  const blobs = new Map();
  const pending = new WeakMap();

  function appUrl(value) {
    try {
      const u = new URL(String(value), document.baseURI);
      return u.protocol === location.protocol && !/^(https?|blob|data):$/.test(u.protocol) ? u.href : null;
    } catch {
      return null;
    }
  }

  function blobFor(url) {
    let p = blobs.get(url);
    if (!p) {
      p = fetch(url)
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((b) => URL.createObjectURL(b));
      p.catch(() => blobs.delete(url));
      blobs.set(url, p);
    }
    return p;
  }

  Object.defineProperty(proto, 'src', {
    ...nativeSrc,
    set(value) {
      const url = appUrl(value);
      if (!url) {
        pending.delete(this);
        return nativeSrc.set.call(this, value);
      }
      const ready = blobFor(url).then(
        (blob) => {
          // Só aplica se ninguém trocou o src enquanto baixava.
          if (pending.get(this) === ready) nativeSrc.set.call(this, blob);
        },
        () => nativeSrc.set.call(this, value),
      );
      pending.set(this, ready);
    },
  });

  // play() logo depois de trocar o src (o caso dos sons da chamada) espera o blob ficar pronto.
  proto.play = function play() {
    const ready = pending.get(this);
    if (!ready) return nativePlay.call(this);
    return ready.then(() => {
      pending.delete(this);
      return nativePlay.call(this);
    });
  };

  // new Audio(url) define o src por dentro, sem passar pelo setter acima.
  const NativeAudio = window.Audio;
  function Audio(src) {
    const el = new NativeAudio();
    if (src !== undefined) el.src = src;
    return el;
  }
  Audio.prototype = NativeAudio.prototype;
  Object.defineProperty(window, 'Audio', { value: Audio, writable: true, configurable: true });
})();

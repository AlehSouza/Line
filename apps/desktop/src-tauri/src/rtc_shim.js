// Adaptador WebRTC do app Linux.
//
// O WebKitGTK das distros vem sem RTCPeerConnection. Este script (injetado antes da interface)
// cria RTCPeerConnection, RTCSessionDescription, RTCIceCandidate e RTCRtpSender com a mesma
// forma do navegador, e quem faz a chamada de verdade é o motor em Rust (crate line-rtc):
//
// - sinalização (ofertas, respostas, ICE) vai e volta pelo invoke do Tauri;
// - microfone: AudioWorklet tira PCM de 20 ms e manda para o Rust, que codifica em Opus;
// - áudio recebido: o Rust decodifica e devolve PCM, tocado por outro AudioWorklet que vira
//   uma trilha de verdade (MediaStreamAudioDestinationNode) para o <audio> da interface;
// - vídeo (câmera/tela): o VideoEncoder (WebCodecs) codifica em VP8 aqui e o Rust empacota;
//   o recebido volta em quadros VP8, o VideoDecoder decodifica num <canvas> e o
//   canvas.captureStream() vira a trilha de vídeo que a interface mostra.
//
// Assim o voice.ts é o mesmo do Windows, do macOS e da web.
(() => {
  'use strict';
  if (window.__lineRtc) return;

  const T = () => window.__TAURI_INTERNALS__;
  const invoke = (cmd, args) => {
    const t = T();
    return t ? t.invoke(cmd, args) : Promise.reject(new Error('ponte do Tauri indisponível'));
  };
  const domError = (err, name = 'OperationError') =>
    err instanceof Error ? err : new DOMException(typeof err === 'string' ? err : String(err), name);

  const hasVideoCodecs = typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
  window.__lineRtc = { adapter: true, video: hasVideoCodecs };

  // ---------- canais Rust -> página ----------

  /** Canal no formato do Tauri: mensagens numeradas, entregues em ordem. */
  function channel(onMessage) {
    let next = 0;
    const pending = new Map();
    const id = T().transformCallback((payload) => {
      if (!payload || typeof payload !== 'object' || !('index' in payload)) return onMessage(payload);
      if (payload.end) return;
      pending.set(payload.index, payload.message);
      while (pending.has(next)) {
        const msg = pending.get(next);
        pending.delete(next);
        next++;
        try {
          onMessage(msg);
        } catch (err) {
          console.error('[line-rtc]', err);
        }
      }
    });
    return `__CHANNEL__:${id}`;
  }

  let attached = null;
  function attach() {
    attached ??= invoke('rtc_attach', { control: channel(onControl), media: channel(onMedia) });
    return attached;
  }

  let nextId = 1;
  const pcs = new Map();
  /** id da recepção (escolhido pelo Rust) -> RemoteAudio | RemoteVideo */
  const receivers = new Map();

  function onControl(ev) {
    if (ev.type === 'keyframe') {
      for (const s of sources.values()) if (s.id === ev.source) s.requestKeyframe?.();
      return;
    }
    if (ev.type === 'trackended') {
      const r = receivers.get(ev.receiver);
      receivers.delete(ev.receiver);
      r?.end(true);
      return;
    }
    pcs.get(ev.pc)?._engineEvent(ev);
  }

  function onMedia(buf) {
    if (!(buf instanceof ArrayBuffer)) return;
    const view = new DataView(buf);
    let o = 0;
    while (o + 9 <= buf.byteLength) {
      const kind = view.getUint8(o);
      const id = view.getUint32(o + 1, true);
      const len = view.getUint32(o + 5, true);
      o += 9;
      if (o + len > buf.byteLength) break;
      receivers.get(id)?.push(kind, buf, o, len);
      o += len;
    }
  }

  /** Mídia local para o Rust: [tipo u8][fonte u32][duração µs u32][dados]. */
  function push(kind, source, durationUs, payload) {
    const out = new Uint8Array(9 + payload.byteLength);
    const v = new DataView(out.buffer);
    v.setUint8(0, kind);
    v.setUint32(1, source, true);
    v.setUint32(5, durationUs >>> 0, true);
    out.set(new Uint8Array(payload), 9);
    const t = T();
    if (t) t.invoke('rtc_push', out).catch(() => {});
  }

  // ---------- áudio (AudioWorklet) ----------

  const WORKLET = `
  // Microfone -> quadros de 960 amostras a 48 kHz (Int16).
  class LineCapture extends AudioWorkletProcessor {
    constructor() {
      super();
      this.buf = new Int16Array(960);
      this.n = 0;
      this.step = 48000 / sampleRate;
      this.acc = 0;
    }
    put(x) {
      const v = x > 1 ? 1 : x < -1 ? -1 : x;
      this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === 960) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
        this.buf = new Int16Array(960);
        this.n = 0;
      }
    }
    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (!ch) return true;
      if (this.step === 1) {
        for (let i = 0; i < ch.length; i++) this.put(ch[i]);
      } else {
        for (let i = 0; i < ch.length; i++) {
          this.acc += this.step;
          while (this.acc >= 1) { this.put(ch[i]); this.acc -= 1; }
        }
      }
      return true;
    }
  }
  // PCM recebido -> saída, com um colchão contra o jitter da rede.
  class LinePlayer extends AudioWorkletProcessor {
    constructor() {
      super();
      this.q = [];
      this.head = null;
      this.pos = 0;
      this.size = 0;
      this.playing = false;
      this.step = 48000 / sampleRate;
      this.acc = 0;
      this.last = 0;
      this.port.onmessage = (e) => {
        const a = new Int16Array(e.data);
        this.q.push(a);
        this.size += a.length;
        // Mais de 200 ms na fila: ficou para trás (rede engasgou e depois soltou tudo). Descarta o mais velho.
        while (this.size > 9600 && this.q.length > 1) this.size -= this.q.shift().length;
      };
    }
    take() {
      while (!this.head || this.pos >= this.head.length) {
        if (!this.q.length) return null;
        this.head = this.q.shift();
        this.pos = 0;
      }
      this.size--;
      return this.head[this.pos++];
    }
    process(_, outputs) {
      const out = outputs[0][0];
      // Começa (e recomeça depois de faltar áudio) só com 60 ms guardados.
      if (!this.playing && this.size >= 2880) this.playing = true;
      if (!this.playing) {
        out.fill(0);
      } else {
        for (let i = 0; i < out.length; i++) {
          this.acc += this.step;
          let ok = true;
          while (this.acc >= 1) {
            const s = this.take();
            this.acc -= 1;
            if (s === null) { ok = false; break; }
            this.last = s;
          }
          if (!ok) { out.fill(0, i); this.playing = false; this.acc = 0; break; }
          out[i] = this.last / 32768;
        }
      }
      for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
      return true;
    }
  }
  registerProcessor('line-capture', LineCapture);
  registerProcessor('line-player', LinePlayer);
  `;

  let ctxPromise = null;
  function audioContext() {
    ctxPromise ??= (async () => {
      let ctx;
      try {
        ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      } catch {
        ctx = new AudioContext();
      }
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const resume = () => void ctx.resume().catch(() => {});
      resume();
      // Se o WebKit segurar o áudio até um clique, o primeiro clique/tecla libera.
      for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, resume, { capture: true });
      return ctx;
    })();
    return ctxPromise;
  }

  // ---------- fontes locais (o que eu mando) ----------

  /** Trilha local -> fonte no Rust. Uma por trilha, dividida entre todas as conexões. */
  const sources = new Map();

  function sourceFor(track) {
    let s = sources.get(track);
    if (!s) {
      s = track.kind === 'audio' ? new AudioSource(track) : new VideoSource(track);
      sources.set(track, s);
      s.ready = s.start().catch((err) => console.warn('[line-rtc] fonte local falhou', err));
    }
    s.refs++;
    return s;
  }

  function release(source) {
    if (!source || --source.refs > 0) return;
    sources.delete(source.track);
    source.stop();
  }

  class AudioSource {
    constructor(track) {
      this.id = nextId++;
      this.track = track;
      this.refs = 0;
    }
    async start() {
      await attach();
      await invoke('rtc_add_source', { source: this.id, kind: 'audio' });
      const ctx = await audioContext();
      if (this.stopped) return;
      this.src = ctx.createMediaStreamSource(new MediaStream([this.track]));
      this.node = new AudioWorkletNode(ctx, 'line-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      // O WebKit só processa nós ligados até a saída: passa por um ganho zerado.
      this.silent = ctx.createGain();
      this.silent.gain.value = 0;
      this.src.connect(this.node).connect(this.silent).connect(ctx.destination);
      this.node.port.onmessage = (e) => {
        // Trilha desligada (mudo): manda silêncio, como o navegador.
        if (!this.track.enabled) new Int16Array(e.data).fill(0);
        push(1, this.id, 20000, e.data);
      };
    }
    stop() {
      this.stopped = true;
      try {
        this.src?.disconnect();
        this.node?.disconnect();
        this.silent?.disconnect();
      } catch {}
      if (this.node) this.node.port.onmessage = null;
      void invoke('rtc_remove_source', { source: this.id }).catch(() => {});
    }
  }

  const KEYFRAME_EVERY_MS = 3000;

  class VideoSource {
    constructor(track) {
      this.id = nextId++;
      this.track = track;
      this.refs = 0;
      /** Vindo de sendEncodings / setParameters. */
      this.params = { maxBitrate: 0, maxFramerate: 0, scaleResolutionDownBy: 1 };
      this.needKey = true;
      this.lastKey = 0;
      this.lastSent = 0;
      this.lastTs = 0;
    }
    async start() {
      if (!hasVideoCodecs) {
        console.warn('[line-rtc] este WebKitGTK não tem WebCodecs: o vídeo não sai daqui.');
        return;
      }
      await attach();
      await invoke('rtc_add_source', { source: this.id, kind: 'video' });
      if (this.stopped) return;
      this.track.addEventListener('ended', () => this.stop());
      // Tela capturada pelo Rust (nativeScreen.ts no Linux): os quadros chegam prontos, sem
      // passar por canvas e <video>; vão direto para o codificador.
      const direct = this.track.__lineFrameSource;
      if (direct) {
        this.unsubscribe = direct.subscribe((frame) => {
          try {
            // O Rust já manda no fps pedido: aqui não descarta por tempo (só se o codificador atrasar).
            if (this.refs && !this.stopped) this.encodeFrame(frame, frame.codedWidth & ~1, frame.codedHeight & ~1, true);
          } catch (err) {
            console.warn('[line-rtc] quadro da tela', err);
          } finally {
            frame.close();
          }
        });
        return;
      }
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.autoplay = true;
      v.srcObject = new MediaStream([this.track]);
      // Fora da tela, mas no documento: assim o WebKit continua decodificando os quadros.
      v.style.cssText = 'position:fixed;left:-10000px;top:0;width:4px;height:4px;opacity:0;pointer-events:none';
      document.documentElement.appendChild(v);
      this.video = v;
      await v.play().catch(() => {});
      this.loop();
    }
    loop() {
      const v = this.video;
      const next = () => {
        if (this.stopped) return;
        if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick);
        else setTimeout(tick, 1000 / this.fps());
      };
      const tick = () => {
        try {
          this.grab();
        } catch (err) {
          console.warn('[line-rtc] quadro de vídeo', err);
        }
        next();
      };
      next();
    }
    fps() {
      return this.params.maxFramerate || this.track.getSettings?.().frameRate || 30;
    }
    requestKeyframe() {
      this.needKey = true;
    }
    size() {
      const v = this.video;
      const scale = Math.max(1, this.params.scaleResolutionDownBy || 1);
      // Par e no máximo 4K: o VP8 exige dimensões pares em alguns codificadores.
      const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
      return { w: even(Math.min(3840, v.videoWidth / scale)), h: even(Math.min(2160, v.videoHeight / scale)) };
    }
    bitrate(w, h) {
      if (this.params.maxBitrate) return this.params.maxBitrate;
      // Sem pedido: ~1,2 Mbps em 720p30, proporcional à área.
      return Math.round(Math.min(8_000_000, Math.max(300_000, (w * h * this.fps()) / 23)));
    }
    configure(w, h) {
      try {
        this.encoder?.close();
      } catch {}
      this.encoder = new VideoEncoder({
        output: (chunk) => this.out(chunk),
        error: (err) => {
          console.warn('[line-rtc] VideoEncoder', err);
          this.encoder = null;
        },
      });
      const bitrate = this.bitrate(w, h);
      this.encoder.configure({ codec: 'vp8', width: w, height: h, bitrate, framerate: this.fps(), latencyMode: 'realtime' });
      this.config = { w, h, bitrate, fps: this.fps() };
      this.needKey = true;
    }
    grab() {
      const v = this.video;
      if (!this.refs || !v.videoWidth || !v.videoHeight || this.track.readyState === 'ended') return;
      const { w, h } = this.size();
      this.encodeFrame(null, w, h);
    }
    /** Codifica um quadro (o dado, ou um tirado do <video>) se o fps e o codificador deixarem. */
    encodeFrame(given, w, h, paced = false) {
      const now = performance.now();
      // Respeita o fps pedido (a fonte pode mandar mais).
      if (!paced && now - this.lastSent < 1000 / this.fps() - 4) return;
      const c = this.config;
      if (!this.encoder || !c || c.w !== w || c.h !== h || c.bitrate !== this.bitrate(w, h) || c.fps !== this.fps()) {
        this.configure(w, h);
      }
      if (this.encoder.encodeQueueSize > 2) return; // codificador atrasado: pula este quadro
      this.lastSent = now;
      const frame = given ?? this.frame(this.video, w, h, Math.round(now * 1000));
      const keyFrame = this.needKey || now - this.lastKey > KEYFRAME_EVERY_MS;
      if (keyFrame) {
        this.needKey = false;
        this.lastKey = now;
      }
      try {
        this.encoder.encode(frame, { keyFrame });
      } finally {
        if (!given) frame.close();
      }
    }
    frame(v, w, h, timestamp) {
      if (w === v.videoWidth && h === v.videoHeight && !this.useCanvas) {
        try {
          return new VideoFrame(v, { timestamp });
        } catch {
          this.useCanvas = true;
        }
      }
      // Reduz a resolução (ou o WebKit não aceitou o <video> direto): passa por um canvas.
      if (!this.canvas) {
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d', { alpha: false });
      }
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      this.ctx.drawImage(v, 0, 0, w, h);
      return new VideoFrame(this.canvas, { timestamp });
    }
    out(chunk) {
      const data = new ArrayBuffer(chunk.byteLength);
      chunk.copyTo(data);
      const dur = this.lastTs ? chunk.timestamp - this.lastTs : 1e6 / this.fps();
      this.lastTs = chunk.timestamp;
      push(2, this.id, Math.min(1e6, Math.max(1000, dur)), data);
    }
    stop() {
      if (this.stopped) return;
      this.stopped = true;
      this.unsubscribe?.();
      try {
        this.encoder?.close();
      } catch {}
      if (this.video) {
        this.video.srcObject = null;
        this.video.remove();
      }
      void invoke('rtc_remove_source', { source: this.id }).catch(() => {});
    }
  }

  // ---------- recepções (o que chega) ----------

  /** Uma trilha remota "termina": tira do stream e avisa como o navegador avisaria. */
  function endTrack(track, streams, notify) {
    if (track.readyState === 'ended') return;
    track.stop();
    if (!notify) return;
    for (const s of streams) {
      if (!s.getTracks().includes(track)) continue;
      s.removeTrack(track);
      let ev;
      try {
        ev = new MediaStreamTrackEvent('removetrack', { track });
      } catch {
        ev = new Event('removetrack');
        ev.track = track;
      }
      s.dispatchEvent(ev);
    }
    track.dispatchEvent(new Event('ended'));
  }

  // O WebKitGTK não toca no alto-falante um stream que vem do WebAudio (MediaStreamAudioDestinationNode)
  // posto num <audio>: o elemento diz "playing" e não sai som. Então o áudio recebido sai direto pelo
  // WebAudio, e cada <audio>/<video> que mostra uma trilha remota fica mudo de verdade e só "manda" no
  // volume: o muted/volume dele (deafen, volume por pessoa, silenciar alguém) viram o ganho da saída.
  const remoteAudioByTrack = new WeakMap();
  /** elemento -> { muted, volume, remotes: RemoteAudio[] } */
  const audioSinks = new Map();
  const mediaProto = HTMLMediaElement.prototype;
  const nativeSrcObject = Object.getOwnPropertyDescriptor(mediaProto, 'srcObject');
  const nativeMuted = Object.getOwnPropertyDescriptor(mediaProto, 'muted');
  const nativeVolume = Object.getOwnPropertyDescriptor(mediaProto, 'volume');

  function refreshRemoteGains() {
    const level = new Map();
    for (const info of audioSinks.values()) {
      if (info.muted) continue;
      for (const r of info.remotes) level.set(r, Math.max(level.get(r) ?? 0, info.volume));
    }
    for (const r of remoteAudios) r.setLevel(level.get(r) ?? 0);
  }

  function bindSink(el, stream) {
    const remotes = (stream?.getAudioTracks?.() ?? []).map((t) => remoteAudioByTrack.get(t)).filter(Boolean);
    const info = audioSinks.get(el);
    if (remotes.length) {
      if (!info) {
        audioSinks.set(el, { muted: nativeMuted.get.call(el), volume: nativeVolume.get.call(el), remotes });
        nativeMuted.set.call(el, true);
      } else {
        info.remotes = remotes;
      }
    } else if (info) {
      audioSinks.delete(el);
      nativeMuted.set.call(el, info.muted);
      nativeVolume.set.call(el, info.volume);
    }
    refreshRemoteGains();
  }

  if (nativeSrcObject?.set && nativeMuted?.set && nativeVolume?.set) {
    Object.defineProperty(mediaProto, 'srcObject', {
      ...nativeSrcObject,
      set(stream) {
        nativeSrcObject.set.call(this, stream);
        bindSink(this, stream);
      },
    });
    Object.defineProperty(mediaProto, 'muted', {
      ...nativeMuted,
      get() {
        const info = audioSinks.get(this);
        return info ? info.muted : nativeMuted.get.call(this);
      },
      set(v) {
        const info = audioSinks.get(this);
        if (!info) return nativeMuted.set.call(this, v);
        info.muted = !!v;
        refreshRemoteGains();
      },
    });
    Object.defineProperty(mediaProto, 'volume', {
      ...nativeVolume,
      get() {
        const info = audioSinks.get(this);
        return info ? info.volume : nativeVolume.get.call(this);
      },
      set(v) {
        const info = audioSinks.get(this);
        if (!info) return nativeVolume.set.call(this, v);
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 1) throw new DOMException('Volume fora de 0 a 1.', 'IndexSizeError');
        info.volume = n;
        refreshRemoteGains();
      },
    });
  }

  const remoteAudios = new Set();

  class RemoteAudio {
    async init() {
      const ctx = await audioContext();
      this.node = new AudioWorkletNode(ctx, 'line-player', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      // Trilha de verdade, para a interface medir quem fala e para o reforço acima de 100%.
      this.dest = ctx.createMediaStreamDestination();
      this.dest.channelCount = 1;
      this.node.connect(this.dest);
      // Alto-falante: começa calado até um <audio> da interface "tocar" esta trilha.
      this.out = ctx.createGain();
      this.out.gain.value = 0;
      this.node.connect(this.out).connect(ctx.destination);
      this.track = this.dest.stream.getAudioTracks()[0];
      remoteAudioByTrack.set(this.track, this);
      remoteAudios.add(this);
      return this.track;
    }
    setLevel(v) {
      if (!this.out) return;
      // Rampa curta: mutar/desmutar sem estalo.
      this.out.gain.setTargetAtTime(v, this.out.context.currentTime, 0.015);
    }
    push(kind, buf, off, len) {
      if (kind !== 1 || !this.node) return;
      const pcm = buf.slice(off, off + len);
      this.node.port.postMessage(pcm, [pcm]);
    }
    end(notify) {
      remoteAudios.delete(this);
      if (this.track) endTrack(this.track, this.streams ?? [], notify);
      try {
        this.node?.disconnect();
        this.out?.disconnect();
      } catch {}
    }
  }

  class RemoteVideo {
    constructor(pc, id) {
      this.pc = pc;
      this.id = id;
      this.waitKey = true;
      this.lastAsk = 0;
    }
    async init() {
      this.canvas = document.createElement('canvas');
      this.canvas.width = 640;
      this.canvas.height = 360;
      this.ctx = this.canvas.getContext('2d', { alpha: false });
      this.ctx.fillRect(0, 0, 640, 360);
      this.track = this.canvas.captureStream().getVideoTracks()[0];
      return this.track;
    }
    decoderReady() {
      if (this.decoder || !hasVideoCodecs) return !!this.decoder;
      this.decoder = new VideoDecoder({
        output: (frame) => this.draw(frame),
        error: (err) => {
          console.warn('[line-rtc] VideoDecoder', err);
          this.reset();
        },
      });
      this.decoder.configure({ codec: 'vp8' });
      return true;
    }
    draw(frame) {
      const w = frame.displayWidth;
      const h = frame.displayHeight;
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      this.ctx.drawImage(frame, 0, 0, w, h);
      frame.close();
    }
    askKeyframe() {
      const now = performance.now();
      if (now - this.lastAsk < 500) return;
      this.lastAsk = now;
      void invoke('rtc_request_keyframe', { pc: this.pc._id, receiver: this.id }).catch(() => {});
    }
    reset() {
      try {
        this.decoder?.close();
      } catch {}
      this.decoder = null;
      this.waitKey = true;
      this.askKeyframe();
    }
    push(kind, buf, off, len) {
      if ((kind !== 2 && kind !== 3) || !this.track || this.track.readyState === 'ended') return;
      if (!this.decoderReady()) return;
      const key = kind === 3;
      // O decodificador só começa (ou recomeça) num quadro-chave.
      if (this.waitKey && !key) return this.askKeyframe();
      // Decodificação atrasada demais: joga fora e espera o próximo quadro-chave.
      if (this.decoder.decodeQueueSize > 8 && !key) {
        this.waitKey = true;
        return this.askKeyframe();
      }
      this.waitKey = false;
      const ts = new DataView(buf, off, 4).getUint32(0, true);
      try {
        this.decoder.decode(
          new EncodedVideoChunk({
            type: key ? 'key' : 'delta',
            timestamp: Math.round((ts * 1000) / 90),
            data: new Uint8Array(buf, off + 4, len - 4),
          }),
        );
      } catch (err) {
        console.warn('[line-rtc] quadro de vídeo inválido', err);
        this.reset();
      }
    }
    end(notify) {
      if (this.track) endTrack(this.track, this.streams ?? [], notify);
      try {
        this.decoder?.close();
      } catch {}
      this.decoder = null;
    }
  }

  // ---------- classes no formato do navegador ----------

  class LineRTCSessionDescription {
    constructor(init = {}) {
      this.type = init.type;
      this.sdp = init.sdp ?? '';
    }
    toJSON() {
      return { type: this.type, sdp: this.sdp };
    }
  }

  class LineRTCIceCandidate {
    constructor(init = {}) {
      this.candidate = init.candidate ?? '';
      this.sdpMid = init.sdpMid ?? null;
      this.sdpMLineIndex = init.sdpMLineIndex ?? null;
      this.usernameFragment = init.usernameFragment ?? null;
      const f = this.candidate.replace(/^candidate:/, '').split(' ');
      this.foundation = f[0] || null;
      this.component = f[1] === '1' ? 'rtp' : f[1] === '2' ? 'rtcp' : null;
      this.protocol = f[2]?.toLowerCase() || null;
      this.priority = f[3] ? Number(f[3]) : null;
      this.address = f[4] || null;
      this.port = f[5] ? Number(f[5]) : null;
      this.type = f[7] || null;
    }
    toJSON() {
      return {
        candidate: this.candidate,
        sdpMid: this.sdpMid,
        sdpMLineIndex: this.sdpMLineIndex,
        usernameFragment: this.usernameFragment,
      };
    }
  }

  class LineRTCRtpSender {
    constructor(pc, id, track, kind, encodings) {
      this._pc = pc;
      this._id = id;
      this._kind = kind;
      this._source = null;
      this.track = null;
      this.transport = null;
      this.dtmf = null;
      this._params = {
        transactionId: String(id),
        encodings: encodings?.length ? encodings.map((e) => ({ ...e })) : [{ active: true }],
        codecs: [],
        headerExtensions: [],
        rtcp: { cname: '', reducedSize: true },
      };
      this._setTrack(track);
    }
    static getCapabilities(kind) {
      return kind === 'audio'
        ? { codecs: [{ mimeType: 'audio/opus', clockRate: 48000, channels: 2 }], headerExtensions: [] }
        : kind === 'video'
          ? { codecs: [{ mimeType: 'video/VP8', clockRate: 90000 }], headerExtensions: [] }
          : null;
    }
    _setTrack(track) {
      release(this._source);
      this._source = null;
      this.track = track ?? null;
      if (track) {
        this._source = sourceFor(track);
        this._applyParams();
      }
    }
    _applyParams() {
      const s = this._source;
      const e = this._params.encodings[0] ?? {};
      if (s?.params) {
        s.params = {
          maxBitrate: e.maxBitrate || 0,
          maxFramerate: e.maxFramerate || 0,
          scaleResolutionDownBy: e.scaleResolutionDownBy || 1,
        };
      }
    }
    _bind() {
      const s = this._source;
      return (s?.ready ?? Promise.resolve()).then(() =>
        invoke('rtc_bind', { pc: this._pc._id, sender: this._id, source: s && !s.stopped ? s.id : null }),
      );
    }
    getParameters() {
      return structuredClone(this._params);
    }
    async setParameters(params) {
      if (params?.encodings) this._params.encodings = params.encodings.map((e) => ({ ...e }));
      if (params?.degradationPreference) this._params.degradationPreference = params.degradationPreference;
      this._applyParams();
    }
    replaceTrack(track) {
      if (track && track.kind !== this._kind) return Promise.reject(new TypeError('tipo de trilha diferente'));
      return this._pc._op(() => {
        this._setTrack(track);
        return this._bind();
      });
    }
    async getStats() {
      return new Map();
    }
    setStreams() {}
  }

  class LineRTCRtpTransceiver {
    constructor(sender, direction, kind) {
      this.sender = sender;
      this.receiver = { track: null, transport: null, getStats: async () => new Map(), getContributingSources: () => [], getSynchronizationSources: () => [] };
      this.direction = direction;
      this.currentDirection = null;
      this.mid = null;
      this.stopped = false;
      this._kind = kind;
    }
    setCodecPreferences() {
      // Só existe VP8 (e Opus) deste lado: a preferência não muda nada.
    }
    stop() {
      this.stopped = true;
      this.direction = 'stopped';
      if (this.sender.track) this.sender._pc.removeTrack(this.sender);
    }
  }

  const EVENTS = [
    'negotiationneeded',
    'icecandidate',
    'icecandidateerror',
    'icegatheringstatechange',
    'iceconnectionstatechange',
    'connectionstatechange',
    'signalingstatechange',
    'track',
    'datachannel',
  ];

  class LineRTCPeerConnection extends EventTarget {
    constructor(config = {}) {
      super();
      this._id = nextId++;
      this._senders = [];
      this._transceivers = [];
      this._receivers = new Set();
      this._streams = new Map();
      this._closed = false;
      /** setLocalDescription em andamento: os candidatos esperam ele terminar (ver abaixo). */
      this._sldPending = 0;
      this._heldCandidates = [];
      this.signalingState = 'stable';
      this.connectionState = 'new';
      this.iceConnectionState = 'new';
      this.iceGatheringState = 'new';
      this.localDescription = null;
      this.remoteDescription = null;
      this.currentLocalDescription = null;
      this.currentRemoteDescription = null;
      this.pendingLocalDescription = null;
      this.pendingRemoteDescription = null;
      this.canTrickleIceCandidates = true;
      this.sctp = null;
      for (const e of EVENTS) this['on' + e] = null;
      this._config = { ...config };
      const iceServers = (config.iceServers ?? []).map((s) => ({
        urls: s.urls,
        username: s.username ?? null,
        credential: typeof s.credential === 'string' ? s.credential : null,
      }));
      pcs.set(this._id, this);
      this._ops = attach().then(() => invoke('rtc_create', { pc: this._id, iceServers }));
      this._ops.catch((err) => console.warn('[line-rtc] não deu para criar a conexão', err));
    }

    /** Fila de operações (como a "operations chain" da especificação): uma por vez, em ordem. */
    _op(fn) {
      if (this._closed) return Promise.reject(new DOMException('A conexão está fechada.', 'InvalidStateError'));
      const p = this._ops.then(() => fn());
      this._ops = p.catch(() => {});
      return p.catch((err) => {
        throw domError(err);
      });
    }

    _fire(type, props = {}) {
      if (this._closed && type !== 'connectionstatechange') return;
      const ev = new Event(type);
      for (const [k, v] of Object.entries(props)) Object.defineProperty(ev, k, { value: v, enumerable: true });
      this.dispatchEvent(ev);
      const handler = this['on' + type];
      if (typeof handler === 'function') {
        try {
          handler.call(this, ev);
        } catch (err) {
          console.error(err);
        }
      }
    }

    _apply(snap) {
      const desc = (d) => (d ? new LineRTCSessionDescription(d) : null);
      const before = this.signalingState;
      this.localDescription = desc(snap.localDescription);
      this.remoteDescription = desc(snap.remoteDescription);
      const stable = snap.signalingState === 'stable';
      this.currentLocalDescription = stable ? this.localDescription : this.currentLocalDescription;
      this.currentRemoteDescription = stable ? this.remoteDescription : this.currentRemoteDescription;
      this.pendingLocalDescription = snap.signalingState === 'have-local-offer' ? this.localDescription : null;
      this.pendingRemoteDescription = snap.signalingState === 'have-remote-offer' ? this.remoteDescription : null;
      this.signalingState = snap.signalingState;
      if (stable) for (const t of this._transceivers) t.currentDirection = t.direction;
      if (before !== this.signalingState) this._fire('signalingstatechange');
    }

    async _engineEvent(ev) {
      switch (ev.type) {
        case 'negotiationneeded':
          if (this.signalingState === 'stable') this._fire('negotiationneeded');
          else this._negotiationPending = true;
          return;
        case 'icecandidate': {
          const candidate = ev.candidate ? new LineRTCIceCandidate(ev.candidate) : null;
          // O Rust começa a coletar candidatos antes da resposta do setLocalDescription chegar aqui.
          // No navegador eles só saem depois que a promessa resolve; se saíssem antes, chegariam ao
          // outro lado antes da oferta/resposta e seriam recusados.
          if (this._sldPending > 0) this._heldCandidates.push(candidate);
          else this._fire('icecandidate', { candidate });
          return;
        }
        case 'icegatheringstate':
          this.iceGatheringState = ev.state;
          this._fire('icegatheringstatechange');
          return;
        case 'iceconnectionstate':
          this.iceConnectionState = ev.state;
          this._fire('iceconnectionstatechange');
          return;
        case 'connectionstate':
          this.connectionState = ev.state;
          console.info(`[line-rtc] conexão ${this._id}: ${ev.state}`);
          this._fire('connectionstatechange');
          return;
        case 'track':
          return this._onTrack(ev);
      }
    }

    async _onTrack(ev) {
      const r = ev.kind === 'audio' ? new RemoteAudio() : new RemoteVideo(this, ev.receiver);
      let track;
      try {
        track = await r.init();
      } catch (err) {
        console.warn('[line-rtc] trilha remota', err);
        return;
      }
      if (this._closed) return r.end(false);
      console.info(`[line-rtc] conexão ${this._id}: trilha ${ev.kind} recebida (stream ${ev.streamIds.join(',')})`);
      receivers.set(ev.receiver, r);
      this._receivers.add(r);
      const streams = ev.streamIds.map((sid) => {
        let s = this._streams.get(sid);
        if (!s) {
          s = new MediaStream();
          // O id precisa ser o do outro lado: a interface casa a câmera e a tela pelo id do stream.
          Object.defineProperty(s, 'id', { value: sid, configurable: true });
          this._streams.set(sid, s);
        }
        s.addTrack(track);
        return s;
      });
      r.streams = streams;
      const receiver = { track, transport: null, getStats: async () => new Map(), getContributingSources: () => [], getSynchronizationSources: () => [] };
      const transceiver = { receiver, sender: null, mid: null, direction: 'recvonly', currentDirection: 'recvonly', stopped: false, setCodecPreferences() {}, stop() {} };
      this._fire('track', { track, streams, receiver, transceiver });
    }

    // ----- mídia -----

    addTrack(track, ...streams) {
      if (this._closed) throw new DOMException('A conexão está fechada.', 'InvalidStateError');
      if (this._senders.some((s) => s.track === track)) throw new DOMException('Trilha já adicionada.', 'InvalidAccessError');
      const sender = new LineRTCRtpSender(this, nextId++, track, track.kind);
      this._senders.push(sender);
      this._transceivers.push(new LineRTCRtpTransceiver(sender, 'sendrecv', track.kind));
      void this._op(() =>
        invoke('rtc_add_track', {
          pc: this._id,
          sender: sender._id,
          kind: track.kind,
          trackId: track.id,
          streamIds: streams.map((s) => s.id),
          direction: null,
        }).then(() => sender._bind()),
      ).catch((err) => console.warn('[line-rtc] addTrack', err));
      return sender;
    }

    addTransceiver(trackOrKind, init = {}) {
      if (this._closed) throw new DOMException('A conexão está fechada.', 'InvalidStateError');
      if (typeof trackOrKind === 'string') {
        // Só para receber: o motor cria quando a oferta do outro lado chegar.
        const sender = new LineRTCRtpSender(this, nextId++, null, trackOrKind);
        const t = new LineRTCRtpTransceiver(sender, init.direction ?? 'recvonly', trackOrKind);
        this._transceivers.push(t);
        return t;
      }
      const track = trackOrKind;
      const sender = new LineRTCRtpSender(this, nextId++, track, track.kind, init.sendEncodings);
      const direction = init.direction ?? 'sendrecv';
      const t = new LineRTCRtpTransceiver(sender, direction, track.kind);
      this._senders.push(sender);
      this._transceivers.push(t);
      void this._op(() =>
        invoke('rtc_add_track', {
          pc: this._id,
          sender: sender._id,
          kind: track.kind,
          trackId: track.id,
          streamIds: (init.streams ?? []).map((s) => s.id),
          direction,
        }).then(() => sender._bind()),
      ).catch((err) => console.warn('[line-rtc] addTransceiver', err));
      return t;
    }

    removeTrack(sender) {
      if (this._closed) throw new DOMException('A conexão está fechada.', 'InvalidStateError');
      if (!this._senders.includes(sender) || !sender.track) return;
      sender._setTrack(null);
      void this._op(() => invoke('rtc_remove_track', { pc: this._id, sender: sender._id })).catch((err) =>
        console.warn('[line-rtc] removeTrack', err),
      );
    }

    getSenders() {
      return [...this._senders];
    }

    getReceivers() {
      return [...this._receivers].filter((r) => r.track).map((r) => ({ track: r.track }));
    }

    getTransceivers() {
      return [...this._transceivers];
    }

    createDataChannel() {
      throw new DOMException('Canal de dados não disponível no app Linux.', 'NotSupportedError');
    }

    // ----- sinalização -----

    createOffer() {
      return this._op(() => invoke('rtc_create_offer', { pc: this._id })).then((d) => new LineRTCSessionDescription(d));
    }

    createAnswer() {
      return this._op(() => invoke('rtc_create_answer', { pc: this._id })).then((d) => new LineRTCSessionDescription(d));
    }

    setLocalDescription(desc) {
      const init = desc && desc.type ? { type: desc.type, sdp: desc.sdp ?? '' } : null;
      this._sldPending++;
      // Solta os candidatos guardados numa tarefa nova: quem chamou já recebeu a promessa
      // resolvida e mandou a descrição antes deles.
      const release = () =>
        setTimeout(() => {
          if (--this._sldPending > 0) return;
          const held = this._heldCandidates.splice(0);
          for (const candidate of held) this._fire('icecandidate', { candidate });
        });
      return this._op(() => invoke('rtc_set_local', { pc: this._id, desc: init })).then(
        (snap) => {
          this._settled(snap);
          release();
        },
        (err) => {
          release();
          throw err;
        },
      );
    }

    setRemoteDescription(desc) {
      if (!desc?.type) return Promise.reject(new TypeError('descrição sem tipo'));
      return this._op(() => invoke('rtc_set_remote', { pc: this._id, desc: { type: desc.type, sdp: desc.sdp ?? '' } })).then((snap) =>
        this._settled(snap),
      );
    }

    _settled(snap) {
      this._apply(snap);
      // Pedido de renegociação que chegou no meio de uma: sai agora que voltou ao estável.
      if (this.signalingState === 'stable' && this._negotiationPending) {
        this._negotiationPending = false;
        queueMicrotask(() => this._fire('negotiationneeded'));
      }
    }

    addIceCandidate(candidate) {
      const init = candidate ? (typeof candidate.toJSON === 'function' ? candidate.toJSON() : { ...candidate }) : null;
      return this._op(() => invoke('rtc_add_ice', { pc: this._id, candidate: init }));
    }

    restartIce() {
      void this._op(() => invoke('rtc_restart_ice', { pc: this._id })).catch(() => {});
    }

    getConfiguration() {
      return { ...this._config };
    }

    setConfiguration(config) {
      this._config = { ...this._config, ...config };
    }

    async getStats() {
      return new Map();
    }

    close() {
      if (this._closed) return;
      this._closed = true;
      this.signalingState = 'closed';
      this.connectionState = 'closed';
      this.iceConnectionState = 'closed';
      pcs.delete(this._id);
      for (const s of this._senders) s._setTrack(null);
      for (const r of this._receivers) {
        for (const [id, rr] of receivers) if (rr === r) receivers.delete(id);
        // Como no navegador: as trilhas param, sem evento.
        r.end(false);
      }
      this._receivers.clear();
      void this._ops.then(() => invoke('rtc_close', { pc: this._id })).catch(() => {});
    }
  }

  // O navegador expõe os construtores como globais com estes nomes.
  const define = (name, value) =>
    Object.defineProperty(window, name, { value, writable: true, configurable: true, enumerable: false });
  define('RTCPeerConnection', LineRTCPeerConnection);
  define('webkitRTCPeerConnection', LineRTCPeerConnection);
  define('RTCSessionDescription', LineRTCSessionDescription);
  define('RTCIceCandidate', LineRTCIceCandidate);
  define('RTCRtpSender', LineRTCRtpSender);
  define('RTCRtpTransceiver', LineRTCRtpTransceiver);
})();

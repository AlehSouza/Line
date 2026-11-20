/**
 * Sons do app (mensagens, voz, microfone, chamadas e transmissão), todos gerados na hora com Web Audio,
 * no mesmo estilo do som de mensagem direta: notas curtas e suaves, sem arquivos para baixar.
 */

export type Sfx =
  | 'dm'
  | 'message'
  | 'mention'
  | 'voiceJoin'
  | 'voiceLeave'
  | 'userMoved'
  | 'selfJoin'
  | 'selfLeave'
  | 'disconnect'
  | 'selfMute'
  | 'selfUnmute'
  | 'selfDeafen'
  | 'selfUndeafen'
  | 'userMuted'
  | 'userUnmuted'
  | 'userDeafened'
  | 'userUndeafened'
  | 'incomingCall'
  | 'outgoingCall'
  | 'callRinging'
  | 'callEnd'
  | 'streamStarted'
  | 'streamEnded'
  | 'streamJoin'
  | 'streamLeave';

/** Uma nota: frequência (Hz), início e duração (s), volume de pico e, opcional, a frequência final (deslize). */
interface Note {
  f: number;
  at: number;
  dur: number;
  vol?: number;
  to?: number;
  type?: OscillatorType;
}

const n = (f: number, at: number, dur = 0.3, vol = 0.14, extra: Partial<Note> = {}): Note => ({ f, at, dur, vol, ...extra });

const SOUNDS: Record<Sfx, Note[]> = {
  // Mensagens
  dm: [n(740, 0, 0.32, 0.16), n(1110, 0.08, 0.32, 0.16)],
  message: [n(880, 0, 0.26, 0.12), n(1320, 0, 0.18, 0.03)],
  mention: [n(988, 0, 0.18, 0.13), n(1319, 0.07, 0.18, 0.13), n(1760, 0.14, 0.34, 0.12)],

  // Canais de voz
  voiceJoin: [n(587, 0, 0.22, 0.12), n(880, 0.09, 0.3, 0.12)],
  voiceLeave: [n(880, 0, 0.22, 0.12), n(587, 0.09, 0.3, 0.12)],
  userMoved: [n(659, 0, 0.22, 0.12, { to: 988 }), n(1319, 0.16, 0.3, 0.1)],
  selfJoin: [n(523, 0, 0.2, 0.13), n(784, 0.08, 0.2, 0.13), n(1047, 0.16, 0.36, 0.13)],
  selfLeave: [n(1047, 0, 0.2, 0.13), n(784, 0.08, 0.2, 0.13), n(523, 0.16, 0.36, 0.13)],
  disconnect: [n(698, 0, 0.3, 0.14, { to: 349, type: 'triangle' }), n(262, 0.22, 0.4, 0.12, { type: 'triangle' })],

  // Microfone e fone (os meus mais marcados, os dos outros mais discretos)
  selfMute: [n(880, 0, 0.12, 0.13), n(587, 0.06, 0.2, 0.13)],
  selfUnmute: [n(587, 0, 0.12, 0.13), n(880, 0.06, 0.2, 0.13)],
  selfDeafen: [n(659, 0, 0.16, 0.13), n(440, 0.08, 0.16, 0.13), n(330, 0.16, 0.28, 0.12)],
  selfUndeafen: [n(330, 0, 0.16, 0.12), n(440, 0.08, 0.16, 0.13), n(659, 0.16, 0.28, 0.13)],
  userMuted: [n(740, 0, 0.18, 0.07, { to: 554 })],
  userUnmuted: [n(554, 0, 0.18, 0.07, { to: 740 })],
  userDeafened: [n(494, 0, 0.24, 0.08, { to: 370 })],
  userUndeafened: [n(370, 0, 0.24, 0.08, { to: 494 })],

  // Chamadas
  incomingCall: [
    n(659, 0, 0.22, 0.15),
    n(988, 0.14, 0.22, 0.15),
    n(1319, 0.28, 0.36, 0.14),
    n(659, 0.7, 0.22, 0.15),
    n(988, 0.84, 0.22, 0.15),
    n(1319, 0.98, 0.5, 0.14),
  ],
  outgoingCall: [n(440, 0, 0.16, 0.12), n(660, 0.08, 0.16, 0.12), n(880, 0.16, 0.3, 0.12)],
  callRinging: [n(587, 0, 0.9, 0.07), n(880, 0, 0.9, 0.04)],
  callEnd: [n(880, 0, 0.18, 0.13), n(660, 0.1, 0.18, 0.13), n(440, 0.2, 0.42, 0.13)],

  // Transmissão de tela
  streamStarted: [n(784, 0, 0.16, 0.11), n(988, 0.06, 0.16, 0.11), n(1175, 0.12, 0.16, 0.11), n(1568, 0.18, 0.4, 0.1)],
  streamEnded: [n(1568, 0, 0.16, 0.1), n(1175, 0.06, 0.16, 0.11), n(988, 0.12, 0.16, 0.11), n(784, 0.18, 0.4, 0.11)],
  streamJoin: [n(988, 0, 0.16, 0.1), n(1319, 0.07, 0.28, 0.1)],
  streamLeave: [n(1319, 0, 0.16, 0.1), n(988, 0.07, 0.28, 0.1)],
};

/** Sons que tocam em repetição (chamada chegando e chamando), com o intervalo entre uma volta e outra. */
const LOOP_MS: Partial<Record<Sfx, number>> = { incomingCall: 2600, callRinging: 2600 };
/** Uma chamada que ninguém atende para de tocar sozinha. */
const LOOP_MAX_MS = 30_000;

let ctx: AudioContext | null = null;
const last: Partial<Record<Sfx, number>> = {};

function context(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  ctx ??= new AudioContext();
  void ctx.resume();
  return ctx;
}

// O navegador só deixa tocar som depois que a pessoa mexe na página. Um som que chega sem ninguém ter
// clicado antes (como a ligação chegando) ficava mudo: o primeiro clique ou tecla já libera o áudio.
if (typeof window !== 'undefined') {
  const unlock = () => {
    if (context()?.state === 'running') {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    }
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
}

/** Toca um som uma vez. O mesmo som repetido em menos de 150 ms (ex.: duas pessoas saindo juntas) toca só uma vez. */
export function playSfx(kind: Sfx) {
  const now = Date.now();
  if (now - (last[kind] ?? 0) < 150) return;
  last[kind] = now;
  try {
    const c = context();
    if (!c) return;
    const t = c.currentTime + 0.01;
    for (const note of SOUNDS[kind]) {
      const o = c.createOscillator();
      const g = c.createGain();
      const start = t + note.at;
      const end = start + note.dur;
      o.type = note.type ?? 'sine';
      o.frequency.setValueAtTime(note.f, start);
      if (note.to) o.frequency.exponentialRampToValueAtTime(note.to, end);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(note.vol ?? 0.14, start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, end);
      o.connect(g).connect(c.destination);
      o.start(start);
      o.stop(end + 0.04);
    }
  } catch {
    /* sem áudio */
  }
}

let loop: { kind: Sfx; key: string; timer: ReturnType<typeof setInterval>; stop: ReturnType<typeof setTimeout> } | null = null;

/** Começa um som em repetição (chamada chegando ou chamando). `key` diz a que chamada ele pertence; `keep` diz se ainda deve tocar. */
export function startSfxLoop(kind: Sfx, key: string, keep: () => boolean = () => true) {
  if (loop?.kind === kind && loop.key === key) return;
  stopSfxLoop();
  playSfx(kind);
  // A cada volta confere se a chamada ainda está de pé: se quem ligou desligou, o toque para.
  const timer = setInterval(() => (keep() ? playSfx(kind) : stopSfxLoop(key)), LOOP_MS[kind] ?? 2600);
  const stop = setTimeout(stopSfxLoop, LOOP_MAX_MS);
  loop = { kind, key, timer, stop };
}

/** Para o som em repetição (de qualquer chamada, ou só da chamada `key`). */
export function stopSfxLoop(key?: string) {
  if (!loop || (key && loop.key !== key)) return;
  clearInterval(loop.timer);
  clearTimeout(loop.stop);
  loop = null;
}

/** Qual som em repetição está tocando agora (e de que chamada). */
export function sfxLoop() {
  return loop ? { kind: loop.kind, key: loop.key } : null;
}

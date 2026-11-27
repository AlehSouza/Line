'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  listAudioDevices,
  setAutoSensitivity,
  setEchoCancellation,
  setInputDevice,
  setInputMode,
  setInputProfile,
  setInputVolume,
  setNoiseModel,
  setNoiseSuppression,
  startMicTest,
  stopMicTest,
  setOutputDevice,
  setOutputVolume,
  setPttKey,
  pttIsGlobal,
  setSensitivityDb,
  useVoice,
  type InputProfile,
} from '@/lib/voice';
import type { NoiseModel } from '@/lib/noise';
import { cx, Icons, Select, Slider } from './ui';

const METER_BARS = 40;
/** Faixa do medidor e do limiar de sensibilidade, em dB. */
const DB_MIN = -80;

export const dbToPct = (db: number) => Math.min(1, Math.max(0, (db - DB_MIN) / -DB_MIN));

/** Nome legível de uma tecla (KeyboardEvent.code). */
export function keyLabel(code: string | null): string {
  if (!code) return 'Nenhuma';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  const names: Record<string, string> = {
    Space: 'Espaço',
    Backquote: '`',
    CapsLock: 'Caps Lock',
    Tab: 'Tab',
    ShiftLeft: 'Shift esquerdo',
    ShiftRight: 'Shift direito',
    ControlLeft: 'Ctrl esquerdo',
    ControlRight: 'Ctrl direito',
    AltLeft: 'Alt esquerdo',
    AltRight: 'Alt direito',
    MetaLeft: 'Windows',
    MetaRight: 'Windows',
  };
  return names[code] ?? code;
}

/** Configurações → Voz e vídeo. */
export function VoiceSettingsPage() {
  const v = useVoice();
  const [devices, setDevices] = useState<Awaited<ReturnType<typeof listAudioDevices>> | null>(null);
  useEffect(() => {
    const load = () => void listAudioDevices().then(setDevices).catch(() => setDevices({ inputs: [], outputs: [] }));
    load();
    navigator.mediaDevices?.addEventListener?.('devicechange', load);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', load);
  }, []);
  const custom = v.inputProfile === 'custom';

  return (
    <div className="space-y-8">
      <Block title="Voz">
        <div className="grid gap-4 sm:grid-cols-2">
          <Labeled label="Microfone">
            <Select
              value={v.inputId ?? ''}
              onChange={(id) => void setInputDevice(id || null)}
              options={[{ value: '', label: 'Padrão do sistema' }, ...(devices?.inputs ?? []).map((d) => ({ value: d.id, label: d.label }))]}
            />
          </Labeled>
          <Labeled label="Alto-falante">
            <Select
              value={v.outputId ?? ''}
              onChange={(id) => setOutputDevice(id || null)}
              options={[{ value: '', label: 'Padrão do sistema' }, ...(devices?.outputs ?? []).map((d) => ({ value: d.id, label: d.label }))]}
            />
          </Labeled>
          <Labeled label={`Volume do microfone · ${Math.round(v.inputVolume * 100)}%`}>
            <Slider value={Math.round(v.inputVolume * 100)} max={200} onChange={(n) => setInputVolume(n / 100)} label="Volume do microfone" className="!w-full" />
          </Labeled>
          <Labeled label={`Volume do alto-falante · ${Math.round(v.outputVolume * 100)}%`}>
            <Slider value={Math.round(v.outputVolume * 100)} max={200} onChange={(n) => setOutputVolume(n / 100)} label="Volume do alto-falante" className="!w-full" />
          </Labeled>
        </div>
        <MicTest />
      </Block>

      <Block title="Perfil de entrada">
        <div className="space-y-2">
          {(
            [
              ['voice', 'Isolamento de voz', 'Só a sua voz: tira ruído de fundo, eco e ajusta o volume sozinho.'],
              ['studio', 'Estúdio', 'Som puro, sem nenhum filtro. Bom para microfone bom ou música.'],
              ['custom', 'Personalizado', 'Você escolhe cada opção aqui embaixo.'],
            ] as [InputProfile, string, string][]
          ).map(([id, label, hint]) => (
            <button
              key={id}
              type="button"
              onClick={() => void setInputProfile(id)}
              className={cx('flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left', v.inputProfile === id ? 'border-accent bg-accent/10' : 'border-edge hover:bg-hover')}
            >
              <span className={cx('flex size-4 shrink-0 items-center justify-center rounded-full border-2', v.inputProfile === id ? 'border-accent' : 'border-muted')}>
                {v.inputProfile === id && <span className="size-2 rounded-full bg-accent" />}
              </span>
              <span>
                <span className="block text-sm font-semibold">{label}</span>
                <span className="block text-xs text-muted">{hint}</span>
              </span>
            </button>
          ))}
        </div>
      </Block>

      <Block title="Sensibilidade de entrada">
        <SensitivityBlock />
      </Block>

      <Block title="Processamento de voz">
        <Toggle
          on={v.echoCancellation}
          onChange={(on) => void setEchoCancellation(on)}
          label="Cancelamento de eco"
          hint="Evita que o som do seu alto-falante volte pelo microfone."
        />
        <Toggle
          on={v.noiseSuppression}
          onChange={(on) => void setNoiseSuppression(on)}
          label="Supressão de ruído"
          hint="Tira teclado, ventilador, rua e conversa de fundo da sua voz. Roda no seu computador, nada sai dele."
        />
        {v.noiseSuppression && (
          <Labeled label="Modelo do supressor">
            <Select
              value={v.noiseModel}
              onChange={(m) => void setNoiseModel(m as NoiseModel)}
              options={[
                { value: 'max', label: 'Máximo (DeepFilterNet 3)' },
                { value: 'balanced', label: 'Equilibrado (GTCRN)' },
                { value: 'light', label: 'Leve (RNNoise)' },
              ]}
            />
            <p className="mt-1.5 text-xs text-muted">{NOISE_MODEL_HINT[v.noiseModel]}</p>
          </Labeled>
        )}
        {!custom && <p className="text-xs text-muted">Mudar uma dessas opções troca o perfil para Personalizado.</p>}
      </Block>

      <Block title="Modo de entrada">
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              ['voice', 'Detecção de voz', 'O microfone abre quando você fala.'],
              ['ptt', 'Apertar para falar', 'O microfone só abre segurando uma tecla.'],
            ] as const
          ).map(([id, label, hint]) => (
            <button
              key={id}
              type="button"
              onClick={() => setInputMode(id)}
              className={cx('rounded-lg border px-3 py-2.5 text-left', v.inputMode === id ? 'border-accent bg-accent/10' : 'border-edge hover:bg-hover')}
            >
              <span className="block text-sm font-semibold">{label}</span>
              <span className="block text-xs text-muted">{hint}</span>
            </button>
          ))}
        </div>
        {v.inputMode === 'ptt' && <PttKeyRecorder code={v.pttKey} down={v.pttDown} />}
      </Block>
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xs font-bold tracking-wide text-muted uppercase">{title}</h2>
      {children}
    </section>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span className="mb-1.5 block text-sm font-semibold">{label}</span>
      {children}
    </div>
  );
}

function Toggle({ on, onChange, label, hint, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; hint: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="flex w-full items-center gap-3 rounded-lg border border-edge bg-rail px-3 py-2.5 text-left hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-rail"
    >
      <span className="flex-1">
        <span className="block text-sm font-semibold">{label}</span>
        <span className="block text-xs text-muted">{hint}</span>
      </span>
      <span className={cx('relative h-6 w-11 shrink-0 rounded-full transition-colors', on ? 'bg-accent' : 'bg-edge')}>
        <span className={cx('absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all', on ? 'left-[22px]' : 'left-0.5')} />
      </span>
    </button>
  );
}

const NOISE_MODEL_HINT: Record<NoiseModel, string> = {
  max: 'A limpeza mais forte: tira até barulhos difíceis, como conversa, cachorro e rua, e deixa a voz natural. Ideal para computador.',
  balanced: 'Limpa bem o ruído do dia a dia usando pouco do aparelho. Ideal para celular e notebook na bateria.',
  light: 'O mais leve: tira ruídos constantes, como ventilador e ar-condicionado. Bom para aparelhos mais simples.',
};

/** Nível do microfone (em dB) num teste à parte, com as mesmas opções da chamada. Nada vai para a chamada. */
function useMicLevel(active: boolean) {
  const inputId = useVoice((v) => v.inputId);
  const echo = useVoice((v) => v.echoCancellation);
  const noise = useVoice((v) => v.noiseSuppression);
  const gain = useVoice((v) => v.inputVolume);
  const [db, setDb] = useState(DB_MIN);
  useEffect(() => {
    if (!active) return;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let alive = true;
    navigator.mediaDevices
      .getUserMedia({ audio: { deviceId: inputId ? { exact: inputId } : undefined, echoCancellation: echo, noiseSuppression: noise } })
      .then((s) => {
        if (!alive) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(s).connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (const b of buf) {
            const x = (b - 128) / 128;
            sum += x * x;
          }
          const rms = Math.sqrt(sum / buf.length) * gain;
          setDb(rms > 0 ? Math.max(DB_MIN, 20 * Math.log10(rms)) : DB_MIN);
          raf = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch(() => setDb(DB_MIN));
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
      setDb(DB_MIN);
    };
  }, [active, inputId, echo, noise, gain]);
  return db;
}

/** Medidor de gominhos de 4px, colados (3px entre eles), quantos couberem na largura. */
export function Meter({ db, threshold }: { db: number; threshold?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [bars, setBars] = useState(METER_BARS);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => setBars(Math.max(8, Math.floor((el.clientWidth + 3) / 7)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const lit = Math.round(dbToPct(db) * bars);
  const cut = threshold === undefined ? -1 : Math.round(dbToPct(threshold) * bars);
  return (
    <div ref={ref} className="flex h-6 min-w-0 flex-1 items-center gap-[3px] overflow-hidden">
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className={cx('h-full w-1 shrink-0 rounded-full transition-colors', i < lit ? (cut >= 0 && i < cut ? 'bg-sun' : 'bg-online') : 'bg-edge')}
        />
      ))}
    </div>
  );
}

/** Teste com retorno: ouço o meu microfone já tratado (supressor, eco, volume), e as barras medem esse som. */
export function useMicLoopback(active: boolean) {
  const v = useVoice();
  const deps = [v.inputId, v.echoCancellation, v.noiseSuppression, v.noiseModel, v.inputProfile, v.autoSensitivity, v.inputVolume, v.outputId, v.outputVolume];
  const [db, setDb] = useState(DB_MIN);
  const [failed, setFailed] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    if (!active) return;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let alive = true;
    setFailed(null);
    setOpening(true);
    // Começa no próximo ciclo: se o efeito for desfeito na hora (modo estrito do React), nem abre.
    const timer = setTimeout(() => {
      startMicTest()
        .then((s) => {
          if (!alive) return;
          setOpening(false);
          ctx = new AudioContext();
          if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          ctx.createMediaStreamSource(s).connect(analyser);
          const buf = new Float32Array(analyser.fftSize);
          const tick = () => {
            analyser.getFloatTimeDomainData(buf);
            let sum = 0;
            for (const x of buf) sum += x * x;
            const rms = Math.sqrt(sum / buf.length);
            setDb(rms > 0 ? Math.max(DB_MIN, 20 * Math.log10(rms)) : DB_MIN);
            raf = requestAnimationFrame(tick);
          };
          tick();
        })
        .catch((err) => {
          if (!alive) return;
          console.warn('Teste do microfone falhou', err);
          setOpening(false);
          setFailed(`${(err as Error)?.name ?? 'Erro'}: ${(err as Error)?.message ?? String(err)}`);
          setDb(DB_MIN);
        });
    }, 0);
    return () => {
      alive = false;
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      void ctx?.close();
      stopMicTest();
      setOpening(false);
      setDb(DB_MIN);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ...deps]);
  return { db, failed, opening };
}

function MicTest() {
  const [testing, setTesting] = useState(false);
  const { db, failed, opening } = useMicLoopback(testing);
  const inCall = useVoice((v) => !!v.channelId);
  return (
    <div className="rounded-lg border border-edge bg-rail p-3">
      <p className="mb-2 text-sm font-semibold">Teste do microfone</p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setTesting((t) => !t)}
          className={cx('shrink-0 rounded-lg px-4 py-1.5 text-sm font-semibold', testing ? 'bg-accent text-on-accent' : 'bg-raise hover:bg-hover')}
        >
          {testing ? 'Parar' : 'Testar'}
        </button>
        <Meter db={db} />
      </div>
      <p className="mt-2 text-xs text-muted">
        {failed
          ? `Não foi possível abrir o microfone (${failed}).`
          : testing && opening
            ? 'Abrindo o microfone e o supressor…'
            : 'Fale algo: você ouve a sua voz como os outros ouvem, já com o supressor escolhido. Use fone para não dar microfonia.'}
        {inCall && !failed && ' Durante o teste você fica mutado e sem som na chamada; ao parar, volta como estava.'}
      </p>
    </div>
  );
}

/**
 * Sensibilidade no estilo de uma barra só: o nível da voz aparece ao vivo por trás e, no modo manual,
 * a bolinha marca o limiar. Abaixo dele (amarelo) o microfone fica fechado; acima (verde) os outros ouvem.
 */
function SensitivityBlock() {
  const auto = useVoice((v) => v.autoSensitivity);
  const profile = useVoice((v) => v.inputProfile);
  const threshold = useVoice((v) => v.sensitivityDb);
  const locked = profile === 'voice';
  const manual = !auto && !locked;
  const db = useMicLevel(true);
  const level = dbToPct(db) * 100;
  const cut = manual ? dbToPct(threshold) * 100 : 0;
  return (
    <div className="space-y-3 rounded-lg border border-edge bg-rail px-3 py-3">
      <button
        type="button"
        role="switch"
        aria-checked={auto}
        disabled={locked}
        onClick={() => void setAutoSensitivity(!auto)}
        className="flex w-full items-center gap-3 text-left disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="flex-1">
          <span className="block text-sm font-semibold">Ajustar automaticamente a sensibilidade de entrada</span>
          <span className="block text-xs text-muted">
            {locked ? 'No Isolamento de voz o Line ajusta sozinho. Escolha Personalizado para mexer aqui.' : 'Controla quanto som o Line transmite do seu microfone.'}
          </span>
        </span>
        <span className={cx('relative h-6 w-11 shrink-0 rounded-full transition-colors', auto ? 'bg-accent' : 'bg-edge')}>
          <span className={cx('absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all', auto ? 'left-[22px]' : 'left-0.5')} />
        </span>
      </button>
      <div className="relative flex h-6 items-center">
        {/* Trilho: amarelo até o limiar, verde depois (apagados) */}
        <div className="absolute inset-x-0 h-1.5 overflow-hidden rounded-full">
          <div className="absolute inset-y-0 left-0 bg-sun/30" style={{ width: `${cut}%` }} />
          <div className="absolute inset-y-0 right-0 bg-online/30" style={{ left: `${cut}%` }} />
          {/* Nível ao vivo por cima, nas mesmas cores */}
          <div
            className="absolute inset-0 transition-[clip-path] duration-75"
            style={{
              background: `linear-gradient(to right, var(--color-sun) 0 ${cut}%, var(--color-online) ${cut}% 100%)`,
              clipPath: `inset(0 ${100 - level}% 0 0)`,
            }}
          />
        </div>
        {manual && (
          <>
            <span
              className="pointer-events-none absolute size-4 -translate-x-1/2 rounded-full bg-white shadow"
              style={{ left: `${cut}%` }}
              aria-hidden
            />
            <input
              type="range"
              min={DB_MIN}
              max={0}
              step={1}
              value={threshold}
              onChange={(e) => setSensitivityDb(Number(e.target.value))}
              aria-label="Limiar de sensibilidade"
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </>
        )}
      </div>
      {manual && <p className="text-xs text-muted">Limiar: {threshold} dB. Abaixo da bolinha (amarelo) o microfone fica fechado; acima (verde) os outros te ouvem.</p>}
    </div>
  );
}

function PttKeyRecorder({ code, down }: { code: string | null; down: boolean }) {
  const [recording, setRecording] = useState(false);
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') return setRecording(false);
      setPttKey(e.code);
      setRecording(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording]);
  return (
    <div className="space-y-2 rounded-lg border border-edge bg-rail p-3">
      <p className="text-sm font-semibold">Atalho</p>
      <div className="flex items-center gap-2">
        <span
          className={cx(
            'flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border px-3 text-sm',
            recording ? 'border-accent text-fg' : 'border-edge',
            down && !recording && 'border-online',
          )}
        >
          <Icons.Mic size={15} className={down ? 'text-online' : 'text-muted'} />
          {recording ? 'Aperte uma tecla… (Esc cancela)' : <b>{keyLabel(code)}</b>}
        </span>
        <button
          type="button"
          onClick={() => setRecording((r) => !r)}
          className={cx('h-10 shrink-0 rounded-lg px-4 text-sm font-semibold', recording ? 'bg-danger text-white' : 'bg-accent text-on-accent hover:opacity-90')}
        >
          {recording ? 'Cancelar' : code ? 'Trocar tecla' : 'Gravar tecla'}
        </button>
      </div>
      <p className="text-xs text-muted">
        {code ? 'Segure a tecla para falar; a bolinha fica verde enquanto o microfone está aberto. ' : 'Escolha uma tecla para poder falar. '}
        {pttIsGlobal() ? 'Funciona mesmo com o Line em segundo plano, dentro de jogos e outros apps.' : 'Aqui funciona com a janela do Line em foco; no app para Windows vale em qualquer lugar.'}
      </p>
    </div>
  );
}

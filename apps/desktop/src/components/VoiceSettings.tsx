'use client';

import { useEffect, useState, type ReactNode } from 'react';
import {
  listAudioDevices,
  setAutoSensitivity,
  setEchoCancellation,
  setInputDevice,
  setInputMode,
  setInputProfile,
  setInputVolume,
  setNoiseSuppression,
  setOutputDevice,
  setOutputVolume,
  setPttKey,
  setSensitivityDb,
  useVoice,
  type InputProfile,
} from '@/lib/voice';
import { cx, Icons, Select, Slider } from './ui';

const METER_BARS = 40;
/** Faixa do medidor e do limiar de sensibilidade, em dB. */
const DB_MIN = -80;

const dbToPct = (db: number) => Math.min(1, Math.max(0, (db - DB_MIN) / -DB_MIN));

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
        <Toggle
          on={v.autoSensitivity}
          onChange={(on) => void setAutoSensitivity(on)}
          label="Determinar automaticamente"
          hint="O Line decide quando você está falando. Desligue para escolher o limiar na mão."
          disabled={v.inputProfile === 'voice'}
        />
        {!v.autoSensitivity && v.inputProfile !== 'voice' && <SensitivitySlider />}
      </Block>

      <Block title="Processamento de voz">
        <Toggle
          on={v.noiseSuppression}
          onChange={(on) => void setNoiseSuppression(on)}
          label="Supressão de ruído"
          hint="Tira teclado, ventilador e barulho de fundo da sua voz. Roda no seu computador."
        />
        <Toggle
          on={v.echoCancellation}
          onChange={(on) => void setEchoCancellation(on)}
          label="Cancelamento de eco"
          hint="Evita que o som do seu alto-falante volte pelo microfone."
        />
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

function Meter({ db, threshold }: { db: number; threshold?: number }) {
  const lit = Math.round(dbToPct(db) * METER_BARS);
  const cut = threshold === undefined ? -1 : Math.round(dbToPct(threshold) * METER_BARS);
  return (
    <div className="flex h-6 flex-1 items-center gap-[3px]">
      {Array.from({ length: METER_BARS }, (_, i) => (
        <span
          key={i}
          className={cx('h-full flex-1 rounded-full transition-colors', i < lit ? (cut >= 0 && i < cut ? 'bg-sun' : 'bg-online') : 'bg-edge')}
        />
      ))}
    </div>
  );
}

function MicTest() {
  const [testing, setTesting] = useState(false);
  const db = useMicLevel(testing);
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
      <p className="mt-2 text-xs text-muted">Fale algo: as barras mostram o nível que chega. Nada é enviado para a chamada.</p>
    </div>
  );
}

function SensitivitySlider() {
  const threshold = useVoice((v) => v.sensitivityDb);
  const db = useMicLevel(true);
  return (
    <div className="space-y-2 rounded-lg border border-edge bg-rail p-3">
      <div className="flex items-center justify-between text-sm">
        <span className="font-semibold">Limiar</span>
        <span className="text-muted">{threshold} dB</span>
      </div>
      <Meter db={db} threshold={threshold} />
      <Slider value={threshold} min={DB_MIN} max={0} onChange={setSensitivityDb} label="Limiar de sensibilidade" className="!w-full" />
      <p className="text-xs text-muted">Abaixo da linha (amarelo) o microfone fica fechado; acima (verde) os outros te ouvem.</p>
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
        Por enquanto funciona com a janela do Line em foco.
      </p>
    </div>
  );
}

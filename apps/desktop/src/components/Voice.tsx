'use client';

import type { Channel, PublicUser, VoiceState } from '@line/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { actions, dmTitle, useLine } from '@/lib/store';
import {
  clearVoiceError,
  type Fps,
  joinVoice,
  leaveVoice,
  listAudioDevices,
  participants,
  type Resolution,
  RESOLUTIONS,
  setInputDevice,
  setNoiseSuppression,
  setOutputDevice,
  setScreenQuality,
  startCamera,
  toggleCamera,
  toggleDeafen,
  toggleMute,
  toggleScreen,
  useVoice,
} from '@/lib/voice';
import { Avatar, Button, cx, Icons, Modal } from './ui';

// ---------- vídeo ----------

function Video({ stream, mirror, contain }: { stream: MediaStream; mirror?: boolean; contain?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className={cx('h-full w-full bg-black', contain ? 'object-contain' : 'object-cover', mirror && '-scale-x-100')}
    />
  );
}

interface Tile {
  key: string;
  kind: 'person' | 'screen';
  state: VoiceState;
  user: PublicUser | undefined;
  stream: MediaStream | null;
  isMe: boolean;
}

function useTiles(channelId: string) {
  const states = useVoice((v) => v.states);
  const streams = useVoice((v) => v.streams);
  const camera = useVoice((v) => v.camera);
  const screen = useVoice((v) => v.screen);
  const users = useLine((s) => s.users);
  const meId = useLine((s) => s.me?.id);

  return useMemo(() => {
    const list = participants(states, channelId);
    const tiles: Tile[] = [];
    for (const p of list) {
      const isMe = p.userId === meId;
      const scr = isMe ? screen : p.screenStreamId ? (streams[p.screenStreamId] ?? null) : null;
      if (p.screenStreamId && scr) {
        tiles.push({ key: `screen:${p.userId}`, kind: 'screen', state: p, user: users[p.userId], stream: scr, isMe });
      }
    }
    for (const p of list) {
      const isMe = p.userId === meId;
      const cam = isMe ? camera : p.cameraStreamId ? (streams[p.cameraStreamId] ?? null) : null;
      tiles.push({ key: `person:${p.userId}`, kind: 'person', state: p, user: users[p.userId], stream: p.cameraStreamId ? cam : null, isMe });
    }
    return { tiles, count: list.length };
  }, [states, streams, camera, screen, users, meId, channelId]);
}

function TileView({ tile, big, onClick }: { tile: Tile; big?: boolean; onClick?: () => void }) {
  const speaking = useVoice((v) => !!v.speaking[tile.state.userId]);
  const name = tile.user?.displayName ?? 'Alguém';
  return (
    <button
      onClick={onClick}
      className={cx(
        'group relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl bg-raise transition-shadow',
        tile.kind === 'person' && speaking && 'ring-[3px] ring-accent',
        big && 'aspect-auto h-full',
      )}
    >
      {tile.stream ? (
        <Video stream={tile.stream} mirror={tile.isMe && tile.kind === 'person'} contain={tile.kind === 'screen'} />
      ) : (
        <Avatar name={name} color={tile.user?.avatarColor ?? '#3a3a42'} size={big ? 112 : 72} />
      )}
      <span className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-0.5 text-sm font-medium">
        {tile.kind === 'screen' && <Icons.Screen size={14} />}
        {tile.kind === 'screen' ? `Tela de ${name}` : name}
        {tile.kind === 'person' && tile.state.deafened ? (
          <Icons.HeadphonesOff size={14} className="text-danger" />
        ) : tile.kind === 'person' && tile.state.muted ? (
          <Icons.MicOff size={14} className="text-danger" />
        ) : null}
      </span>
      {onClick && (
        <span className="absolute top-2 right-2 hidden rounded-md bg-black/60 p-1 group-hover:block">
          <Icons.Expand size={14} />
        </span>
      )}
    </button>
  );
}

// ---------- palco da chamada ----------

/** Área principal de um canal de voz (ou o topo de uma DM em chamada). */
const GAP = 12;

/** Quadros 16:9 centralizados e do maior tamanho que cabe no espaço, sem barra de rolagem. */
function TileGrid({ tiles, onFocus }: { tiles: Tile[]; onFocus: (key: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Testa cada número de colunas e fica com o que deixa os quadros maiores.
  const n = Math.max(1, tiles.length);
  let width = 0;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const byW = (box.w - GAP * (cols - 1)) / cols;
    const byH = ((box.h - GAP * (rows - 1)) / rows) * (16 / 9);
    width = Math.max(width, Math.min(byW, byH));
  }
  width = Math.floor(Math.min(width, 960));

  return (
    <div ref={ref} className="flex min-h-0 flex-1 flex-wrap content-center items-center justify-center overflow-hidden" style={{ gap: GAP }}>
      {width > 0 &&
        tiles.map((t) => (
          <div key={t.key} style={{ width }}>
            <TileView tile={t} onClick={() => onFocus(t.key)} />
          </div>
        ))}
    </div>
  );
}

export function VoiceStage({ channel, compact }: { channel: Channel; compact?: boolean }) {
  const inCall = useVoice((v) => v.channelId === channel.id);
  const connecting = useVoice((v) => v.connecting && v.channelId === channel.id);
  const error = useVoice((v) => v.error);
  const { tiles, count } = useTiles(channel.id);
  const [focus, setFocus] = useState<string | null>(null);
  const meId = useLine((s) => s.me?.id);
  const users = useLine((s) => s.users);
  const title = channel.serverId ? channel.name : dmTitle(channel, meId, users);

  // Foca automaticamente numa tela compartilhada nova.
  const firstScreen = tiles.find((t) => t.kind === 'screen')?.key ?? null;
  useEffect(() => {
    if (firstScreen) setFocus((f) => f ?? firstScreen);
  }, [firstScreen]);
  const focused = tiles.find((t) => t.key === focus);
  const others = focused ? tiles.filter((t) => t !== focused) : tiles;

  // Canal vazio: tela de espera colorida, com o convite para entrar no centro.
  if (count === 0 && !inCall) {
    return (
      <div
        className={cx('relative flex flex-col overflow-hidden', compact ? 'h-[45%] min-h-64 border-b border-edge' : 'min-h-0 flex-1')}
        style={{
          background:
            'radial-gradient(120% 80% at 50% 110%, color-mix(in srgb, var(--color-accent) 70%, transparent) 0%, color-mix(in srgb, var(--color-accent) 25%, transparent) 45%, transparent 75%), linear-gradient(to bottom, var(--color-rail), color-mix(in srgb, var(--color-accent) 18%, var(--color-rail)))',
        }}
      >
        {!compact && (
          <header className="flex h-12 shrink-0 items-center gap-2 px-4">
            <Icons.Speaker size={20} className="text-soft" />
            <h1 className="font-bold">{title}</h1>
          </header>
        )}
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <h2 className="text-3xl font-bold text-white drop-shadow">{title}</h2>
          <p className="text-soft">Ninguém está em voz no momento.</p>
          <button
            disabled={connecting}
            onClick={() => joinVoice(channel.id)}
            className="mt-4 rounded-full bg-white px-6 py-2.5 text-sm font-semibold text-[#141418] shadow-lg transition hover:scale-[1.03] hover:bg-white/90 disabled:opacity-60"
          >
            {connecting ? 'Conectando…' : 'Entrar na chamada de voz'}
          </button>
          {error && (
            <p className="mt-3 flex items-center gap-2 rounded-lg bg-danger/15 px-3 py-1.5 text-sm text-danger">
              {error}
              <button onClick={clearVoiceError} className="hover:text-fg">
                <Icons.X size={14} />
              </button>
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={cx('flex flex-col bg-rail', compact ? 'h-[45%] min-h-64 border-b border-edge' : 'min-h-0 flex-1')}>
      {!compact && (
        <header className="flex h-12 shrink-0 items-center gap-2 px-4">
          <Icons.Speaker size={20} className="text-muted" />
          <h1 className="font-bold">{title}</h1>
        </header>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {count === 0 && !inCall ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-raise text-accent">
              <Icons.Speaker size={40} />
            </div>
            <h2 className="text-2xl font-bold">{title}</h2>
            <p className="text-muted">Ninguém por aqui ainda. Entre e chame a galera.</p>
          </div>
        ) : focused ? (
          <>
            <div className="min-h-0 flex-1">
              <TileView tile={focused} big onClick={() => setFocus(null)} />
            </div>
            {others.length > 0 && (
              <div className="flex h-28 shrink-0 gap-3 overflow-x-auto">
                {others.map((t) => (
                  <div key={t.key} className="h-full shrink-0" style={{ aspectRatio: '16 / 9' }}>
                    <TileView tile={t} onClick={() => setFocus(t.key)} />
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <TileGrid tiles={others} onFocus={setFocus} />
        )}

        {error && (
          <p className="mx-auto flex items-center gap-2 rounded-lg bg-danger/15 px-3 py-1.5 text-sm text-danger">
            {error}
            <button onClick={clearVoiceError} className="hover:text-fg">
              <Icons.X size={14} />
            </button>
          </p>
        )}

        <div className="flex shrink-0 justify-center">
          {inCall ? (
            <VoiceControls large />
          ) : (
            <Button disabled={connecting} onClick={() => joinVoice(channel.id)} className="px-6 py-2.5">
              <Icons.Phone size={18} />
              {connecting ? 'Conectando…' : count > 0 ? 'Entrar na chamada' : 'Entrar no canal de voz'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- controles ----------

export function VoiceControls({ large }: { large?: boolean }) {
  const muted = useVoice((v) => v.muted);
  const deafened = useVoice((v) => v.deafened);
  const camera = useVoice((v) => !!v.camera);
  const screen = useVoice((v) => !!v.screen);
  const [picker, setPicker] = useState(false);
  const [camPicker, setCamPicker] = useState(false);

  const shareScreen = () => (screen ? void toggleScreen() : setPicker(true));

  const size = large ? 22 : 18;
  const btn = (active: boolean, danger = false) =>
    cx(
      'flex items-center justify-center rounded-full transition-colors',
      large ? 'h-12 w-12' : 'h-8 w-8 rounded-md',
      danger ? 'bg-danger text-white hover:brightness-110' : active ? 'bg-fg text-rail' : large ? 'bg-raise text-fg hover:bg-hover' : 'text-soft hover:bg-hover hover:text-fg',
    );

  return (
    <div className={cx('flex items-center', large ? 'gap-3 rounded-2xl bg-side/80 p-2' : 'gap-1')}>
      <button title={muted ? 'Ativar microfone' : 'Silenciar microfone'} onClick={toggleMute} className={btn(false, muted && large)}>
        {muted ? <Icons.MicOff size={size} className={large ? '' : 'text-danger'} /> : <Icons.Mic size={size} />}
      </button>
      <button title={deafened ? 'Voltar a ouvir' : 'Ensurdecer'} onClick={toggleDeafen} className={btn(false, deafened && large)}>
        {deafened ? <Icons.HeadphonesOff size={size} className={large ? '' : 'text-danger'} /> : <Icons.Headphones size={size} />}
      </button>
      <button title={camera ? 'Desligar câmera' : 'Ligar câmera'} onClick={() => (camera ? void toggleCamera() : setCamPicker(true))} className={btn(camera)}>
        {camera ? <Icons.Video size={size} /> : <Icons.VideoOff size={size} />}
      </button>
      <button title={screen ? 'Parar de compartilhar' : 'Compartilhar tela'} onClick={shareScreen} className={btn(screen)}>
        <Icons.Screen size={size} />
      </button>
      <button title="Sair da chamada" onClick={() => leaveVoice()} className={btn(false, true)}>
        <Icons.PhoneOff size={size} />
      </button>
      {camPicker && <CameraModal onClose={() => setCamPicker(false)} />}
      {picker && <ScreenShareModal onClose={() => setPicker(false)} />}
    </div>
  );
}

// ---------- transmitir tela: qualidade ----------

/** Escolhe resolução e fps antes de abrir o seletor de tela do sistema. */
const CAMERA_KEY = 'line.cameraId';

/** Escolher a câmera com prévia ao vivo antes de entrar na chamada. Fechar sem confirmar solta a câmera. */
export function CameraModal({ onClose }: { onClose: () => void }) {
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>(() => {
    try {
      return localStorage.getItem(CAMERA_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState('');
  const handed = useRef(false);
  const current = useRef<MediaStream | null>(null);

  useEffect(() => {
    let alive = true;
    setError('');
    navigator.mediaDevices
      .getUserMedia({
        video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false,
      })
      .then(async (s) => {
        if (!alive) return s.getTracks().forEach((t) => t.stop());
        current.current?.getTracks().forEach((t) => t.stop());
        current.current = s;
        setStream(s);
        // Os nomes das câmeras só aparecem depois da permissão.
        const all = await navigator.mediaDevices.enumerateDevices();
        if (alive) setCameras(all.filter((d) => d.kind === 'videoinput'));
      })
      .catch((err) => {
        if (!alive) return;
        if (deviceId) setDeviceId('');
        else setError((err as Error).name === 'NotAllowedError' ? 'Sem permissão para usar a câmera.' : 'Nenhuma câmera encontrada.');
      });
    return () => {
      alive = false;
    };
  }, [deviceId]);

  // Fechou sem confirmar: solta a câmera.
  useEffect(
    () => () => {
      if (!handed.current) current.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const activeId = stream?.getVideoTracks()[0]?.getSettings().deviceId ?? deviceId;
  const confirm = () => {
    if (!stream) return;
    handed.current = true;
    try {
      localStorage.setItem(CAMERA_KEY, activeId);
    } catch {}
    startCamera(stream);
    onClose();
  };

  return (
    <Modal
      title="Transmitir câmera"
      subtitle="Confira como você vai aparecer antes de entrar."
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={confirm} disabled={!stream}>
            <Icons.Video size={16} /> Ligar câmera
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-black">
          {stream ? <Video stream={stream} mirror /> : <p className="text-sm text-muted">{error || 'Abrindo a câmera…'}</p>}
        </div>
        {cameras.length > 0 && (
          <label className="block">
            <span className="mb-1.5 block text-xs font-bold tracking-wide text-muted uppercase">Câmera</span>
            <select
              value={activeId}
              onChange={(e) => setDeviceId(e.target.value)}
              className="w-full rounded-lg border border-edge bg-rail px-3 py-2 text-sm text-fg outline-none focus:border-accent"
            >
              {cameras.map((c, i) => (
                <option key={c.deviceId || i} value={c.deviceId}>
                  {c.label || `Câmera ${i + 1}`}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </Modal>
  );
}

export function ScreenShareModal({ onClose }: { onClose: () => void }) {
  const quality = useVoice((v) => v.screenQuality);
  const [resolution, setResolution] = useState<Resolution>(quality.resolution);
  const [fps, setFps] = useState<Fps>(quality.fps);
  const start = () => {
    setScreenQuality({ resolution, fps });
    onClose();
    void toggleScreen();
  };
  const choice = (active: boolean) =>
    cx(
      'flex-1 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors',
      active ? 'border-accent bg-accent/15 text-fg' : 'border-edge text-soft hover:bg-hover hover:text-fg',
    );

  return (
    <Modal
      title="Transmitir tela"
      subtitle="Escolha a qualidade. Depois o Windows pergunta qual tela ou janela mostrar (e se o áudio vai junto)."
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={start}>
            <Icons.Screen size={16} /> Ao vivo
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-xs font-bold tracking-wide text-muted uppercase">Resolução</p>
          <div className="flex gap-2">
            {(Object.keys(RESOLUTIONS) as Resolution[]).map((r) => (
              <button key={r} onClick={() => setResolution(r)} className={choice(resolution === r)}>
                {RESOLUTIONS[r].label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-2 text-xs font-bold tracking-wide text-muted uppercase">Taxa de quadros</p>
          <div className="flex gap-2">
            {([30, 60] as Fps[]).map((f) => (
              <button key={f} onClick={() => setFps(f)} className={choice(fps === f)}>
                {f} fps
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-muted">
          Até {(RESOLUTIONS[resolution].kbps[fps] / 1000).toLocaleString('pt-BR')} Mbps para cada pessoa na chamada.
          {resolution === '2160' && ' Em 4K, sua internet de upload e a placa de vídeo precisam aguentar; com muita gente na call, prefira 1440p.'}
        </p>
      </div>
    </Modal>
  );
}

// ---------- configurações de voz ----------

export function VoiceSettingsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Voz e áudio" onClose={onClose} width={480}>
      <VoiceSettingsPanel />
    </Modal>
  );
}

/** Microfone, saída de áudio e supressão de ruído. */
export function VoiceSettingsPanel() {
  const inputId = useVoice((v) => v.inputId);
  const outputId = useVoice((v) => v.outputId);
  const noise = useVoice((v) => v.noiseSuppression);
  const [devices, setDevices] = useState<Awaited<ReturnType<typeof listAudioDevices>> | null>(null);
  useEffect(() => {
    listAudioDevices().then(setDevices).catch(() => setDevices({ inputs: [], outputs: [] }));
  }, []);
  const select = 'w-full rounded-lg border border-edge bg-rail px-3 py-2 text-sm text-fg outline-none focus:border-accent';

  return (
    <div className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-bold tracking-wide text-muted uppercase">Microfone</span>
          <select className={select} value={inputId ?? ''} onChange={(e) => void setInputDevice(e.target.value || null)}>
            <option value="">Padrão do sistema</option>
            {devices?.inputs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-bold tracking-wide text-muted uppercase">Saída de áudio</span>
          <select className={select} value={outputId ?? ''} onChange={(e) => setOutputDevice(e.target.value || null)}>
            <option value="">Padrão do sistema</option>
            {devices?.outputs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <NoiseToggle on={noise} />
    </div>
  );
}

function NoiseToggle({ on }: { on: boolean }) {
  return (
    <button
      onClick={() => void setNoiseSuppression(!on)}
      className="flex w-full items-center gap-3 rounded-lg border border-edge bg-rail px-3 py-2.5 text-left hover:bg-hover"
    >
      <Icons.Waves size={20} className={on ? 'text-accent' : 'text-muted'} />
      <span className="flex-1">
        <span className="block text-sm font-semibold">Supressor de ruído</span>
        <span className="block text-xs text-muted">Tira teclado, ventilador e barulho de fundo da sua voz.</span>
      </span>
      <span className={cx('relative h-5 w-9 rounded-full transition-colors', on ? 'bg-accent' : 'bg-edge')}>
        <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all', on ? 'left-[18px]' : 'left-0.5')} />
      </span>
    </button>
  );
}

const METER_BARS = 24;

/** Popover da supressão de ruído: liga/desliga, explicação e teste do microfone com medidor ao vivo. */
function NoisePopover({ onClose }: { onClose: () => void }) {
  const on = useVoice((v) => v.noiseSuppression);
  const inputId = useVoice((v) => v.inputId);
  const ref = useRef<HTMLDivElement>(null);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Teste: abre o microfone à parte e mede o volume, sem mandar nada para a chamada.
  useEffect(() => {
    if (!testing) return;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let alive = true;
    navigator.mediaDevices
      .getUserMedia({ audio: { deviceId: inputId ? { exact: inputId } : undefined, noiseSuppression: on, echoCancellation: true } })
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
          let peak = 0;
          for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
          setLevel(Math.min(1, peak / 64));
          raf = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch(() => setTesting(false));
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
      setLevel(0);
    };
  }, [testing, inputId, on]);

  const lit = Math.round(level * METER_BARS);
  return (
    <div ref={ref} className="absolute bottom-full right-0 z-40 mb-2 w-72 space-y-3 rounded-xl border border-edge bg-rail p-4 shadow-2xl">
      <div className="flex items-center justify-between">
        <span className="font-bold">Supressão de ruído</span>
        <button
          role="switch"
          aria-checked={on}
          onClick={() => void setNoiseSuppression(!on)}
          className={cx('relative h-6 w-11 rounded-full transition-colors', on ? 'bg-accent' : 'bg-edge')}
        >
          <span className={cx('absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all', on ? 'left-[22px]' : 'left-0.5')} />
        </button>
      </div>
      <p className="text-sm text-soft">
        Tira teclado, ventilador e outros barulhos de fundo da sua voz. Tente bater palmas enquanto fala: a galera só vai ouvir você.
      </p>
      <div>
        <p className="mb-2 font-semibold">Teste do microfone</p>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setTesting((v) => !v)}
            className={cx('shrink-0 rounded-lg px-3 py-1.5 text-sm font-semibold', testing ? 'bg-accent text-white' : 'bg-raise hover:bg-hover')}
          >
            {testing ? 'Parar' : 'Testar'}
          </button>
          <div className="flex h-6 flex-1 items-center gap-[3px]">
            {Array.from({ length: METER_BARS }, (_, i) => (
              <span key={i} className={cx('h-full flex-1 rounded-full transition-colors', i < lit ? 'bg-online' : 'bg-edge')} />
            ))}
          </div>
        </div>
      </div>
      <div className="border-t border-edge pt-3">
        <p className="text-xs text-muted">Fornecido por</p>
        <p className="text-sm font-semibold">RNNoise</p>
        <p className="text-xs text-muted">Rede neural de código aberto que roda no seu próprio computador. Sua voz não sai daqui para ser filtrada.</p>
      </div>
    </div>
  );
}

// ---------- barra "voz conectada" na lateral ----------

export function VoiceBar() {
  const channelId = useVoice((v) => v.channelId);
  const connecting = useVoice((v) => v.connecting);
  const noise = useVoice((v) => v.noiseSuppression);
  const camera = useVoice((v) => !!v.camera);
  const screen = useVoice((v) => !!v.screen);
  const quality = useVoice((v) => v.screenQuality);
  const channel = useLine((s) => (channelId ? s.channels[channelId] : undefined));
  const server = useLine((s) => (channel?.serverId ? s.servers[channel.serverId] : undefined));
  const meId = useLine((s) => s.me?.id);
  const users = useLine((s) => s.users);
  const [modal, setModal] = useState<'screen' | 'settings' | 'camera' | null>(null);
  const [noiseOpen, setNoiseOpen] = useState(false);
  if (!channelId) return null;

  const label = channel ? (channel.serverId ? `${channel.name} / ${server?.name ?? ''}` : dmTitle(channel, meId, users)) : '';
  const go = () => {
    if (!channel) return;
    if (channel.serverId) actions.goServer(channel.serverId, channel.id);
    else actions.goHome(channel.id);
  };
  const tile = (active: boolean) =>
    cx(
      'flex h-9 items-center justify-center gap-1.5 rounded-lg border text-xs font-semibold transition-colors',
      active ? 'border-accent/60 bg-accent/20 text-fg' : 'border-edge bg-raise text-soft hover:bg-hover hover:text-fg',
    );

  return (
    <div className="space-y-2.5 border-b border-edge p-2.5">
      <div className="flex items-center gap-1">
        <button onClick={go} className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-hover">
          <Icons.Signal size={20} className={connecting ? 'text-sun' : 'text-online'} />
          <span className="min-w-0">
            <span className={cx('block truncate text-[13px] font-bold', connecting ? 'text-sun' : 'text-online')}>
              {connecting ? 'Conectando…' : 'Voz conectada'}
            </span>
            <span className="block truncate text-xs text-muted">{label}</span>
          </span>
        </button>
        <span className="relative">
          <button
            title="Supressão de ruído"
            onClick={() => setNoiseOpen((v) => !v)}
            className={cx('rounded-md p-1.5 hover:bg-hover', noise ? 'text-accent' : 'text-muted hover:text-fg', noiseOpen && 'bg-hover')}
          >
            <Icons.Waves size={18} />
          </button>
          {noiseOpen && <NoisePopover onClose={() => setNoiseOpen(false)} />}
        </span>
        <button title="Sair da chamada" onClick={() => leaveVoice()} className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-danger">
          <Icons.PhoneOff size={18} />
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <button title={camera ? 'Desligar câmera' : 'Ligar câmera'} onClick={() => (camera ? void toggleCamera() : setModal('camera'))} className={tile(camera)}>
          {camera ? <Icons.Video size={16} /> : <Icons.VideoOff size={16} />}
        </button>
        <button
          title={screen ? 'Parar transmissão' : 'Transmitir tela'}
          onClick={() => (screen ? void toggleScreen() : setModal('screen'))}
          className={tile(screen)}
        >
          <Icons.Screen size={16} />
          {screen && <span>{RESOLUTIONS[quality.resolution].label}</span>}
        </button>
        <button title="Voz e áudio" onClick={() => setModal('settings')} className={tile(false)}>
          <Icons.Sliders size={16} />
        </button>
      </div>
      {modal === 'screen' && <ScreenShareModal onClose={() => setModal(null)} />}
      {modal === 'settings' && <VoiceSettingsModal onClose={() => setModal(null)} />}
      {modal === 'camera' && <CameraModal onClose={() => setModal(null)} />}
    </div>
  );
}

// ---------- participantes embaixo do canal de voz ----------

export function VoiceChannelMembers({ channelId }: { channelId: string }) {
  const states = useVoice((v) => v.states);
  const speaking = useVoice((v) => v.speaking);
  const users = useLine((s) => s.users);
  const list = participants(states, channelId);
  if (!list.length) return null;
  return (
    <div className="ml-7 space-y-0.5 pb-1">
      {list.map((p) => {
        const u = users[p.userId];
        return (
          <div key={p.userId} className="flex items-center gap-2 rounded px-1 py-0.5 text-sm text-soft">
            <span className={cx('rounded-full', speaking[p.userId] && 'ring-2 ring-accent')}>
              <Avatar name={u?.displayName ?? '?'} color={u?.avatarColor ?? '#3a3a42'} size={22} />
            </span>
            <span className="flex-1 truncate">{u?.displayName ?? 'Alguém'}</span>
            {p.screenStreamId && <span className="rounded bg-danger px-1 text-[10px] font-bold text-white">AO VIVO</span>}
            {p.cameraStreamId && <Icons.Video size={14} className="text-muted" />}
            {p.deafened ? (
              <Icons.HeadphonesOff size={14} className="text-muted" />
            ) : p.muted ? (
              <Icons.MicOff size={14} className="text-muted" />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ---------- chamada recebida (DM) ----------

export function IncomingCall() {
  const states = useVoice((v) => v.states);
  const myChannel = useVoice((v) => v.channelId);
  const channels = useLine((s) => s.channels);
  const users = useLine((s) => s.users);
  const meId = useLine((s) => s.me?.id);
  const dnd = useLine((s) => s.me?.status === 'dnd');
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});

  // Uma DM com gente em chamada, onde eu não estou.
  const ringing = Object.values(states).find(
    (s) => !s.serverId && s.channelId !== myChannel && s.userId !== meId && channels[s.channelId] && !dismissed[s.channelId],
  );

  useEffect(() => {
    if (!ringing) return;
    window.line?.requestAttention();
    if (!dnd && typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
      const caller = users[ringing.userId]?.displayName ?? 'Alguém';
      new Notification(`${caller} está te ligando`, { body: 'Abra o Line para atender.' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ringing?.channelId]);

  // Quando a chamada acaba, esquece o "ignorar" para tocar de novo na próxima.
  useEffect(() => {
    setDismissed((d) => {
      const active = new Set(Object.values(states).map((s) => s.channelId));
      const next = Object.fromEntries(Object.entries(d).filter(([cid]) => active.has(cid)));
      return Object.keys(next).length === Object.keys(d).length ? d : next;
    });
  }, [states]);

  if (!ringing || dnd) return null;
  const channel = channels[ringing.channelId]!;
  const caller = users[ringing.userId];

  return (
    <div className="fixed right-6 bottom-6 z-40 flex w-72 flex-col items-center gap-3 rounded-2xl border border-edge bg-side p-5 shadow-2xl">
      <span className="animate-pulse rounded-full ring-4 ring-accent/50">
        <Avatar name={caller?.displayName ?? '?'} color={caller?.avatarColor ?? '#3a3a42'} size={64} />
      </span>
      <div className="text-center">
        <p className="font-bold">{channel.type === 'group_dm' ? dmTitle(channel, meId, users) : caller?.displayName}</p>
        <p className="text-sm text-muted">Chamada em andamento…</p>
      </div>
      <div className="flex gap-3">
        <button
          title="Ignorar"
          onClick={() => setDismissed((d) => ({ ...d, [channel.id]: true }))}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-danger text-white hover:brightness-110"
        >
          <Icons.PhoneOff size={20} />
        </button>
        <button
          title="Atender"
          onClick={() => {
            actions.goHome(channel.id);
            void joinVoice(channel.id);
          }}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-accent text-on-accent hover:bg-accent-strong"
        >
          <Icons.Phone size={20} />
        </button>
      </div>
    </div>
  );
}

'use client';

import type { Channel, PublicUser, VoiceState } from '@line/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { actions, dmTitle, useLine } from '@/lib/store';
import {
  clearVoiceError,
  joinVoice,
  leaveVoice,
  participants,
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
        <Avatar name={name} color={tile.user?.avatarColor ?? '#3a4a41'} size={big ? 112 : 72} />
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
  const cols = others.length <= 1 ? 1 : others.length <= 4 ? 2 : 3;

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
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto">
            <div
              className="grid w-full gap-3"
              style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, maxWidth: cols === 1 ? 720 : undefined }}
            >
              {others.map((t) => (
                <TileView key={t.key} tile={t} onClick={() => setFocus(t.key)} />
              ))}
            </div>
          </div>
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

  const shareScreen = () => {
    if (screen) return void toggleScreen();
    if (window.line?.getScreenSources) setPicker(true);
    else void toggleScreen();
  };

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
      <button title={camera ? 'Desligar câmera' : 'Ligar câmera'} onClick={toggleCamera} className={btn(camera)}>
        {camera ? <Icons.Video size={size} /> : <Icons.VideoOff size={size} />}
      </button>
      <button title={screen ? 'Parar de compartilhar' : 'Compartilhar tela'} onClick={shareScreen} className={btn(screen)}>
        <Icons.Screen size={size} />
      </button>
      <button title="Sair da chamada" onClick={() => leaveVoice()} className={btn(false, true)}>
        <Icons.PhoneOff size={size} />
      </button>
      {picker && (
        <ScreenPicker
          onClose={() => setPicker(false)}
          onPick={(id) => {
            setPicker(false);
            void toggleScreen(id);
          }}
        />
      )}
    </div>
  );
}

/** Seletor de tela/janela (só no app desktop). */
function ScreenPicker({ onClose, onPick }: { onClose: () => void; onPick: (id: string) => void }) {
  const [sources, setSources] = useState<{ id: string; name: string; thumbnail: string; isScreen: boolean }[] | null>(null);
  const [tab, setTab] = useState<'screen' | 'window'>('screen');
  useEffect(() => {
    window.line
      ?.getScreenSources?.()
      .then(setSources)
      .catch(() => setSources([]));
  }, []);
  const list = (sources ?? []).filter((s) => (tab === 'screen' ? s.isScreen : !s.isScreen));

  return (
    <Modal title="Compartilhar tela" subtitle="Escolha o que a galera vai ver. O áudio do sistema vai junto." onClose={onClose} width={720}>
      <div className="mb-4 flex gap-2">
        {(['screen', 'window'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cx('rounded-md px-3 py-1 text-sm font-medium', tab === t ? 'bg-hover text-fg' : 'text-muted hover:text-fg')}
          >
            {t === 'screen' ? 'Telas' : 'Janelas'}
          </button>
        ))}
      </div>
      {!sources && <p className="text-sm text-muted">Carregando…</p>}
      {sources && list.length === 0 && (
        <p className="text-sm text-muted">Nada encontrado aqui. Tente a outra aba.</p>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {list.map((s) => (
          <button key={s.id} onClick={() => onPick(s.id)} className="group space-y-1.5 rounded-lg p-1.5 text-left hover:bg-hover">
            <img src={s.thumbnail} alt="" className="aspect-video w-full rounded-md bg-black object-contain ring-accent group-hover:ring-2" />
            <span className="block truncate text-xs text-soft">{s.name}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

// ---------- barra "voz conectada" na lateral ----------

export function VoiceBar() {
  const channelId = useVoice((v) => v.channelId);
  const connecting = useVoice((v) => v.connecting);
  const channel = useLine((s) => (channelId ? s.channels[channelId] : undefined));
  const server = useLine((s) => (channel?.serverId ? s.servers[channel.serverId] : undefined));
  const meId = useLine((s) => s.me?.id);
  const users = useLine((s) => s.users);
  if (!channelId) return null;

  const label = channel ? (channel.serverId ? `${channel.name} / ${server?.name ?? ''}` : dmTitle(channel, meId, users)) : '';
  const go = () => {
    if (!channel) return;
    if (channel.serverId) actions.goServer(channel.serverId, channel.id);
    else actions.goHome(channel.id);
  };

  return (
    <div className="space-y-1.5 border-b border-edge bg-rail/70 px-2 py-2">
      <button onClick={go} className="block w-full min-w-0 rounded px-1 text-left hover:bg-hover">
        <span className={cx('block text-sm font-bold', connecting ? 'text-sun' : 'text-accent')}>
          {connecting ? 'Conectando…' : 'Voz conectada'}
        </span>
        <span className="block truncate text-xs text-muted">{label}</span>
      </button>
      <VoiceControls />
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
              <Avatar name={u?.displayName ?? '?'} color={u?.avatarColor ?? '#3a4a41'} size={22} />
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
        <Avatar name={caller?.displayName ?? '?'} color={caller?.avatarColor ?? '#3a4a41'} size={64} />
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
          className="flex h-11 w-11 items-center justify-center rounded-full bg-accent text-rail hover:bg-accent-strong"
        >
          <Icons.Phone size={20} />
        </button>
      </div>
    </div>
  );
}

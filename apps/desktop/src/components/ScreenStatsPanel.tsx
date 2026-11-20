'use client';

import { useLine } from '@/lib/store';
import { useScreenStats, type RecvStat, type SendStat } from '@/lib/screenStats';
import { cx } from './ui';

/** Painel com os números reais da transmissão (o que chega de verdade, não a qualidade escolhida). */

const mbps = (kbps: number) => `${(kbps / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} Mbps`;
const pct = (v: number) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
const ms = (v: number | null) => (v == null ? '–' : `${Math.round(v)} ms`);

type Level = 'good' | 'warn' | 'bad';
function level(lossPct: number, rttMs: number | null): Level {
  if (lossPct >= 3 || (rttMs ?? 0) > 250) return 'bad';
  if (lossPct >= 1 || (rttMs ?? 0) > 150) return 'warn';
  return 'good';
}
const LEVEL_LABEL: Record<Level, string> = { good: 'Conexão boa', warn: 'Conexão instável', bad: 'Conexão ruim' };
const LEVEL_DOT: Record<Level, string> = { good: 'bg-online', warn: 'bg-[#f0b232]', bad: 'bg-danger' };

const LIMIT: Record<string, string> = {
  bandwidth: 'limitada pela rede',
  cpu: 'limitada pelo processador',
  other: 'limitada',
};

function Head({ lvl }: { lvl: Level }) {
  return (
    <p className="mb-1 flex items-center gap-1.5 font-semibold">
      <span className={cx('h-2 w-2 rounded-full', LEVEL_DOT[lvl])} />
      {LEVEL_LABEL[lvl]}
    </p>
  );
}

function Recv({ s }: { s: RecvStat }) {
  return (
    <>
      <Head lvl={level(s.lossPct, s.rttMs)} />
      <p>
        {s.width && s.height ? `${s.width}×${s.height}` : '–'} · {s.fps} fps · {mbps(s.kbps)}
      </p>
      <p>
        {s.codec || 'Vídeo'} · {s.hw ? 'placa de vídeo' : 'processador'}
      </p>
      <p>
        Perda {pct(s.lossPct)} · RTT {ms(s.rttMs)} · Jitter {ms(s.jitterMs)}
      </p>
      <p>
        Buffer {ms(s.bufferMs)} · Congelamentos {s.freezes}
        {s.relay ? ' · via servidor TURN' : ''}
      </p>
    </>
  );
}

function Send({ list }: { list: [string, SendStat][] }) {
  const users = useLine((st) => st.users);
  const worst = list.reduce<Level>((acc, [, s]) => {
    const l = level(s.lossPct, s.rttMs);
    return l === 'bad' || acc === 'bad' ? 'bad' : l === 'warn' || acc === 'warn' ? 'warn' : 'good';
  }, 'good');
  const first = list[0]?.[1];
  const total = list.reduce((n, [, s]) => n + s.kbps, 0);
  return (
    <>
      <Head lvl={worst} />
      {first && (
        <p>
          {first.codec || 'Vídeo'} · {first.hw ? 'placa de vídeo' : 'processador'} · upload total {mbps(total)}
        </p>
      )}
      {list.map(([id, s]) => (
        <p key={id} className="truncate">
          <span className="font-semibold">{users[id]?.displayName ?? 'Alguém'}:</span> {s.width && s.height ? `${s.height}p` : '–'}
          {s.fps} · {mbps(s.kbps)} de {mbps(s.capKbps)} · perda {pct(s.lossPct)} · RTT {ms(s.rttMs)}
          {s.limit !== 'none' && LIMIT[s.limit] ? ` · ${LIMIT[s.limit]}` : ''}
          {s.relay ? ' · TURN' : ''}
        </p>
      ))}
    </>
  );
}

export function ScreenStatsPanel({ userId, isMe }: { userId: string; isMe: boolean }) {
  const open = useScreenStats((s) => s.open);
  const recv = useScreenStats((s) => s.recv[userId]);
  const send = useScreenStats((s) => s.send);
  if (!open) return null;
  const sendList = isMe ? Object.entries(send) : [];
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="pointer-events-auto absolute top-10 left-2 z-20 max-w-[min(26rem,calc(100%-1rem))] space-y-0.5 rounded-md bg-black/75 px-2.5 py-1.5 text-xs leading-snug text-white tabular-nums"
    >
      {isMe ? (
        sendList.length ? <Send list={sendList} /> : <p>Ninguém assistindo ainda.</p>
      ) : recv ? (
        <Recv s={recv} />
      ) : (
        <p>Medindo…</p>
      )}
    </div>
  );
}

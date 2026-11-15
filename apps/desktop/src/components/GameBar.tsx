'use client';

import { useEffect, useState } from 'react';
import { detectGame, hasGameDetection, type RunningGame } from '@/lib/nativeScreen';
import { toggleScreen, useVoice } from '@/lib/voice';
import { Icons } from './ui';

/** De quanto em quanto tempo olha se abriu/fechou um jogo. */
const POLL_MS = 10_000;

function elapsed(since: number) {
  const min = Math.floor((Date.now() - since) / 60_000);
  if (min < 1) return 'Jogando agora';
  if (min < 60) return `Jogando há ${min} min`;
  const h = Math.floor(min / 60);
  return `Jogando há ${h} h${min % 60 ? ` ${min % 60} min` : ''}`;
}

/**
 * Cartão do jogo aberto, em cima de "Voz conectada" (só no app do Windows).
 * Em chamada, o botão de monitor transmite a janela do jogo direto, sem passar pelo seletor.
 */
export function GameBar() {
  const [enabled] = useState(() => hasGameDetection());
  const [game, setGame] = useState<(RunningGame & { since: number }) | null>(null);
  const inCall = useVoice((v) => !!v.channelId && !v.connecting);
  const streaming = useVoice((v) => !!v.screen);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const check = () =>
      void detectGame().then((g) => {
        if (!alive) return;
        setGame((old) => (!g ? null : { ...g, since: old?.name === g.name ? old.since : Date.now() }));
      });
    check();
    const t = setInterval(check, POLL_MS);
    window.addEventListener('focus', check);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener('focus', check);
    };
  }, [enabled]);

  if (!enabled || !game) return null;
  const canStream = inCall && !streaming;

  return (
    <div className="flex items-center gap-2.5 border-b border-edge px-2.5 py-2">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-raise">
        {game.icon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={game.icon} alt="" className="h-8 w-8 object-contain" />
        ) : (
          <Icons.Gamepad size={20} className="text-muted" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-bold">{game.name}</span>
        <span className="block truncate text-xs text-muted">{streaming && inCall ? 'Transmitindo na chamada' : elapsed(game.since)}</span>
      </span>
      {canStream && (
        <button
          title="Transmitir agora"
          onClick={() => void toggleScreen({ id: game.windowId, audio: true })}
          className="shrink-0 rounded-md p-1.5 text-soft transition-colors hover:bg-hover hover:text-fg"
        >
          <Icons.Screen size={18} />
        </button>
      )}
    </div>
  );
}

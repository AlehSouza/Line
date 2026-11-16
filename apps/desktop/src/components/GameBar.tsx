'use client';

import { useEffect, useState } from 'react';
import { detectGame, hasGameDetection, type RunningGame } from '@/lib/nativeScreen';
import { toggleScreen, useVoice } from '@/lib/voice';
import { ScreenShareModal } from './Voice';
import { reportGame } from '@/lib/session';
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
 * Em chamada, o botão de monitor abre o seletor de tela já com a janela do jogo marcada.
 */
export function GameBar() {
  const [enabled] = useState(() => hasGameDetection());
  const [game, setGame] = useState<(RunningGame & { since: number }) | null>(null);
  const inCall = useVoice((v) => !!v.channelId && !v.connecting);
  const streaming = useVoice((v) => !!v.screen);
  const [picker, setPicker] = useState<string | null>(null);

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

  // A Atividade da lista de pessoas mostra o que cada um está jogando.
  useEffect(() => {
    if (!enabled) return;
    reportGame(game ? { name: game.name, icon: game.icon?.startsWith('data:image/png') && game.icon.length < 48_000 ? game.icon : undefined } : null);
  }, [enabled, game?.name]);

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
          onClick={() => setPicker(game.windowId)}
          className="shrink-0 rounded-md p-1.5 text-soft transition-colors hover:bg-hover hover:text-fg"
        >
          <Icons.Screen size={18} />
        </button>
      )}
      {streaming && inCall && (
        <button
          title="Encerrar transmissão"
          onClick={() => void toggleScreen()}
          className="shrink-0 rounded-md p-1.5 text-danger transition-colors hover:bg-danger/15"
        >
          <Icons.X size={18} />
        </button>
      )}
      {/* Abre o seletor já com a janela do jogo marcada: dá para conferir a qualidade e o áudio antes. */}
      {picker && <ScreenShareModal preselect={picker} onClose={() => setPicker(null)} />}
    </div>
  );
}

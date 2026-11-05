'use client';

import type { Channel } from '@line/shared';
import { Icons } from './ui';

/** Canais de voz já existem na estrutura; áudio, vídeo e tela chegam na fase 2 (WebRTC). */
export function VoicePlaceholder({ channel }: { channel: Channel }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-rail p-8 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-raise text-accent">
        <Icons.Speaker size={40} />
      </div>
      <h1 className="text-2xl font-bold">{channel.name}</h1>
      <p className="max-w-md text-muted">
        Canais de voz, vídeo e compartilhamento de tela chegam na próxima fase do Line. O canal já fica criado e
        organizado aqui para quando a voz for ligada.
      </p>
    </div>
  );
}

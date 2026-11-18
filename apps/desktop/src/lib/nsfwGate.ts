'use client';

import { create } from 'zustand';
import { isAdult } from './age';
import { useLine } from './store';

/** Canais +18 que a pessoa já aceitou entrar (guardado neste aparelho, por conta). */
const key = () => `line:nsfw-ok:${useLine.getState().me?.id ?? ''}`;

function read(): string[] {
  try {
    return JSON.parse(localStorage.getItem(key()) || '[]');
  } catch {
    return [];
  }
}

export const useNsfwOk = create<{ ids: string[] }>(() => ({ ids: [] }));

export function loadNsfwOk() {
  useNsfwOk.setState({ ids: read() });
}

export function acceptNsfwChannel(channelId: string) {
  const ids = [...new Set([...read(), channelId])];
  try {
    localStorage.setItem(key(), JSON.stringify(ids));
  } catch {
    /* sem armazenamento: vale só nesta sessão */
  }
  useNsfwOk.setState({ ids });
}

/** O canal é +18 e a pessoa ainda não passou pelo aviso (ou não tem idade). */
export function needsNsfwGate(channelId: string): boolean {
  const s = useLine.getState();
  const channel = s.channels[channelId];
  if (!channel?.nsfw) return false;
  if (!isAdult(s.me?.birthDate)) return true;
  const ids = useNsfwOk.getState().ids.length ? useNsfwOk.getState().ids : read();
  return !ids.includes(channelId);
}

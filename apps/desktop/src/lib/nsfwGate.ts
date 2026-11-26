'use client';

import type { Channel, Rating } from '@line/shared';
import { create } from 'zustand';
import { ageOf } from './age';
import { useLine } from './store';

/** Canais (ou servidores, quando o canal segue o servidor) com classificação que a pessoa
 * já aceitou abrir (guardado neste aparelho, por conta). */
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

export function acceptNsfwChannel(id: string) {
  const ids = [...new Set([...read(), id])];
  try {
    localStorage.setItem(key(), JSON.stringify(ids));
  } catch {
    /* sem armazenamento: vale só nesta sessão */
  }
  useNsfwOk.setState({ ids });
}

export type Gate = { rating: Exclude<Rating, 'L'>; min: number; key: string };

/** Classificação que vale para o canal (a dele ou a do servidor) e a chave do aceite.
 * Livre ou sem classificação: sem aviso. */
export function gateOf(channel: Channel, serverRating?: Rating | null): Gate | null {
  const own = channel.rating ?? (channel.nsfw ? '18' : null);
  const rating = own ?? (channel.type === 'text' || channel.type === 'voice' ? serverRating : null);
  if (!rating || rating === 'L') return null;
  return { rating, min: Number(rating), key: own ? channel.id : `s:${channel.serverId}` };
}

/** Tem idade informada e suficiente para a classificação? */
export const oldEnough = (gate: Gate, birthDate: string | null | undefined) => (ageOf(birthDate) ?? -1) >= gate.min;

/** A pessoa não tem a idade do canal, ou é um canal 18 e ela ainda não passou pelo aviso. */
export function needsNsfwGate(channelId: string): boolean {
  const s = useLine.getState();
  const channel = s.channels[channelId];
  if (!channel) return false;
  const gate = gateOf(channel, channel.serverId ? s.servers[channel.serverId]?.rating : null);
  if (!gate) return false;
  if (!oldEnough(gate, s.me?.birthDate)) return true;
  if (gate.rating !== '18') return false;
  const ids = useNsfwOk.getState().ids.length ? useNsfwOk.getState().ids : read();
  return !ids.includes(gate.key);
}

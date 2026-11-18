import type { Message } from '@line/shared';
import { ensureServerLoaded, jumpToMessage } from './session';
import { useLine } from './store';
import { toast } from '@/components/Dialogs';

/** Link de uma mensagem: useline.tech/app/?mensagem=<servidor ou dm>/<canal>/<mensagem>. */
export function messageLink(message: Pick<Message, 'id' | 'channelId'>) {
  const serverId = useLine.getState().channels[message.channelId]?.serverId ?? 'dm';
  return `https://useline.tech/app/?mensagem=${encodeURIComponent(`${serverId}/${message.channelId}/${message.id}`)}`;
}

const LINK = /^https:\/\/useline\.tech\/app\/?\?mensagem=([^&#\s]+)/;

/** Separa servidor, canal e mensagem de um link de mensagem (ou do valor do ?mensagem=). */
export function parseMessageLink(value: string) {
  const raw = LINK.exec(value)?.[1] ?? (value.includes('://') ? null : value);
  if (!raw) return null;
  const [serverId, channelId, messageId] = decodeURIComponent(raw).split('/');
  return serverId && channelId && messageId ? { serverId, channelId, messageId } : null;
}

export const isMessageLink = (url: string) => LINK.test(url);

/** Abre o canal da mensagem e rola até ela (sem acesso: avisa na snackbar). */
export async function openMessageLink(value: string) {
  const link = parseMessageLink(value);
  if (!link) return;
  try {
    if (link.serverId !== 'dm') {
      if (!useLine.getState().servers[link.serverId]) throw new Error();
      await ensureServerLoaded(link.serverId);
    }
    if (!useLine.getState().channels[link.channelId]) throw new Error();
    await jumpToMessage({ id: link.messageId, channelId: link.channelId } as Message);
  } catch {
    toast('Você não tem acesso a essa mensagem.', 'error');
  }
}

import { randomBytes } from 'node:crypto';

let lastTime = 0;
let seq = 0;

/**
 * IDs ordenáveis por tempo (timestamp + sequência + aleatório), em base36.
 * Ordem lexicográfica = ordem de criação, o que facilita paginar mensagens.
 */
export function newId(): string {
  const now = Date.now();
  if (now === lastTime) seq++;
  else {
    lastTime = now;
    seq = 0;
  }
  const time = now.toString(36).padStart(9, '0');
  const counter = seq.toString(36).padStart(3, '0');
  const rand = randomBytes(4).toString('hex');
  return `${time}${counter}${rand}`;
}

const INVITE_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newInviteCode(length = 8): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const b of bytes) out += INVITE_ALPHABET[b % INVITE_ALPHABET.length];
  return out;
}

import type { Presence, UserStatus } from '@line/shared';

interface Entry {
  sockets: Set<string>;
  /** Sockets que reportaram inatividade (sem mouse/teclado há um tempo). */
  idleSockets: Set<string>;
}

/**
 * Guarda em memória quem está conectado. A presença final combina:
 * - conexões abertas (nenhuma = offline)
 * - status escolhido (invisível = offline para os outros, ocupado = dnd)
 * - inatividade (todas as conexões ociosas = ausente)
 */
export class PresenceTracker {
  private entries = new Map<string, Entry>();

  connect(userId: string, socketId: string): boolean {
    let entry = this.entries.get(userId);
    const wasOnline = !!entry && entry.sockets.size > 0;
    if (!entry) {
      entry = { sockets: new Set(), idleSockets: new Set() };
      this.entries.set(userId, entry);
    }
    entry.sockets.add(socketId);
    return !wasOnline;
  }

  disconnect(userId: string, socketId: string): boolean {
    const entry = this.entries.get(userId);
    if (!entry) return false;
    entry.sockets.delete(socketId);
    entry.idleSockets.delete(socketId);
    if (entry.sockets.size === 0) {
      this.entries.delete(userId);
      return true;
    }
    return false;
  }

  setIdle(userId: string, socketId: string, idle: boolean) {
    const entry = this.entries.get(userId);
    if (!entry) return;
    if (idle) entry.idleSockets.add(socketId);
    else entry.idleSockets.delete(socketId);
  }

  isConnected(userId: string): boolean {
    return (this.entries.get(userId)?.sockets.size ?? 0) > 0;
  }

  resolve(userId: string, status: UserStatus): Presence {
    const entry = this.entries.get(userId);
    if (!entry || entry.sockets.size === 0) return 'offline';
    if (status === 'invisible') return 'offline';
    if (status === 'dnd') return 'dnd';
    if (status === 'idle') return 'idle';
    if (entry.idleSockets.size === entry.sockets.size) return 'idle';
    return 'online';
  }
}

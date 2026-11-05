import type { Server as HttpServer } from 'node:http';
import type { ClientToServerEvents, ServerToClientEvents } from '@line/shared';
import { Server as IOServer, type Socket } from 'socket.io';
import type { TokenService } from './auth';
import type { PresenceTracker } from './presence';
import type { Store } from './store';

type IO = IOServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, { userId: string }>;
type LineSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, { userId: string }>;

const userRoom = (id: string) => `user:${id}`;
const serverRoom = (id: string) => `server:${id}`;

/**
 * Gateway em tempo real (Socket.IO sobre WebSocket).
 * Salas: `user:<id>` (todas as conexões de um usuário) e `server:<id>` (membros de um servidor).
 * Mensagens de DM vão direto para as salas dos participantes.
 */
export class Gateway {
  io!: IO;

  constructor(
    private store: Store,
    private presence: PresenceTracker,
    private tokens: TokenService,
  ) {}

  attach(http: HttpServer) {
    this.io = new IOServer(http, { cors: { origin: true, credentials: true } });

    this.io.use(async (socket, next) => {
      const token = socket.handshake.auth?.token;
      const userId = typeof token === 'string' ? await this.tokens.verify(token) : null;
      if (!userId || !this.store.selfUser(userId)) return next(new Error('unauthorized'));
      socket.data.userId = userId;
      next();
    });

    this.io.on('connection', (socket) => this.onConnection(socket));
  }

  private onConnection(socket: LineSocket) {
    const userId = socket.data.userId;
    socket.join(userRoom(userId));
    for (const serverId of this.store.serverIdsOf(userId)) socket.join(serverRoom(serverId));

    const cameOnline = this.presence.connect(userId, socket.id);
    socket.emit('ready', { user: this.store.selfUser(userId)! });
    if (cameOnline) this.broadcastPresence(userId);

    socket.on('typing:start', ({ channelId }) => {
      const channel = typeof channelId === 'string' ? this.store.channel(channelId) : undefined;
      if (!channel || !this.canAccess(userId, channel.id)) return;
      const me = this.store.publicUser(userId)!;
      const payload = { channelId, userId, displayName: me.displayName };
      if (channel.serverId) socket.to(serverRoom(channel.serverId)).emit('typing:start', payload);
      else this.toUsers(this.store.recipientIds(channel.id).filter((r) => r !== userId), 'typing:start', payload);
    });

    socket.on('presence:activity', ({ idle }) => {
      const before = this.presence.resolve(userId, this.store.userStatus(userId));
      this.presence.setIdle(userId, socket.id, !!idle);
      const after = this.presence.resolve(userId, this.store.userStatus(userId));
      if (before !== after) this.broadcastPresence(userId);
    });

    socket.on('disconnect', () => {
      const wentOffline = this.presence.disconnect(userId, socket.id);
      if (wentOffline) this.broadcastPresence(userId);
    });
  }

  canAccess(userId: string, channelId: string): boolean {
    const channel = this.store.channel(channelId);
    if (!channel) return false;
    if (channel.serverId) return this.store.isMember(channel.serverId, userId);
    return this.store.recipientIds(channel.id).includes(userId);
  }

  broadcastPresence(userId: string) {
    const user = this.store.publicUser(userId);
    if (!user || !this.io) return;
    const payload = { userId, presence: user.presence, customStatus: user.customStatus };
    // Inclui o próprio usuário para sincronizar outras janelas/dispositivos.
    this.toUsers([userId, ...this.store.audienceOf(userId)], 'presence:update', payload);
  }

  /** Emite um evento para salas; lista vazia não emite nada (Socket.IO mandaria para todos). */
  private emitTo<E extends keyof ServerToClientEvents>(rooms: string[], event: E, ...args: Parameters<ServerToClientEvents[E]>) {
    if (!this.io || rooms.length === 0) return;
    (this.io.to(rooms).emit as (ev: string, ...a: unknown[]) => boolean)(event, ...args);
  }

  toUsers<E extends keyof ServerToClientEvents>(userIds: string[], event: E, ...args: Parameters<ServerToClientEvents[E]>) {
    this.emitTo(userIds.map(userRoom), event, ...args);
  }

  toServer<E extends keyof ServerToClientEvents>(serverId: string, event: E, ...args: Parameters<ServerToClientEvents[E]>) {
    this.emitTo([serverRoom(serverId)], event, ...args);
  }

  /** Emite para quem enxerga o canal (membros do servidor ou participantes da DM). */
  toChannel<E extends keyof ServerToClientEvents>(channelId: string, event: E, ...args: Parameters<ServerToClientEvents[E]>) {
    const channel = this.store.channel(channelId);
    if (!channel) return;
    if (channel.serverId) this.toServer(channel.serverId, event, ...args);
    else this.toUsers(this.store.recipientIds(channel.id), event, ...args);
  }

  joinServer(userId: string, serverId: string) {
    this.io?.in(userRoom(userId)).socketsJoin(serverRoom(serverId));
  }

  leaveServer(userId: string, serverId: string) {
    this.io?.in(userRoom(userId)).socketsLeave(serverRoom(serverId));
  }

  closeServerRoom(serverId: string) {
    this.io?.in(serverRoom(serverId)).socketsLeave(serverRoom(serverId));
  }
}

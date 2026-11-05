import type { Category, Channel, Friend, Member, Message, Presence, PublicUser, SelfUser, Server } from './types';

/** Eventos que o servidor envia para o cliente via WebSocket (Socket.IO). */
export interface ServerToClientEvents {
  ready: (payload: { user: SelfUser }) => void;
  'message:create': (message: Message) => void;
  'message:update': (message: Message) => void;
  'message:delete': (payload: { id: string; channelId: string }) => void;
  'typing:start': (payload: { channelId: string; userId: string; displayName: string }) => void;
  'presence:update': (payload: { userId: string; presence: Presence; customStatus: string | null }) => void;
  'user:update': (user: PublicUser) => void;
  'self:update': (user: SelfUser) => void;
  'server:create': (server: Server) => void;
  'server:update': (server: Server) => void;
  'server:delete': (payload: { id: string }) => void;
  'member:add': (member: Member) => void;
  'member:remove': (payload: { serverId: string; userId: string }) => void;
  'channel:create': (channel: Channel) => void;
  'channel:update': (channel: Channel) => void;
  'channel:delete': (payload: { id: string; serverId: string | null }) => void;
  'category:create': (category: Category) => void;
  'category:update': (category: Category) => void;
  'category:delete': (payload: { id: string; serverId: string }) => void;
  'friend:update': (friend: Friend) => void;
  'friend:remove': (payload: { userId: string }) => void;
}

/** Eventos que o cliente envia para o servidor. */
export interface ClientToServerEvents {
  'typing:start': (payload: { channelId: string }) => void;
  'presence:activity': (payload: { idle: boolean }) => void;
}

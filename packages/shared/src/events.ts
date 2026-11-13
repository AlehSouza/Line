import type {
  Category,
  Channel,
  Friend,
  Member,
  Message,
  Presence,
  PublicUser,
  SelfUser,
  Server,
  VoiceSignal,
  VoiceState,
} from './types';

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
  /** Todos os estados de voz que você pode ver (enviado ao conectar). */
  'voice:snapshot': (states: VoiceState[]) => void;
  /** Alguém entrou, mudou o estado ou saiu (state = null) de um canal de voz. */
  'voice:update': (payload: { userId: string; channelId: string; state: VoiceState | null }) => void;
  'voice:signal': (payload: { from: string; signal: VoiceSignal }) => void;
  /** Você foi desconectado da voz (ex.: entrou em outro canal por outra janela). */
  'voice:kicked': (payload: { channelId: string }) => void;
  /** Status temporário dos canais de voz que você pode ver (enviado ao conectar). */
  'voice:statuses': (statuses: Record<string, string>) => void;
  /** Status de um canal de voz mudou (null = sumiu, ex.: todos saíram). */
  'voice:status': (payload: { channelId: string; status: string | null }) => void;
}

export type VoiceJoinResult = { ok: true; peers: VoiceState[] } | { ok: false; error: string };

/** Eventos que o cliente envia para o servidor. */
export interface ClientToServerEvents {
  'typing:start': (payload: { channelId: string }) => void;
  'presence:activity': (payload: { idle: boolean }) => void;
  'voice:join': (payload: { channelId: string; muted?: boolean; deafened?: boolean }, ack: (res: VoiceJoinResult) => void) => void;
  'voice:leave': () => void;
  'voice:state': (patch: Partial<Pick<VoiceState, 'muted' | 'deafened' | 'cameraStreamId' | 'screenStreamId'>>) => void;
  'voice:signal': (payload: { to: string; signal: VoiceSignal }) => void;
  /** Define o status do canal de voz em que você está ('' limpa). */
  'voice:status': (payload: { channelId: string; status: string }) => void;
}

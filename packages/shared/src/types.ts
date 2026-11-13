/** Status que o usuário escolhe. "invisible" aparece como offline para os outros. */
export type UserStatus = 'online' | 'idle' | 'dnd' | 'invisible';
/** Presença que os outros enxergam. */
export type Presence = 'online' | 'idle' | 'dnd' | 'offline';

export type ChannelType = 'text' | 'voice' | 'dm' | 'group_dm' | 'thread';

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatarColor: string;
  bio: string;
  customStatus: string | null;
  presence: Presence;
}

export interface SelfUser extends PublicUser {
  status: UserStatus;
  createdAt: string;
  email?: string | null;
}

export interface Server {
  id: string;
  name: string;
  description: string;
  iconColor: string;
  ownerId: string;
  isPublic: boolean;
  inviteCode: string;
  memberCount: number;
  createdAt: string;
}

export interface Category {
  id: string;
  serverId: string;
  name: string;
  position: number;
}

export interface Channel {
  id: string;
  type: ChannelType;
  serverId: string | null;
  categoryId: string | null;
  name: string;
  topic: string;
  position: number;
  /** Só para dm / group_dm. */
  recipients?: PublicUser[];
  /** Dono da DM em grupo ou quem criou a thread. */
  ownerId?: string | null;
  lastMessageAt?: string | null;
  /** Só para threads: canal de texto onde a thread nasceu. */
  parentId?: string;
  /** Só para threads: mensagem que abriu a thread (null se foi criada solta). */
  threadMessageId?: string | null;
  /** Só para threads. */
  messageCount?: number;
}

export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  /** Caminho relativo ao servidor, ex.: /api/attachments/abc/foto.png */
  url: string;
}

export interface ThreadSummary {
  id: string;
  name: string;
  messageCount: number;
  lastMessageAt: string | null;
  participantIds?: string[];
  participantCount?: number;
}

export interface Member {
  serverId: string;
  user: PublicUser;
  nickname: string | null;
  joinedAt: string;
}

export interface Message {
  id: string;
  channelId: string;
  author: PublicUser;
  content: string;
  createdAt: string;
  editedAt: string | null;
  attachments: Attachment[];
  /** Thread aberta a partir desta mensagem. */
  thread: ThreadSummary | null;
}

export type FriendState = 'friends' | 'incoming' | 'outgoing';

export interface Friend {
  user: PublicUser;
  state: FriendState;
  since: string;
}

export interface ServerDetail {
  server: Server;
  categories: Category[];
  channels: Channel[];
  members: Member[];
}

export interface AuthResponse {
  token: string;
  user: SelfUser;
}

export interface ApiError {
  error: string;
  message: string;
}

/** Estado de alguém conectado a um canal de voz (ou chamada de DM). */
export interface VoiceState {
  userId: string;
  channelId: string;
  /** Canal de servidor; null em chamadas de DM. */
  serverId: string | null;
  muted: boolean;
  deafened: boolean;
  /** id do MediaStream da câmera (null = câmera desligada). */
  cameraStreamId: string | null;
  /** id do MediaStream da tela compartilhada (null = sem compartilhamento). */
  screenStreamId: string | null;
  joinedAt: string;
}

/** Mensagem de sinalização WebRTC repassada pelo servidor entre dois participantes. */
export type VoiceSignal =
  | { type: 'description'; description: { type: 'offer' | 'answer' | 'pranswer' | 'rollback'; sdp?: string } }
  | { type: 'candidate'; candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null } | null };

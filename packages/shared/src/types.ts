/** Status que o usuário escolhe. "invisible" aparece como offline para os outros. */
export type UserStatus = 'online' | 'idle' | 'dnd' | 'invisible';
/** Presença que os outros enxergam. */
export type Presence = 'online' | 'idle' | 'dnd' | 'offline';

export type ChannelType = 'text' | 'voice' | 'dm' | 'group_dm';

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
  ownerId?: string | null;
  lastMessageAt?: string | null;
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

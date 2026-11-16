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
  avatarUrl?: string | null;
  bannerUrl?: string | null;
  pronouns?: string;
  thought?: string | null;
  /** Bot (ex.: o bot de música do servidor). */
  bot?: boolean;
  /** Tag de servidor que a pessoa exibe ao lado do nome. */
  tag?: { serverId: string; text: string; icon?: string | null; iconUrl?: string | null; style?: TagStyle | null } | null;
  /** Só para bots: cor do nome, cor da etiqueta, texto dela ("BOT" ou "B") e cor do anel de fala. */
  botStyle?: { nameColor: string | null; tagColor: string | null; tagText: 'BOT' | 'B'; ringColor?: string | null };
}

/** Aparência da tag do servidor (tudo opcional; vazio = padrão). */
export interface TagStyle {
  bg?: string;
  fg?: string;
  border?: string;
  iconColor?: string;
  iconStyle?: 'outline' | 'solid';
}

/** Uma faixa na fila do bot de música. */
export interface MusicTrack {
  uid: string;
  videoId: string;
  title: string;
  author: string;
  /** Segundos (null = ainda não se sabe). */
  duration: number | null;
  addedBy: string;
}

/** Estado do bot de música num canal de voz. */
export interface MusicState {
  serverId: string;
  channelId: string;
  textChannelId: string;
  /** Quem deu o primeiro /play: controla tudo sem votação. */
  djId: string;
  tracks: MusicTrack[];
  index: number;
  paused: boolean;
  /** Posição da faixa atual quando o servidor mandou o estado. */
  positionMs: number;
  votes: Partial<Record<'skip' | 'prev' | 'pause', string[]>>;
  listeners: number;
  needed: number;
}

export interface SelfUser extends PublicUser {
  status: UserStatus;
  /** Até quando o status vale (ISO); null = para sempre. */
  statusUntil?: string | null;
  createdAt: string;
  email?: string | null;
  /** false em conta criada pelo Google que ainda não definiu senha. */
  hasPassword?: boolean;
}

export interface Server {
  id: string;
  name: string;
  description: string;
  iconColor: string;
  /** Tag de identificação do servidor (até 4 caracteres); vazia = sem tag. */
  tag?: string;
  /** Ícone da tag: '' = foto do servidor; senão o nome de um ícone do Lucide. */
  tagIcon?: string;
  /** Cores da tag e estilo do ícone. */
  tagStyle?: TagStyle | null;
  /** Imagem do ícone (squircle da barra lateral); sem ela mostra as iniciais. */
  iconUrl?: string | null;
  /** Banner fixo no topo da lista de canais. */
  bannerUrl?: string | null;
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
  /** Exclusiva de cargos: só eles (e dono/admin) veem a categoria e os canais dela. */
  isPrivate?: boolean;
}

export interface Channel {
  id: string;
  type: ChannelType;
  serverId: string | null;
  categoryId: string | null;
  name: string;
  topic: string;
  position: number;
  /** Canal privado: só o dono do servidor e os membros escolhidos enxergam. */
  isPrivate?: boolean;
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
  /** Cargos da pessoa (sem o @everyone). */
  roleIds: string[];
}

export interface Role {
  /** O @everyone tem o mesmo id do servidor. */
  id: string;
  serverId: string;
  name: string;
  color: string | null;
  permissions: number;
  /** Maior = mais alto. O @everyone fica em 0. */
  position: number;
  mentionable: boolean;
  /** Aparece numa seção própria na lista de membros. */
  hoist?: boolean;
  memberCount: number;
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
  poll?: Poll | null;
  /** @everyone/@here que vale (quem mandou tinha permissão). */
  mentionEveryone?: boolean;
  /** Cargos mencionados (`<@&id>` no texto) que valem. */
  mentionRoleIds?: string[];
  /** Reações agrupadas por emoji, na ordem em que apareceram. */
  reactions?: Reaction[];
  /** Recursos que o app precisa conhecer para mostrar a mensagem (ver `CLIENT_FEATURES`). */
  requires?: string[];
}

export interface Reaction {
  emoji: string;
  /** Quem reagiu, na ordem em que reagiu. */
  userIds: string[];
}

export type FriendState = 'friends' | 'incoming' | 'outgoing' | 'blocked';

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
  roles: Role[];
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
  /** Silenciado / com áudio desativado por um moderador do servidor. */
  serverMuted?: boolean;
  serverDeafened?: boolean;
  joinedAt: string;
}

/** Jogo que está sendo transmitido (nome e ícone em data URL), quando a fonte é a janela de um jogo. */
export interface ScreenGame {
  name: string;
  icon?: string;
}

/** Mensagem de sinalização WebRTC repassada pelo servidor entre dois participantes. */
export type VoiceSignal =
  | { type: 'description'; description: { type: 'offer' | 'answer' | 'pranswer' | 'rollback'; sdp?: string } }
  | { type: 'candidate'; candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null } | null }
  /** Quem assiste avisa quem transmite: só quem pediu recebe o vídeo e o som da tela. */
  | { type: 'watch'; on: boolean }
  /** Miniatura estática (JPEG em data URL, pequena) da tela de quem transmite, para quem ainda não assiste. */
  | { type: 'thumb'; data: string; game?: ScreenGame }
  /** Quem transmite conta a todos do canal quem está assistindo à tela agora. */
  | { type: 'viewers'; ids: string[] };

export interface PollOption {
  id: string;
  text: string;
  voterIds: string[];
}

export interface Poll {
  question: string;
  multi: boolean;
  options: PollOption[];
}

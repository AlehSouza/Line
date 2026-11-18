import type {
  Attachment,
  AuthResponse,
  Category,
  Channel,
  CreateChannelInput,
  CreateServerInput,
  Friend,
  Member,
  Message,
  SavedMessage,
  PublicUser,
  Role,
  SelfUser,
  Server,
  ServerDetail,
  TagStyle,
  UpdateChannelInput,
  UpdateProfileInput,
  UpdateServerInput,
  NameStyle,
  CallLook,
  ProfileConnection,
  ProfileGame,
  UserProfile,
  FavoriteSong,
  NotifySettings,
  ReadState,
  Sound,
  ServerEvent,
  RsvpStatus,
} from '@line/shared';

/** Criar/editar evento (datas em ISO). */
export interface EventInput {
  title: string;
  description: string;
  startsAt: string;
  endsAt: string | null;
  location: string;
  voiceChannelId: string | null;
  game: string;
}

/**
 * O Line tem um servidor público só. Em desenvolvimento (porta 3000) usa o servidor local,
 * a não ser que NEXT_PUBLIC_SERVER_URL diga outro (ex.: https://useline.tech para ver com dados reais).
 */
export const DEFAULT_SERVER_URL =
  process.env.NEXT_PUBLIC_SERVER_URL ||
  (typeof window !== 'undefined' && window.location.port === '3000' ? 'http://localhost:4000' : 'https://useline.tech');

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let baseUrl = DEFAULT_SERVER_URL;
let token: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function configureApi(opts: { baseUrl?: string; token?: string | null; onUnauthorized?: () => void }) {
  if (opts.baseUrl !== undefined) baseUrl = opts.baseUrl.replace(/\/+$/, '');
  if (opts.token !== undefined) token = opts.token;
  if (opts.onUnauthorized) onUnauthorized = opts.onUnauthorized;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, `Não foi possível conectar ao servidor (${baseUrl})`);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized?.();
    throw new ApiError(res.status, data?.message ?? `Erro ${res.status}`);
  }
  return data as T;
}

const enc = encodeURIComponent;

/** URL completa de um arquivo do servidor (anexos vêm com caminho relativo). */
export function fileUrl(path: string) {
  return /^https?:/.test(path) ? path : `${baseUrl}${path}`;
}

/** Jogo de alguém na Atividade (jogando agora ou nas últimas 24 h). */
export interface ServerActivity {
  userId: string;
  playing: boolean;
  name: string;
  since?: string;
  lastPlayed?: string;
  icon?: string | null;
  cover?: string | null;
  totalSecs?: number | null;
  /** Segundos jogados nesta semana (sem a sessão aberta). */
  weekSecs?: number | null;
}

export interface MyGame {
  name: string;
  icon?: string | null;
  cover?: string | null;
  firstPlayed: string;
  lastPlayed: string;
  totalSecs: number;
  hidden: boolean;
}

export interface ActivitySettings {
  share: boolean;
  scope: 'all' | 'small' | 'none';
  hiddenServers: string[];
}

/** Resposta inteligente do agente: pergunta, texto e até 4 imagens/vídeos. */
export interface AgentReply {
  q: string;
  a: string;
  media?: { id: string; filename: string; contentType: string; url: string }[];
}

/** Envia um arquivo cru (sem multipart) e acompanha o progresso. */
/** Largura e altura reais de uma imagem/vídeo (para o chat reservar o espaço exato). */
function mediaSize(file: Blob): Promise<{ w: number; h: number } | null> {
  const type = file.type;
  if (!/^(image|video)\//.test(type) || type === 'image/svg+xml' || typeof document === 'undefined') return Promise.resolve(null);
  const url = URL.createObjectURL(file);
  const done = (v: { w: number; h: number } | null) => {
    URL.revokeObjectURL(url);
    return v && v.w > 0 && v.h > 0 ? v : null;
  };
  const measure = new Promise<{ w: number; h: number } | null>((resolve) => {
    if (type.startsWith('video/')) {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.onloadedmetadata = () => resolve({ w: v.videoWidth, h: v.videoHeight });
      v.onerror = () => resolve(null);
      v.src = url;
    } else {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = url;
    }
  });
  const timeout = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 5000));
  return Promise.race([measure, timeout]).then(done);
}

async function uploadAttachment(file: File | Blob, filename: string, onProgress?: (fraction: number) => void) {
  const dims = await mediaSize(file).catch(() => null);
  return new Promise<Attachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${baseUrl}/api/attachments`);
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.setRequestHeader('x-filename', enc(filename));
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    if (dims) {
      xhr.setRequestHeader('x-width', String(Math.round(dims.w)));
      xhr.setRequestHeader('x-height', String(Math.round(dims.h)));
    }
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data: { message?: string } | null = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        /* resposta sem JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as Attachment);
      else {
        if (xhr.status === 401 && token) onUnauthorized?.();
        reject(new ApiError(xhr.status, data?.message ?? (xhr.status === 413 ? 'Arquivo grande demais (máximo 100 MB)' : `Erro ${xhr.status}`)));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, `Não foi possível conectar ao servidor (${baseUrl})`));
    xhr.send(file);
  });
}

/** Baixa uma imagem/vídeo de outro site pelo servidor (o navegador esbarra no CORS). */
async function fetchMedia(url: string): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/media?url=${enc(url)}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new ApiError(0, `Não foi possível conectar ao servidor (${baseUrl})`);
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.message ?? 'Não deu para baixar esse arquivo.');
  }
  return res.blob();
}

/** GIF do GIPHY, buscado pelo servidor. */
export interface Gif {
  id: string;
  title: string;
  preview: string;
  url: string;
  width: number;
  height: number;
}

/** Preview de um link do chat, montado pelo servidor. */
export interface LinkEmbed {
  url: string;
  siteName?: string | null;
  title?: string | null;
  description?: string | null;
  image?: string | null;
  youtubeId?: string | null;
}

export const api = {
  /** Bug report, sugestão ou denúncia (cai no painel administrador). */
  report: (input: {
    kind: 'bug' | 'idea' | 'user' | 'message' | 'nsfw';
    targetUserId?: string;
    /** Denúncia +18: o anexo e se o detector deste aparelho concordou. */
    attachmentId?: string;
    detected?: boolean;
    messageId?: string;
    reason?: string;
    details?: string;
    platform?: string;
    version?: string;
    /** Ids de imagens enviadas antes com uploadAttachment (até 5). */
    images?: string[];
  }) => request<{ id: string }>('POST', '/reports', input),
  health: () => request<{ ok: boolean; name: string }>('GET', '/health'),
  register: (username: string, password: string, displayName?: string, email?: string, captchaToken?: string) =>
    request<AuthResponse>('POST', '/auth/register', { username, password, displayName, email, captchaToken }),
  authConfig: () => request<{ turnstileSiteKey: string | null; passwordReset?: boolean; google?: boolean }>('GET', '/auth/config'),
  googleFinish: (code: string, desktop = false) => request<AuthResponse>('POST', '/auth/google/finish', { code, desktop }),
  forgotPassword: (email: string) => request<void>('POST', '/auth/forgot', { email }),
  resetInfo: (token: string) =>
    request<{ username: string; displayName: string; avatarUrl?: string | null; avatarColor: string }>('GET', `/auth/reset/info?token=${enc(token)}`),
  /** Manda o link de "redefinir senha" para o email da própria conta. */
  sendResetLink: () => request<{ email: string }>('POST', '/users/@me/password/link'),
  resetPassword: (token: string, newPassword: string) =>
    request<{ username: string }>('POST', '/auth/reset', { token, newPassword }),
  login: (username: string, password: string) => request<AuthResponse>('POST', '/auth/login', { username, password }),

  me: () => request<SelfUser>('GET', '/users/@me'),
  updateMe: (patch: UpdateProfileInput) => request<SelfUser>('PATCH', '/users/@me', patch),
  /** Data de nascimento AAAA-MM-DD (null apaga). */
  setBirthDate: (birthDate: string | null) => request<SelfUser>('PATCH', '/users/@me', { birthDate }),
  setBlurSensitive: (blurSensitive: boolean) => request<SelfUser>('PATCH', '/users/@me', { blurSensitive }),
  updateAccount: (patch: { username?: string; email?: string | null; currentPassword?: string; code?: string }) =>
    request<SelfUser>('PATCH', '/users/@me/account', patch),
  changePassword: (proof: { currentPassword?: string; code?: string }, newPassword: string) =>
    request<{ token: string }>('POST', '/users/@me/password', { ...proof, newPassword }),
  /** Manda um código de 6 caracteres para o email da conta (confirma sem a senha atual). */
  sendEmailCode: () => request<void>('POST', '/users/@me/code'),
  /** Desativa a conta (volta ao entrar de novo). */
  deactivateAccount: (proof: { password?: string; code?: string }) => request<void>('POST', '/users/@me/deactivate', proof),
  /** Exclui a conta para sempre. */
  deleteAccount: (proof: { password?: string; code?: string }) => request<void>('POST', '/users/@me/delete', proof),
  user: (id: string) => request<PublicUser>('GET', `/users/${enc(id)}`),
  profile: (id: string, serverId?: string | null) =>
    request<UserProfile>('GET', `/users/${enc(id)}/profile${serverId ? `?server=${enc(serverId)}` : ''}`),
  updateProfileExtras: (patch: { favoriteSong?: string | null; favoriteGame?: ProfileGame | null; likedGames?: ProfileGame[]; connections?: ProfileConnection[]; nameStyle?: NameStyle | null; cardColors?: string[] | null; callLook?: CallLook | null }) =>
    request<{ favoriteSong?: FavoriteSong | null; cardColors?: string[] | null; callLook?: CallLook | null; favoriteGame: ProfileGame | null; likedGames: ProfileGame[]; connections: ProfileConnection[] }>('PUT', '/users/@me/profile', patch),
  setNote: (id: string, note: string) => request<{ note: string }>('PUT', `/users/${enc(id)}/note`, { note }),
  ignored: () => request<string[]>('GET', '/users/@me/ignored'),
  ignore: (id: string) => request<void>('PUT', `/users/${enc(id)}/ignore`),
  unignore: (id: string) => request<void>('DELETE', `/users/${enc(id)}/ignore`),
  searchGames: (q: string) => request<{ games: ProfileGame[]; enabled: boolean; error?: string }>('GET', `/games/search?q=${enc(q)}`),
  mutual: (id: string) => request<{ friends: PublicUser[]; servers: Server[] }>('GET', `/users/${enc(id)}/mutual`),

  servers: () => request<Server[]>('GET', '/servers'),
  discover: (q = '') => request<Server[]>('GET', `/servers/discover?q=${enc(q)}`),
  createServer: (input: CreateServerInput) => request<Server>('POST', '/servers', input),
  server: (id: string) => request<ServerDetail>('GET', `/servers/${enc(id)}`),
  updateServer: (id: string, patch: UpdateServerInput) => request<Server>('PATCH', `/servers/${enc(id)}`, patch),
  channelEvents: (channelId: string) => request<ServerEvent[]>('GET', `/channels/${enc(channelId)}/events`),
  createEvent: (channelId: string, body: EventInput) => request<ServerEvent>('POST', `/channels/${enc(channelId)}/events`, body),
  updateEvent: (id: string, body: EventInput) => request<ServerEvent>('PATCH', `/events/${enc(id)}`, body),
  deleteEvent: (id: string) => request<void>('DELETE', `/events/${enc(id)}`),
  rsvpEvent: (id: string, status: RsvpStatus | null) => request<ServerEvent>('PUT', `/events/${enc(id)}/rsvp`, { status }),
  /** Notas e Atualizações: mostrar/esconder a categoria e cada canal base. */
  setNotes: (id: string, body: { categoryVisible?: boolean; channels?: Record<string, boolean> }) =>
    request<void>('PUT', `/servers/${enc(id)}/notes`, body),
  /** `/play <link>` no chat: põe o vídeo na fila do canal de voz em que você está. */
  musicPlay: (channelId: string, url: string) => request<void>('POST', `/channels/${enc(channelId)}/music/play`, { url }),
  musicBot: (serverId: string) => request<PublicUser>('GET', `/servers/${enc(serverId)}/music/bot`),
  musicSettings: (serverId: string) => request<{ idleMessage: string; defaultIdleMessage: string }>('GET', `/servers/${enc(serverId)}/music/settings`),
  updateMusicSettings: (serverId: string, patch: { idleMessage: string }) =>
    request<{ idleMessage: string; defaultIdleMessage: string }>('PATCH', `/servers/${enc(serverId)}/music/settings`, patch),
  serverActivities: (serverId: string) => request<ServerActivity[]>('GET', `/servers/${enc(serverId)}/activities`),
  myGames: () => request<{ current: string | null; games: MyGame[]; covers: boolean }>('GET', '/users/@me/games'),
  updateMyGame: (patch: { name: string; hidden?: boolean; remove?: boolean }) => request<{ games: MyGame[] }>('PATCH', '/users/@me/games', patch),
  notifySettings: () => request<NotifySettings>('GET', '/users/@me/notification-settings'),
  setNotifySettings: (s: NotifySettings) => request<NotifySettings>('PUT', '/users/@me/notification-settings', s),
  readStates: () => request<ReadState[]>('GET', '/users/@me/read-states'),
  ack: (channelId: string, messageId?: string) => request<unknown>('POST', `/channels/${enc(channelId)}/ack`, { messageId }),
  ackServer: (serverId: string) => request<unknown>('POST', `/servers/${enc(serverId)}/ack`),
  recentMentions: (o: { server?: string; everyone: boolean; roles: boolean; before?: string }) =>
    request<Message[]>(
      'GET',
      `/users/@me/mentions?everyone=${o.everyone ? 1 : 0}&roles=${o.roles ? 1 : 0}${o.server ? `&server=${enc(o.server)}` : ''}${o.before ? `&before=${enc(o.before)}` : ''}`,
    ),
  activitySettings: () => request<ActivitySettings>('GET', '/users/@me/activity-settings'),
  setActivitySettings: (s: ActivitySettings) => request<ActivitySettings>('PUT', '/users/@me/activity-settings', s),
  agentReplies: (serverId: string) => request<AgentReply[]>('GET', `/servers/${enc(serverId)}/agent/replies`),
  setAgentReplies: (serverId: string, list: AgentReply[]) => request<AgentReply[]>('PUT', `/servers/${enc(serverId)}/agent/replies`, list),
  /** Cartão, estilo do nome, música favorita e visual de chamada do agente (igual ao perfil da pessoa). */
  updateAgentProfile: (serverId: string, patch: { favoriteSong?: string | null; nameStyle?: NameStyle | null; cardColors?: string[] | null; callLook?: CallLook | null }) =>
    request<{ favoriteSong?: FavoriteSong | null; cardColors?: string[] | null; callLook?: CallLook | null }>('PUT', `/servers/${enc(serverId)}/agent/profile`, patch),
  updateMusicBot: (serverId: string, patch: UpdateProfileInput) => request<PublicUser>('PATCH', `/servers/${enc(serverId)}/music/bot`, patch),
  deleteServer: (id: string) => request<void>('DELETE', `/servers/${enc(id)}`),
  leaveServer: (id: string) => request<void>('POST', `/servers/${enc(id)}/leave`),
  serverCard: (id: string) => request<ServerCardInfo>('GET', `/servers/${enc(id)}/card`),
  channelAudience: (id: string) => request<{ userIds: string[] | null }>('GET', `/channels/${enc(id)}/audience`),
  reorderMyServers: (serverIds: string[]) => request<void>('PUT', '/users/@me/servers/order', { serverIds }),
  joinPublic: (id: string) => request<Server>('POST', `/servers/${enc(id)}/join`),
  resetInvite: (id: string) => request<Server>('POST', `/servers/${enc(id)}/invite/reset`),
  kick: (serverId: string, userId: string) => request<void>('DELETE', `/servers/${enc(serverId)}/members/${enc(userId)}`),
  setServerProfile: (serverId: string, patch: { avatarId?: string | null; bannerId?: string | null; bio?: string }) =>
    request<Member>('PUT', `/servers/${enc(serverId)}/profile`, patch),
  setNickname: (serverId: string, userId: string, nickname: string | null) =>
    request<Member>('PATCH', `/servers/${enc(serverId)}/members/${enc(userId)}`, { nickname }),
  createRole: (serverId: string, input: { name?: string; color?: string | null; permissions?: number; mentionable?: boolean; hoist?: boolean }) =>
    request<Role>('POST', `/servers/${enc(serverId)}/roles`, input),
  updateRole: (id: string, patch: { name?: string; color?: string | null; permissions?: number; mentionable?: boolean; hoist?: boolean }) =>
    request<Role>('PATCH', `/roles/${enc(id)}`, patch),
  deleteRole: (id: string) => request<void>('DELETE', `/roles/${enc(id)}`),
  reorderRoles: (serverId: string, roleIds: string[]) => request<Role[]>('PUT', `/servers/${enc(serverId)}/roles/order`, { roleIds }),
  setMemberRole: (serverId: string, userId: string, roleId: string, on: boolean) =>
    request<Member>(on ? 'PUT' : 'DELETE', `/servers/${enc(serverId)}/members/${enc(userId)}/roles/${enc(roleId)}`),
  invite: (code: string) => request<Server>('GET', `/invites/${enc(code)}`),
  acceptInvite: (code: string) => request<Server>('POST', `/invites/${enc(code)}`),

  createChannel: (serverId: string, input: CreateChannelInput) =>
    request<Channel>('POST', `/servers/${enc(serverId)}/channels`, input),
  updateChannel: (id: string, patch: UpdateChannelInput) => request<Channel>('PATCH', `/channels/${enc(id)}`, patch),
  setChannelLayout: (serverId: string, categoryIds: string[], channels: { id: string; categoryId: string | null }[]) =>
    request<void>('PUT', `/servers/${enc(serverId)}/layout`, { categoryIds, channels }),
  deleteChannel: (id: string) => request<void>('DELETE', `/channels/${enc(id)}`),
  createCategory: (serverId: string, name: string, roleIds?: string[]) =>
    request<Category>('POST', `/servers/${enc(serverId)}/categories`, roleIds ? { name, isPrivate: true, roleIds } : { name }),
  renameCategory: (id: string, name: string) => request<Category>('PATCH', `/categories/${enc(id)}`, { name }),
  deleteCategory: (id: string) => request<void>('DELETE', `/categories/${enc(id)}`),

  messages: (channelId: string, before?: string, limit = 50) =>
    request<Message[]>('GET', `/channels/${enc(channelId)}/messages?limit=${limit}${before ? `&before=${enc(before)}` : ''}`),
  messagesAround: (channelId: string, messageId: string) =>
    request<Message[]>('GET', `/channels/${enc(channelId)}/messages?around=${enc(messageId)}`),
  search: (params: Record<string, string | undefined>) =>
    request<Message[]>(
      'GET',
      `/search?${Object.entries(params)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}=${enc(v!)}`)
        .join('&')}`,
    ),
  sendMessage: (
    channelId: string,
    content: string,
    attachmentIds: string[] = [],
    requires: string[] = [],
    flags: { spoilerIds?: string[]; nsfwIds?: string[] } = {},
  ) => request<Message>('POST', `/channels/${enc(channelId)}/messages`, { content, attachmentIds, requires, ...flags }),
  uploadAttachment,
  fetchMedia,
  threads: (channelId: string) => request<Channel[]>('GET', `/channels/${enc(channelId)}/threads`),
  createThread: (channelId: string, name: string, messageId?: string) =>
    request<Channel>('POST', `/channels/${enc(channelId)}/threads`, { name, messageId }),
  createPoll: (channelId: string, question: string, options: string[], multi: boolean) =>
    request<Message>('POST', `/channels/${enc(channelId)}/polls`, { question, options, multi }),
  addReaction: (messageId: string, emoji: string) =>
    request<Message>('PUT', `/messages/${enc(messageId)}/reactions/${enc(emoji)}`),
  removeReaction: (messageId: string, emoji: string) =>
    request<Message>('DELETE', `/messages/${enc(messageId)}/reactions/${enc(emoji)}`),
  votePoll: (messageId: string, optionId: string) =>
    request<Message>('POST', `/messages/${enc(messageId)}/poll/votes`, { optionId }),
  /** Fixa a mensagem por `minutes` (null = sempre). */
  pinMessage: (id: string, minutes: number | null) => request<Message>('PUT', `/messages/${enc(id)}/pin`, { minutes }),
  unpinMessage: (id: string) => request<Message>('DELETE', `/messages/${enc(id)}/pin`),
  /** Encaminha para canais do mesmo servidor ou DMs de amigos (até 5), com comentário opcional. */
  forwardMessage: (id: string, channelIds: string[], note = '') =>
    request<Message[]>('POST', `/messages/${enc(id)}/forward`, { channelIds, note }),
  saved: () => request<SavedMessage[]>('GET', '/users/@me/saved'),
  savedIds: () => request<string[]>('GET', '/users/@me/saved/ids'),
  saveMessage: (id: string) => request<unknown>('PUT', `/messages/${enc(id)}/save`),
  unsaveMessage: (id: string) => request<unknown>('DELETE', `/messages/${enc(id)}/save`),
  pins: (channelId: string) => request<Message[]>('GET', `/channels/${enc(channelId)}/pins`),
  editMessage: (id: string, content: string) => request<Message>('PATCH', `/messages/${enc(id)}`, { content }),
  deleteMessage: (id: string) => request<void>('DELETE', `/messages/${enc(id)}`),

  /** Sons do painel de efeitos sonoros de todos os meus servidores. */
  soundboard: () => request<Sound[]>('GET', '/soundboard'),
  createSound: (serverId: string, input: { attachmentId: string; name: string; emoji: string; volume: number }) =>
    request<Sound>('POST', `/servers/${enc(serverId)}/sounds`, input),
  updateSound: (serverId: string, id: string, input: { name: string; emoji: string; volume: number }) =>
    request<Sound>('PATCH', `/servers/${enc(serverId)}/sounds/${enc(id)}`, input),
  deleteSound: (serverId: string, id: string) => request<void>('DELETE', `/servers/${enc(serverId)}/sounds/${enc(id)}`),

  iceServers: () => request<{ iceServers: RTCIceServer[] }>('GET', '/voice/ice'),

  dms: () => request<Channel[]>('GET', '/dms'),
  openDm: (userIds: string[], name?: string) => request<Channel>('POST', '/dms', { userIds, name }),
  leaveGroup: (id: string) => request<void>('POST', `/dms/${enc(id)}/leave`),

  friends: () => request<Friend[]>('GET', '/friends'),
  addFriend: (username: string) => request<Friend>('POST', '/friends', { username }),
  acceptFriend: (userId: string) => request<Friend>('PUT', `/friends/${enc(userId)}`),
  removeFriend: (userId: string) => request<void>('DELETE', `/friends/${enc(userId)}`),
  blockUser: (userId: string) => request<Friend>('PUT', `/friends/${enc(userId)}/block`),
  unblockUser: (userId: string) => request<void>('DELETE', `/friends/${enc(userId)}/block`),

  gifs: (q = '', offset = 0) => request<Gif[]>('GET', `/gifs?q=${enc(q)}&offset=${offset}`),
  embed: (url: string) => request<LinkEmbed | null>('GET', `/embeds?url=${enc(url)}`),
};

/** Cartão do servidor (clique na tag). Privado e sem ser membro: só foto e banner. */
export type ServerCardInfo =
  | { id: string; private: true; iconUrl: string | null; bannerUrl: string | null }
  | {
      id: string;
      private: false;
      member: boolean;
      name: string;
      description: string;
      iconUrl: string | null;
      bannerUrl: string | null;
      tag: string;
      tagIcon: string;
      tagStyle?: TagStyle | null;
      memberCount: number;
      onlineCount: number;
      createdAt: string;
    };

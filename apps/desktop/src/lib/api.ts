import type {
  Attachment,
  AuthResponse,
  Category,
  Channel,
  CreateChannelInput,
  CreateServerInput,
  Friend,
  Message,
  PublicUser,
  SelfUser,
  Server,
  ServerDetail,
  UpdateChannelInput,
  UpdateProfileInput,
  UpdateServerInput,
} from '@line/shared';

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

/** Envia um arquivo cru (sem multipart) e acompanha o progresso. */
function uploadAttachment(file: File | Blob, filename: string, onProgress?: (fraction: number) => void) {
  return new Promise<Attachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${baseUrl}/api/attachments`);
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.setRequestHeader('x-filename', enc(filename));
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
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

/** GIF do GIPHY, buscado pelo servidor. */
export interface Gif {
  id: string;
  title: string;
  preview: string;
  url: string;
  width: number;
  height: number;
}

export const api = {
  health: () => request<{ ok: boolean; name: string }>('GET', '/health'),
  register: (username: string, password: string, displayName?: string, email?: string, captchaToken?: string) =>
    request<AuthResponse>('POST', '/auth/register', { username, password, displayName, email, captchaToken }),
  authConfig: () => request<{ turnstileSiteKey: string | null }>('GET', '/auth/config'),
  login: (username: string, password: string) => request<AuthResponse>('POST', '/auth/login', { username, password }),

  me: () => request<SelfUser>('GET', '/users/@me'),
  updateMe: (patch: UpdateProfileInput) => request<SelfUser>('PATCH', '/users/@me', patch),
  updateAccount: (patch: { username?: string; email?: string | null; currentPassword: string }) =>
    request<SelfUser>('PATCH', '/users/@me/account', patch),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('POST', '/users/@me/password', { currentPassword, newPassword }),
  user: (id: string) => request<PublicUser>('GET', `/users/${enc(id)}`),
  mutual: (id: string) => request<{ friends: PublicUser[]; servers: Server[] }>('GET', `/users/${enc(id)}/mutual`),

  servers: () => request<Server[]>('GET', '/servers'),
  discover: (q = '') => request<Server[]>('GET', `/servers/discover?q=${enc(q)}`),
  createServer: (input: CreateServerInput) => request<Server>('POST', '/servers', input),
  server: (id: string) => request<ServerDetail>('GET', `/servers/${enc(id)}`),
  updateServer: (id: string, patch: UpdateServerInput) => request<Server>('PATCH', `/servers/${enc(id)}`, patch),
  deleteServer: (id: string) => request<void>('DELETE', `/servers/${enc(id)}`),
  leaveServer: (id: string) => request<void>('POST', `/servers/${enc(id)}/leave`),
  joinPublic: (id: string) => request<Server>('POST', `/servers/${enc(id)}/join`),
  resetInvite: (id: string) => request<Server>('POST', `/servers/${enc(id)}/invite/reset`),
  kick: (serverId: string, userId: string) => request<void>('DELETE', `/servers/${enc(serverId)}/members/${enc(userId)}`),
  invite: (code: string) => request<Server>('GET', `/invites/${enc(code)}`),
  acceptInvite: (code: string) => request<Server>('POST', `/invites/${enc(code)}`),

  createChannel: (serverId: string, input: CreateChannelInput) =>
    request<Channel>('POST', `/servers/${enc(serverId)}/channels`, input),
  updateChannel: (id: string, patch: UpdateChannelInput) => request<Channel>('PATCH', `/channels/${enc(id)}`, patch),
  deleteChannel: (id: string) => request<void>('DELETE', `/channels/${enc(id)}`),
  createCategory: (serverId: string, name: string) =>
    request<Category>('POST', `/servers/${enc(serverId)}/categories`, { name }),
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
  sendMessage: (channelId: string, content: string, attachmentIds: string[] = []) =>
    request<Message>('POST', `/channels/${enc(channelId)}/messages`, { content, attachmentIds }),
  uploadAttachment,
  threads: (channelId: string) => request<Channel[]>('GET', `/channels/${enc(channelId)}/threads`),
  createThread: (channelId: string, name: string, messageId?: string) =>
    request<Channel>('POST', `/channels/${enc(channelId)}/threads`, { name, messageId }),
  createPoll: (channelId: string, question: string, options: string[], multi: boolean) =>
    request<Message>('POST', `/channels/${enc(channelId)}/polls`, { question, options, multi }),
  votePoll: (messageId: string, optionId: string) =>
    request<Message>('POST', `/messages/${enc(messageId)}/poll/votes`, { optionId }),
  editMessage: (id: string, content: string) => request<Message>('PATCH', `/messages/${enc(id)}`, { content }),
  deleteMessage: (id: string) => request<void>('DELETE', `/messages/${enc(id)}`),

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
};

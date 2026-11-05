import type {
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

export const DEFAULT_SERVER_URL = 'http://localhost:4000';

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

export const api = {
  health: () => request<{ ok: boolean; name: string }>('GET', '/health'),
  register: (username: string, password: string, displayName?: string) =>
    request<AuthResponse>('POST', '/auth/register', { username, password, displayName }),
  login: (username: string, password: string) => request<AuthResponse>('POST', '/auth/login', { username, password }),

  me: () => request<SelfUser>('GET', '/users/@me'),
  updateMe: (patch: UpdateProfileInput) => request<SelfUser>('PATCH', '/users/@me', patch),
  user: (id: string) => request<PublicUser>('GET', `/users/${enc(id)}`),

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
  sendMessage: (channelId: string, content: string) =>
    request<Message>('POST', `/channels/${enc(channelId)}/messages`, { content }),
  editMessage: (id: string, content: string) => request<Message>('PATCH', `/messages/${enc(id)}`, { content }),
  deleteMessage: (id: string) => request<void>('DELETE', `/messages/${enc(id)}`),

  dms: () => request<Channel[]>('GET', '/dms'),
  openDm: (userIds: string[], name?: string) => request<Channel>('POST', '/dms', { userIds, name }),
  leaveGroup: (id: string) => request<void>('POST', `/dms/${enc(id)}/leave`),

  friends: () => request<Friend[]>('GET', '/friends'),
  addFriend: (username: string) => request<Friend>('POST', '/friends', { username }),
  acceptFriend: (userId: string) => request<Friend>('PUT', `/friends/${enc(userId)}`),
  removeFriend: (userId: string) => request<void>('DELETE', `/friends/${enc(userId)}`),
};

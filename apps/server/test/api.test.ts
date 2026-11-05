import type { AuthResponse, ClientToServerEvents, Message, ServerDetail, ServerToClientEvents } from '@line/shared';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type LineApp } from '../src/app';
import { loadConfig } from '../src/config';

let line: LineApp;
let base: string;
const sockets: Socket[] = [];

beforeAll(async () => {
  line = await buildApp(loadConfig({ dbFile: ':memory:', dataDir: '/tmp/line-test', jwtSecret: 'test-secret' }));
  await line.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = line.app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await line.app.close();
});

async function api<T = unknown>(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

async function register(username: string) {
  const { status, data } = await api<AuthResponse>('POST', '/auth/register', undefined, { username, password: 'senha123' });
  expect(status).toBe(201);
  return data;
}

function socketFor(token: string): Promise<Socket<ServerToClientEvents, ClientToServerEvents>> {
  return new Promise((resolve, reject) => {
    const s: Socket<ServerToClientEvents, ClientToServerEvents> = connect(base, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });
    sockets.push(s);
    s.once('ready', () => resolve(s));
    s.once('connect_error', reject);
  });
}

function next<E extends keyof ServerToClientEvents>(s: Socket<ServerToClientEvents, ClientToServerEvents>, event: E) {
  return new Promise<Parameters<ServerToClientEvents[E]>[0]>((resolve) => {
    s.once(event as never, ((payload: never) => resolve(payload)) as never);
  });
}

describe('Line server', () => {
  let ana: AuthResponse;
  let bia: AuthResponse;

  it('cadastra e faz login', async () => {
    ana = await register('ana');
    bia = await register('Bia');
    expect(bia.user.username).toBe('bia');

    const dup = await api('POST', '/auth/register', undefined, { username: 'ana', password: 'outra123' });
    expect(dup.status).toBe(409);

    const bad = await api('POST', '/auth/login', undefined, { username: 'ana', password: 'errada' });
    expect(bad.status).toBe(401);

    const ok = await api<AuthResponse>('POST', '/auth/login', undefined, { username: 'ana', password: 'senha123' });
    expect(ok.status).toBe(200);
    expect(ok.data.user.id).toBe(ana.user.id);

    const me = await api('GET', '/users/@me');
    expect(me.status).toBe(401);
  });

  it('cria servidor, entra por convite e troca mensagens em tempo real', async () => {
    const created = await api<{ id: string; inviteCode: string }>('POST', '/servers', ana.token, { name: 'Resenha' });
    expect(created.status).toBe(201);

    const detail = await api<ServerDetail>('GET', `/servers/${created.data.id}`, ana.token);
    expect(detail.data.categories.map((c) => c.name)).toEqual(['Canais de texto', 'Canais de voz']);
    const geral = detail.data.channels.find((c) => c.name === 'geral')!;

    // Bia ainda não é membro
    expect((await api('GET', `/channels/${geral.id}/messages`, bia.token)).status).toBe(404);

    const biaSocket = await socketFor(bia.token);
    const anaSocket = await socketFor(ana.token);

    const joined = next(anaSocket, 'member:add');
    expect((await api('POST', `/invites/${created.data.inviteCode}`, bia.token)).status).toBe(200);
    expect((await joined).user.id).toBe(bia.user.id);

    const received = next(biaSocket, 'message:create');
    const sent = await api<Message>('POST', `/channels/${geral.id}/messages`, ana.token, { content: 'Fala, galera!' });
    expect(sent.status).toBe(201);
    expect((await received).content).toBe('Fala, galera!');

    // Bia não pode editar a mensagem da Ana, mas a Ana pode
    expect((await api('PATCH', `/messages/${sent.data.id}`, bia.token, { content: 'hack' })).status).toBe(403);
    const edited = next(biaSocket, 'message:update');
    await api('PATCH', `/messages/${sent.data.id}`, ana.token, { content: 'Fala, pessoal!' });
    expect((await edited).editedAt).not.toBeNull();

    // Só o dono cria canais
    expect((await api('POST', `/servers/${created.data.id}/channels`, bia.token, { name: 'memes' })).status).toBe(403);
    const ch = await api<{ name: string }>('POST', `/servers/${created.data.id}/channels`, ana.token, { name: 'Memes Bons' });
    expect(ch.data.name).toBe('memes-bons');

    // Paginação
    for (let i = 0; i < 5; i++) await api('POST', `/channels/${geral.id}/messages`, bia.token, { content: `msg ${i}` });
    const page = await api<Message[]>('GET', `/channels/${geral.id}/messages?limit=3`, bia.token);
    expect(page.data.map((m) => m.content)).toEqual(['msg 2', 'msg 3', 'msg 4']);
    const older = await api<Message[]>('GET', `/channels/${geral.id}/messages?limit=3&before=${page.data[0]!.id}`, bia.token);
    expect(older.data.map((m) => m.content)).toEqual(['Fala, pessoal!', 'msg 0', 'msg 1']);
  });

  it('DMs, amizades e presença', async () => {
    const cris = await register('cris');
    const anaSocket = await socketFor(ana.token);

    const request = next(anaSocket, 'friend:update');
    expect((await api('POST', '/friends', cris.token, { username: 'ana' })).status).toBe(201);
    expect((await request).state).toBe('incoming');

    await api('PUT', `/friends/${cris.user.id}`, ana.token);
    const friends = await api<{ state: string }[]>('GET', '/friends', ana.token);
    expect(friends.data[0]?.state).toBe('friends');

    // Cris fica online -> Ana recebe presença
    const online = next(anaSocket, 'presence:update');
    const crisSocket = await socketFor(cris.token);
    expect(await online).toMatchObject({ userId: cris.user.id, presence: 'online' });

    // Cris fica invisível -> aparece offline
    const invisible = next(anaSocket, 'presence:update');
    await api('PATCH', '/users/@me', cris.token, { status: 'invisible' });
    expect((await invisible).presence).toBe('offline');

    // DM 1:1 é reaproveitada
    const dm = await api<{ id: string; type: string }>('POST', '/dms', ana.token, { userIds: ['cris'] });
    expect(dm.data.type).toBe('dm');
    const again = await api<{ id: string }>('POST', '/dms', cris.token, { userIds: [ana.user.id] });
    expect(again.data.id).toBe(dm.data.id);

    const got = next(crisSocket, 'message:create');
    await api('POST', `/channels/${dm.data.id}/messages`, ana.token, { content: 'oi, sumida' });
    expect((await got).content).toBe('oi, sumida');
    expect((await api('GET', `/channels/${dm.data.id}/messages`, bia.token)).status).toBe(404);

    const group = await api<{ type: string; recipients: unknown[] }>('POST', '/dms', ana.token, {
      userIds: ['cris', 'bia'],
      name: 'Rolê',
    });
    expect(group.data.type).toBe('group_dm');
    expect(group.data.recipients).toHaveLength(3);
  });
});

import type { Attachment, AuthResponse, Channel, ClientToServerEvents, Message, ServerDetail, ServerToClientEvents } from '@line/shared';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Testes de contrato: sobem o binário Rust (`cargo build -p line-server`) e falam com ele
 * exatamente como o app faz (fetch + socket.io-client). Garantem que o protocolo não mudou.
 */
const BIN = path.resolve(import.meta.dirname, '../../../target/debug', process.platform === 'win32' ? 'line-server.exe' : 'line-server');

let child: ChildProcess;
let base: string;
const sockets: Socket[] = [];

beforeAll(async () => {
  child = spawn(BIN, [], {
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      DB_FILE: ':memory:',
      DATA_DIR: mkdtempSync(path.join(tmpdir(), 'line-test-')),
      JWT_SECRET: 'test-secret',
      RUST_LOG: 'warn',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const m = out.match(/LINE_LISTENING (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.once('exit', (code) => reject(new Error(`line-server saiu com código ${code}`)));
    child.once('error', reject);
  });
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  child?.kill();
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

  it('voz: entrar, sinalizar entre pares e sair', async () => {
    const dora = await register('dora');
    const edu = await register('edu');
    const srv = await api<{ id: string; inviteCode: string }>('POST', '/servers', dora.token, { name: 'Call' });
    await api('POST', `/invites/${srv.data.inviteCode}`, edu.token);
    const detail = await api<ServerDetail>('GET', `/servers/${srv.data.id}`, dora.token);
    const voice = detail.data.channels.find((c) => c.type === 'voice')!;
    const text = detail.data.channels.find((c) => c.type === 'text')!;

    const ds = await socketFor(dora.token);
    const es = await socketFor(edu.token);

    const bad = await ds.emitWithAck('voice:join', { channelId: text.id });
    expect(bad.ok).toBe(false);

    const first = await ds.emitWithAck('voice:join', { channelId: voice.id });
    expect(first).toEqual({ ok: true, peers: [] });

    const seen = next(ds, 'voice:update');
    const second = await es.emitWithAck('voice:join', { channelId: voice.id, muted: true });
    expect(second.ok && second.peers.map((p) => p.userId)).toEqual([dora.user.id]);
    expect((await seen).state).toMatchObject({ userId: edu.user.id, muted: true });

    const signal = next(es, 'voice:signal');
    ds.emit('voice:signal', { to: edu.user.id, signal: { type: 'candidate', candidate: null } });
    expect(await signal).toEqual({ from: dora.user.id, signal: { type: 'candidate', candidate: null } });

    const cam = next(ds, 'voice:update');
    es.emit('voice:state', { cameraStreamId: 'abc' });
    expect((await cam).state?.cameraStreamId).toBe('abc');

    const left = next(ds, 'voice:update');
    es.disconnect();
    expect(await left).toMatchObject({ userId: edu.user.id, state: null });
  });

  it('gerência: perfil, descoberta, categorias, expulsão e grupos', async () => {
    const fabi = await register('fabi');
    const gui = await register('gui');

    // Perfil: status personalizado vazio vira null; validação devolve 400 com mensagem
    const prof = await api<{ customStatus: string | null; bio: string }>('PATCH', '/users/@me', fabi.token, {
      bio: 'oi',
      customStatus: '',
    });
    expect(prof.data).toMatchObject({ bio: 'oi', customStatus: null });
    const badColor = await api<{ error: string }>('PATCH', '/users/@me', fabi.token, { avatarColor: 'azul' });
    expect(badColor.status).toBe(400);
    expect(badColor.data.error).toBe('validation');
    expect((await api('POST', '/auth/register', undefined, { username: 'x', password: 'senha123' })).status).toBe(400);

    // Servidor público aparece no explorar de quem não é membro
    const srv = await api<{ id: string; isPublic: boolean }>('POST', '/servers', fabi.token, { name: 'Aberto', isPublic: true });
    expect(srv.data.isPublic).toBe(true);
    const found = await api<{ id: string }[]>('GET', '/servers/discover?q=Abe', gui.token);
    expect(found.data.map((s) => s.id)).toContain(srv.data.id);
    expect((await api('POST', `/servers/${srv.data.id}/join`, gui.token)).status).toBe(200);
    expect((await api<unknown[]>('GET', '/servers/discover', gui.token)).data.length).toBe(0);

    // Apagar categoria solta os canais dela
    const cat = await api<{ id: string }>('POST', `/servers/${srv.data.id}/categories`, fabi.token, { name: 'Extra' });
    const ch = await api<{ id: string; categoryId: string }>('POST', `/servers/${srv.data.id}/channels`, fabi.token, {
      name: 'solto',
      categoryId: cat.data.id,
    });
    expect(ch.data.categoryId).toBe(cat.data.id);
    expect((await api('DELETE', `/categories/${cat.data.id}`, fabi.token)).status).toBe(204);
    const loose = await api<{ categoryId: string | null }>('GET', `/channels/${ch.data.id}`, fabi.token);
    expect(loose.data.categoryId).toBeNull();
    const moved = await api<{ position: number; categoryId: string | null }>('PATCH', `/channels/${ch.data.id}`, fabi.token, {
      position: 7,
      categoryId: null,
    });
    expect(moved.data).toMatchObject({ position: 7, categoryId: null });

    // Expulsar: o expulso recebe server:delete e perde acesso
    const gs = await socketFor(gui.token);
    const kicked = next(gs, 'server:delete');
    expect((await api('DELETE', `/servers/${srv.data.id}/members/${gui.user.id}`, fabi.token)).status).toBe(204);
    expect((await kicked).id).toBe(srv.data.id);
    expect((await api('GET', `/servers/${srv.data.id}`, gui.token)).status).toBe(404);

    // Grupo: sair avisa quem fica
    const group = await api<{ id: string }>('POST', '/dms', fabi.token, { userIds: ['gui', 'ana'], name: 'Trio' });
    const fs = await socketFor(fabi.token);
    const updated = next(fs, 'channel:update');
    expect((await api('POST', `/dms/${group.data.id}/leave`, gui.token)).status).toBe(204);
    expect((await updated).recipients).toHaveLength(2);

    // Mensagem do dono pode ser apagada; rota desconhecida dá 404
    const dm = await api<{ id: string }>('POST', '/dms', fabi.token, { userIds: [gui.user.id] });
    const msg = await api<{ id: string }>('POST', `/channels/${dm.data.id}/messages`, fabi.token, { content: '  oi  ' });
    expect((await api<{ content: string }>('GET', `/channels/${dm.data.id}/messages`, gui.token)).data[0]?.content).toBe('oi');
    expect((await api('DELETE', `/messages/${msg.data.id}`, gui.token)).status).toBe(403);
    expect((await api('DELETE', `/messages/${msg.data.id}`, fabi.token)).status).toBe(204);
    expect((await api('GET', '/nada', fabi.token)).status).toBe(404);
    expect((await api<{ ok: boolean }>('GET', '/health')).data.ok).toBe(true);
  });

  it('anexos e threads', async () => {
    const hel = await register('helena');
    const ivo = await register('ivo');
    const srv = await api<{ id: string; inviteCode: string }>('POST', '/servers', hel.token, { name: 'Arquivos' });
    await api('POST', `/invites/${srv.data.inviteCode}`, ivo.token);
    const detail = await api<ServerDetail>('GET', `/servers/${srv.data.id}`, hel.token);
    const text = detail.data.channels.find((c) => c.type === 'text')!;
    const voice = detail.data.channels.find((c) => c.type === 'voice')!;

    // Upload cru com o nome no cabeçalho
    const bytes = new TextEncoder().encode('linha 1\nlinha 2\n');
    const up = await fetch(`${base}/api/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${hel.token}`, 'x-filename': encodeURIComponent('notas da call.txt'), 'content-type': 'text/plain' },
      body: bytes,
    });
    expect(up.status).toBe(201);
    const att = (await up.json()) as Attachment;
    expect(att).toMatchObject({ filename: 'notas da call.txt', contentType: 'text/plain', size: bytes.length });
    expect(att.url).toBe(`/api/attachments/${att.id}/notas%20da%20call.txt`);
    expect((await fetch(`${base}/api/attachments`, { method: 'POST', body: bytes })).status).toBe(401);

    // Mensagem só com anexo; outra pessoa não pode reaproveitar o anexo
    expect((await api('POST', `/channels/${text.id}/messages`, ivo.token, { attachmentIds: [att.id] })).status).toBe(400);
    const is = await socketFor(ivo.token);
    const got = next(is, 'message:create');
    const msg = await api<Message>('POST', `/channels/${text.id}/messages`, hel.token, { attachmentIds: [att.id] });
    expect(msg.status).toBe(201);
    expect(msg.data.content).toBe('');
    expect(msg.data.attachments).toEqual([att]);
    expect((await got).attachments[0]?.id).toBe(att.id);
    expect((await api('POST', `/channels/${text.id}/messages`, hel.token, { attachmentIds: [att.id] })).status).toBe(400);
    expect((await api('POST', `/channels/${text.id}/messages`, hel.token, {})).status).toBe(400);

    // Download sem login (id impossível de adivinhar), com Range
    const file = await fetch(`${base}${att.url}`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toContain('text/plain');
    expect(await file.text()).toBe('linha 1\nlinha 2\n');
    const part = await fetch(`${base}${att.url}`, { headers: { range: 'bytes=0-4' } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('linha');
    expect((await fetch(`${base}/api/attachments/naoexiste/x.txt`)).status).toBe(404);

    // Thread a partir da mensagem
    expect((await api('POST', `/channels/${voice.id}/threads`, hel.token, { name: 'x' })).status).toBe(400);
    const created = next(is, 'channel:create');
    const updatedStarter = next(is, 'message:update');
    const thread = await api<Channel>('POST', `/channels/${text.id}/threads`, ivo.token, { name: 'Sobre as notas', messageId: msg.data.id });
    expect(thread.status).toBe(201);
    expect(thread.data).toMatchObject({ type: 'thread', parentId: text.id, threadMessageId: msg.data.id, ownerId: ivo.user.id, messageCount: 0 });
    expect((await created).id).toBe(thread.data.id);
    expect((await updatedStarter).thread).toMatchObject({ id: thread.data.id, name: 'Sobre as notas', messageCount: 0 });
    expect((await api('POST', `/channels/${text.id}/threads`, hel.token, { name: 'de novo', messageId: msg.data.id })).status).toBe(409);

    // Responder na thread atualiza o contador na mensagem original
    const counted = next(is, 'message:update');
    await api('POST', `/channels/${thread.data.id}/messages`, hel.token, { content: 'boa' });
    expect((await counted).thread?.messageCount).toBe(1);
    const list = await api<Message[]>('GET', `/channels/${text.id}/messages`, ivo.token);
    expect(list.data[0]?.thread?.messageCount).toBe(1);
    expect((await api<Channel[]>('GET', `/channels/${text.id}/threads`, ivo.token)).data).toHaveLength(1);
    expect((await is.emitWithAck('voice:join', { channelId: thread.data.id })).ok).toBe(false);

    // Quem criou a thread pode apagar; o resumo some da mensagem
    const gone = next(is, 'channel:delete');
    expect((await api('DELETE', `/channels/${thread.data.id}`, ivo.token)).status).toBe(204);
    expect((await gone).id).toBe(thread.data.id);
    expect((await api<Message[]>('GET', `/channels/${text.id}/messages`, ivo.token)).data[0]?.thread).toBeNull();

    // Apagar a mensagem apaga o arquivo
    expect((await api('DELETE', `/messages/${msg.data.id}`, hel.token)).status).toBe(204);
    expect((await fetch(`${base}${att.url}`)).status).toBe(404);
  });
});

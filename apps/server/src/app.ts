import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { resolveJwtSecret, TokenService } from './auth';
import type { Config } from './config';
import { openDatabase, type DB } from './db';
import { HttpError, unauthorized } from './errors';
import { Gateway } from './gateway';
import { PresenceTracker } from './presence';
import { authRoutes } from './routes/auth';
import { channelRoutes } from './routes/channels';
import { dmRoutes } from './routes/dms';
import { friendRoutes } from './routes/friends';
import { serverRoutes } from './routes/servers';
import { userRoutes } from './routes/users';
import { Store } from './store';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

export interface Ctx {
  store: Store;
  gateway: Gateway;
  tokens: TokenService;
  /** Lê o usuário autenticado (lança 401 se não houver). */
  auth: (req: FastifyRequest) => Promise<string>;
}

export interface LineApp {
  app: FastifyInstance;
  db: DB;
  ctx: Ctx;
}

export async function buildApp(config: Config, opts: { logger?: boolean } = {}): Promise<LineApp> {
  const db = openDatabase(config.dbFile);
  const presence = new PresenceTracker();
  const store = new Store(db, presence);
  const tokens = new TokenService(resolveJwtSecret(config.dataDir, config.jwtSecret, config.dbFile !== ':memory:'));
  const gateway = new Gateway(store, presence, tokens);

  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cors, { origin: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });

  const auth = async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const userId = token ? await tokens.verify(token) : null;
    if (!userId || !store.selfUser(userId)) throw unauthorized();
    req.userId = userId;
    return userId;
  };

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: 'validation', message: error.issues[0]?.message ?? 'Dados inválidos' });
    }
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({ error: error.code, message: error.message });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({ error: 'bad_request', message: (error as Error).message });
    }
    app.log.error(error);
    return reply.status(500).send({ error: 'internal', message: 'Erro interno do servidor' });
  });

  const ctx: Ctx = { store, gateway, tokens, auth };

  app.get('/api/health', async () => ({ ok: true, name: 'line', version: '0.1.0' }));
  await app.register(async (api) => {
    authRoutes(api, ctx);
    userRoutes(api, ctx);
    serverRoutes(api, ctx);
    channelRoutes(api, ctx);
    dmRoutes(api, ctx);
    friendRoutes(api, ctx);
  }, { prefix: '/api' });

  gateway.attach(app.server);
  app.addHook('preClose', async () => {
    gateway.io.disconnectSockets(true);
    gateway.io.engine.close();
  });
  app.addHook('onClose', async () => {
    db.close();
  });

  return { app, db, ctx };
}

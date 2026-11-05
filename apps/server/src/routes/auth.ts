import { loginSchema, registerSchema, type AuthResponse } from '@line/shared';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../app';
import { hashPassword, verifyPassword } from '../auth';
import { conflict, HttpError } from '../errors';

export function authRoutes(app: FastifyInstance, { store, tokens }: Ctx) {
  app.post('/auth/register', async (req, reply): Promise<AuthResponse> => {
    const input = registerSchema.parse(req.body);
    if (store.userByUsername(input.username)) throw conflict('Esse nome de usuário já está em uso');
    const user = store.createUser({
      username: input.username,
      displayName: input.displayName ?? input.username,
      passwordHash: await hashPassword(input.password),
    });
    reply.status(201);
    return { token: await tokens.sign(user.id), user };
  });

  app.post('/auth/login', async (req): Promise<AuthResponse> => {
    const input = loginSchema.parse(req.body);
    const row = store.userByUsername(input.username);
    if (!row || !(await verifyPassword(input.password, row.password_hash))) {
      throw new HttpError(401, 'invalid_credentials', 'Usuário ou senha incorretos');
    }
    return { token: await tokens.sign(row.id), user: store.toSelfUser(row) };
  });
}

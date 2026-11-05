import { updateProfileSchema } from '@line/shared';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../app';
import { notFound } from '../errors';

export function userRoutes(app: FastifyInstance, { store, gateway, auth }: Ctx) {
  app.get('/users/@me', async (req) => store.selfUser(await auth(req)));

  app.patch('/users/@me', async (req) => {
    const me = await auth(req);
    const patch = updateProfileSchema.parse(req.body);
    const user = store.updateUser(me, patch);
    gateway.toUsers([me], 'self:update', user);
    const pub = store.publicUser(me)!;
    gateway.toUsers(store.audienceOf(me), 'user:update', pub);
    gateway.broadcastPresence(me);
    return user;
  });

  app.get<{ Params: { id: string } }>('/users/:id', async (req) => {
    await auth(req);
    const user = store.publicUser(req.params.id);
    if (!user) throw notFound('Usuário');
    return user;
  });
}

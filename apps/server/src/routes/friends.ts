import { friendRequestSchema } from '@line/shared';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../app';
import { badRequest, conflict, notFound } from '../errors';

export function friendRoutes(app: FastifyInstance, { store, gateway, auth }: Ctx) {
  const notifyBoth = (a: string, b: string) => {
    const forA = store.friend(a, b);
    const forB = store.friend(b, a);
    if (forA) gateway.toUsers([a], 'friend:update', forA);
    if (forB) gateway.toUsers([b], 'friend:update', forB);
  };

  app.get('/friends', async (req) => store.friends(await auth(req)));

  app.post('/friends', async (req, reply) => {
    const me = await auth(req);
    const { username } = friendRequestSchema.parse(req.body);
    const target = store.userByUsername(username);
    if (!target) throw notFound('Usuário');
    if (target.id === me) throw badRequest('Você não pode adicionar a si mesmo');
    const result = store.requestFriend(me, target.id);
    if (result === 'exists') throw conflict('Vocês já são amigos ou o pedido já foi enviado');
    notifyBoth(me, target.id);
    if (result === 'accepted') {
      gateway.broadcastPresence(me);
      gateway.broadcastPresence(target.id);
    }
    reply.status(201);
    return store.friend(me, target.id);
  });

  app.put<{ Params: { userId: string } }>('/friends/:userId', async (req) => {
    const me = await auth(req);
    if (!store.acceptFriend(me, req.params.userId)) throw notFound('Pedido de amizade');
    notifyBoth(me, req.params.userId);
    return store.friend(me, req.params.userId);
  });

  app.delete<{ Params: { userId: string } }>('/friends/:userId', async (req, reply) => {
    const me = await auth(req);
    const other = req.params.userId;
    if (!store.removeFriend(me, other)) throw notFound('Amizade');
    gateway.toUsers([me], 'friend:remove', { userId: other });
    gateway.toUsers([other], 'friend:remove', { userId: me });
    reply.status(204);
  });
}

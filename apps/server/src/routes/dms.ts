import { createDmSchema } from '@line/shared';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../app';
import { badRequest, notFound } from '../errors';

export function dmRoutes(app: FastifyInstance, { store, gateway, auth }: Ctx) {
  app.get('/dms', async (req) => store.dmsOf(await auth(req)));

  /** Abre (ou reaproveita) uma DM. Aceita ids ou nomes de usuário. */
  app.post('/dms', async (req, reply) => {
    const me = await auth(req);
    const input = createDmSchema.parse(req.body);
    const ids = new Set<string>();
    for (const ref of input.userIds) {
      const user = store.publicUser(ref) ?? store.userByUsername(ref.toLowerCase());
      if (!user) throw notFound(`Usuário "${ref}"`);
      if (user.id !== me) ids.add(user.id);
    }
    if (ids.size === 0) throw badRequest('Escolha pelo menos uma outra pessoa');

    if (ids.size === 1) {
      const existing = store.findDirectDm(me, [...ids][0]!);
      if (existing) return existing;
    }
    const channel = store.createDm(me, [...ids], input.name);
    gateway.toUsers(store.recipientIds(channel.id), 'channel:create', channel);
    reply.status(201);
    return channel;
  });

  /** Sai de um grupo. DMs 1:1 não são apagadas, só somem quando não há mensagens (fase futura). */
  app.post<{ Params: { id: string } }>('/dms/:id/leave', async (req, reply) => {
    const me = await auth(req);
    const channel = store.channel(req.params.id);
    if (!channel || channel.type !== 'group_dm' || !store.recipientIds(channel.id).includes(me)) throw notFound('Grupo');
    gateway.dropVoice({ channelId: channel.id, userId: me });
    store.leaveGroupDm(channel.id, me);
    gateway.toUsers([me], 'channel:delete', { id: channel.id, serverId: null });
    const updated = store.channel(channel.id);
    if (updated) gateway.toUsers(store.recipientIds(channel.id), 'channel:update', updated);
    reply.status(204);
  });
}

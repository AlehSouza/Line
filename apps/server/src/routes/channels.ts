import { sendMessageSchema, updateChannelSchema } from '@line/shared';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../app';
import { badRequest, forbidden, notFound } from '../errors';

export function channelRoutes(app: FastifyInstance, { store, gateway, auth }: Ctx) {
  const requireAccess = (channelId: string, userId: string) => {
    const channel = store.channel(channelId);
    if (!channel || !gateway.canAccess(userId, channelId)) throw notFound('Canal');
    return channel;
  };

  const requireChannelManager = (channelId: string, userId: string) => {
    const channel = requireAccess(channelId, userId);
    if (!channel.serverId) throw badRequest('Use as rotas de DM para conversas privadas');
    if (store.server(channel.serverId)?.ownerId !== userId) throw forbidden('Só o dono do servidor pode gerenciar canais');
    return channel;
  };

  app.get<{ Params: { id: string } }>('/channels/:id', async (req) => requireAccess(req.params.id, await auth(req)));

  app.patch<{ Params: { id: string } }>('/channels/:id', async (req) => {
    const me = await auth(req);
    const channel = requireChannelManager(req.params.id, me);
    const patch = updateChannelSchema.parse(req.body);
    if (patch.categoryId && store.category(patch.categoryId)?.serverId !== channel.serverId) throw notFound('Categoria');
    const updated = store.updateChannel(channel.id, patch);
    gateway.toServer(channel.serverId!, 'channel:update', updated);
    return updated;
  });

  app.delete<{ Params: { id: string } }>('/channels/:id', async (req, reply) => {
    const me = await auth(req);
    const channel = requireChannelManager(req.params.id, me);
    store.deleteChannel(channel.id);
    gateway.toServer(channel.serverId!, 'channel:delete', { id: channel.id, serverId: channel.serverId });
    reply.status(204);
  });

  // ----- mensagens -----

  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>(
    '/channels/:id/messages',
    async (req) => {
      const me = await auth(req);
      const channel = requireAccess(req.params.id, me);
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
      return store.messages(channel.id, { before: req.query.before, limit });
    },
  );

  app.post<{ Params: { id: string } }>('/channels/:id/messages', async (req, reply) => {
    const me = await auth(req);
    const channel = requireAccess(req.params.id, me);
    if (channel.type === 'voice') throw badRequest('Canais de voz não aceitam mensagens de texto');
    const { content } = sendMessageSchema.parse(req.body);
    const message = store.createMessage(channel.id, me, content);
    gateway.toChannel(channel.id, 'message:create', message);
    reply.status(201);
    return message;
  });

  app.patch<{ Params: { id: string } }>('/messages/:id', async (req) => {
    const me = await auth(req);
    const message = store.message(req.params.id);
    if (!message || !gateway.canAccess(me, message.channelId)) throw notFound('Mensagem');
    if (message.author.id !== me) throw forbidden('Você só pode editar suas próprias mensagens');
    const { content } = sendMessageSchema.parse(req.body);
    const updated = store.editMessage(message.id, content);
    gateway.toChannel(message.channelId, 'message:update', updated);
    return updated;
  });

  app.delete<{ Params: { id: string } }>('/messages/:id', async (req, reply) => {
    const me = await auth(req);
    const message = store.message(req.params.id);
    if (!message || !gateway.canAccess(me, message.channelId)) throw notFound('Mensagem');
    const channel = store.channel(message.channelId)!;
    const isServerOwner = !!channel.serverId && store.server(channel.serverId)?.ownerId === me;
    if (message.author.id !== me && !isServerOwner) throw forbidden('Você não pode apagar esta mensagem');
    store.deleteMessage(message.id);
    gateway.toChannel(channel.id, 'message:delete', { id: message.id, channelId: channel.id });
    reply.status(204);
  });
}

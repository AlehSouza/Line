import {
  createCategorySchema,
  createChannelSchema,
  createServerSchema,
  updateServerSchema,
  type ServerDetail,
} from '@line/shared';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../app';
import { badRequest, forbidden, notFound } from '../errors';

export function serverRoutes(app: FastifyInstance, ctx: Ctx) {
  const { store, gateway, auth } = ctx;

  const requireMember = (serverId: string, userId: string) => {
    const server = store.server(serverId);
    if (!server || !store.isMember(serverId, userId)) throw notFound('Servidor');
    return server;
  };
  // Fase 1: só o dono gerencia. Cargos e permissões chegam na fase 3.
  const requireOwner = (serverId: string, userId: string) => {
    const server = requireMember(serverId, userId);
    if (server.ownerId !== userId) throw forbidden('Só o dono do servidor pode fazer isso');
    return server;
  };

  app.get('/servers', async (req) => store.serversOf(await auth(req)));

  app.get<{ Querystring: { q?: string } }>('/servers/discover', async (req) =>
    store.discoverServers(await auth(req), (req.query.q ?? '').slice(0, 100)),
  );

  app.post('/servers', async (req, reply) => {
    const me = await auth(req);
    const input = createServerSchema.parse(req.body);
    const server = store.createServer(me, input);
    gateway.joinServer(me, server.id);
    gateway.toUsers([me], 'server:create', server);
    reply.status(201);
    return server;
  });

  app.get<{ Params: { id: string } }>('/servers/:id', async (req): Promise<ServerDetail> => {
    const me = await auth(req);
    const server = requireMember(req.params.id, me);
    return {
      server,
      categories: store.categories(server.id),
      channels: store.channels(server.id),
      members: store.members(server.id),
    };
  });

  app.patch<{ Params: { id: string } }>('/servers/:id', async (req) => {
    const me = await auth(req);
    requireOwner(req.params.id, me);
    const server = store.updateServer(req.params.id, updateServerSchema.parse(req.body));
    gateway.toServer(server.id, 'server:update', server);
    return server;
  });

  app.delete<{ Params: { id: string } }>('/servers/:id', async (req, reply) => {
    const me = await auth(req);
    const server = requireOwner(req.params.id, me);
    gateway.toServer(server.id, 'server:delete', { id: server.id });
    gateway.closeServerRoom(server.id);
    store.deleteServer(server.id);
    reply.status(204);
  });

  app.post<{ Params: { id: string } }>('/servers/:id/invite/reset', async (req) => {
    const me = await auth(req);
    requireOwner(req.params.id, me);
    const server = store.resetInvite(req.params.id);
    gateway.toServer(server.id, 'server:update', server);
    return server;
  });

  app.post<{ Params: { id: string } }>('/servers/:id/leave', async (req, reply) => {
    const me = await auth(req);
    const server = requireMember(req.params.id, me);
    if (server.ownerId === me) throw badRequest('O dono não pode sair; exclua o servidor');
    store.removeMember(server.id, me);
    gateway.leaveServer(me, server.id);
    gateway.toUsers([me], 'server:delete', { id: server.id });
    gateway.toServer(server.id, 'member:remove', { serverId: server.id, userId: me });
    reply.status(204);
  });

  app.delete<{ Params: { id: string; userId: string } }>('/servers/:id/members/:userId', async (req, reply) => {
    const me = await auth(req);
    const server = requireOwner(req.params.id, me);
    const target = req.params.userId;
    if (target === me) throw badRequest('Você não pode expulsar a si mesmo');
    if (!store.isMember(server.id, target)) throw notFound('Membro');
    store.removeMember(server.id, target);
    gateway.leaveServer(target, server.id);
    gateway.toUsers([target], 'server:delete', { id: server.id });
    gateway.toServer(server.id, 'member:remove', { serverId: server.id, userId: target });
    reply.status(204);
  });

  // ----- convites -----

  app.get<{ Params: { code: string } }>('/invites/:code', async (req) => {
    await auth(req);
    const server = store.serverByInvite(req.params.code);
    if (!server) throw notFound('Convite');
    return server;
  });

  app.post<{ Params: { code: string } }>('/invites/:code', async (req) => joinServer(await auth(req), store.serverByInvite(req.params.code)));

  app.post<{ Params: { id: string } }>('/servers/:id/join', async (req) => {
    const me = await auth(req);
    const server = store.server(req.params.id);
    if (!server?.isPublic) throw notFound('Servidor');
    return joinServer(me, server);
  });

  function joinServer(me: string, server: ReturnType<typeof store.server>) {
    if (!server) throw notFound('Convite');
    if (!store.isMember(server.id, me)) {
      const member = store.addMember(server.id, me);
      gateway.toServer(server.id, 'member:add', member);
      gateway.joinServer(me, server.id);
      const fresh = store.server(server.id)!;
      gateway.toUsers([me], 'server:create', fresh);
      gateway.broadcastPresence(me);
      return fresh;
    }
    return server;
  }

  // ----- canais e categorias -----

  app.post<{ Params: { id: string } }>('/servers/:id/channels', async (req, reply) => {
    const me = await auth(req);
    requireOwner(req.params.id, me);
    const input = createChannelSchema.parse(req.body);
    if (input.categoryId && store.category(input.categoryId)?.serverId !== req.params.id) throw notFound('Categoria');
    const channel = store.createChannel(req.params.id, input);
    gateway.toServer(req.params.id, 'channel:create', channel);
    reply.status(201);
    return channel;
  });

  app.post<{ Params: { id: string } }>('/servers/:id/categories', async (req, reply) => {
    const me = await auth(req);
    requireOwner(req.params.id, me);
    const { name } = createCategorySchema.parse(req.body);
    const category = store.createCategory(req.params.id, name);
    gateway.toServer(req.params.id, 'category:create', category);
    reply.status(201);
    return category;
  });

  app.patch<{ Params: { id: string } }>('/categories/:id', async (req) => {
    const me = await auth(req);
    const category = store.category(req.params.id);
    if (!category) throw notFound('Categoria');
    requireOwner(category.serverId, me);
    const { name } = createCategorySchema.parse(req.body);
    const updated = store.renameCategory(category.id, name);
    gateway.toServer(category.serverId, 'category:update', updated);
    return updated;
  });

  app.delete<{ Params: { id: string } }>('/categories/:id', async (req, reply) => {
    const me = await auth(req);
    const category = store.category(req.params.id);
    if (!category) throw notFound('Categoria');
    requireOwner(category.serverId, me);
    // Os canais da categoria ficam "soltos" (ON DELETE SET NULL).
    const affected = store.channels(category.serverId).filter((c) => c.categoryId === category.id);
    store.deleteCategory(category.id);
    gateway.toServer(category.serverId, 'category:delete', { id: category.id, serverId: category.serverId });
    for (const c of affected) gateway.toServer(category.serverId, 'channel:update', store.channel(c.id)!);
    reply.status(204);
  });
}

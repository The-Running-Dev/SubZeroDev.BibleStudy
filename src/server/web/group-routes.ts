import type { FastifyInstance } from 'fastify';
import type { ClientMessage, CreatedInvitation, GroupSummary, GroupView, InvitationView, ServerMessage } from '../../shared/api.ts';
import { createInvitation, getGroup, listGroups, listInvitations, removeMember, revokeInvitation } from '../groups/groups.ts';
import type { RealtimeHub } from '../study/realtime.ts';
import type { AppDeps } from './app.ts';
import { requireAuth } from './auth.ts';

type Params = Record<string, string>;

function parseMessage(raw: unknown): ClientMessage | null {
  try {
    const message = JSON.parse(String(raw)) as Partial<ClientMessage> | null;
    if (message?.t === 'ping' && typeof message.clientSentMs === 'number' && Number.isFinite(message.clientSentMs)) return message as ClientMessage;
  } catch {
    // Not JSON; answered below like any other unknown message.
  }
  return null;
}

export function registerGroupRoutes(app: FastifyInstance, deps: AppDeps, hub: RealtimeHub): void {
  app.get('/api/groups', async (request): Promise<GroupSummary[]> => listGroups(deps.db, requireAuth(request).userId));

  app.get('/api/groups/:groupId', async (request): Promise<GroupView> => {
    const { groupId } = request.params as Params;
    return getGroup(deps.db, requireAuth(request).userId, groupId);
  });

  app.post('/api/groups/:groupId/invitations', async (request): Promise<CreatedInvitation> => {
    const { groupId } = request.params as Params;
    return createInvitation(deps.db, deps.clock, deps.config.publicUrl, requireAuth(request).userId, groupId);
  });

  app.get('/api/groups/:groupId/invitations', async (request): Promise<InvitationView[]> => {
    const { groupId } = request.params as Params;
    return listInvitations(deps.db, deps.clock, requireAuth(request).userId, groupId);
  });

  app.delete('/api/groups/:groupId/invitations/:invitationId', async (request, reply) => {
    const { groupId, invitationId } = request.params as Params;
    await revokeInvitation(deps.db, deps.clock, requireAuth(request).userId, groupId, invitationId);
    return reply.status(204).send();
  });

  app.delete('/api/groups/:groupId/members/:userId', async (request, reply) => {
    const { groupId, userId } = request.params as Params;
    hub.closeUser(await removeMember(deps.db, deps.clock, requireAuth(request).userId, groupId, userId));
    return reply.status(204).send();
  });

  // The realtime channel. The onRequest hook authenticates the upgrade like any API call.
  app.get('/ws', { websocket: true }, (socket, request) => {
    const { userId } = requireAuth(request);
    const unregister = hub.register(userId, socket);
    socket.on('close', unregister);
    socket.on('message', (raw) => {
      const message = parseMessage(raw);
      const reply: ServerMessage = message
        ? { t: 'pong', clientSentMs: message.clientSentMs, serverMs: deps.clock.now().getTime() }
        : { t: 'error', error: 'invalid_request', retryable: false };
      socket.send(JSON.stringify(reply));
    });
  });
}

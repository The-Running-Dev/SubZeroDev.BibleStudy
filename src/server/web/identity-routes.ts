import type { FastifyInstance } from 'fastify';
import type { AcceptInvitationResponse, VerifyCodeResponse } from '../../shared/api.ts';
import { acceptInvitation } from '../groups/groups.ts';
import type { IdentityDeps } from '../identity/codes.ts';
import { loginCodeStatus, requestLoginCode, verifyLoginCode } from '../identity/codes.ts';
import { getProfile, updateProfile } from '../identity/profile.ts';
import { revokeSession } from '../identity/sessions.ts';
import { withTransaction } from '../platform/db.ts';
import type { RealtimeHub } from '../study/realtime.ts';
import type { AppDeps } from './app.ts';
import { requireAuth } from './auth.ts';
import { sessionCookie, setSessionCookie } from './cookies.ts';

type Body = Record<string, unknown> | undefined;

export function registerIdentityRoutes(app: FastifyInstance, deps: AppDeps, hub: RealtimeHub): void {
  const identity: IdentityDeps = {
    db: deps.db,
    clock: deps.clock,
    outbox: deps.outbox,
    codePepper: deps.codePepper,
    publicUrl: deps.config.publicUrl,
    ownerEmail: deps.config.ownerEmail,
  };

  app.post('/api/auth/code', async (request) => {
    const body = request.body as Body;
    const result = await requestLoginCode(identity, { email: body?.email, ip: request.ip, invitationToken: body?.invitationToken });
    deps.onEmailQueued?.();
    return result;
  });

  app.post('/api/auth/verify', async (request, reply): Promise<VerifyCodeResponse> => {
    const body = request.body as Body;
    const session = await verifyLoginCode(identity, { email: body?.email, code: body?.code, invitationToken: body?.invitationToken });
    setSessionCookie(reply, deps.config, session.token, session.expiresAt);
    return { user: session.user, joinedGroupId: session.joinedGroupId, invitation: session.invitation };
  });

  app.get('/api/auth/code-status', async (request) => {
    const query = request.query as Record<string, unknown>;
    return loginCodeStatus(identity, query.email);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const { sessionId } = requireAuth(request);
    await revokeSession(deps.db, deps.clock, sessionId);
    // Realtime connections opened with this session end with it.
    hub.closeAuthSession(sessionId);
    reply.clearCookie(sessionCookie, { path: '/' });
    return reply.status(204).send();
  });

  // A link opened by someone already signed in joins without a new code.
  app.post('/api/invitations/accept', async (request): Promise<AcceptInvitationResponse> => {
    const userId = requireAuth(request).userId;
    const token = (request.body as Body)?.token;
    const accepted = await withTransaction(deps.db, (tx) => acceptInvitation(tx, deps.clock, userId, token));
    return 'groupId' in accepted ? { joinedGroupId: accepted.groupId, invitation: 'accepted' } : { joinedGroupId: null, invitation: 'invalid' };
  });

  app.get('/api/me', async (request) => getProfile(deps.db, requireAuth(request).userId));

  app.patch('/api/me', async (request) => updateProfile(deps.db, requireAuth(request).userId, request.body));
}

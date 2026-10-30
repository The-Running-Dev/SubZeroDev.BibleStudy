import type { FastifyInstance } from 'fastify';
import type { VerifyCodeResponse } from '../../shared/api.ts';
import type { IdentityDeps } from '../identity/codes.ts';
import { loginCodeStatus, requestLoginCode, verifyLoginCode } from '../identity/codes.ts';
import { getProfile, updateProfile } from '../identity/profile.ts';
import { revokeSession } from '../identity/sessions.ts';
import type { AppDeps } from './app.ts';
import { sessionCookie, setSessionCookie } from './cookies.ts';

type Body = Record<string, unknown> | undefined;

export function registerIdentityRoutes(app: FastifyInstance, deps: AppDeps): void {
  const identity: IdentityDeps = {
    db: deps.db,
    clock: deps.clock,
    outbox: deps.outbox,
    codePepper: deps.codePepper,
    publicUrl: deps.config.publicUrl,
  };

  app.post('/api/auth/code', async (request) => {
    const body = request.body as Body;
    const result = await requestLoginCode(identity, { email: body?.email, ip: request.ip });
    deps.onEmailQueued?.();
    return result;
  });

  app.post('/api/auth/verify', async (request, reply): Promise<VerifyCodeResponse> => {
    const body = request.body as Body;
    const session = await verifyLoginCode(identity, { email: body?.email, code: body?.code });
    setSessionCookie(reply, deps.config, session.token, session.expiresAt);
    // Invitations arrive with S4; until then every sign-in reports none.
    return { user: session.user, joinedGroupId: null, invitation: 'none' };
  });

  app.get('/api/auth/code-status', async (request) => {
    const query = request.query as Record<string, unknown>;
    return loginCodeStatus(identity, query.email);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    await revokeSession(deps.db, deps.clock, request.auth!.sessionId);
    reply.clearCookie(sessionCookie, { path: '/' });
    return reply.status(204).send();
  });

  app.get('/api/me', async (request) => getProfile(deps.db, request.auth!.userId));

  app.patch('/api/me', async (request) => updateProfile(deps.db, request.auth!.userId, request.body));
}

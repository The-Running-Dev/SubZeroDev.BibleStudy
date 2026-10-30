import type { FastifyRequest } from 'fastify';
import type { Authenticated } from '../identity/sessions.ts';
import { AppError } from '../platform/errors.ts';

// The caller of a protected route. The onRequest hook has already authenticated it; this refuses
// rather than trusting that, so a route the hook ever misses fails closed.
export function requireAuth(request: FastifyRequest): Authenticated {
  if (!request.auth) throw new AppError('unauthenticated', 401, 'Sign in to continue.');
  return request.auth;
}

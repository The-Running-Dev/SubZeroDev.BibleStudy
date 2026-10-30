import type { FastifyReply } from 'fastify';
import type { Config } from '../platform/config.ts';

export const sessionCookie = 'bs_session';

export function setSessionCookie(reply: FastifyReply, config: Config, token: string, expiresAt: Date): void {
  reply.setCookie(sessionCookie, token, { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/', expires: expiresAt });
}

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { Outbox } from '../mail/outbox.ts';
import type { Clock } from '../platform/clock.ts';
import type { Config } from '../platform/config.ts';
import type { Db } from '../platform/db.ts';
import { AppError } from '../platform/errors.ts';
import { log } from '../platform/log.ts';
import { sessionCookie, setSessionCookie } from './cookies.ts';
import { registerAssistantRoutes } from './assistant-routes.ts';
import { registerContentRoutes } from './content-routes.ts';
import { registerGroupRoutes } from './group-routes.ts';
import { registerIdentityRoutes } from './identity-routes.ts';
import { registerProgressRoutes } from './progress-routes.ts';
import { registerQuestionRoutes } from './question-routes.ts';
import { registerScheduleRoutes } from './schedule-routes.ts';
import { registerStudyRoutes } from './study-routes.ts';
import type { Authenticated } from '../identity/sessions.ts';
import { authenticate } from '../identity/sessions.ts';
import type { RealtimeHub } from '../study/realtime.ts';
import { createRealtimeHub } from '../study/realtime.ts';

// API paths reachable without a session. Recordings under /media/ need one too.
const publicApiPaths = new Set(['/api/auth/code', '/api/auth/verify', '/api/auth/code-status']);

declare module 'fastify' {
  interface FastifyRequest {
    auth: Authenticated | null;
  }
}

function decodedPath(url: string): string {
  const path = url.split('?')[0];
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export interface AppDeps {
  config: Config;
  db: Db;
  clock: Clock;
  outbox: Outbox;
  codePepper: Buffer;
  // Wakes the mail worker after a job is enqueued, so a code goes out without waiting for the next poll.
  onEmailQueued?: () => void;
  // Wakes the audio worker after a recording is queued for on-demand import.
  onAudioQueued?: () => void;
  // Open realtime connections; tests pass their own to watch them.
  hub?: RealtimeHub;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  // A hop count trusts that many proxies nearest the server, the same rule proxy-addr applies to a number.
  const hops = config.trustProxy;
  const trustProxy = typeof hops === 'number' ? (_address: string, hop: number) => hop < hops : hops;
  const options: FastifyServerOptions = { logger: false, trustProxy, bodyLimit: 256 * 1024 };
  const app = Fastify(options);

  await app.register(fastifyCookie);
  // Sized for the connector's link, which carries whole answers; /ws enforces its own smaller limit.
  await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (request, reply) => {
    // Decide on the matched route, not the raw URL: Fastify decodes the path before routing, so
    // "/%61pi/me" reaches the /api/me handler while its raw URL does not start with /api/.
    // Unmatched paths are judged by their decoded form, so an unknown /api/ path is refused before it 404s.
    const route = request.routeOptions.url ?? decodedPath(request.url);
    const protectedRoute = route.startsWith('/api/') || route.startsWith('/media/') || route === '/ws';
    if (!protectedRoute || publicApiPaths.has(route)) return;
    const auth = await authenticate(deps.db, deps.clock, request.cookies[sessionCookie]);
    if (!auth) throw new AppError('unauthenticated', 401, 'Sign in to continue.');
    request.auth = auth;
    const token = request.cookies[sessionCookie];
    if (auth.renewedUntil && token) setSessionCookie(reply, config, token, auth.renewedUntil);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      if (error.code === 'rate_limited' && typeof error.details?.retryAfterSeconds === 'number') {
        reply.header('retry-after', String(error.details.retryAfterSeconds));
      }
      return reply.status(error.status).send(error.toBody());
    }
    const fastifyError = error as { statusCode?: number; message?: string; code?: string };
    if (fastifyError.statusCode && fastifyError.statusCode >= 400 && fastifyError.statusCode < 500) {
      return reply.status(400).send({ error: 'invalid_request', message: fastifyError.message ?? 'Bad request.', retryable: false });
    }
    const pgCode = fastifyError.code ?? '';
    if (pgCode === 'ECONNREFUSED' || pgCode.startsWith('08') || pgCode === '57P01') {
      return reply.status(503).send({ error: 'unavailable', message: 'The service is temporarily unavailable.', retryable: true });
    }
    log('error', 'request failed', { requestId: request.id, method: request.method, url: request.url.split('?')[0], error: fastifyError.message });
    return reply.status(500).send({ error: 'internal', message: `Something went wrong (request ${request.id}).`, retryable: false });
  });

  app.get('/__build-id', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return { buildId: config.buildId };
  });

  const hub = deps.hub ?? createRealtimeHub();
  app.addHook('onClose', async () => hub.stop());
  registerIdentityRoutes(app, deps, hub);
  registerContentRoutes(app, deps);
  registerGroupRoutes(app, deps, hub);
  registerStudyRoutes(app, deps, hub);
  registerQuestionRoutes(app, deps, hub);
  registerProgressRoutes(app, deps);
  registerScheduleRoutes(app, deps);
  registerAssistantRoutes(app, deps, hub);

  const staticRoot = resolve(config.staticDir);
  const hasClient = existsSync(resolve(staticRoot, 'index.html'));
  if (hasClient) {
    await app.register(fastifyStatic, {
      root: staticRoot,
      wildcard: false,
      setHeaders(res, filePath) {
        if (/[\\/]assets[\\/]/.test(filePath)) res.header('cache-control', 'public, max-age=31536000, immutable');
        else res.header('cache-control', 'no-cache');
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/media/') || request.method !== 'GET' || !hasClient) {
      return reply.status(404).send({ error: 'not_found', message: 'Not found.', retryable: false });
    }
    // Client-side routes all load the app shell.
    reply.header('cache-control', 'no-cache');
    return reply.sendFile('index.html');
  });

  return app;
}

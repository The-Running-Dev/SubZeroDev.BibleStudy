import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { AssistantStatus, AssistantTranscript, SendTurnResponse } from '../../shared/api.ts';
import type { Assistant } from '../assistant/assistant.ts';
import { createAssistant } from '../assistant/assistant.ts';
import { AppError } from '../platform/errors.ts';
import type { RealtimeHub } from '../study/realtime.ts';
import type { AppDeps } from './app.ts';
import { requireAuth } from './auth.ts';

type Params = Record<string, string>;

const digest = (value: string) => createHash('sha256').update(value).digest();

// The connector presents CONNECTOR_TOKEN as a bearer. Compared in constant time; no token configured refuses everyone.
export function connectorAuthorized(request: FastifyRequest, token: string | null): boolean {
  if (!token) return false;
  const header = request.headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  return timingSafeEqual(digest(match[1]), digest(token));
}

export function registerAssistantRoutes(app: FastifyInstance, deps: AppDeps, hub: RealtimeHub): Assistant {
  const assistant = createAssistant({ db: deps.db, clock: deps.clock, config: deps.config, hub });
  app.addHook('onClose', async () => assistant.stop());

  app.get('/api/assistant/status', async (request): Promise<AssistantStatus> => assistant.status(requireAuth(request).userId));

  app.get('/api/assistant/conversations', async (request) => assistant.latestConversation(requireAuth(request).userId));

  app.post('/api/assistant/conversations', async (request, reply) => {
    const created = await assistant.createConversation(requireAuth(request).userId);
    return reply.status(201).send(created);
  });

  app.get('/api/assistant/conversations/:id', async (request): Promise<AssistantTranscript> => {
    const { id } = request.params as Params;
    const raw = (request.query as Record<string, unknown>).afterSeq;
    const afterSeq = raw === undefined ? 0 : typeof raw === 'string' && /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isFinite(afterSeq)) throw new AppError('invalid_request', 400, 'afterSeq is a whole number.');
    return assistant.transcript(requireAuth(request).userId, id, afterSeq);
  });

  app.post('/api/assistant/conversations/:id/turns', async (request, reply): Promise<SendTurnResponse> => {
    const { id } = request.params as Params;
    const result = await assistant.sendTurn(requireAuth(request).userId, id, request.body);
    reply.status(result.existing ? 200 : 202);
    return result;
  });

  app.post('/api/assistant/turns/:turnId/interrupt', async (request) => {
    const { turnId } = request.params as Params;
    return assistant.interrupt(requireAuth(request).userId, turnId);
  });

  // The PC connector's link. Not under /api: it carries the connector token, never a browser session.
  app.get(
    '/connector',
    {
      websocket: true,
      preValidation: async (request) => {
        if (!connectorAuthorized(request, deps.config.connectorToken)) throw new AppError('unauthenticated', 401, 'Connector token required.');
      },
    },
    (socket: WebSocket) => {
      const link = assistant.attach(socket);
      socket.on('message', (raw) => link.message(raw));
      socket.on('close', () => link.closed());
    },
  );

  return assistant;
}

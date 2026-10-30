import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { ClientMessage, DriftReport, ServerMessage, StudySessionResponse } from '../../shared/api.ts';
import { closeTooMany } from '../../shared/api.ts';
import { sessionIsValid } from '../identity/sessions.ts';
import { AppError } from '../platform/errors.ts';
import { isUuid } from '../platform/ids.ts';
import { log } from '../platform/log.ts';
import type { RealtimeHub } from '../study/realtime.ts';
import type { StudyDeps } from '../study/sessions.ts';
import { activeSession, applyCommand, driftReport, parseCommand, pauseForEmptyRoom, recordDrift, sessionForMember, startOrJoinSession } from '../study/sessions.ts';
import type { AppDeps } from './app.ts';
import { requireAuth } from './auth.ts';

type Params = Record<string, string>;

// Per-user and per-connection limits on the realtime channel.
export const maxConnectionsPerUser = 8;
const burst = 30;
const refillPerSecond = 10;
// A connection that sends nothing (clients ping every 5 s) for this long is gone.
const heartbeatTimeoutMs = 15_000;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function parseMessage(raw: unknown): ClientMessage | null {
  let message: Record<string, unknown> | null;
  try {
    message = JSON.parse(String(raw)) as Record<string, unknown> | null;
  } catch {
    return null;
  }
  if (!message || typeof message !== 'object') return null;
  switch (message.t) {
    case 'hello':
      return isUuid(message.clientId) ? { t: 'hello', clientId: message.clientId } : null;
    case 'ping':
      return finite(message.clientSentMs) ? { t: 'ping', clientSentMs: message.clientSentMs } : null;
    case 'join':
      return typeof message.sessionId === 'string' ? { t: 'join', sessionId: message.sessionId } : null;
    case 'command': {
      const command = parseCommand(message.command);
      if (!command || typeof message.sessionId !== 'string' || typeof message.commandId !== 'string' || !Number.isInteger(message.expectedRevision)) return null;
      return { t: 'command', sessionId: message.sessionId, commandId: message.commandId, expectedRevision: message.expectedRevision as number, command };
    }
    case 'drift':
      return typeof message.sessionId === 'string' && finite(message.driftMs) && typeof message.ready === 'boolean'
        ? { t: 'drift', sessionId: message.sessionId, driftMs: message.driftMs, ready: message.ready }
        : null;
    default:
      return null;
  }
}

// A browser sends Origin on every WebSocket upgrade; one from another site is refused (cross-site WebSocket hijacking).
function originAllowed(request: FastifyRequest, publicUrl: string): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).host;
    return host === request.headers.host || host === new URL(publicUrl).host;
  } catch {
    return false;
  }
}

export function registerStudyRoutes(app: FastifyInstance, deps: AppDeps, hub: RealtimeHub): void {
  const study: StudyDeps = { db: deps.db, clock: deps.clock, mediaDir: deps.config.mediaDir, onAudioQueued: deps.onAudioQueued };

  hub.onRoomEmpty((sessionId) => {
    pauseForEmptyRoom(study, sessionId, () => hub.presence(sessionId).length > 0)
      .then((state) => {
        if (!state) return;
        log('info', 'paused empty room', { sessionId, positionSeconds: state.positionSeconds });
        // Anyone who joined while the pause was committing hears about it.
        hub.broadcast(sessionId, { t: 'state', state });
      })
      .catch((error: Error) => log('error', 'could not pause empty room', { sessionId, error: error.message }));
  });

  app.post('/api/groups/:groupId/session', async (request): Promise<StudySessionResponse> => {
    const { groupId } = request.params as Params;
    return startOrJoinSession(study, requireAuth(request).userId, groupId);
  });

  app.get('/api/groups/:groupId/session', async (request): Promise<StudySessionResponse> => {
    const { groupId } = request.params as Params;
    return activeSession(study, requireAuth(request).userId, groupId);
  });

  app.get('/api/groups/:groupId/session/:sessionId/drift-report', async (request): Promise<DriftReport> => {
    const { groupId, sessionId } = request.params as Params;
    return driftReport(study, requireAuth(request).userId, groupId, sessionId);
  });

  // The realtime channel. The onRequest hook authenticates the upgrade like any API call.
  app.get(
    '/ws',
    {
      websocket: true,
      preValidation: async (request) => {
        if (!originAllowed(request, deps.config.publicUrl)) throw new AppError('invalid_request', 403, 'Connections from another site are refused.');
        if (hub.connections(requireAuth(request).userId) >= maxConnectionsPerUser) {
          throw new AppError('rate_limited', 429, 'Too many open connections. Close another tab and try again.', { retryable: true });
        }
      },
    },
    (socket: WebSocket, request) => {
      const auth = requireAuth(request);
      // Re-checked after the await below, since another tab may have opened meanwhile.
      const connection = hub.add({ userId: auth.userId, authSessionId: auth.sessionId, displayName: '', socket });
      const reply = (message: ServerMessage) => {
        try {
          socket.send(JSON.stringify(message));
        } catch {
          // Closing; nothing to tell it.
        }
      };
      let tokens = burst;
      let refilledAt = Date.now();
      let lastHeard = Date.now();
      const heartbeat = setInterval(() => {
        if (Date.now() - lastHeard > heartbeatTimeoutMs) socket.terminate();
      }, 5_000);

      // Messages are handled one at a time, in arrival order, so a join completes before the command after it.
      let chain: Promise<void> = deps.db
        .query<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [auth.userId])
        .then((result) => {
          connection.displayName = result.rows[0]?.display_name ?? '';
          if (hub.connections(auth.userId) > maxConnectionsPerUser) {
            hub.remove(connection);
            socket.close(closeTooMany, 'too_many_connections');
          }
        })
        .catch(() => undefined);

      socket.on('close', () => {
        clearInterval(heartbeat);
        hub.remove(connection);
      });
      socket.on('message', (raw) => {
        lastHeard = Date.now();
        const now = Date.now();
        tokens = Math.min(burst, tokens + ((now - refilledAt) / 1000) * refillPerSecond);
        refilledAt = now;
        if (tokens < 1) {
          reply({ t: 'error', error: 'rate_limited', retryable: true });
          return;
        }
        tokens -= 1;
        chain = chain
          .then(() => handle(raw))
          .catch((error: Error) => {
            log('error', 'realtime message failed', { error: error.message });
            reply({ t: 'error', error: 'internal', retryable: true });
          });
      });

      // A join or command acts for the signed-in user; a revoked or expired session ends the channel.
      async function stillSignedIn(): Promise<boolean> {
        if (await sessionIsValid(deps.db, deps.clock, auth.sessionId)) return true;
        hub.closeAuthSession(auth.sessionId);
        return false;
      }

      async function handle(raw: unknown): Promise<void> {
        const message = parseMessage(raw);
        if (!message) return reply({ t: 'error', error: 'invalid_request', retryable: false });
        try {
          switch (message.t) {
            case 'hello':
              connection.clientId = message.clientId;
              return;
            case 'ping':
              return reply({ t: 'pong', clientSentMs: message.clientSentMs, serverMs: deps.clock.now().getTime() });
            case 'join': {
              if (!(await stillSignedIn())) return;
              const { state: checked } = await sessionForMember(study, auth.userId, message.sessionId);
              // Join the room before reading the snapshot, so a change committed in between reaches this connection
              // as a broadcast instead of being lost.
              hub.join(connection, checked.sessionId);
              const { state } = await sessionForMember(study, auth.userId, checked.sessionId);
              return reply({ t: 'snapshot', state, presence: hub.presence(state.sessionId) });
            }
            case 'command': {
              if (!(await stillSignedIn())) return;
              const result = await applyCommand(study, auth.userId, message);
              reply({ t: 'result', commandId: message.commandId, outcome: result.outcome, state: result.state, ...(result.reason ? { reason: result.reason } : {}) });
              if (result.outcome === 'applied') hub.broadcast(result.state.sessionId, { t: 'state', state: result.state }, connection);
              return;
            }
            case 'drift':
              if (connection.sessionId !== message.sessionId) return;
              hub.setReady(connection, message.ready);
              if (message.ready && connection.clientId) await recordDrift(study, auth.userId, message.sessionId, connection.clientId, message.driftMs);
              return;
          }
        } catch (error) {
          if (error instanceof AppError) return reply({ t: 'error', error: error.code, retryable: error.retryable });
          throw error;
        }
      }
    },
  );
}

import type { FastifyInstance } from 'fastify';
import type { PullResponse, PushResult } from '../../shared/api.ts';
import type { PersonalDeps } from '../personal/personal.ts';
import { pull, pushOps } from '../personal/personal.ts';
import type { AppDeps } from './app.ts';
import { requireAuth } from './auth.ts';

// 200 notes of 64 KB each, with room for the JSON around them. Larger batches are refused as payload_too_large.
const pushBodyLimit = 16 * 1024 * 1024;

export function registerSyncRoutes(app: FastifyInstance, deps: AppDeps): void {
  const personal: PersonalDeps = { db: deps.db, clock: deps.clock };

  // The caller's own operations, applied in order; each op says what became of it (I-22).
  app.post('/api/sync/push', { bodyLimit: pushBodyLimit }, async (request): Promise<{ results: PushResult[] }> =>
    pushOps(personal, requireAuth(request).userId, request.body),
  );

  // The caller's own notes changed since `cursor` (all live ones without it), solo position and open conflicts (I-21).
  app.get('/api/sync/pull', async (request): Promise<PullResponse> => {
    const { cursor } = request.query as Record<string, string | undefined>;
    return pull(personal, requireAuth(request).userId, cursor ?? null);
  });
}

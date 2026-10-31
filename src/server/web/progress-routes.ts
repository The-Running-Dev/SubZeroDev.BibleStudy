import type { FastifyInstance } from 'fastify';
import type { GroupProgressView } from '../../shared/api.ts';
import type { ProgressDeps } from '../progress/progress.ts';
import { confirmStoppingPoint, currentStoppingPoint } from '../progress/progress.ts';
import type { AppDeps } from './app.ts';
import { requireAuth } from './auth.ts';

type Params = Record<string, string>;

export function registerProgressRoutes(app: FastifyInstance, deps: AppDeps): void {
  const progress: ProgressDeps = { db: deps.db, clock: deps.clock };

  // The group's stopping point, or null before the first confirmation.
  app.get('/api/groups/:groupId/progress', async (request): Promise<{ progress: GroupProgressView | null }> => {
    const { groupId } = request.params as Params;
    return { progress: await currentStoppingPoint(progress, requireAuth(request).userId, groupId) };
  });

  app.post('/api/groups/:groupId/progress', async (request, reply): Promise<{ id: string }> => {
    const { groupId } = request.params as Params;
    const result = await confirmStoppingPoint(progress, requireAuth(request).userId, groupId, request.body);
    reply.status(201);
    return result;
  });
}

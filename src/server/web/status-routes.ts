import type { FastifyInstance } from 'fastify';
import type { OwnerStatus } from '../../shared/api.ts';
import type { Assistant } from '../assistant/assistant.ts';
import { listGroups } from '../groups/groups.ts';
import { mailStatus } from '../mail/status.ts';
import { databaseUnavailable } from '../platform/db.ts';
import { AppError } from '../platform/errors.ts';
import type { AppDeps } from './app.ts';
import { requireAuth } from './auth.ts';

export function registerStatusRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  assistant: Assistant
): void {
  app.get('/api/owner/status', async (request, reply): Promise<OwnerStatus> => {
    reply.header('cache-control', 'no-store');
    const { userId } = requireAuth(request);
    // v1 has one group. Use its active persisted owner membership, not a client flag or assistant permission.
    if (!(await listGroups(deps.db, userId)).some((group) => group.role === 'owner')) {
      throw new AppError('not_owner', 403, 'Only the group owner can inspect operational status.');
    }
    try {
      return {
        checkedAt: deps.clock.now().toISOString(),
        assistant: assistant.connectorStatus(),
        mail: await mailStatus(deps.db),
      };
    } catch (error) {
      // A pool connection failure may carry internal connection details. Keep them out of this response.
      if (databaseUnavailable(error))
        throw new AppError('unavailable', 503, 'Operational status is unavailable.', {
          retryable: true,
        });
      throw error;
    }
  });
}

import type { FastifyInstance } from 'fastify';
import type { GroupView, OccurrenceView } from '../../shared/api.ts';
import type { ScheduleDeps } from '../schedule/occurrences.ts';
import { listOccurrences, updateOccurrence, updateSchedule } from '../schedule/occurrences.ts';
import type { AppDeps } from './app.ts';
import { requireAuth } from './auth.ts';

type Params = Record<string, string>;

export function registerScheduleRoutes(app: FastifyInstance, deps: AppDeps): void {
  const schedule: ScheduleDeps = { db: deps.db, clock: deps.clock };

  // The meetings starting in [from, to), in the viewer's profile zone; the next eight weeks by default.
  app.get('/api/groups/:groupId/occurrences', async (request): Promise<OccurrenceView[]> => {
    const { groupId } = request.params as Params;
    const { from, to } = request.query as Record<string, string | undefined>;
    return listOccurrences(schedule, requireAuth(request).userId, groupId, { from, to });
  });

  app.patch('/api/groups/:groupId/occurrences/:occurrenceId', async (request): Promise<OccurrenceView> => {
    const { groupId, occurrenceId } = request.params as Params;
    return updateOccurrence(schedule, requireAuth(request).userId, groupId, occurrenceId, request.body);
  });

  app.patch('/api/groups/:groupId/schedule', async (request): Promise<GroupView> => {
    const { groupId } = request.params as Params;
    return updateSchedule(schedule, requireAuth(request).userId, groupId, request.body);
  });
}

import type { FastifyInstance } from 'fastify';
import type { ReminderPreference } from '../../shared/api.ts';
import { getReminderPreference, setReminderPreference } from '../reminders/reminders.ts';
import type { AppDeps } from './app.ts';
import { requireAuth } from './auth.ts';

type Params = Record<string, string>;

export function registerReminderRoutes(app: FastifyInstance, deps: AppDeps): void {
  // The viewer's own reminder emails for this group's meetings.
  app.get('/api/groups/:groupId/reminders', async (request): Promise<ReminderPreference> => {
    const { groupId } = request.params as Params;
    return getReminderPreference(deps.db, requireAuth(request).userId, groupId);
  });

  app.put('/api/groups/:groupId/reminders', async (request): Promise<ReminderPreference> => {
    const { groupId } = request.params as Params;
    return setReminderPreference(deps, requireAuth(request).userId, groupId, request.body);
  });
}

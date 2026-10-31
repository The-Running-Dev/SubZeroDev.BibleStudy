import type { FastifyInstance } from 'fastify';
import { exportPersonal } from '../personal/export.ts';
import type { AppDeps } from './app.ts';
import { requireAuth } from './auth.ts';

export function registerExportRoutes(app: FastifyInstance, deps: AppDeps): void {
  // The caller's own data as a JSON file to keep (S16).
  app.get('/api/export', async (request, reply) => {
    const { userId } = requireAuth(request);
    const now = deps.clock.now();
    const data = await exportPersonal(deps.db, userId, now);
    reply
      .header('cache-control', 'no-store')
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="bible-study-export-${now.toISOString().slice(0, 10)}.json"`);
    return JSON.stringify(data, null, 2);
  });
}

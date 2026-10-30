import type { FastifyInstance } from 'fastify';
import { getChapter, listBooks, listTranslations, parseTranslationId } from '../content/catalog.ts';
import type { AppDeps } from './app.ts';

export function registerContentRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/api/content/translations', async () => listTranslations(deps.db));

  app.get('/api/content/books', async (request) => {
    const query = request.query as Record<string, unknown>;
    return listBooks(deps.db, parseTranslationId(query.translation));
  });

  app.get('/api/content/:translation/:book/:chapter', async (request, reply) => {
    const params = request.params as { translation: string; book: string; chapter: string };
    const chapter = /^\d{1,3}$/.test(params.chapter) ? Number(params.chapter) : NaN;
    const stored = await getChapter(deps.db, parseTranslationId(params.translation), params.book.toUpperCase(), chapter);
    const etag = stored.etag;
    reply.header('etag', etag).header('cache-control', 'private, no-cache');
    if (request.headers['if-none-match'] === etag) return reply.status(304).send();
    return reply.type('application/json; charset=utf-8').send(stored.body);
  });
}

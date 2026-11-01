import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { getChapter, listBooks, listTranslations, parseTranslationId } from '../content/catalog.ts';
import { contentAccess } from '../content/access.ts';
import { requireAuth } from './auth.ts';
import { downloadManifest } from '../content/downloads.ts';
import { mediaPath, sha256Pattern } from '../content/media-store.ts';
import { findMedia, listRecordings } from '../content/narration.ts';
import { AppError } from '../platform/errors.ts';
import type { AppDeps } from './app.ts';

// A single `bytes=` range resolved against the file size; null means serve the whole file, 'unsatisfiable' a 416.
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'unsatisfiable' {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // Several ranges, or a unit we do not serve, are ignored and the whole file is sent (RFC 9110 14.2).
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  // A last position before the first makes the range invalid, so it is ignored like any other bad syntax.
  if (match[2] !== '' && Number(match[2]) < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end: match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1) };
}

const missingMedia = (reason: string) => new AppError('not_found', 404, `Narration unavailable for this chapter: ${reason}`);

export function registerContentRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/api/content/translations', async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    return listTranslations(deps.db, deps.csb ?? null, await contentAccess(deps.db, deps.config, requireAuth(request).userId));
  });

  app.get('/api/content/books', async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    const query = request.query as Record<string, unknown>;
    return listBooks(deps.db, parseTranslationId(query.translation), deps.csb ?? null, await contentAccess(deps.db, deps.config, requireAuth(request).userId));
  });

  app.get('/api/content/:translation/:book/:chapter', async (request, reply) => {
    const params = request.params as { translation: string; book: string; chapter: string };
    const chapter = /^\d{1,3}$/.test(params.chapter) ? Number(params.chapter) : NaN;
    reply.header('cache-control', 'private, no-store');
    const stored = await getChapter(deps.db, parseTranslationId(params.translation), params.book.toUpperCase(), chapter, deps.csb ?? null, await contentAccess(deps.db, deps.config, requireAuth(request).userId));
    const etag = stored.etag;
    reply.header('etag', etag).header('cache-control', params.translation === 'CSB' ? 'private, no-store' : 'private, no-cache');
    if (request.headers['if-none-match'] === etag) return reply.status(304).send();
    return reply.type('application/json; charset=utf-8').send(stored.body);
  });

  // S14: what to store for this chapter offline, and how big it is, before the download starts.
  app.get('/api/content/:translation/:book/:chapter/download-manifest', async (request, reply) => {
    const params = request.params as { translation: string; book: string; chapter: string };
    const chapter = /^\d{1,3}$/.test(params.chapter) ? Number(params.chapter) : NaN;
    const query = request.query as Record<string, unknown>;
    reply.header('cache-control', 'private, no-store');
    const { queued, ...manifest } = await downloadManifest(
      { db: deps.db, clock: deps.clock, mediaDir: deps.config.mediaDir, csb: deps.csb ?? null, access: await contentAccess(deps.db, deps.config, requireAuth(request).userId) },
      parseTranslationId(params.translation),
      params.book.toUpperCase(),
      chapter,
      query.narration === 'true',
    );
    if (queued) deps.onAudioQueued?.();
    reply.header('cache-control', 'no-store');
    return manifest;
  });

  app.get('/api/content/:translation/:book/:chapter/recordings', async (request, reply) => {
    const params = request.params as { translation: string; book: string; chapter: string };
    const chapter = /^\d{1,3}$/.test(params.chapter) ? Number(params.chapter) : NaN;
    const { queued, ...body } = await listRecordings(
      { db: deps.db, clock: deps.clock, mediaDir: deps.config.mediaDir },
      parseTranslationId(params.translation),
      params.book.toUpperCase(),
      chapter,
    );
    if (queued) deps.onAudioQueued?.();
    reply.header('cache-control', 'no-store');
    // 202 while any enabled narrator's recording is still being fetched; the client polls again after 5 s.
    return reply.status(body.preparing.length ? 202 : 200).send(body);
  });

  // Recordings are immutable and named by content hash, so they cache for a year; private, since they sit behind sign-in.
  app.get('/media/:sha256', async (request, reply) => {
    const { sha256 } = request.params as { sha256: string };
    if (!sha256Pattern.test(sha256)) throw missingMedia('no such recording');
    const media = await findMedia(deps.db, sha256);
    if (!media) throw missingMedia('the recording is no longer stored');
    const path = mediaPath(deps.config.mediaDir, sha256, media.mimeType);
    const file = await stat(path).catch(() => null);
    if (!file) throw missingMedia('the media file is missing from the server');

    const etag = `"${sha256}"`;
    reply
      .header('etag', etag)
      .header('accept-ranges', 'bytes')
      .header('cache-control', 'private, max-age=31536000, immutable')
      .type(media.mimeType);
    if (request.headers['if-none-match'] === etag) return reply.status(304).send();

    const ifRange = request.headers['if-range'];
    const range = ifRange && ifRange !== etag ? null : parseRange(request.headers.range, file.size);
    if (range === 'unsatisfiable') {
      // Only the file itself is immutable; a refusal is not cached.
      return reply.status(416).header('cache-control', 'no-store').header('content-range', `bytes */${file.size}`).send();
    }
    if (range) {
      reply.status(206).header('content-range', `bytes ${range.start}-${range.end}/${file.size}`).header('content-length', range.end - range.start + 1);
      return reply.send(createReadStream(path, { start: range.start, end: range.end }));
    }
    reply.header('content-length', file.size);
    return reply.send(createReadStream(path));
  });
}

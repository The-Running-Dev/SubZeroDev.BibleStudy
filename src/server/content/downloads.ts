// What a device stores to read (and hear) a chapter offline (S14). Each asset names the URL the client fetches and
// the SHA-256 of the exact bytes it will receive, so a download is ready only once every hash checks out (I-27).
import { createHash } from 'node:crypto';
import type { DownloadManifest, TranslationId } from '../../shared/api.ts';
import type { Clock } from '../platform/clock.ts';
import type { Db } from '../platform/db.ts';
import { AppError } from '../platform/errors.ts';
import type { ContentAccess } from './access.ts';
import { getChapter } from './catalog.ts';
import type { Csb } from './catalog.ts';
import { listRecordings } from './narration.ts';

export interface DownloadDeps {
  db: Db;
  clock: Clock;
  mediaDir: string;
  csb: Csb | null;
  access?: ContentAccess;
}

export async function downloadManifest(
  deps: DownloadDeps,
  translationId: TranslationId,
  bookId: string,
  chapter: number,
  withNarration: boolean,
): Promise<DownloadManifest & { queued: boolean }> {
  const stored = await getChapter(deps.db, translationId, bookId, chapter, deps.csb, deps.access);
  const assets: DownloadManifest['assets'] = [
    {
      url: `/api/content/${translationId}/${bookId}/${chapter}`,
      sha256: createHash('sha256').update(stored.body).digest('hex'),
      bytes: Buffer.byteLength(stored.body),
      kind: 'chapter',
    },
  ];
  let queued = false;
  if (withNarration) {
    const listing = await listRecordings(deps, translationId, bookId, chapter);
    queued = listing.queued;
    // The recording the reader plays by default is the one downloaded.
    const recording = listing.recordings[0];
    if (!recording) {
      throw listing.preparing.length
        ? new AppError('narration_unavailable', 409, 'The narration is still being prepared; try again in a few seconds.', { retryable: true })
        : new AppError('narration_unavailable', 409, 'This chapter has no narration to download.');
    }
    assets.push({ url: recording.mediaUrl, sha256: recording.mediaSha256, bytes: recording.bytes, kind: 'audio' });
  }
  const { restrictedToUserId } = JSON.parse(stored.body) as { restrictedToUserId?: string };
  return { ...(restrictedToUserId ? { restrictedToUserId } : {}), assets, totalBytes: assets.reduce((sum, a) => sum + a.bytes, 0), expiresAt: stored.expiresAt, queued };
}

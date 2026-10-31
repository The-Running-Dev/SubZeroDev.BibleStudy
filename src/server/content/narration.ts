import type { Availability, PassageRef, RecordingTiming, RecordingView, RecordingsResponse, TranslationId } from '../../shared/api.ts';
import { bookById } from '../../shared/books.ts';
import type { Clock } from '../platform/clock.ts';
import type { Db, Queryable } from '../platform/db.ts';
import { AppError } from '../platform/errors.ts';
import { uuidv7 } from '../platform/ids.ts';
import { log } from '../platform/log.ts';
import type { AoChapter, ContentSource } from './aolab.ts';
import { SourceError, isPermanent } from './aolab.ts';
import { mediaExists, storeMedia } from './media-store.ts';
import { mp3DurationSeconds } from './mp3.ts';

// Narrators, recordings and audio import (S3). Audio is BSB only; CSB has no licensed narration.

export type TimingCheck = { status: 'verified'; starts: number[] } | { status: 'absent' | 'rejected'; reason: string; starts: number[] | null };

// Verse following uses a timing only when it has one start per verse, strictly increasing, all inside the recording (I-13).
export function validateTiming(starts: unknown, verseCount: number, durationSeconds: number): TimingCheck {
  if (starts === null || starts === undefined) return { status: 'absent', reason: 'the source publishes no verse timing for this recording', starts: null };
  if (!Array.isArray(starts) || !starts.every((s) => typeof s === 'number' && Number.isFinite(s))) {
    return { status: 'rejected', reason: 'timing is not a list of numbers', starts: null };
  }
  const list = starts as number[];
  if (list.length !== verseCount) return { status: 'rejected', reason: `verse count ${list.length} ≠ ${verseCount}`, starts: list };
  if (list[0] < 0) return { status: 'rejected', reason: `verse 1 starts before the recording (${list[0]} s)`, starts: list };
  for (let i = 1; i < list.length; i++) {
    if (!(list[i] > list[i - 1])) {
      return { status: 'rejected', reason: `verse ${i + 1} starts at ${list[i]} s, not after verse ${i} at ${list[i - 1]} s`, starts: list };
    }
  }
  const last = list[list.length - 1];
  if (!(last < durationSeconds)) {
    return { status: 'rejected', reason: `verse ${list.length} starts at ${last} s, after the recording ends at ${durationSeconds.toFixed(3)} s`, starts: list };
  }
  return { status: 'verified', starts: list };
}

export interface NarrationDeps {
  db: Db;
  clock: Clock;
  source: ContentSource;
  mediaDir: string;
}

interface NarratorRow {
  id: string;
  display_name: string;
  license: string | null;
  enabled: boolean;
}

export type AudioItem =
  | {
      bookId: string;
      chapter: number;
      narratorId: string;
      status: 'inserted' | 'updated' | 'unchanged';
      mediaSha256: string;
      bytes: number;
      durationSeconds: number;
      timingStatus: 'verified' | 'absent' | 'rejected';
      timingReason: string | null;
    }
  | { bookId: string; chapter: number; narratorId: string; status: 'failed'; reason: string; permanent: boolean };

export interface AudioScope {
  translationId: 'BSB';
  bookId: string;
  chapters: number[];
  narrators?: string[];
}

export interface AudioManifestSummary {
  manifestId: string;
  status: 'succeeded' | 'partial' | 'failed';
  counts: { inserted: number; updated: number; unchanged: number; failed: number };
  items: AudioItem[];
}

// `ROM:1-16`, `ROM:3`, or `ROM` for every chapter.
export function parseAudioScope(spec: string): { bookId: string; chapters: number[] } {
  const match = /^([1-3]?[A-Z]{2,3})(?::(\d{1,3})(?:-(\d{1,3}))?)?$/.exec(spec.trim().toUpperCase());
  const book = match ? bookById(match[1]) : undefined;
  if (!match || !book) throw new Error(`--audio ${spec} is not BOOK, BOOK:N or BOOK:N-M (e.g. ROM:1-16)`);
  const first = match[2] ? Number(match[2]) : 1;
  const last = match[3] ? Number(match[3]) : match[2] ? first : book.chapters;
  if (first < 1 || last > book.chapters || first > last) throw new Error(`--audio ${spec}: ${book.name} has chapters 1-${book.chapters}`);
  return { bookId: book.id, chapters: Array.from({ length: last - first + 1 }, (_, i) => first + i) };
}

async function enabledNarrators(db: Queryable, translationId: TranslationId): Promise<NarratorRow[]> {
  const result = await db.query<NarratorRow>('SELECT id, display_name, license, enabled FROM narrators WHERE translation_id = $1 ORDER BY id', [translationId]);
  return result.rows.filter((n) => n.enabled);
}

// Naming an unknown or disabled narrator; retrying cannot fix it.
export class NarratorError extends Error {}

// Picks the narrators to import. Naming a disabled one is refused: it has no recorded license (I-14).
export async function narratorsFor(db: Queryable, translationId: 'BSB', requested?: string[]): Promise<string[]> {
  const all = await db.query<NarratorRow>('SELECT id, display_name, license, enabled FROM narrators WHERE translation_id = $1 ORDER BY id', [translationId]);
  const enabled = all.rows.filter((n) => n.enabled).map((n) => n.id);
  if (!requested) return enabled;
  for (const id of requested) {
    const row = all.rows.find((n) => n.id === id);
    if (!row) throw new NarratorError(`narrator ${id} is not a ${translationId} narrator; known: ${all.rows.map((n) => n.id).join(', ')}`);
    if (!row.enabled) throw new NarratorError(`narrator ${id} is disabled: no license source is recorded for it. Enabled: ${enabled.join(', ')}`);
  }
  return [...new Set(requested)];
}

// Fetches, verifies and stores one chapter's recording by one narrator. Throws SourceError on a source failure.
async function importOne(deps: NarrationDeps, raw: AoChapter, verseCount: number, bookId: string, chapter: number, narratorId: string): Promise<AudioItem> {
  const link = raw.thisChapterAudioLinks?.[narratorId];
  if (!link) throw new SourceError(`the source has no ${narratorId} recording of ${bookId} ${chapter}`, 404);
  const audio = await deps.source.audio(link);
  const durationSeconds = mp3DurationSeconds(audio.bytes);
  const timingPath = raw.thisChapterAudioTimings?.[narratorId];
  let starts: unknown = null;
  if (timingPath) {
    try {
      starts = (await deps.source.timing(timingPath)).verses;
    } catch (error) {
      if (!(error instanceof SourceError && error.status === 404)) throw error;
    }
  }
  const timing = validateTiming(starts, verseCount, durationSeconds);
  const stored = await storeMedia(deps.mediaDir, audio.bytes, audio.mimeType);
  const reason = timing.status === 'verified' ? null : timing.reason;

  const result = await deps.db.query<{ inserted: boolean }>(
    `INSERT INTO recordings (id, translation_id, book_id, chapter, narrator_id, media_sha256, bytes, duration_seconds, mime_type, source_url, imported_at, timing, timing_status, timing_reason)
     VALUES ($1, 'BSB', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (translation_id, book_id, chapter, narrator_id) DO UPDATE
       SET media_sha256 = excluded.media_sha256, bytes = excluded.bytes, duration_seconds = excluded.duration_seconds, mime_type = excluded.mime_type,
           source_url = excluded.source_url, imported_at = excluded.imported_at, timing = excluded.timing,
           timing_status = excluded.timing_status, timing_reason = excluded.timing_reason
     WHERE (recordings.media_sha256, recordings.timing, recordings.timing_status, recordings.timing_reason)
       IS DISTINCT FROM (excluded.media_sha256, excluded.timing, excluded.timing_status, excluded.timing_reason)
     RETURNING (xmax = 0) AS inserted`,
    [
      uuidv7(deps.clock.now().getTime()),
      bookId,
      chapter,
      narratorId,
      stored.sha256,
      stored.bytes,
      durationSeconds,
      audio.mimeType,
      link,
      deps.clock.now(),
      timing.starts ? JSON.stringify(timing.starts) : null,
      timing.status,
      reason,
    ],
  );
  const status = result.rows.length === 0 ? 'unchanged' : result.rows[0].inserted ? 'inserted' : 'updated';
  return { bookId, chapter, narratorId, status, mediaSha256: stored.sha256, bytes: stored.bytes, durationSeconds, timingStatus: timing.status, timingReason: reason };
}

async function eachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

// Imports recordings for the chapters in scope and writes one ImportManifest for the run.
// The chapters' text must already be imported: timing is checked against their verse counts.
export async function importAudio(deps: NarrationDeps & { concurrency?: number }, scope: AudioScope): Promise<AudioManifestSummary> {
  const { db, clock } = deps;
  const narrators = await narratorsFor(db, scope.translationId, scope.narrators);
  if (narrators.length === 0) throw new Error(`No enabled narrators for ${scope.translationId}`);
  const manifestId = uuidv7(clock.now().getTime());
  await db.query(
    `INSERT INTO import_manifests (id, started_at, scope, source_versions, items, status) VALUES ($1, $2, $3, '{}', '[]', 'running')`,
    [manifestId, clock.now(), JSON.stringify({ ...scope, narrators, kind: 'audio' })],
  );

  const items: AudioItem[] = [];
  try {
    await eachLimited(scope.chapters, deps.concurrency ?? 2, async (chapter) => {
      const fail = (narratorId: string, error: unknown) => {
        const reason = (error as Error).message;
        const permanent = error instanceof SourceError && isPermanent(error.status);
        log('warn', 'audio import failed', { bookId: scope.bookId, chapter, narratorId, error: reason });
        items.push({ bookId: scope.bookId, chapter, narratorId, status: 'failed', reason, permanent });
      };
      const text = await db.query<{ verse_count: number }>('SELECT verse_count FROM chapters WHERE translation_id = $1 AND book_id = $2 AND chapter = $3', [
        scope.translationId,
        scope.bookId,
        chapter,
      ]);
      if (!text.rows[0]) {
        for (const n of narrators) fail(n, new SourceError(`${scope.bookId} ${chapter} text is not imported; run import-content --translation BSB first`, 409));
        return;
      }
      let raw: AoChapter;
      try {
        raw = await deps.source.chapter(scope.translationId, scope.bookId, chapter);
      } catch (error) {
        for (const n of narrators) fail(n, error);
        return;
      }
      for (const narratorId of narrators) {
        try {
          items.push(await importOne(deps, raw, text.rows[0].verse_count, scope.bookId, chapter, narratorId));
        } catch (error) {
          fail(narratorId, error);
        }
      }
    });
  } catch (error) {
    await db
      .query(`UPDATE import_manifests SET finished_at = $2, items = $3, status = 'failed' WHERE id = $1`, [
        manifestId,
        clock.now(),
        JSON.stringify([...items, { status: 'failed', reason: (error as Error).message }]),
      ])
      .catch(() => undefined);
    throw error;
  }

  items.sort((a, b) => a.chapter - b.chapter || a.narratorId.localeCompare(b.narratorId));
  const counts = { inserted: 0, updated: 0, unchanged: 0, failed: 0 };
  for (const item of items) counts[item.status]++;
  const status = counts.failed === 0 ? 'succeeded' : counts.failed === items.length ? 'failed' : 'partial';
  await db.query(`UPDATE import_manifests SET finished_at = $2, items = $3, status = $4 WHERE id = $1`, [manifestId, clock.now(), JSON.stringify(items), status]);
  return { manifestId, status, counts, items };
}

// ---- Serving ----

interface RecordingRow {
  id: string;
  narrator_id: string;
  display_name: string;
  license: string;
  media_sha256: string;
  bytes: string;
  duration_seconds: number;
  mime_type: string;
  timing: number[] | null;
  timing_status: 'verified' | 'absent' | 'rejected';
  timing_reason: string | null;
}

const recordingColumns = `r.id, r.narrator_id, n.display_name, n.license, r.media_sha256, r.bytes, r.duration_seconds, r.mime_type, r.timing, r.timing_status, r.timing_reason`;

function toView(row: RecordingRow): RecordingView {
  const timing: RecordingTiming =
    row.timing_status === 'verified' && row.timing
      ? { status: 'verified', verseStarts: row.timing }
      : { status: row.timing_status === 'verified' ? 'rejected' : row.timing_status, reason: row.timing_reason ?? 'timing missing' };
  return {
    id: row.id,
    narratorId: row.narrator_id,
    narratorName: row.display_name,
    license: row.license,
    mediaUrl: `/media/${row.media_sha256}`,
    mediaSha256: row.media_sha256,
    bytes: Number(row.bytes),
    durationSeconds: row.duration_seconds,
    timing,
  };
}

export async function narrationAvailability(db: Queryable, translationId: TranslationId): Promise<Availability> {
  if (translationId === 'CSB') return { state: 'unavailable', reason: 'No licensed CSB recording.' };
  const narrators = await enabledNarrators(db, translationId);
  return narrators.length ? { state: 'available' } : { state: 'unavailable', reason: 'No narrator has a recorded license.' };
}

// How long a failed on-demand import is reported before the next request tries again.
const failedRetryAfterMinutes = 60;

// Lists the chapter's recordings by enabled narrators. A narrator with no recording yet gets an
// on-demand import job and is listed under `preparing` until the audio worker stores it.
export async function listRecordings(
  deps: { db: Db; clock: Clock; mediaDir: string },
  translationId: TranslationId,
  bookId: string,
  chapter: number,
): Promise<RecordingsResponse & { queued: boolean }> {
  const book = bookById(bookId);
  if (!book || !Number.isInteger(chapter) || chapter < 1 || chapter > book.chapters) {
    throw new AppError('chapter_not_found', 404, `${bookId} ${chapter} is not a chapter.`);
  }
  // A recording is only ever served for its own translation (I-12).
  if (translationId === 'CSB') return { recordings: [], preparing: [], failed: [], queued: false };

  const { db, clock } = deps;
  const text = await db.query('SELECT 1 FROM chapters WHERE translation_id = $1 AND book_id = $2 AND chapter = $3', [translationId, book.id, chapter]);
  if (!text.rowCount) throw new AppError('translation_unavailable', 409, 'BSB text has not been imported yet. Run import-content --translation BSB.');

  const narrators = await enabledNarrators(db, translationId);
  const rows = await db.query<RecordingRow>(
    `SELECT ${recordingColumns} FROM recordings r JOIN narrators n ON n.id = r.narrator_id
     WHERE r.translation_id = $1 AND r.book_id = $2 AND r.chapter = $3 AND n.enabled AND n.translation_id = r.translation_id
     ORDER BY n.id`,
    [translationId, book.id, chapter],
  );
  const response: RecordingsResponse & { queued: boolean } = { recordings: [], preparing: [], failed: [], queued: false };
  // A recording whose file is gone from the volume is fetched again, like one never stored.
  const fileMissing = new Set<string>();
  for (const row of rows.rows) {
    if (mediaExists(deps.mediaDir, row.media_sha256, row.mime_type)) response.recordings.push(toView(row));
    else fileMissing.add(row.narrator_id);
  }

  const missing = narrators.filter((n) => fileMissing.has(n.id) || !rows.rows.some((r) => r.narrator_id === n.id));
  for (const narrator of missing) {
    const now = clock.now();
    // Queue the import, or re-queue one that failed long enough ago; otherwise report the job as it stands.
    // A recording stored since the listing above was read is not queued again.
    const job = await db.query<{ status: 'preparing' | 'failed'; reason: string | null; queued: boolean }>(
      `INSERT INTO audio_jobs (translation_id, book_id, chapter, narrator_id, status, next_attempt_at, updated_at)
       SELECT $1::text, $2::text, $3::int, $4::text, 'preparing', $5::timestamptz, $5::timestamptz
       WHERE $7::boolean OR NOT EXISTS (
         SELECT 1 FROM recordings WHERE translation_id = $1::text AND book_id = $2::text AND chapter = $3::int AND narrator_id = $4::text)
       ON CONFLICT (translation_id, book_id, chapter, narrator_id) DO UPDATE
         SET status = 'preparing', reason = NULL, attempts = 0, next_attempt_at = $5, claimed_at = NULL, updated_at = $5
         WHERE audio_jobs.status = 'failed' AND audio_jobs.updated_at <= $5::timestamptz - make_interval(mins => $6)
       RETURNING status, reason, true AS queued`,
      [translationId, book.id, chapter, narrator.id, now, failedRetryAfterMinutes, fileMissing.has(narrator.id)],
    );
    const state =
      job.rows[0] ??
      (
        await db.query<{ status: 'preparing' | 'failed'; reason: string | null; queued: boolean }>(
          'SELECT status, reason, false AS queued FROM audio_jobs WHERE translation_id = $1 AND book_id = $2 AND chapter = $3 AND narrator_id = $4',
          [translationId, book.id, chapter, narrator.id],
        )
      ).rows[0];
    if (state?.queued) response.queued = true;
    if (state?.status === 'failed') response.failed.push({ narratorId: narrator.id, reason: state.reason ?? 'import failed' });
    // No job: the worker stored the recording meanwhile, and the next poll lists it.
    else response.preparing.push(narrator.id);
  }
  return response;
}

// The recording a study session plays for a passage, or null when none is stored and servable.
export async function resolveRecording(
  deps: { db: Queryable; mediaDir: string },
  translationId: TranslationId,
  ref: PassageRef,
  narratorId: string,
): Promise<RecordingView | null> {
  if (translationId === 'CSB') return null;
  const rows = await deps.db.query<RecordingRow>(
    `SELECT ${recordingColumns} FROM recordings r JOIN narrators n ON n.id = r.narrator_id
     WHERE r.translation_id = $1 AND r.book_id = $2 AND r.chapter = $3 AND r.narrator_id = $4 AND n.enabled AND n.translation_id = r.translation_id`,
    [translationId, ref.bookId, ref.chapter, narratorId],
  );
  const row = rows.rows[0];
  return row && mediaExists(deps.mediaDir, row.media_sha256, row.mime_type) ? toView(row) : null;
}

// The stored file behind a media URL, if a recording by an enabled narrator still names it.
export async function findMedia(db: Queryable, sha256: string): Promise<{ mimeType: string; bytes: number } | null> {
  const result = await db.query<{ mime_type: string; bytes: string }>(
    `SELECT r.mime_type, r.bytes FROM recordings r JOIN narrators n ON n.id = r.narrator_id
     WHERE r.media_sha256 = $1 AND n.enabled AND n.translation_id = r.translation_id LIMIT 1`,
    [sha256],
  );
  const row = result.rows[0];
  return row ? { mimeType: row.mime_type, bytes: Number(row.bytes) } : null;
}

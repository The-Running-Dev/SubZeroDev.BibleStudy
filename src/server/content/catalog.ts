import type { Availability, BookView, TranslationId, TranslationView } from '../../shared/api.ts';
import { bookById, books } from '../../shared/books.ts';
import type { Clock } from '../platform/clock.ts';
import type { Queryable } from '../platform/db.ts';
import { AppError } from '../platform/errors.ts';
import { log } from '../platform/log.ts';
import { ApiBibleError, csbCacheMs, failureReason } from './apibible.ts';
import type { ApiBible } from './apibible.ts';
import { narrationAvailability } from './narration.ts';
import { contentHash, serializeContent } from './normalize.ts';

// CSB is the owner's imported text, and API.Bible for any chapter not imported (I-11). Null when the owner has not
// set APIBIBLE_KEY.
export interface Csb {
  api: ApiBible;
  clock: Clock;
}

export const csbNotConfigured: Availability = {
  state: 'not_configured',
  reason: "CSB needs the owner's CSB files (import-content --translation CSB) or API.Bible key (APIBIBLE_KEY).",
};
const bsbNotImported: Availability = { state: 'unavailable', reason: 'BSB text has not been imported yet. Run import-content --translation BSB.' };

export function parseTranslationId(input: unknown): TranslationId {
  if (input === 'BSB' || input === 'CSB') return input;
  throw new AppError('invalid_request', 400, 'translation is BSB or CSB.');
}

// An imported CSB chapter never expires; a cached API.Bible one does.
async function csbImported(db: Queryable): Promise<boolean> {
  const result = await db.query(`SELECT 1 FROM chapters WHERE translation_id = 'CSB' AND expires_at IS NULL LIMIT 1`);
  return Boolean(result.rowCount);
}

async function textAvailability(db: Queryable, translationId: TranslationId, csb: Csb | null): Promise<Availability> {
  if (translationId === 'CSB') {
    if (await csbImported(db)) return { state: 'available' };
    return csb ? csb.api.status() : csbNotConfigured;
  }
  const result = await db.query('SELECT 1 FROM chapters WHERE translation_id = $1 LIMIT 1', [translationId]);
  return result.rowCount ? { state: 'available' } : bsbNotImported;
}

function unavailable(availability: Availability): AppError {
  const reason = availability.state === 'available' ? 'Unavailable.' : availability.reason;
  return new AppError('translation_unavailable', 409, reason, { details: { availability } });
}

export async function listTranslations(db: Queryable, csb: Csb | null): Promise<TranslationView[]> {
  const rows = await db.query<{ id: TranslationId; name: string; copyright_notice: string }>(
    'SELECT id, name, copyright_notice FROM translations ORDER BY id',
  );
  return Promise.all(
    rows.rows.map(async (row) => ({
      id: row.id,
      name: row.name,
      copyrightNotice: row.copyright_notice,
      availability: await textAvailability(db, row.id, csb),
      narration: await narrationAvailability(db, row.id),
    })),
  );
}

export async function listBooks(db: Queryable, translationId: TranslationId, csb: Csb | null): Promise<BookView[]> {
  const availability = await textAvailability(db, translationId, csb);
  if (availability.state !== 'available') throw unavailable(availability);
  // With API.Bible, any CSB chapter can be fetched, so its canon is the shared one; without it, only the books
  // the owner imported can be read.
  if (translationId === 'CSB' && csb) return books.map((b) => ({ bookId: b.id, name: b.name, chapters: b.chapters }));
  const result = await db.query<BookView>(
    'SELECT book_id AS "bookId", name, chapters FROM books WHERE translation_id = $1 ORDER BY book_order',
    [translationId],
  );
  return result.rows;
}

export interface StoredChapter {
  contentSha256: string;
  // Validator for the whole body: the content hash, plus the expiry when cached text carries one (CSB).
  etag: string;
  // The response body: ChapterView with the stored content spliced in byte for byte (I-10).
  body: string;
  expiresAt: string | null;
}

interface ChapterRow {
  verse_count: number;
  content: string;
  content_sha256: string;
  expires_at: Date | null;
  fums_token: string | null;
}

const selectChapter = 'SELECT verse_count, content, content_sha256, expires_at, fums_token FROM chapters WHERE translation_id = $1 AND book_id = $2 AND chapter = $3';

// I-11: an imported CSB chapter is always served. A cached API.Bible chapter is served only before its expiry;
// expired copies are deleted first, so the licence's 14-day limit holds even when the refetch fails, and a missing
// or expired chapter is fetched from API.Bible.
async function csbChapter(db: Queryable, csb: Csb | null, bookId: string, chapter: number): Promise<ChapterRow> {
  if (!csb) {
    const imported = await db.query<ChapterRow>(`${selectChapter} AND expires_at IS NULL`, ['CSB', bookId, chapter]);
    if (imported.rows[0]) return imported.rows[0];
    throw unavailable((await csbImported(db)) ? { state: 'unavailable', reason: 'This CSB chapter has not been imported.' } : csbNotConfigured);
  }
  // Readers asking for one chapter at once share the lookup, fetch and store. Sharing only the fetch let a reader
  // whose lookup ran before the first one stored the chapter, but whose fetch started after it, fetch again.
  const running = loading.get(csb) ?? new Map<string, Promise<ChapterRow>>();
  loading.set(csb, running);
  const key = `${bookId}.${chapter}`;
  const shared = running.get(key);
  if (shared) return shared;
  const load = loadCsbChapter(db, csb, bookId, chapter).finally(() => running.delete(key));
  running.set(key, load);
  return load;
}

const loading = new WeakMap<Csb, Map<string, Promise<ChapterRow>>>();

async function loadCsbChapter(db: Queryable, csb: Csb, bookId: string, chapter: number): Promise<ChapterRow> {
  await db.query(`DELETE FROM chapters WHERE translation_id = 'CSB' AND expires_at <= $1`, [csb.clock.now()]);
  const stored = await db.query<ChapterRow>(selectChapter, ['CSB', bookId, chapter]);
  if (stored.rows[0]) return stored.rows[0];

  let fetched;
  try {
    fetched = await csb.api.chapter(bookId, chapter);
  } catch (error) {
    if (!(error instanceof ApiBibleError)) throw error;
    log('warn', 'CSB fetch failed', { bookId, chapter, kind: error.kind, error: error.message });
    throw unavailable({ state: 'unavailable', reason: failureReason(error) });
  }
  const content = serializeContent(fetched.content);
  const fetchedAt = csb.clock.now();
  const row = await db.query<ChapterRow>(
    `INSERT INTO chapters (translation_id, book_id, chapter, verse_count, content, content_sha256, source_ref, fetched_at, expires_at, fums_token)
     VALUES ('CSB', $1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (translation_id, book_id, chapter) DO UPDATE SET verse_count = EXCLUDED.verse_count, content = EXCLUDED.content,
       content_sha256 = EXCLUDED.content_sha256, source_ref = EXCLUDED.source_ref, fetched_at = EXCLUDED.fetched_at,
       expires_at = EXCLUDED.expires_at, fums_token = EXCLUDED.fums_token
     WHERE chapters.expires_at IS NOT NULL
     RETURNING verse_count, content, content_sha256, expires_at, fums_token`,
    [bookId, chapter, fetched.verseCount, content, contentHash(content), fetched.sourceRef, fetchedAt, new Date(fetchedAt.getTime() + csbCacheMs), fetched.fumsToken],
  );
  // The notice shown under CSB text is the one API.Bible sends with it.
  if (fetched.copyright) await db.query(`UPDATE translations SET copyright_notice = $1 WHERE id = 'CSB' AND copyright_notice <> $1`, [fetched.copyright]);
  // A chapter imported while this one was being fetched is kept, and served instead.
  return row.rows[0] ?? (await db.query<ChapterRow>(selectChapter, ['CSB', bookId, chapter])).rows[0];
}

export async function getChapter(db: Queryable, translationId: TranslationId, bookId: string, chapter: number, csb: Csb | null): Promise<StoredChapter> {
  const book = bookById(bookId);
  if (!book || !Number.isInteger(chapter) || chapter < 1 || chapter > book.chapters) {
    throw new AppError('chapter_not_found', 404, `${bookId} ${chapter} is not a chapter.`);
  }

  let row: ChapterRow;
  if (translationId === 'CSB') row = await csbChapter(db, csb, book.id, chapter);
  else {
    const result = await db.query<ChapterRow>(selectChapter, [translationId, book.id, chapter]);
    if (!result.rows[0]) throw unavailable(bsbNotImported);
    row = result.rows[0];
  }

  const head = JSON.stringify({
    translationId,
    bookId: book.id,
    chapter,
    verseCount: row.verse_count,
    contentSha256: row.content_sha256,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    ...(row.fums_token ? { fums: { token: row.fums_token } } : {}),
  });
  // Both are JSON objects: drop the head's closing brace and the content's opening one, and join.
  const etag = row.expires_at ? `"${row.content_sha256}-${row.expires_at.getTime()}"` : `"${row.content_sha256}"`;
  return {
    contentSha256: row.content_sha256,
    etag,
    body: `${head.slice(0, -1)},${row.content.slice(1)}`,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
  };
}

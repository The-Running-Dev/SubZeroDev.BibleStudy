import type { Availability, BookView, TranslationId, TranslationView } from '../../shared/api.ts';
import { bookById } from '../../shared/books.ts';
import type { Queryable } from '../platform/db.ts';
import { AppError } from '../platform/errors.ts';

// Until S13 wires API.Bible, CSB has no licensed source and is never served (I-11).
export const csbNotConfigured: Availability = { state: 'not_configured', reason: 'CSB text not available from a licensed source' };
const narrationAbsent: Availability = { state: 'unavailable', reason: 'No narration has been imported yet.' };
const bsbNotImported: Availability = { state: 'unavailable', reason: 'BSB text has not been imported yet. Run import-content --translation BSB.' };

export function parseTranslationId(input: unknown): TranslationId {
  if (input === 'BSB' || input === 'CSB') return input;
  throw new AppError('invalid_request', 400, 'translation is BSB or CSB.');
}

async function textAvailability(db: Queryable, translationId: TranslationId): Promise<Availability> {
  if (translationId === 'CSB') return csbNotConfigured;
  const result = await db.query('SELECT 1 FROM chapters WHERE translation_id = $1 LIMIT 1', [translationId]);
  return result.rowCount ? { state: 'available' } : bsbNotImported;
}

function unavailable(availability: Availability): AppError {
  const reason = availability.state === 'available' ? 'Unavailable.' : availability.reason;
  return new AppError('translation_unavailable', 409, reason, { details: { availability } });
}

export async function listTranslations(db: Queryable): Promise<TranslationView[]> {
  const rows = await db.query<{ id: TranslationId; name: string; copyright_notice: string }>(
    'SELECT id, name, copyright_notice FROM translations ORDER BY id',
  );
  return Promise.all(
    rows.rows.map(async (row) => ({
      id: row.id,
      name: row.name,
      copyrightNotice: row.copyright_notice,
      availability: await textAvailability(db, row.id),
      narration: narrationAbsent,
    })),
  );
}

export async function listBooks(db: Queryable, translationId: TranslationId): Promise<BookView[]> {
  const availability = await textAvailability(db, translationId);
  if (availability.state !== 'available') throw unavailable(availability);
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
}

export async function getChapter(db: Queryable, translationId: TranslationId, bookId: string, chapter: number): Promise<StoredChapter> {
  const book = bookById(bookId);
  if (!book || !Number.isInteger(chapter) || chapter < 1 || chapter > book.chapters) {
    throw new AppError('chapter_not_found', 404, `${bookId} ${chapter} is not a chapter.`);
  }
  if (translationId === 'CSB') throw unavailable(csbNotConfigured);

  const result = await db.query<{ verse_count: number; content: string; content_sha256: string; expires_at: Date | null }>(
    'SELECT verse_count, content, content_sha256, expires_at FROM chapters WHERE translation_id = $1 AND book_id = $2 AND chapter = $3',
    [translationId, book.id, chapter],
  );
  const row = result.rows[0];
  if (!row) throw unavailable(bsbNotImported);

  const head = JSON.stringify({
    translationId,
    bookId: book.id,
    chapter,
    verseCount: row.verse_count,
    contentSha256: row.content_sha256,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
  });
  // Both are JSON objects: drop the head's closing brace and the content's opening one, and join.
  const etag = row.expires_at ? `"${row.content_sha256}-${row.expires_at.getTime()}"` : `"${row.content_sha256}"`;
  return { contentSha256: row.content_sha256, etag, body: `${head.slice(0, -1)},${row.content.slice(1)}` };
}

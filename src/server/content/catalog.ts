import type { Availability, BookView, TranslationId, TranslationView } from '../../shared/api.ts';
import { isTranslationId } from '../../shared/api.ts';
import { bookById } from '../../shared/books.ts';
import type { Queryable } from '../platform/db.ts';
import { AppError } from '../platform/errors.ts';
import { narrationAvailability } from './narration.ts';

// Every translation is text imported once and kept: BSB from AO Lab, CSB and ESV from the owner's files (ADR-0008).
const notImported = (id: TranslationId): Availability => ({
  state: 'unavailable',
  reason: `${id} text has not been imported yet. Run import-content --translation ${id}${id === 'BSB' ? '' : ` --from <${id} folder>`}.`,
});

export function parseTranslationId(input: unknown): TranslationId {
  if (isTranslationId(input)) return input;
  throw new AppError('invalid_request', 400, 'translation is BSB, CSB or ESV.');
}

async function textAvailability(db: Queryable, translationId: TranslationId): Promise<Availability> {
  const result = await db.query('SELECT 1 FROM chapters WHERE translation_id = $1 LIMIT 1', [translationId]);
  return result.rowCount ? { state: 'available' } : notImported(translationId);
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
      narration: await narrationAvailability(db, row.id),
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
  // Validator for the whole body: the content hash.
  etag: string;
  // The response body: ChapterView with the stored content spliced in byte for byte (I-10).
  body: string;
}

interface ChapterRow {
  verse_count: number;
  content: string;
  content_sha256: string;
}

export async function getChapter(db: Queryable, translationId: TranslationId, bookId: string, chapter: number): Promise<StoredChapter> {
  const book = bookById(bookId);
  if (!book || !Number.isInteger(chapter) || chapter < 1 || chapter > book.chapters) {
    throw new AppError('chapter_not_found', 404, `${bookId} ${chapter} is not a chapter.`);
  }

  const result = await db.query<ChapterRow>(
    'SELECT verse_count, content, content_sha256 FROM chapters WHERE translation_id = $1 AND book_id = $2 AND chapter = $3',
    [translationId, book.id, chapter],
  );
  const row = result.rows[0];
  if (!row) {
    const imported = await textAvailability(db, translationId);
    throw unavailable(imported.state === 'available' ? { state: 'unavailable', reason: `This ${translationId} chapter has not been imported.` } : imported);
  }

  const head = JSON.stringify({ translationId, bookId: book.id, chapter, verseCount: row.verse_count, contentSha256: row.content_sha256 });
  // Both are JSON objects: drop the head's closing brace and the content's opening one, and join.
  return { contentSha256: row.content_sha256, etag: `"${row.content_sha256}"`, body: `${head.slice(0, -1)},${row.content.slice(1)}` };
}

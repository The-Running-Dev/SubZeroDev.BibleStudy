import type { ChapterContent, TranslationId } from '../../shared/api.ts';
import type { Clock } from '../platform/clock.ts';
import type { Db } from '../platform/db.ts';
import { uuidv7 } from '../platform/ids.ts';
import { log } from '../platform/log.ts';
import type { ContentSource } from './aolab.ts';
import { contentHash, normalizeChapter, serializeContent } from './normalize.ts';

export interface ImportScope {
  translationId: TranslationId;
  books?: string[];
}

export interface TextBook {
  id: string;
  name: string;
  order: number;
  numberOfChapters: number;
  sha256: string;
}

// Where a translation's text is imported from: AO Lab for BSB, the owner's files for CSB. The edition a
// complete import records names the kind.
export interface TextSource {
  translationId: TranslationId;
  kind: 'aolab' | 'files';
  catalog(): Promise<{ sha256: string; books: TextBook[] }>;
  chapter(bookId: string, chapter: number): Promise<{ content: ChapterContent; sourceRef: string }>;
}

export type ImportItem =
  | { bookId: string; chapter: number; status: 'inserted' | 'updated' | 'unchanged'; contentSha256: string; verseCount: number }
  | { bookId: string; chapter: number; status: 'failed'; reason: string };

export interface ImportManifestSummary {
  manifestId: string;
  status: 'succeeded' | 'partial' | 'failed';
  sourceSha256: string;
  counts: { inserted: number; updated: number; unchanged: number; failed: number };
  items: ImportItem[];
}

export interface ImportDeps {
  db: Db;
  clock: Clock;
  source: ContentSource;
  concurrency?: number;
}

export interface TextImportDeps {
  db: Db;
  clock: Clock;
  text: TextSource;
  concurrency?: number;
}

export function aolabText(source: ContentSource, translationId: 'BSB'): TextSource {
  return {
    translationId,
    kind: 'aolab',
    async catalog() {
      const catalog = await source.books(translationId);
      return { sha256: catalog.translation.sha256, books: catalog.books };
    },
    async chapter(bookId, chapter) {
      const raw = await source.chapter(translationId, bookId, chapter);
      const content = normalizeChapter(raw);
      if (content.verses.length === 0 || content.verses.length !== raw.numberOfVerses) {
        throw new Error(`verse count ${content.verses.length} does not match the source's ${raw.numberOfVerses}`);
      }
      return { content, sourceRef: raw.thisChapterLink };
    },
  };
}

async function eachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  });
  await Promise.all(workers);
}

// Imports BSB text from AO Lab.
export function runImport(deps: ImportDeps, scope: ImportScope & { translationId: 'BSB' }): Promise<ImportManifestSummary> {
  return importText({ db: deps.db, clock: deps.clock, text: aolabText(deps.source, scope.translationId), concurrency: deps.concurrency }, scope);
}

// Imports a translation's text. A chapter row changes only when its content hash changes, so re-running against
// an unchanged source writes nothing but a new manifest. An imported chapter never expires; it replaces a cached
// CSB copy fetched from API.Bible.
export async function importText(deps: TextImportDeps, scope: ImportScope): Promise<ImportManifestSummary> {
  const { db, clock, text } = deps;
  if (text.translationId !== scope.translationId) throw new Error(`The source holds ${text.translationId}, not ${scope.translationId}`);
  const manifestId = uuidv7(clock.now().getTime());
  const catalog = await text.catalog();
  const wanted = scope.books ? new Set(scope.books.map((b) => b.toUpperCase())) : null;
  const books = catalog.books.filter((book) => !wanted || wanted.has(book.id));
  if (wanted && books.length !== wanted.size) {
    const known = new Set(books.map((b) => b.id));
    throw new Error(`Unknown book(s) for ${scope.translationId}: ${[...wanted].filter((b) => !known.has(b)).join(', ')}`);
  }

  if (books.length === 0) throw new Error(`No books to import for ${scope.translationId}`);

  const sourceVersions = { [scope.translationId]: { kind: text.kind, sha256: catalog.sha256, books: Object.fromEntries(books.map((b) => [b.id, b.sha256])) } };
  await db.query(
    `INSERT INTO import_manifests (id, started_at, scope, source_versions, items, status) VALUES ($1, $2, $3, $4, '[]', 'running')`,
    [manifestId, clock.now(), JSON.stringify(scope), JSON.stringify(sourceVersions)],
  );
  try {
    return await importBooks(deps, scope, manifestId, catalog.sha256, books);
  } catch (error) {
    // A run that stops part-way still leaves a finished manifest that says why.
    await db
      .query(`UPDATE import_manifests SET finished_at = $2, items = $3, status = 'failed' WHERE id = $1 AND status = 'running'`, [
        manifestId,
        clock.now(),
        JSON.stringify([{ status: 'failed', reason: (error as Error).message }]),
      ])
      .catch(() => undefined);
    throw error;
  }
}

async function importBooks(deps: TextImportDeps, scope: ImportScope, manifestId: string, sourceSha256: string, books: TextBook[]): Promise<ImportManifestSummary> {
  const { db, clock, text } = deps;
  for (const book of books) {
    await db.query(
      `INSERT INTO books (translation_id, book_id, name, book_order, chapters) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (translation_id, book_id) DO UPDATE SET name = excluded.name, book_order = excluded.book_order, chapters = excluded.chapters
       WHERE (books.name, books.book_order, books.chapters) IS DISTINCT FROM (excluded.name, excluded.book_order, excluded.chapters)`,
      [scope.translationId, book.id, book.name, book.order, book.numberOfChapters],
    );
  }

  const work = books.flatMap((book) => Array.from({ length: book.numberOfChapters }, (_, i) => ({ bookId: book.id, chapter: i + 1 })));
  const items: ImportItem[] = [];
  await eachLimited(work, deps.concurrency ?? 8, async ({ bookId, chapter }) => {
    try {
      const { content, sourceRef } = await text.chapter(bookId, chapter);
      const verseCount = content.verses[content.verses.length - 1].number;
      const serialized = serializeContent(content);
      const sha = contentHash(serialized);
      const result = await db.query<{ inserted: boolean }>(
        `INSERT INTO chapters (translation_id, book_id, chapter, verse_count, content, content_sha256, source_ref, fetched_at, expires_at, fums_token)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL)
         ON CONFLICT (translation_id, book_id, chapter) DO UPDATE
           SET verse_count = excluded.verse_count, content = excluded.content, content_sha256 = excluded.content_sha256,
               source_ref = excluded.source_ref, fetched_at = excluded.fetched_at, expires_at = NULL, fums_token = NULL
         WHERE chapters.content_sha256 <> excluded.content_sha256 OR chapters.expires_at IS NOT NULL
         RETURNING (xmax = 0) AS inserted`,
        [scope.translationId, bookId, chapter, verseCount, serialized, sha, sourceRef, clock.now()],
      );
      const status = result.rows.length === 0 ? 'unchanged' : result.rows[0].inserted ? 'inserted' : 'updated';
      items.push({ bookId, chapter, status, contentSha256: sha, verseCount });
    } catch (error) {
      log('warn', 'chapter import failed', { translationId: scope.translationId, bookId, chapter, error: (error as Error).message });
      items.push({ bookId, chapter, status: 'failed', reason: (error as Error).message });
    }
  });

  const order = new Map(books.map((b, i) => [b.id, i]));
  items.sort((a, b) => order.get(a.bookId)! - order.get(b.bookId)! || a.chapter - b.chapter);
  const counts = { inserted: 0, updated: 0, unchanged: 0, failed: 0 };
  for (const item of items) counts[item.status]++;
  const status = counts.failed === 0 ? 'succeeded' : counts.failed === items.length ? 'failed' : 'partial';

  // The edition names a source release only once every book of it is stored.
  if (status === 'succeeded' && !scope.books) {
    await db.query(`UPDATE translations SET edition = $2 WHERE id = $1 AND edition IS DISTINCT FROM $2::jsonb`, [
      scope.translationId,
      JSON.stringify({ source: text.kind, sha256: sourceSha256 }),
    ]);
  }
  await db.query(`UPDATE import_manifests SET finished_at = $2, items = $3, status = $4 WHERE id = $1`, [manifestId, clock.now(), JSON.stringify(items), status]);
  return { manifestId, status, sourceSha256, counts, items };
}

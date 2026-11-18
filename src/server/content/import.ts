import type { TranslationId } from '../../shared/api.ts';
import type { Clock } from '../platform/clock.ts';
import { withTransaction, type Db, type Tx } from '../platform/db.ts';
import { uuidv7 } from '../platform/ids.ts';
import { log } from '../platform/log.ts';
import type { ContentSource } from './aolab.ts';
import { contentHash, normalizeChapter, serializeContent } from './normalize.ts';
import { plainText, servedContent, verseRef, type ChapterText } from './text.ts';

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

// Where a translation's text is imported from: AO Lab for BSB, the owner's files for CSB/ESV. The edition a
// complete import records names the kind.
export interface TextSource {
  translationId: TranslationId;
  kind: 'aolab' | 'files';
  catalog(): Promise<{ sha256: string; books: TextBook[] }>;
  chapter(bookId: string, chapter: number): Promise<{ text: ChapterText; sourceRef: string }>;
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
      return { text: plainText(content), sourceRef: raw.thisChapterLink };
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

// Imports a translation's text. Each chapter is one transaction: its served copy in chapters, and its verses,
// headings and notes rows, which are rewritten every time so they always match the source. The served copy changes
// only when its content hash changes, so an unchanged chapter reports 'unchanged'.
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
      const { text: chapterText, sourceRef } = await text.chapter(bookId, chapter);
      const content = servedContent(chapterText);
      const verseCount = content.verses[content.verses.length - 1].number;
      const serialized = serializeContent(content);
      const sha = contentHash(serialized);
      const result = await withTransaction(db, async (tx) => {
        const upsert = await tx.query<{ inserted: boolean }>(
          `INSERT INTO chapters (translation_id, book_id, chapter, verse_count, content, content_sha256, source_ref, fetched_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (translation_id, book_id, chapter) DO UPDATE
             SET verse_count = excluded.verse_count, content = excluded.content, content_sha256 = excluded.content_sha256,
                 source_ref = excluded.source_ref, fetched_at = excluded.fetched_at
           WHERE chapters.content_sha256 <> excluded.content_sha256
           RETURNING (xmax = 0) AS inserted`,
          [scope.translationId, bookId, chapter, verseCount, serialized, sha, sourceRef, clock.now()],
        );
        await writeText(tx, scope.translationId, bookId, chapter, chapterText);
        return upsert;
      });
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

// Replaces a chapter's verses, headings and notes rows.
async function writeText(tx: Tx, translationId: TranslationId, bookId: string, chapter: number, text: ChapterText): Promise<void> {
  const key = [translationId, bookId, chapter];
  for (const table of ['verses', 'headings', 'verse_notes']) {
    await tx.query(`DELETE FROM ${table} WHERE translation_id = $1 AND book_id = $2 AND chapter = $3`, key);
  }
  const ref = (verse: number) => verseRef(bookId, chapter, verse);
  await tx.query(
    `INSERT INTO verses (translation_id, ref, book_id, chapter, verse, text)
     SELECT $1, v.ref, $2, $3, v.verse, v.text FROM unnest($4::int[], $5::int[], $6::text[]) AS v(ref, verse, text)`,
    [...key, text.verses.map((v) => ref(v.number)), text.verses.map((v) => v.number), text.verses.map((v) => v.text)],
  );
  if (text.headings.length > 0) {
    await tx.query(
      `INSERT INTO headings (translation_id, book_id, chapter, seq, ref, level, text)
       SELECT $1, $2, $3, h.seq, h.ref, h.level, h.text FROM unnest($4::int[], $5::int[], $6::int[], $7::text[]) AS h(seq, ref, level, text)`,
      [...key, text.headings.map((_, i) => i + 1), text.headings.map((h) => ref(h.beforeVerse)), text.headings.map((h) => h.level), text.headings.map((h) => h.text)],
    );
  }
  if (text.notes.length > 0) {
    await tx.query(
      `INSERT INTO verse_notes (translation_id, book_id, chapter, seq, ref, kind, text, passage)
       SELECT $1, $2, $3, n.seq, n.ref, n.kind, n.text, n.passage FROM unnest($4::int[], $5::int[], $6::text[], $7::text[], $8::text[]) AS n(seq, ref, kind, text, passage)`,
      [...key, text.notes.map((_, i) => i + 1), text.notes.map((n) => ref(n.verse)), text.notes.map((n) => n.kind), text.notes.map((n) => n.text), text.notes.map((n) => n.passage)],
    );
  }
}

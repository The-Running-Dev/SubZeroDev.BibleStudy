import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createAoLabSource } from '../../src/server/content/aolab.ts';
import type { AoBook, AoChapter, AoContentItem, ContentSource } from '../../src/server/content/aolab.ts';
import { createCsbFileSource } from '../../src/server/content/csb-files.ts';
import { importText, runImport } from '../../src/server/content/import.ts';
import { sha256Hex } from '../../src/server/platform/secrets.ts';
import type { Harness } from '../support/harness.ts';
import { clearMailbox, signIn, startHarness, truncateAll } from '../support/harness.ts';

const aoLabUrl = process.env.AOLAB_BASE_URL ?? 'https://bible.helloao.org';
const noSleep = async () => {};
let h: Harness;
let cookie: string;

before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});

async function freshMember(): Promise<void> {
  await truncateAll(h.db);
  await clearMailbox();
  h.clock.set('2026-11-01T12:00:00Z');
  cookie = (await signIn(h, 'reader@example.test')).cookie;
}

const get = (url: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url, cookies: { bs_session: cookie }, headers });

// ---- A local stand-in for AO Lab, for the failure paths the live service cannot be made to show ----

interface FixtureBook {
  id: string;
  name: string;
  verses: number[]; // verse count per chapter
}

function fixtureChapter(book: FixtureBook, chapter: number, edition: string): AoChapter {
  const content: AoContentItem[] = Array.from({ length: book.verses[chapter - 1] }, (_, i) => ({
    type: 'verse' as const,
    number: i + 1,
    content: [`${book.name} ${chapter}:${i + 1} ${edition}`],
  }));
  return {
    translation: { id: 'BSB', name: 'Berean Standard Bible', sha256: `translation-${edition}`, numberOfBooks: 2, totalNumberOfChapters: 2 },
    book: { id: book.id, name: book.name, order: 1, numberOfChapters: book.verses.length, sha256: `book-${edition}` },
    numberOfVerses: book.verses[chapter - 1],
    thisChapterLink: `/api/BSB/${book.id}/${chapter}.json`,
    chapter: { number: chapter, content, footnotes: [] },
  };
}

interface Fixture {
  url: string;
  edition: string;
  failures: Map<string, number>; // path → remaining 500 replies (Infinity = always)
  lies: Set<string>; // paths whose numberOfVerses is off by one
  requests: string[];
  close(): Promise<void>;
}

async function startFixture(fixtureBooks: FixtureBook[]): Promise<Fixture> {
  const fixture = { edition: 'e1', failures: new Map<string, number>(), lies: new Set<string>(), requests: [] as string[] } as Fixture;
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    fixture.requests.push(path);
    const remaining = fixture.failures.get(path) ?? 0;
    if (remaining > 0) {
      fixture.failures.set(path, remaining - 1);
      response.writeHead(500).end('boom');
      return;
    }
    if (path === '/api/BSB/books.json') {
      const books: AoBook[] = fixtureBooks.map((b, i) => ({
        id: b.id,
        name: b.name,
        order: i + 1,
        numberOfChapters: b.verses.length,
        sha256: `book-${fixture.edition}`,
      }));
      const translation = { id: 'BSB', name: 'Berean Standard Bible', sha256: `translation-${fixture.edition}`, numberOfBooks: books.length, totalNumberOfChapters: 2 };
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ translation, books }));
      return;
    }
    const match = /^\/api\/BSB\/(\w+)\/(\d+)\.json$/.exec(path);
    const book = match ? fixtureBooks.find((b) => b.id === match[1]) : undefined;
    if (!match || !book || Number(match[2]) > book.verses.length) {
      response.writeHead(404).end();
      return;
    }
    const body = fixtureChapter(book, Number(match[2]), fixture.edition);
    if (fixture.lies.has(path)) body.numberOfVerses += 1;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fixture.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fixture.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return fixture;
}

const twoBooks: FixtureBook[] = [
  { id: 'JUD', name: 'Jude', verses: [25] },
  { id: '3JN', name: '3 John', verses: [15] },
];

describe('importing from a fixture source', () => {
  let fixture: Fixture;
  before(async () => {
    fixture = await startFixture(twoBooks);
  });
  after(async () => {
    await fixture.close();
  });
  beforeEach(async () => {
    await truncateAll(h.db);
    await h.db.query(`UPDATE translations SET edition = NULL`);
    fixture.edition = 'e1';
    fixture.failures.clear();
    fixture.lies.clear();
    fixture.requests.length = 0;
  });
  const importAll = (books?: string[]) =>
    runImport({ db: h.db, clock: h.clock, source: createAoLabSource({ baseUrl: fixture.url, sleep: noSleep }) }, { translationId: 'BSB', books });

  test('retries a transient failure, then a changed source updates only the changed chapter row', async () => {
    fixture.failures.set('/api/BSB/JUD/1.json', 2);
    const first = await importAll();
    assert.equal(first.status, 'succeeded');
    assert.deepEqual(first.counts, { inserted: 2, updated: 0, unchanged: 0, failed: 0 });
    assert.equal(fixture.requests.filter((r) => r === '/api/BSB/JUD/1.json').length, 3);

    fixture.edition = 'e2';
    const second = await importAll(['jud']);
    assert.deepEqual(second.counts, { inserted: 0, updated: 1, unchanged: 0, failed: 0 });
    const rows = await h.db.query<{ book_id: string; content: string; content_sha256: string }>('SELECT book_id, content, content_sha256 FROM chapters');
    assert.match(rows.rows.find((r) => r.book_id === 'JUD')!.content, /Jude 1:1 e2/);
    assert.match(rows.rows.find((r) => r.book_id === '3JN')!.content, /3 John 1:1 e1/);
    for (const row of rows.rows) assert.equal(row.content_sha256, sha256Hex(row.content));
  });

  test('a chapter that keeps failing, or whose verse count disagrees, fails alone', async () => {
    fixture.failures.set('/api/BSB/JUD/1.json', Infinity);
    fixture.lies.add('/api/BSB/3JN/1.json');
    const failed = await importAll();
    assert.equal(failed.status, 'failed');
    assert.deepEqual(failed.counts, { inserted: 0, updated: 0, unchanged: 0, failed: 2 });
    assert.match((failed.items[0] as { reason: string }).reason, /HTTP 500/);
    assert.match((failed.items[1] as { reason: string }).reason, /verse count 15 does not match the source's 16/);

    fixture.failures.clear();
    const partial = await importAll();
    assert.equal(partial.status, 'partial');
    assert.deepEqual(partial.counts, { inserted: 1, updated: 0, unchanged: 0, failed: 1 });
    const manifest = await h.db.query('SELECT status, items, finished_at FROM import_manifests WHERE id = $1', [partial.manifestId]);
    assert.equal(manifest.rows[0].status, 'partial');
    assert.equal(manifest.rows[0].items.length, 2);
    assert.ok(manifest.rows[0].finished_at);
  });

  test('an unknown book or an empty list is refused before anything is written', async () => {
    await assert.rejects(importAll(['JUD', 'XYZ']), /Unknown book\(s\) for BSB: XYZ/);
    await assert.rejects(importAll([]), /No books to import for BSB/);
    assert.equal((await h.db.query('SELECT 1 FROM import_manifests')).rowCount, 0);
  });

  test('the edition names the source release only after a whole, successful import', async () => {
    const edition = async () => (await h.db.query<{ edition: unknown }>(`SELECT edition FROM translations WHERE id = 'BSB'`)).rows[0].edition;
    fixture.failures.set('/api/BSB/JUD/1.json', Infinity);
    assert.equal((await importAll()).status, 'partial');
    assert.equal(await edition(), null);
    fixture.failures.clear();
    assert.equal((await importAll(['JUD'])).status, 'succeeded');
    assert.equal(await edition(), null, 'a partial-scope import does not claim the release');
    assert.equal((await importAll()).status, 'succeeded');
    assert.deepEqual(await edition(), { source: 'aolab', sha256: 'translation-e1' });
  });

  test('a run that throws part-way leaves its manifest failed with the reason', async () => {
    const failing = Object.create(h.db) as typeof h.db;
    failing.query = ((sql: string, params?: unknown[]) =>
      sql.trimStart().startsWith('INSERT INTO books') ? Promise.reject(new Error('disk full')) : h.db.query(sql, params)) as typeof h.db.query;
    const source = createAoLabSource({ baseUrl: fixture.url, sleep: noSleep });
    await assert.rejects(runImport({ db: failing, clock: h.clock, source }, { translationId: 'BSB' }), /disk full/);
    const manifest = await h.db.query('SELECT status, items, finished_at FROM import_manifests');
    assert.equal(manifest.rowCount, 1);
    assert.equal(manifest.rows[0].status, 'failed');
    assert.ok(manifest.rows[0].finished_at);
    assert.deepEqual(manifest.rows[0].items, [{ status: 'failed', reason: 'disk full' }]);
  });
});

describe('before any import', () => {
  before(freshMember);

  test('BSB is unavailable with the command to run, and no text is served', async () => {
    const translations = (await get('/api/content/translations')).json();
    assert.deepEqual(translations.find((t: { id: string }) => t.id === 'BSB').availability, {
      state: 'unavailable',
      reason: 'BSB text has not been imported yet. Run import-content --translation BSB.',
    });
    const chapter = await get('/api/content/BSB/ROM/1');
    assert.equal(chapter.statusCode, 409);
    assert.equal(chapter.json().error, 'translation_unavailable');
    assert.equal((await get('/api/content/books?translation=BSB')).statusCode, 409);
  });
});

describe('Romans imported live from AO Lab', () => {
  let source: AoChapter;
  // What the importer read from the catalog. AO Lab's CDN can serve chapter files from different releases for a while after
  // an update, so the checksum to compare against is the one in the catalog the run used, not one in a later fetch.
  let catalog: Awaited<ReturnType<ContentSource['books']>> | undefined;
  const live = createAoLabSource({ baseUrl: aoLabUrl });
  const recording: ContentSource = {
    ...live,
    books: async (translationId) => (catalog = await live.books(translationId)),
    chapter: async (translationId, bookId, chapter) => {
      const fetched = await live.chapter(translationId, bookId, chapter);
      if (bookId === 'ROM' && chapter === 1) source = fetched;
      return fetched;
    },
  };
  const importRomans = () => runImport({ db: h.db, clock: h.clock, source: recording }, { translationId: 'BSB', books: ['ROM'] });

  before(async () => {
    await freshMember();
    const result = await importRomans();
    assert.equal(result.status, 'succeeded', JSON.stringify(result.items.filter((i) => i.status === 'failed')));
  });

  test('S2.1 the manifest records the source checksum and each chapter hash, and a re-run changes no rows', async () => {
    const manifests = await h.db.query<{
      status: string;
      source_versions: Record<string, { sha256: string; books: Record<string, string> }>;
      items: { chapter: number; contentSha256: string }[];
    }>('SELECT status, source_versions, items FROM import_manifests');
    assert.equal(manifests.rowCount, 1);
    const manifest = manifests.rows[0];
    assert.equal(manifest.status, 'succeeded');
    assert.equal(manifest.source_versions.BSB.sha256, catalog!.translation.sha256);
    assert.equal(manifest.source_versions.BSB.books.ROM, catalog!.books.find((b) => b.id === 'ROM')!.sha256);
    assert.deepEqual(
      manifest.items.map((i) => i.chapter),
      Array.from({ length: 16 }, (_, i) => i + 1),
    );

    const snapshot = async () => (await h.db.query('SELECT *, xmin::text AS row_version FROM chapters ORDER BY chapter')).rows;
    const before = await snapshot();
    for (const row of before) {
      assert.equal(row.content_sha256, sha256Hex(row.content));
      assert.equal(manifest.items[row.chapter - 1].contentSha256, row.content_sha256);
    }

    h.clock.advance(60_000);
    const rerun = await importRomans();
    assert.deepEqual(rerun.counts, { inserted: 0, updated: 0, unchanged: 16, failed: 0 });
    assert.deepEqual(await snapshot(), before);
  });

  test('S2.2 Romans 1 has 32 verses whose text is the source text, and contentSha256 hashes the stored content', async () => {
    const response = await get('/api/content/BSB/ROM/1');
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type']), /^application\/json/);
    const view = response.json();
    assert.equal(view.verseCount, 32);
    assert.equal(view.verses.length, 32);

    // Same characters in the same order; spacing is the normaliser's (unit-tested) job, except that
    // no space may come before closing punctuation.
    const letters = (s: string) => s.replace(/\s+/g, '');
    const sourceVerses = source.chapter.content.flatMap((c) => (c.type === 'verse' ? [c] : []));
    assert.equal(sourceVerses.length, 32);
    for (const [i, verse] of sourceVerses.entries()) {
      const text = verse.content.map((seg) => (typeof seg === 'string' ? seg : 'text' in seg ? seg.text : '')).join('');
      assert.equal(letters(view.verses[i].text), letters(text), `verse ${i + 1}`);
      assert.doesNotMatch(view.verses[i].text, /\s[”’),.;:!?]/, `verse ${i + 1}`);
    }

    const stored = (await h.db.query<{ content: string }>(`SELECT content FROM chapters WHERE book_id = 'ROM' AND chapter = 1`)).rows[0].content;
    assert.equal(view.contentSha256, sha256Hex(stored));
    assert.ok(response.body.endsWith(stored.slice(1)), 'the stored bytes are served unchanged');
    assert.deepEqual({ verses: view.verses, headings: view.headings, footnotes: view.footnotes }, JSON.parse(stored));
  });

  test('a matching ETag gets 304 with no body', async () => {
    const first = await get('/api/content/BSB/ROM/2');
    assert.equal(first.headers.etag, `"${first.json().contentSha256}"`);
    assert.equal(first.headers['cache-control'], 'private, no-cache');
    const second = await get('/api/content/BSB/rom/2', { 'if-none-match': String(first.headers.etag) });
    assert.equal(second.statusCode, 304);
    assert.equal(second.body, '');
  });

  test('S2.7 BSB is available and CSB is not configured; CSB never serves text', async () => {
    const translations = (await get('/api/content/translations')).json();
    assert.deepEqual(
      translations.map((t: { id: string; availability: unknown }) => [t.id, t.availability]),
      [
        ['BSB', { state: 'available' }],
        ['CSB', { state: 'not_configured', reason: "CSB needs the owner's CSB files (import-content --translation CSB) or API.Bible key (APIBIBLE_KEY)." }],
      ],
    );
    const csb = await get('/api/content/CSB/ROM/1');
    assert.equal(csb.statusCode, 409);
    assert.equal(csb.json().error, 'translation_unavailable');
    assert.equal(csb.json().message, "CSB needs the owner's CSB files (import-content --translation CSB) or API.Bible key (APIBIBLE_KEY).");
    assert.equal((await get('/api/content/books?translation=CSB')).statusCode, 409);
  });

  test('books lists what was imported', async () => {
    assert.deepEqual((await get('/api/content/books?translation=BSB')).json(), [{ bookId: 'ROM', name: 'Romans', chapters: 16 }]);
  });

  test('a chapter outside the canon is chapter_not_found; a bad translation is invalid_request', async () => {
    for (const url of ['/api/content/BSB/ROM/17', '/api/content/BSB/ROM/0', '/api/content/BSB/XYZ/1', '/api/content/BSB/ROM/abc', '/api/content/BSB/ROM/1e1']) {
      const response = await get(url);
      assert.equal(response.statusCode, 404, url);
      assert.equal(response.json().error, 'chapter_not_found', url);
    }
    assert.equal((await get('/api/content/KJV/ROM/1')).json().error, 'invalid_request');
    assert.equal((await get('/api/content/books')).statusCode, 400);
  });

  test('every content route needs a session', async () => {
    for (const url of ['/api/content/translations', '/api/content/books?translation=BSB', '/api/content/BSB/ROM/1']) {
      assert.equal((await h.app.inject({ method: 'GET', url })).statusCode, 401, url);
    }
  });
});

describe("CSB imported from the owner's files", () => {
  // Synthetic markup in the files' shape; no CSB text is kept in this repository.
  const philemon = `<book id="bk.57"><bookname>Philemon</bookname><chapter id="philemon.1" display="1">
<head1>A Fixture Heading</head1>
<p><verse reference="philemon.1.1" display-number="1"><sup class="verse-ref" id="philemon.1.1">1</sup>Fixture verse one.</verse>
<verse reference="philemon.1.2" display-number="2"><sup class="verse-ref" id="philemon.1.2">2</sup>Fixture verse two.</verse></p>
</chapter></book>`;
  let dir: string;
  const importCsb = () => importText({ db: h.db, clock: h.clock, text: createCsbFileSource(dir) }, { translationId: 'CSB', books: ['PHM'] });

  before(async () => {
    await freshMember();
    dir = await mkdtemp(join(tmpdir(), 'csb-import-'));
    await writeFile(join(dir, '57-Phm.xml'), philemon);
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
    await h.db.query(`DELETE FROM chapters WHERE translation_id = 'CSB'`);
    await h.db.query(`DELETE FROM books WHERE translation_id = 'CSB'`);
  });

  test('an imported CSB chapter is served without API.Bible and never expires', async () => {
    const summary = await importCsb();
    assert.equal(summary.status, 'succeeded');
    assert.deepEqual(summary.counts, { inserted: 1, updated: 0, unchanged: 0, failed: 0 });

    const csb = (await get('/api/content/translations')).json().find((t: { id: string }) => t.id === 'CSB');
    assert.deepEqual(csb.availability, { state: 'available' });
    assert.deepEqual((await get('/api/content/books?translation=CSB')).json(), [{ bookId: 'PHM', name: 'Philemon', chapters: 1 }]);

    h.clock.set('2026-11-21T12:00:00Z'); // past an API.Bible copy's 14 days
    const chapter = await get('/api/content/CSB/PHM/1');
    assert.equal(chapter.statusCode, 200);
    const view = chapter.json();
    assert.equal(view.expiresAt, null);
    assert.deepEqual(view.verses, [
      { number: 1, text: 'Fixture verse one.' },
      { number: 2, text: 'Fixture verse two.' },
    ]);
    assert.deepEqual(view.headings, [{ beforeVerse: 1, text: 'A Fixture Heading' }]);

    const missing = await get('/api/content/CSB/ROM/1');
    assert.equal(missing.statusCode, 409);
    assert.equal(missing.json().message, 'This CSB chapter has not been imported.');
  });

  test('importing the same files again changes nothing', async () => {
    assert.deepEqual((await importCsb()).counts, { inserted: 0, updated: 0, unchanged: 1, failed: 0 });
  });
});

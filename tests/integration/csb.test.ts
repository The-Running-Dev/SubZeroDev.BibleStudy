import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createCsbFileSource } from '../../src/server/content/csb-files.ts';
import { importText } from '../../src/server/content/import.ts';
import { sha256Hex } from '../../src/server/platform/secrets.ts';
import type { Harness } from '../support/harness.ts';
import { signIn, startHarness, truncateAll } from '../support/harness.ts';

// Synthetic markup in the shape of the owner's CSB files: no CSB text is kept in this repository.
const romans = (verseTwo: string) => `<book id="bk.45">
<chapter id="romans.1" display="1">
<head1>Fixture Heading</head1>
<p><verse reference="romans.1.1" display-number="1"><sup class="verse-ref">1</sup>Grace fixture verse.<sup class="cross-ref"><a data-content="1Co 1:1; 2Co 1:1">a</a></sup></verse>
<verse reference="romans.1.2" display-number="2"><sup class="verse-ref">2</sup>${verseTwo}<sup class="translate-note"><a data-content="Or synthetic">b</a></sup></verse></p>
<head3>Minor Fixture Heading</head3>
<p><verse reference="romans.1.3" display-number="3"><sup class="verse-ref">3</sup>Third fixture verse.</verse></p>
</chapter>
</book>`;

let h: Harness;
let cookie: string;

before(async () => { h = await startHarness(); });
after(async () => { await h?.close(); });
beforeEach(async () => {
  await truncateAll(h.db);
  cookie = (await signIn(h, 'reader@example.test')).cookie;
});

const get = (url: string) => h.app.inject({ method: 'GET', url, cookies: { bs_session: cookie } });
const csbOf = async () => (await get('/api/content/translations')).json().find((t: { id: string }) => t.id === 'CSB');
async function importRomans(verseTwo: string) {
  const dir = await mkdtemp(join(tmpdir(), 'csb-import-'));
  await writeFile(join(dir, '45-Rom.xml'), romans(verseTwo));
  try {
    return await importText({ db: h.db, clock: h.clock, text: createCsbFileSource(dir) }, { translationId: 'CSB', books: ['ROM'] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const rows = async (table: 'verses' | 'headings' | 'verse_notes', columns: string) =>
  (await h.db.query(`SELECT ${columns} FROM ${table} WHERE translation_id = 'CSB' ORDER BY ref, 1`)).rows;

describe('CSB imported from the owner\'s files (ADR-0008)', () => {
  test('before any import CSB says how to import it, and needs no key', async () => {
    assert.deepEqual((await csbOf()).availability, {
      state: 'unavailable',
      reason: 'CSB text has not been imported yet. Run import-content --translation CSB --from <CSB folder>.',
    });
    assert.equal((await get('/api/content/CSB/ROM/1')).statusCode, 409);
  });

  test('an imported chapter is served and its verses, headings and notes are stored as rows', async () => {
    // Only chapter 1 is in the file, so Romans' other fifteen chapters fail.
    const summary = await importRomans('Second fixture verse.');
    assert.deepEqual(summary.counts, { inserted: 1, updated: 0, unchanged: 0, failed: 15 });
    assert.deepEqual((await csbOf()).availability, { state: 'available' });

    const chapter = await get('/api/content/CSB/ROM/1');
    assert.equal(chapter.statusCode, 200);
    assert.equal(chapter.headers['cache-control'], 'private, no-cache');
    const body = chapter.json();
    assert.equal(body.expiresAt, undefined);
    assert.equal(body.fums, undefined);
    assert.deepEqual(body.headings, [
      { beforeVerse: 1, text: 'Fixture Heading' },
      { beforeVerse: 3, text: 'Minor Fixture Heading' },
    ]);
    assert.deepEqual(body.footnotes, [
      { verse: 1, text: 'Cross-reference: 1Co 1:1; 2Co 1:1' },
      { verse: 2, text: 'Or synthetic' },
    ]);
    const manifest = await get('/api/content/CSB/ROM/1/download-manifest');
    assert.equal(manifest.json().assets[0].sha256, sha256Hex(chapter.body));
    assert.equal(manifest.json().expiresAt, undefined);

    assert.deepEqual(await rows('verses', 'ref, verse, text'), [
      { ref: 45_001_001, verse: 1, text: 'Grace fixture verse.' },
      { ref: 45_001_002, verse: 2, text: 'Second fixture verse.' },
      { ref: 45_001_003, verse: 3, text: 'Third fixture verse.' },
    ]);
    assert.deepEqual(await rows('headings', 'seq, ref, level, text'), [
      { seq: 1, ref: 45_001_001, level: 1, text: 'Fixture Heading' },
      { seq: 2, ref: 45_001_003, level: 3, text: 'Minor Fixture Heading' },
    ]);
    assert.deepEqual(await rows('verse_notes', 'seq, ref, kind, text, passage'), [
      { seq: 1, ref: 45_001_001, kind: 'crossref', text: '1Co 1:1; 2Co 1:1', passage: '1Co 1:1; 2Co 1:1' },
      { seq: 2, ref: 45_001_002, kind: 'footnote', text: 'Or synthetic', passage: null },
    ]);
    const found = await h.db.query(`SELECT ref FROM verses WHERE translation_id = 'CSB' AND search @@ plainto_tsquery('english', 'graces')`);
    assert.deepEqual(found.rows, [{ ref: 45_001_001 }]);
    // A passage is a ref range: Romans 1:2-3.
    const passage = await h.db.query(`SELECT verse FROM verses WHERE translation_id = 'CSB' AND ref BETWEEN 45001002 AND 45001003 ORDER BY ref`);
    assert.deepEqual(passage.rows, [{ verse: 2 }, { verse: 3 }]);
  });

  test('re-importing unchanged files changes nothing; changed text replaces the rows with it', async () => {
    await importRomans('Second fixture verse.');
    const first = (await get('/api/content/CSB/ROM/1')).body;
    assert.deepEqual((await importRomans('Second fixture verse.')).counts, { inserted: 0, updated: 0, unchanged: 1, failed: 15 });
    assert.equal((await get('/api/content/CSB/ROM/1')).body, first);
    assert.equal((await rows('verses', 'ref')).length, 3);

    assert.deepEqual((await importRomans('A corrected second verse.')).counts, { inserted: 0, updated: 1, unchanged: 0, failed: 15 });
    assert.deepEqual((await rows('verses', 'text')).map((r) => r.text), ['Grace fixture verse.', 'A corrected second verse.', 'Third fixture verse.']);
    assert.equal((await rows('verse_notes', 'ref')).length, 2);
    assert.equal((await get('/api/content/CSB/ROM/1')).json().verses[1].text, 'A corrected second verse.');
  });

  test('S13.5 CSB narration is unavailable: no licensed CSB recording', async () => {
    assert.deepEqual((await csbOf()).narration, { state: 'unavailable', reason: 'No licensed CSB recording.' });
  });
});

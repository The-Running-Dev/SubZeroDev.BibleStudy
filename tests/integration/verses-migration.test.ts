import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { migrationsDir } from '../../src/server/platform/migrate.ts';
import { startHarness, type Harness } from '../support/harness.ts';

// Migration 0014 against a schema at 0013 holding synthetic chapters: imported ones fill the verse tables, and an
// API.Bible copy (one with an expiry) is removed with its columns.
let h: Harness;
before(async () => { h = await startHarness(); });
after(async () => { await h?.close(); });

test('0014 fills verses, headings and notes from stored chapters and drops API.Bible copies', async () => {
  const schema = `verses_upgrade_${randomUUID().replaceAll('-', '')}`;
  const q = await h.db.connect();
  try {
    await q.query(`CREATE SCHEMA ${schema}`);
    await q.query(`SET search_path TO ${schema}`);
    for (const file of (await readdir(migrationsDir)).filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0014').sort()) {
      await q.query(await readFile(join(migrationsDir, file), 'utf8'));
    }
    const imported = JSON.stringify({
      verses: [{ number: 1, text: 'Fixture one.' }, { number: 3, text: 'Fixture three.' }],
      headings: [{ beforeVerse: 1, text: 'Fixture heading' }],
      footnotes: [{ verse: 1, text: 'A note.' }, { verse: 3, text: 'Cross-reference: Fixture 2:1' }],
    });
    const leased = JSON.stringify({ verses: [{ number: 1, text: 'Leased.' }], headings: [], footnotes: [] });
    await q.query(
      `INSERT INTO chapters (translation_id, book_id, chapter, verse_count, content, content_sha256, source_ref, fetched_at, expires_at, fums_token) VALUES
       ('ESV', 'PHM', 1, 3, $1, 'imported-hash', 'fixture', now(), NULL, NULL),
       ('CSB', 'ROM', 1, 1, $2, 'leased-hash', 'apibible:fixture', now(), now() + interval '14 days', 'token')`,
      [imported, leased],
    );

    await q.query('BEGIN');
    await q.query(await readFile(join(migrationsDir, '0014_verses.sql'), 'utf8'));
    await q.query('COMMIT');

    assert.deepEqual((await q.query('SELECT translation_id, book_id, content FROM chapters')).rows, [{ translation_id: 'ESV', book_id: 'PHM', content: imported }]);
    const columns = (await q.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'chapters'`, [schema])).rows.map((r) => r.column_name);
    assert.ok(!columns.includes('expires_at') && !columns.includes('fums_token'));
    assert.equal((await q.query('SELECT count(*)::int AS n FROM canon')).rows[0].n, 66);
    assert.equal((await q.query("SELECT source_kind FROM translations WHERE id = 'CSB'")).rows[0].source_kind, 'files');
    assert.deepEqual((await q.query('SELECT translation_id, ref, verse, text FROM verses ORDER BY ref')).rows, [
      { translation_id: 'ESV', ref: 57_001_001, verse: 1, text: 'Fixture one.' },
      { translation_id: 'ESV', ref: 57_001_003, verse: 3, text: 'Fixture three.' },
    ]);
    assert.deepEqual((await q.query('SELECT seq, ref, level, text FROM headings')).rows, [{ seq: 1, ref: 57_001_001, level: null, text: 'Fixture heading' }]);
    assert.deepEqual((await q.query('SELECT seq, ref, kind, text, passage FROM verse_notes ORDER BY seq')).rows, [
      { seq: 1, ref: 57_001_001, kind: 'footnote', text: 'A note.', passage: null },
      { seq: 2, ref: 57_001_003, kind: 'crossref', text: 'Fixture 2:1', passage: null },
    ]);
    // Deleting a chapter takes its rows with it.
    await q.query('DELETE FROM chapters');
    assert.equal((await q.query('SELECT count(*)::int AS n FROM verses')).rows[0].n, 0);
  } finally {
    await q.query('ROLLBACK');
    await q.query('SET search_path TO public');
    await q.query(`DROP SCHEMA ${schema} CASCADE`);
    q.release();
  }
});

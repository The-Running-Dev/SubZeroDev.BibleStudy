import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createEsvFileSource } from '../../src/server/content/esv-files.ts';
import { importText } from '../../src/server/content/import.ts';
import { sha256Hex } from '../../src/server/platform/secrets.ts';
import { migrationsDir } from '../../src/server/platform/migrate.ts';
import { writeEsvFixture } from '../support/esv-fixture.ts';
import { signIn, startHarness, type Harness } from '../support/harness.ts';

let h: Harness;
let dir: string;
let cookie: string;
before(async () => {
  h = await startHarness({ OWNER_EMAIL: '' });
  dir = await mkdtemp(join(tmpdir(), 'esv-import-'));
  await writeEsvFixture(dir);
  cookie = (await signIn(h, 'esv-reader@example.test')).cookie;
});
after(async () => { await h?.close(); if (dir) await rm(dir, { recursive: true, force: true }); });
const get = (url: string) => h.app.inject({ method: 'GET', url, cookies: { bs_session: cookie } });

test('upgrading the existing schema preserves BSB, CSB and user data', async () => {
  const schema = `esv_upgrade_${randomUUID().replaceAll('-', '')}`;
  const q = await h.db.connect();
  try {
    await q.query(`CREATE SCHEMA ${schema}`);
    await q.query(`SET search_path TO ${schema}`);
    for (const file of (await readdir(migrationsDir)).filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0013').sort()) {
      await q.query(await readFile(join(migrationsDir, file), 'utf8'));
    }
    const user = randomUUID();
    await q.query("INSERT INTO users (id,email,display_name,time_zone,display_translation_id,created_at) VALUES ($1,'upgrade@example.test','Reader','UTC','CSB',now())", [user]);
    await q.query("INSERT INTO chapters (translation_id,book_id,chapter,verse_count,content,content_sha256,source_ref,fetched_at) VALUES ('CSB','PHM',1,1,'fixture','fixture-hash','fixture',now())");
    const originalUsers = (await q.query('SELECT * FROM users')).rows;
    const originalChapters = (await q.query('SELECT * FROM chapters')).rows;
    const originalTranslations = (await q.query('SELECT * FROM translations ORDER BY id')).rows;
    await q.query('BEGIN');
    await q.query(await readFile(join(migrationsDir, '0013_esv.sql'), 'utf8'));
    await q.query('COMMIT');
    assert.deepEqual((await q.query('SELECT * FROM users')).rows, originalUsers);
    assert.deepEqual((await q.query('SELECT * FROM chapters')).rows, originalChapters);
    assert.deepEqual((await q.query("SELECT * FROM translations WHERE id <> 'ESV' ORDER BY id")).rows, originalTranslations);
    await q.query("UPDATE users SET display_translation_id = 'ESV' WHERE id = $1", [user]);
    assert.equal((await q.query("SELECT source_kind FROM translations WHERE id = 'ESV'")).rows[0].source_kind, 'files');
  } finally {
    await q.query('ROLLBACK');
    await q.query('SET search_path TO public');
    await q.query(`DROP SCHEMA ${schema} CASCADE`);
    q.release();
  }
});

test('one local ESV import makes text available without a key, with stable hashes and no expiration', async () => {
  const before = (await get('/api/content/translations')).json().find((t: { id: string }) => t.id === 'ESV');
  assert.equal(before.availability.state, 'unavailable');
  const run = () => importText({ db: h.db, clock: h.clock, text: createEsvFileSource(dir) }, { translationId: 'ESV' });
  assert.deepEqual((await run()).counts, { inserted: 1, updated: 0, unchanged: 0, failed: 0 });
  assert.deepEqual((await run()).counts, { inserted: 0, updated: 0, unchanged: 1, failed: 0 });
  const esv = (await get('/api/content/translations')).json().find((t: { id: string }) => t.id === 'ESV');
  assert.equal(esv.name, 'English Standard Version');
  assert.equal(esv.availability.state, 'available');
  assert.equal(esv.narration.state, 'unavailable');
  assert.deepEqual((await get('/api/content/books?translation=ESV')).json(), [{ bookId: 'PHM', name: 'Philemon', chapters: 1 }]);
  const response = await get('/api/content/ESV/PHM/1');
  assert.equal(response.statusCode, 200);
  const chapter = response.json();
  assert.deepEqual(chapter.verses.map((v: { number: number }) => v.number), [1, 3]);
  assert.equal(chapter.verseCount, 3);
  assert.equal(chapter.footnotes.length, 3);
  assert.equal(chapter.expiresAt, null);
  assert.equal(chapter.fums, undefined);
  const stored = (await h.db.query("SELECT content, content_sha256 FROM chapters WHERE translation_id = 'ESV'")).rows[0];
  assert.equal(sha256Hex(stored.content), chapter.contentSha256);
  const manifest = (await get('/api/content/ESV/PHM/1/download-manifest')).json();
  assert.equal(manifest.expiresAt, null);
  assert.equal(manifest.assets[0].sha256, sha256Hex(response.body));
  assert.equal(manifest.totalBytes, Buffer.byteLength(response.body));
  assert.deepEqual((await get('/api/content/ESV/PHM/1/recordings')).json(), { recordings: [], preparing: [], failed: [] });
  assert.equal((await get('/api/content/ESV/PHM/1/download-manifest?narration=true')).json().error, 'narration_unavailable');
  const missing = await get('/api/content/ESV/ROM/1');
  assert.equal(missing.statusCode, 409);
  assert.match(missing.json().message, /ESV/);
  // Imported text has no expiry even a year later; use the content service independently of login expiry.
  const { getChapter } = await import('../../src/server/content/catalog.ts');
  h.clock.advance(365 * 24 * 60 * 60 * 1000);
  assert.equal((await getChapter(h.db, 'ESV', 'PHM', 1, null)).body, response.body);
  h.clock.advance(-365 * 24 * 60 * 60 * 1000);
});

test('ESV display preferences, notes and reading position survive the database round trip', async () => {
  const profile = await h.app.inject({ method: 'PATCH', url: '/api/me', cookies: { bs_session: cookie }, payload: { displayTranslationId: 'ESV' } });
  assert.equal(profile.statusCode, 200);
  assert.equal(profile.json().displayTranslationId, 'ESV');
  const response = await h.app.inject({
    method: 'POST', url: '/api/sync/push', cookies: { bs_session: cookie }, payload: { ops: [
      { opId: randomUUID(), entity: 'note', entityId: randomUUID(), op: 'upsert', anchor: { translationId: 'ESV', bookId: 'PHM', chapter: 1, startVerse: 1, endVerse: 1 }, body: 'Local ESV note.', deviceId: 'esv-test' },
      { opId: randomUUID(), entity: 'solo_position', op: 'set', position: { translationId: 'ESV', bookId: 'PHM', chapter: 1, verse: 3 } },
    ] },
  });
  assert.equal(response.statusCode, 200, response.body);
  const pulled = (await get('/api/sync/pull')).json();
  assert.equal(pulled.notes[0].anchor.translationId, 'ESV');
  assert.equal(pulled.soloPosition.translationId, 'ESV');
});

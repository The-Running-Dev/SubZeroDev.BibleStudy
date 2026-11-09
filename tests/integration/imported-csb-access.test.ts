import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { getChapter } from '../../src/server/content/catalog.ts';
import { contentAccess } from '../../src/server/content/access.ts';
import { createSession } from '../../src/server/identity/sessions.ts';
import { sha256Hex } from '../../src/server/platform/secrets.ts';
import type { Harness } from '../support/harness.ts';
import { ownerEmail, startHarness, truncateAll } from '../support/harness.ts';

// Synthetic text only. Real PostgreSQL and the real authentication middleware; no model or upstream service.
const importedText = 'Private imported fixture verse.';
const bsbText = 'Public domain fixture verse.';
let h: Harness;
let owner: { userId: string; cookie: string };
let solo: { userId: string; cookie: string };
let member: { userId: string; cookie: string };

async function account(email: string) {
  const userId = randomUUID();
  await h.db.query(`INSERT INTO users (id, email, display_name, time_zone, created_at) VALUES ($1, $2, 'Fixture', 'UTC', $3)`, [userId, email, h.clock.now()]);
  return { userId, cookie: (await createSession(h.db, h.clock, userId)).token };
}
const get = (url: string, cookie?: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url, cookies: cookie ? { bs_session: cookie } : {}, headers });
const chapterUrl = '/api/content/CSB/ROM/1';

before(async () => { h = await startHarness(); });
after(async () => { await h?.close(); });
beforeEach(async () => {
  await truncateAll(h.db);
  owner = await account(ownerEmail);
  solo = await account('solo@example.test');
  member = await account('member@example.test');
  const groupId = randomUUID();
  await h.db.query(`INSERT INTO groups (id, name, owner_id, schedule_weekday, schedule_local_time, schedule_time_zone, start_book_id, start_chapter, created_at)
    VALUES ($1, 'Fixture', $2, 1, '10:00', 'UTC', 'ROM', 1, $3)`, [groupId, owner.userId, h.clock.now()]);
  await h.db.query(`INSERT INTO memberships (group_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $4), ($1, $3, 'member', $4)`, [groupId, owner.userId, member.userId, h.clock.now()]);
  for (const [translationId, text] of [['CSB', importedText], ['BSB', bsbText]]) {
    const content = JSON.stringify({ verses: [{ number: 1, text }], headings: [], footnotes: [] });
    await h.db.query(`INSERT INTO books (translation_id, book_id, name, book_order, chapters) VALUES ($1, 'ROM', 'Romans', 45, 16)`, [translationId]);
    await h.db.query(`INSERT INTO chapters (translation_id, book_id, chapter, verse_count, content, content_sha256, source_ref, fetched_at)
      VALUES ($1, 'ROM', 1, 1, $2, $3, 'synthetic-import', $4)`, [translationId, content, sha256Hex(content), h.clock.now()]);
  }
});

test('signed out cannot inspect content or manifests, including HEAD and encoded routes', async () => {
  for (const url of ['/api/content/translations', '/api/content/books?translation=CSB', chapterUrl, `${chapterUrl}/download-manifest`, `${chapterUrl}/download-manifest?narration=true`, `${chapterUrl}/recordings`, '/%61pi/content/CSB/rom/1']) {
    assert.equal((await get(url)).statusCode, 401, url);
  }
  assert.equal((await h.app.inject({ method: 'HEAD', url: chapterUrl })).statusCode, 401);
});

test('solo accounts and ordinary members cannot retrieve imported CSB, even with owner ETag or manifest URL', async () => {
  const allowed = await get(chapterUrl, owner.cookie);
  assert.equal(allowed.statusCode, 200);
  for (const user of [solo, member]) {
    const translations = (await get('/api/content/translations', user.cookie)).json();
    assert.notEqual(translations.find((t: { id: string }) => t.id === 'CSB').availability.state, 'available');
    const books = await get('/api/content/books?translation=CSB', user.cookie);
    assert.equal(books.statusCode, 409);
    assert.doesNotMatch(books.body, /"bookId"/);
    for (const url of [chapterUrl, '/%61pi/content/CSB/rom/1', `${chapterUrl}/download-manifest`, `${chapterUrl}/download-manifest?narration=true`]) {
      const response = await get(url, user.cookie, { 'if-none-match': String(allowed.headers.etag) });
      assert.equal(response.statusCode, 403, url);
      assert.equal(response.json().error, 'content_not_permitted');
      assert.doesNotMatch(response.body, /Private imported|assets|sha256|restrictedToUserId/);
      assert.match(String(response.headers['cache-control']), /no-store/);
    }
    assert.equal((await h.app.inject({ method: 'HEAD', url: chapterUrl, cookies: { bs_session: user.cookie } })).statusCode, 403);
    const recordings = await get(`${chapterUrl}/recordings`, user.cookie);
    assert.doesNotMatch(recordings.body, /Private imported/);
    const exported = await get('/api/export', user.cookie);
    assert.equal(exported.statusCode, 200);
    assert.doesNotMatch(exported.body, /Private imported/);
    // Public-domain solo reading does not require a membership.
    assert.equal((await get('/api/content/BSB/ROM/1', user.cookie)).json().verses[0].text, bsbText);
    assert.equal((await get('/api/content/BSB/ROM/1/download-manifest', user.cookie)).statusCode, 200);
  }
});

test('configured owner can read and download imported CSB with an account scope, even without membership', async () => {
  await h.db.query('DELETE FROM memberships WHERE user_id = $1', [owner.userId]);
  const response = await get(chapterUrl, owner.cookie);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().verses[0].text, importedText);
  assert.equal(response.json().restrictedToUserId, owner.userId);
  assert.equal(response.json().expiresAt, null);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  const manifest = await get(`${chapterUrl}/download-manifest`, owner.cookie);
  assert.equal(manifest.statusCode, 200);
  assert.equal(manifest.json().restrictedToUserId, owner.userId);
  assert.equal(manifest.json().assets[0].sha256, sha256Hex(response.body));
  assert.equal((await get('/api/content/books?translation=CSB', owner.cookie)).json()[0].bookId, 'ROM');
});

test('missing owner, disabled imports and omitted internal access fail closed; a group owner role grants nothing', async () => {
  // The default internal API cannot accidentally expose imports to a new caller (including assistant callers).
  await assert.rejects(getChapter(h.db, 'CSB', 'ROM', 1, null), { code: 'content_not_permitted' });
  for (const config of [{ ...h.config, ownerEmail: null }, { ...h.config, csbImportedAccess: 'disabled' as const }, { ...h.config, ownerEmail: 'someone-else@example.test' }]) {
    const access = await contentAccess(h.db, config, owner.userId);
    await assert.rejects(getChapter(h.db, 'CSB', 'ROM', 1, null, access), { code: 'content_not_permitted' });
  }
});

test('disabling imports or unsetting OWNER_EMAIL denies the owner on real routes and hides imported catalog entries', async () => {
  const originalEmail = h.config.ownerEmail;
  try {
    for (const mode of ['disabled', 'missing-owner'] as const) {
      h.config.csbImportedAccess = mode === 'disabled' ? 'disabled' : 'owner';
      h.config.ownerEmail = mode === 'missing-owner' ? null : originalEmail;
      for (const url of [chapterUrl, `${chapterUrl}/download-manifest`]) {
        assert.equal((await get(url, owner.cookie)).statusCode, 403, mode);
      }
      const translations = (await get('/api/content/translations', owner.cookie)).json();
      assert.notEqual(translations.find((t: { id: string }) => t.id === 'CSB').availability.state, 'available');
      assert.equal((await get('/api/content/books?translation=CSB', owner.cookie)).statusCode, 409);
      assert.equal((await get('/api/content/BSB/ROM/1', solo.cookie)).statusCode, 200);
    }
  } finally {
    h.config.csbImportedAccess = 'owner';
    h.config.ownerEmail = originalEmail;
  }
});

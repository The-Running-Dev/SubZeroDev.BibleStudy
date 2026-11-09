import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { getChapter } from '../../src/server/content/catalog.ts';
import { createSession } from '../../src/server/identity/sessions.ts';
import { sha256Hex } from '../../src/server/platform/secrets.ts';
import type { Harness } from '../support/harness.ts';
import { ownerEmail, startHarness, truncateAll } from '../support/harness.ts';

// Synthetic text only. Real PostgreSQL and the real authentication middleware; no model or upstream service.
const importedText = 'Shared imported fixture verse.';
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

before(async () => { h = await startHarness({ OWNER_EMAIL: '', CSB_IMPORTED_ACCESS: 'disabled' }); });
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

test('every signed-in account receives identical imported chapters, catalogs and manifests', async () => {
  const expectedChapter = await get(chapterUrl, owner.cookie);
  const expectedTranslations = await get('/api/content/translations', owner.cookie);
  const expectedBooks = await get('/api/content/books?translation=CSB', owner.cookie);
  const expectedManifest = await get(`${chapterUrl}/download-manifest`, owner.cookie);
  assert.equal(expectedChapter.statusCode, 200);
  assert.equal(expectedChapter.json().verses[0].text, importedText);
  assert.equal(expectedChapter.json().expiresAt, null);
  assert.equal(expectedChapter.json().restrictedToUserId, undefined);
  assert.equal(expectedManifest.json().restrictedToUserId, undefined);
  assert.equal(expectedManifest.json().assets[0].sha256, sha256Hex(expectedChapter.body));
  assert.equal(expectedTranslations.json().find((t: { id: string }) => t.id === 'CSB').availability.state, 'available');
  assert.equal(expectedBooks.json()[0].bookId, 'ROM');
  for (const user of [owner, solo, member]) {
    for (const url of [chapterUrl, '/%61pi/content/CSB/rom/1']) {
      const response = await get(url, user.cookie);
      assert.equal(response.statusCode, 200);
      assert.equal(response.body, expectedChapter.body);
      assert.equal(response.headers.etag, expectedChapter.headers.etag);
      assert.equal(response.headers['cache-control'], 'private, no-store');
      assert.equal((await get(url, user.cookie, { 'if-none-match': String(expectedChapter.headers.etag) })).statusCode, 304);
      const head = await h.app.inject({ method: 'HEAD', url, cookies: { bs_session: user.cookie } });
      assert.equal(head.statusCode, 200);
      assert.equal(head.body, '');
      assert.equal(head.headers.etag, expectedChapter.headers.etag);
    }
    assert.equal((await get('/api/content/translations', user.cookie)).body, expectedTranslations.body);
    assert.equal((await get('/api/content/books?translation=CSB', user.cookie)).body, expectedBooks.body);
    const manifest = await get(`${chapterUrl}/download-manifest`, user.cookie);
    assert.equal(manifest.statusCode, 200);
    assert.equal(manifest.body, expectedManifest.body);
    // CSB has no narration; the account does not affect that result.
    assert.equal((await get(`${chapterUrl}/download-manifest?narration=true`, user.cookie)).statusCode, 409);
    assert.deepEqual((await get(`${chapterUrl}/recordings`, user.cookie)).json(), { recordings: [], preparing: [], failed: [] });
    assert.equal((await get('/api/content/BSB/ROM/1', user.cookie)).json().verses[0].text, bsbText);
    const exported = await get('/api/export', user.cookie);
    assert.equal(exported.statusCode, 200);
    assert.doesNotMatch(exported.body, /Shared imported fixture/);
  }
});

test('imported content needs neither a configured owner nor group membership; obsolete access mode is ignored', async () => {
  // The harness starts without OWNER_EMAIL and with the removed disabled mode still present in its environment.
  assert.equal(h.config.ownerEmail, null);
  await h.db.query('DELETE FROM memberships');
  const original = h.config.ownerEmail;
  try {
    for (const email of [null, 'unrelated@example.test']) {
      h.config.ownerEmail = email;
      for (const user of [owner, solo, member]) {
        assert.equal((await get(chapterUrl, user.cookie)).statusCode, 200);
        assert.equal((await get(`${chapterUrl}/download-manifest`, user.cookie)).statusCode, 200);
      }
      const internal = await getChapter(h.db, 'CSB', 'ROM', 1, null);
      assert.equal(JSON.parse(internal.body).verses[0].text, importedText);
    }
  } finally { h.config.ownerEmail = original; }
});


test('S19/S20 shared scripture does not grant operational or assistant access, even after ownership is revoked', async () => {
  // OWNER_EMAIL is absent and the obsolete disabled mode is present: only persisted membership
  // authorizes operations. Scripture remains shared regardless of either setting.
  const privateRecipient = 'private-operations@example.test';
  const jobId = randomUUID();
  await h.db.query(`INSERT INTO email_jobs (id, kind, idempotency_key, to_address, subject, text_body, html_body, status, attempts, next_attempt_at, created_at, last_error)
    VALUES ($1::uuid, 'reminder', $1::text, $2, 'Private', 'Private', '<p>Private</p>', 'failed', 1, $3, $3, '550 private error')`,
    [jobId, privateRecipient, h.clock.now()]);
  assert.equal((await get('/api/owner/status')).statusCode, 401);
  const ownerConfig = h.config.ownerEmail;
  try {
    for (const configuredOwner of [null, 'unrelated@example.test']) {
      h.config.ownerEmail = configuredOwner;
      const operational = await get('/api/owner/status', owner.cookie);
      assert.equal(operational.statusCode, 200);
      assert.equal(operational.json().mail.failed[0].to, privateRecipient);
      for (const user of [owner, solo, member]) {
        assert.equal((await get(chapterUrl, user.cookie)).json().verses[0].text, importedText);
        assert.equal((await get(`${chapterUrl}/download-manifest`, user.cookie)).statusCode, 200);
        assert.equal((await get('/api/assistant/status', user.cookie)).json().state, 'not_permitted');
      }
      for (const user of [solo, member]) {
        for (const method of ['GET', 'HEAD'] as const) {
          for (const url of ['/api/owner/status', '/%61pi/owner/status?role=owner']) {
            const denied = await h.app.inject({ method, url, cookies: { bs_session: user.cookie }, headers: { 'if-none-match': '*' } });
            assert.equal(denied.statusCode, 403);
            assert.equal(denied.headers['cache-control'], 'no-store');
            assert.doesNotMatch(denied.body, /private-operations|private error|counts|connector/);
          }
        }
      }
    }
    await h.db.query("UPDATE memberships SET role = 'member', removed_at = $1 WHERE user_id = $2", [h.clock.now(), owner.userId]);
    const formerOwner = await get('/api/owner/status', owner.cookie);
    assert.equal(formerOwner.statusCode, 403);
    assert.doesNotMatch(formerOwner.body, /private-operations|counts|connector/);
    assert.equal((await get(chapterUrl, owner.cookie)).json().verses[0].text, importedText);
    assert.equal((await get(`${chapterUrl}/download-manifest`, owner.cookie)).statusCode, 200);
  } finally { h.config.ownerEmail = ownerConfig; }
});

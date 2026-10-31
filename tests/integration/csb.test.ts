import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Harness } from '../support/harness.ts';
import { signIn, startHarness, truncateAll } from '../support/harness.ts';

// A local stand-in for API.Bible. It answers with synthetic text only: no CSB text is kept in this repository, and S13.3
// against the real service needs the owner's key and approved CSB access.
const fixtureKey = 'fixture-key';
const bibleId = 'csb-fixture';
const copyright = 'Synthetic copyright notice for tests.';
const day = 24 * 60 * 60 * 1000;

let mode: 'ok' | 'missing-key' | 'bad-key' | 'down' | 'limited' | 'no-chapter' = 'ok';
let served = 0;
const requests: string[] = [];
let api: Server;
let h: Harness;
let cookie: string;
let savedNotice: string;

function answer(url: URL, headers: Record<string, string | string[] | undefined>): [number, unknown] {
  if (mode === 'down') return [503, { message: 'unavailable' }];
  if (mode === 'limited') return [429, { message: 'Too many requests' }];
  // Recorded 2026-10-31: no key is 401, an unknown key is 403 with this body.
  if (mode === 'missing-key') return [401, { statusCode: 401, error: 'Unauthorized', message: 'Missing API key' }];
  if (mode === 'bad-key' || headers['api-key'] !== fixtureKey) return [403, { statusCode: 403, error: 'Forbidden', message: 'Invalid API key' }];
  if (url.pathname === `/v1/bibles/${bibleId}`) return [200, { data: { id: bibleId, abbreviation: 'CSB' } }];
  const match = new RegExp(`^/v1/bibles/${bibleId}/chapters/([1-3A-Z]{3})\\.(\\d+)$`).exec(url.pathname);
  if (!match || mode === 'no-chapter') return [404, { message: 'not found' }];
  const id = `${match[1]}.${match[2]}`;
  served += 1;
  const verse = (n: number, value: string) => [
    { type: 'tag', name: 'verse', attrs: { number: String(n), style: 'v' }, items: [{ type: 'text', text: String(n) }] },
    { type: 'text', text: value, attrs: { verseId: `${id}.${n}` } },
  ];
  return [
    200,
    {
      data: {
        id,
        bibleId,
        number: match[2],
        bookId: match[1],
        reference: id,
        verseCount: 2,
        copyright,
        content: [
          { type: 'tag', name: 'para', attrs: { style: 's1' }, items: [{ type: 'text', text: 'Synthetic heading' }] },
          { type: 'tag', name: 'para', attrs: { style: 'p' }, items: [...verse(1, `Fixture verse one, fetch ${served}.`), ...verse(2, 'Fixture verse two.')] },
        ],
      },
      meta: { fumsToken: `token-${id}-${served}` },
    },
  ];
}

before(async () => {
  api = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    requests.push(url.pathname + url.search);
    const [status, body] = answer(url, request.headers);
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  h = await startHarness({
    APIBIBLE_KEY: fixtureKey,
    APIBIBLE_CSB_BIBLE_ID: bibleId,
    APIBIBLE_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}/v1`,
  });
  savedNotice = (await h.db.query<{ copyright_notice: string }>(`SELECT copyright_notice FROM translations WHERE id = 'CSB'`)).rows[0].copyright_notice;
});
after(async () => {
  await h?.db.query(`UPDATE translations SET copyright_notice = $1 WHERE id = 'CSB'`, [savedNotice]);
  await h?.close();
  api?.close();
});

beforeEach(async () => {
  await truncateAll(h.db);
  // A day apart, so the availability one test cached has expired by the next.
  h.clock.advance(day);
  mode = 'ok';
  requests.length = 0;
  cookie = (await signIn(h, 'reader@example.test')).cookie;
});

const get = (url: string) => h.app.inject({ method: 'GET', url, cookies: { bs_session: cookie } });
const csbOf = async () => (await get('/api/content/translations')).json().find((t: { id: string }) => t.id === 'CSB');

describe('CSB from API.Bible (S13)', () => {
  test('S13.2 a key API.Bible refuses makes CSB unavailable: "API.Bible rejected the key" (401 and 403)', async () => {
    for (const refused of ['missing-key', 'bad-key'] as const) {
      mode = refused;
      h.clock.advance(day);
      assert.deepEqual((await csbOf()).availability, { state: 'unavailable', reason: 'API.Bible rejected the key' }, refused);
      const chapter = await get('/api/content/CSB/ROM/1');
      assert.equal(chapter.statusCode, 409);
      assert.equal(chapter.json().error, 'translation_unavailable');
      assert.equal(chapter.json().message, 'API.Bible rejected the key');
      assert.equal((await get('/api/content/books?translation=CSB')).statusCode, 409);
    }
    assert.equal((await h.db.query(`SELECT 1 FROM chapters WHERE translation_id = 'CSB'`)).rowCount, 0);
  });

  test('S13.3 (fixture) a chapter comes from API.Bible with its notice, a 14-day expiry and the Fair Use token', async () => {
    assert.deepEqual((await csbOf()).availability, { state: 'available' });
    const response = await get('/api/content/CSB/rom/1');
    assert.equal(response.statusCode, 200);
    const chapter = response.json();
    assert.deepEqual(
      { ...chapter, contentSha256: undefined },
      {
        translationId: 'CSB',
        bookId: 'ROM',
        chapter: 1,
        verseCount: 2,
        contentSha256: undefined,
        expiresAt: new Date(h.clock.now().getTime() + 14 * day).toISOString(),
        fums: { token: 'token-ROM.1-1' },
        verses: [
          { number: 1, text: 'Fixture verse one, fetch 1.' },
          { number: 2, text: 'Fixture verse two.' },
        ],
        headings: [{ beforeVerse: 1, text: 'Synthetic heading' }],
        footnotes: [],
      },
    );
    const call = requests.find((r) => r.includes('/chapters/'));
    assert.ok(call?.startsWith(`/v1/bibles/${bibleId}/chapters/ROM.1?`), call);
    const query = new URLSearchParams((call ?? '').split('?')[1]);
    assert.equal(query.get('content-type'), 'json');
    assert.equal(query.get('fums-version'), '3');
    assert.equal((await csbOf()).copyrightNotice, copyright);
    assert.deepEqual((await get('/api/content/books?translation=CSB')).json().length, 66);

    const stored = await h.db.query(`SELECT source_ref, fums_token FROM chapters WHERE translation_id = 'CSB'`);
    assert.deepEqual(stored.rows, [{ source_ref: `apibible:${bibleId}/ROM.1`, fums_token: 'token-ROM.1-1' }]);
  });

  test('S13.4 a stored chapter is served until it expires, then refetched; if that fails it is not served', async () => {
    const first = (await get('/api/content/CSB/ROM/1')).json();
    h.clock.advance(14 * day - 1000);
    const cached = await get('/api/content/CSB/ROM/1');
    assert.equal(cached.json().verses[0].text, first.verses[0].text);
    assert.equal(requests.filter((r) => r.includes('/chapters/')).length, 1);

    h.clock.advance(1000);
    const refetched = (await get('/api/content/CSB/ROM/1')).json();
    assert.equal(requests.filter((r) => r.includes('/chapters/')).length, 2);
    assert.notEqual(refetched.verses[0].text, first.verses[0].text);
    assert.equal(refetched.expiresAt, new Date(h.clock.now().getTime() + 14 * day).toISOString());
    assert.notEqual(refetched.fums.token, first.fums.token);

    h.clock.advance(14 * day);
    mode = 'down';
    const expired = await get('/api/content/CSB/ROM/1');
    assert.equal(expired.statusCode, 409);
    assert.equal(expired.json().error, 'translation_unavailable');
    assert.equal(expired.json().message, 'API.Bible could not be reached; try again later');
    assert.equal((await h.db.query(`SELECT 1 FROM chapters WHERE translation_id = 'CSB'`)).rowCount, 0);
  });

  const chapterCalls = () => requests.filter((r) => r.includes('/chapters/')).length;

  test('S13.4 a chapter API.Bible lacks fails alone, and is not asked for again for a minute', async () => {
    mode = 'no-chapter';
    const missing = await get('/api/content/CSB/ROM/1');
    assert.equal(missing.statusCode, 409);
    assert.match(missing.json().message, /does not offer this Bible/);
    assert.equal((await get('/api/content/CSB/ROM/1')).statusCode, 409);
    assert.equal(chapterCalls(), 1);
    assert.deepEqual((await csbOf()).availability, { state: 'available' });

    mode = 'ok';
    assert.equal((await get('/api/content/CSB/ROM/2')).statusCode, 200);
    assert.equal((await get('/api/content/CSB/ROM/1')).statusCode, 409);
    h.clock.advance(61_000);
    assert.equal((await get('/api/content/CSB/ROM/1')).statusCode, 200);
    assert.equal(chapterCalls(), 3);
  });

  test('S13.4 the request limit holds for every chapter for a minute', async () => {
    mode = 'limited';
    const limited = await get('/api/content/CSB/ROM/1');
    assert.equal(limited.statusCode, 409);
    assert.equal(limited.json().message, "API.Bible's request limit was reached; try again later");
    assert.equal((await get('/api/content/CSB/ROM/2')).json().message, "API.Bible's request limit was reached; try again later");
    assert.equal(chapterCalls(), 1);
    assert.equal((await csbOf()).availability.state, 'unavailable');

    mode = 'ok';
    h.clock.advance(61_000);
    assert.equal((await get('/api/content/CSB/ROM/2')).statusCode, 200);
    assert.equal(chapterCalls(), 2);
  });

  test('S13.4 readers asking for one chapter at once share a single request', async () => {
    const answers = await Promise.all([1, 2, 3].map(() => get('/api/content/CSB/ROM/1')));
    assert.deepEqual(answers.map((a) => a.statusCode), [200, 200, 200]);
    assert.equal(chapterCalls(), 1);
    assert.equal(new Set(answers.map((a) => a.json().fums.token)).size, 1);
  });

  test('S13.5 CSB narration is unavailable: no licensed CSB recording', async () => {
    assert.deepEqual((await csbOf()).narration, { state: 'unavailable', reason: 'No licensed CSB recording.' });
  });
});

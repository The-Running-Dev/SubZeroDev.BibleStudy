import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createAoLabSource } from '../../src/server/content/aolab.ts';
import type { AoBook, AoChapter, ContentSource } from '../../src/server/content/aolab.ts';
import { createAudioWorker } from '../../src/server/content/audio-worker.ts';
import { runImport } from '../../src/server/content/import.ts';
import { importAudio } from '../../src/server/content/narration.ts';
import { sha256Hex } from '../../src/server/platform/secrets.ts';
import type { Harness } from '../support/harness.ts';
import { clearMailbox, signIn, startHarness, truncateAll } from '../support/harness.ts';
import { synthMp3 } from '../support/mp3.ts';

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
  cookie = (await signIn(h, 'listener@example.test')).cookie;
}

const get = (url: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url, cookies: { bs_session: cookie }, headers });
const mediaFile = (sha256: string) => join(h.config.mediaDir, `${sha256}.mp3`);

// ---- A local stand-in for AO Lab's chapter, timing and audio files ----

const books = [
  { id: 'JUD', name: 'Jude', verses: 25 },
  { id: '3JN', name: '3 John', verses: 15 },
];
const narratorFrames: Record<string, number> = { souer: 400, hays: 401, david: 402 };

interface Fixture {
  url: string;
  timings: Map<string, unknown>; // timing path → replacement `verses`, or 'missing' for a 404
  audioStatus: Map<string, number>; // audio path → status to reply with instead
  redirects: Map<string, string>; // path → Location of a 302
  requests: string[];
  close(): Promise<void>;
}

async function startFixture(): Promise<Fixture> {
  const fixture = { timings: new Map(), audioStatus: new Map(), redirects: new Map(), requests: [] as string[] } as Fixture;
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    fixture.requests.push(path);
    const json = (body: unknown) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const location = fixture.redirects.get(path);
    if (location) {
      response.writeHead(302, { location }).end();
      return;
    }
    if (path === '/api/BSB/books.json') {
      const list: AoBook[] = books.map((b, i) => ({ id: b.id, name: b.name, order: i + 1, numberOfChapters: 1, sha256: 'book' }));
      json({ translation: { id: 'BSB', name: 'Berean Standard Bible', sha256: 'translation', numberOfBooks: list.length, totalNumberOfChapters: 2 }, books: list });
      return;
    }
    const chapter = /^\/api\/BSB\/(\w+)\/1\.json$/.exec(path);
    const timing = /^\/api\/BSB\/(\w+)\/1\.(\w+)\.timing\.json$/.exec(path);
    const audio = /^\/audio\/(\w+)\/1\/(\w+)\.mp3$/.exec(path);
    const book = books.find((b) => b.id === (chapter ?? timing ?? audio)?.[1]);
    if (book && chapter) {
      const body: AoChapter = {
        translation: { id: 'BSB', name: 'Berean Standard Bible', sha256: 'translation', numberOfBooks: 2, totalNumberOfChapters: 2 },
        book: { id: book.id, name: book.name, order: 1, numberOfChapters: 1, sha256: 'book' },
        numberOfVerses: book.verses,
        thisChapterLink: path,
        chapter: {
          number: 1,
          content: Array.from({ length: book.verses }, (_, i) => ({ type: 'verse' as const, number: i + 1, content: [`${book.name} 1:${i + 1}`] })),
          footnotes: [],
        },
        thisChapterAudioLinks: Object.fromEntries(Object.keys(narratorFrames).map((n) => [n, `${fixture.url}/audio/${book.id}/1/${n}.mp3`])),
        thisChapterAudioTimings: Object.fromEntries(Object.keys(narratorFrames).map((n) => [n, `/api/BSB/${book.id}/1.${n}.timing.json`])),
      };
      json(body);
      return;
    }
    if (book && timing) {
      const replacement = fixture.timings.get(path);
      if (replacement === 'missing') response.writeHead(404).end();
      else json({ reader: timing[2], verses: replacement ?? Array.from({ length: book.verses }, (_, i) => i * 0.4) });
      return;
    }
    if (book && audio && audio[2] in narratorFrames) {
      const status = fixture.audioStatus.get(path);
      if (status) {
        response.writeHead(status).end();
        return;
      }
      const bytes = synthMp3(narratorFrames[audio[2]] + (book.id === '3JN' ? 10 : 0));
      response.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': bytes.length }).end(bytes);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fixture.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fixture.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return fixture;
}

describe('narration from a fixture source', () => {
  let fixture: Fixture;
  let source: ContentSource;
  const deps = () => ({ db: h.db, clock: h.clock, source, mediaDir: h.config.mediaDir });

  before(async () => {
    fixture = await startFixture();
    source = createAoLabSource({ baseUrl: fixture.url, sleep: noSleep });
  });
  after(async () => {
    await fixture.close();
  });
  beforeEach(async () => {
    await freshMember();
    fixture.timings.clear();
    fixture.audioStatus.clear();
    fixture.redirects.clear();
    fixture.requests.length = 0;
    assert.equal((await runImport({ db: h.db, clock: h.clock, source }, { translationId: 'BSB' })).status, 'succeeded');
  });

  test('stores each enabled narrator under its SHA-256, records it in the manifest, and never fetches david', async () => {
    const summary = await importAudio(deps(), { translationId: 'BSB', bookId: 'JUD', chapters: [1] });
    assert.equal(summary.status, 'succeeded');
    assert.deepEqual(summary.counts, { inserted: 2, updated: 0, unchanged: 0, failed: 0 });
    for (const item of summary.items) {
      assert.ok(item.status === 'inserted');
      const bytes = readFileSync(mediaFile(item.mediaSha256));
      assert.equal(sha256Hex(bytes), item.mediaSha256);
      assert.equal(bytes.length, item.bytes);
      assert.equal(item.timingStatus, 'verified');
    }
    assert.deepEqual(
      summary.items.map((i) => i.narratorId),
      ['hays', 'souer'],
    );
    assert.ok(!fixture.requests.some((r) => r.includes('david')));
    const manifest = await h.db.query('SELECT status, scope, items FROM import_manifests WHERE id = $1', [summary.manifestId]);
    assert.equal(manifest.rows[0].scope.kind, 'audio');
    assert.deepEqual(
      manifest.rows[0].items.map((i: { mediaSha256: string; bytes: number }) => [i.mediaSha256, i.bytes]),
      summary.items.map((i) => ('mediaSha256' in i ? [i.mediaSha256, i.bytes] : null)),
    );

    const rerun = await importAudio(deps(), { translationId: 'BSB', bookId: 'JUD', chapters: [1] });
    assert.deepEqual(rerun.counts, { inserted: 0, updated: 0, unchanged: 2, failed: 0 });
    await assert.rejects(importAudio(deps(), { translationId: 'BSB', bookId: 'JUD', chapters: [1], narrators: ['david'] }), /narrator david is disabled/);
  });

  test('S3.2 a timing with too few entries or a start that does not increase is rejected; a missing one is absent', async () => {
    const twentyFour = Array.from({ length: 24 }, (_, i) => i * 0.4);
    const stalled = Array.from({ length: 25 }, (_, i) => (i === 6 ? 2.0 : i * 0.4));
    fixture.timings.set('/api/BSB/JUD/1.souer.timing.json', twentyFour);
    fixture.timings.set('/api/BSB/JUD/1.hays.timing.json', stalled);
    fixture.timings.set('/api/BSB/3JN/1.souer.timing.json', 'missing');
    const jude = await importAudio(deps(), { translationId: 'BSB', bookId: 'JUD', chapters: [1] });
    const reasons = Object.fromEntries(jude.items.map((i) => [i.narratorId, 'timingReason' in i ? [i.timingStatus, i.timingReason] : null]));
    assert.deepEqual(reasons, {
      souer: ['rejected', 'verse count 24 ≠ 25'],
      hays: ['rejected', 'verse 7 starts at 2 s, not after verse 6 at 2 s'],
    });
    const john = await importAudio(deps(), { translationId: 'BSB', bookId: '3JN', chapters: [1], narrators: ['souer'] });
    assert.ok(john.items[0].status === 'inserted' && john.items[0].timingStatus === 'absent');

    const listed = (await get('/api/content/BSB/JUD/1/recordings')).json();
    assert.deepEqual(listed.recordings.find((r: { narratorId: string }) => r.narratorId === 'souer').timing, { status: 'rejected', reason: 'verse count 24 ≠ 25' });
  });

  test('S3.7 an unimported recording is prepared on demand, then listed', async () => {
    const worker = createAudioWorker(deps());
    const first = await get('/api/content/BSB/JUD/1/recordings');
    assert.equal(first.statusCode, 202);
    assert.equal(first.headers['cache-control'], 'no-store');
    assert.deepEqual(first.json(), { recordings: [], preparing: ['hays', 'souer'], failed: [] });
    assert.equal((await get('/api/content/BSB/JUD/1/recordings')).statusCode, 202, 'a second request does not queue twice');
    assert.equal((await h.db.query('SELECT 1 FROM audio_jobs')).rowCount, 2);

    assert.equal(await worker.runOnce(), 2);
    const ready = await get('/api/content/BSB/JUD/1/recordings');
    assert.equal(ready.statusCode, 200);
    const body = ready.json();
    assert.deepEqual(body.preparing, []);
    assert.deepEqual(
      body.recordings.map((r: { narratorId: string; narratorName: string; license: string; timing: { status: string } }) => [r.narratorId, r.narratorName, r.license, r.timing.status]),
      [
        ['hays', 'Barry Hays', 'CC0 1.0', 'verified'],
        ['souer', 'Bob Souer', 'CC0 1.0', 'verified'],
      ],
    );
    assert.equal(body.recordings[0].mediaUrl, `/media/${body.recordings[0].mediaSha256}`);
    assert.equal((await h.db.query('SELECT 1 FROM audio_jobs')).rowCount, 0);
  });

  test('S3.7 a failed on-demand import is listed under failed with its reason, and asked for again an hour later', async () => {
    const worker = createAudioWorker(deps());
    fixture.audioStatus.set('/audio/JUD/1/hays.mp3', 404);
    fixture.audioStatus.set('/audio/JUD/1/souer.mp3', 503);
    assert.equal((await get('/api/content/BSB/JUD/1/recordings')).statusCode, 202);

    await worker.runOnce();
    // hays failed for good (404); souer's 503 is retried 1, 5, 15 and 60 minutes later, then fails.
    let listing = (await get('/api/content/BSB/JUD/1/recordings')).json();
    assert.deepEqual(listing.preparing, ['souer']);
    assert.equal(listing.failed.length, 1);
    assert.equal(listing.failed[0].narratorId, 'hays');
    assert.match(listing.failed[0].reason, /hays\.mp3: not found/);
    for (const minutes of [1, 5, 15, 60]) {
      h.clock.advance(minutes * 60_000);
      assert.equal(await worker.runOnce(), 1);
    }
    // 81 minutes on: souer has just failed, and hays (failed at the start) is asked for again.
    const settled = await get('/api/content/BSB/JUD/1/recordings');
    assert.equal(settled.statusCode, 202);
    listing = settled.json();
    assert.deepEqual(listing.preparing, ['hays']);
    assert.equal(listing.failed.length, 1);
    assert.equal(listing.failed[0].narratorId, 'souer');
    assert.match(listing.failed[0].reason, /souer\.mp3: HTTP 503/);

    fixture.audioStatus.clear();
    h.clock.advance(61 * 60_000);
    const retried = await get('/api/content/BSB/JUD/1/recordings');
    assert.equal(retried.statusCode, 202);
    assert.deepEqual(retried.json(), { recordings: [], preparing: ['hays', 'souer'], failed: [] });
    assert.equal(await worker.runOnce(), 2);
    const stored = await get('/api/content/BSB/JUD/1/recordings');
    assert.equal(stored.statusCode, 200);
    assert.equal(stored.json().recordings.length, 2);
  });

  test('a recording whose file is gone is not served, and is fetched again like one never stored', async () => {
    const worker = createAudioWorker(deps());
    const summary = await importAudio(deps(), { translationId: 'BSB', bookId: 'JUD', chapters: [1], narrators: ['souer'] });
    const sha = summary.items[0].status === 'inserted' ? summary.items[0].mediaSha256 : '';
    rmSync(mediaFile(sha));
    const media = await get(`/media/${sha}`);
    assert.equal(media.statusCode, 404);
    assert.equal(media.json().message, 'Narration unavailable for this chapter: the media file is missing from the server');
    const listing = await get('/api/content/BSB/JUD/1/recordings');
    assert.equal(listing.statusCode, 202);
    assert.deepEqual(listing.json(), { recordings: [], preparing: ['hays', 'souer'], failed: [] });

    assert.equal(await worker.runOnce(), 2);
    assert.equal(sha256Hex(readFileSync(mediaFile(sha))), sha);
    const ready = await get('/api/content/BSB/JUD/1/recordings');
    assert.equal(ready.statusCode, 200);
    assert.deepEqual(
      ready.json().recordings.map((r: { narratorId: string }) => r.narratorId),
      ['hays', 'souer'],
    );
    assert.equal((await get(`/media/${sha}`)).statusCode, 200);
  });

  test('a redirect is followed only to a host the first URL could have named', async () => {
    const audioUrl = `${fixture.url}/audio/JUD/1/souer.mp3`;
    fixture.redirects.set('/moved/souer.mp3', '/audio/JUD/1/souer.mp3');
    fixture.redirects.set('/away/souer.mp3', 'https://169.254.169.254/latest/meta-data');
    fixture.redirects.set('/api/BSB/JUD/1.away.timing.json', 'https://example.com/timing.json');
    fixture.redirects.set('/loop/a.mp3', '/loop/b.mp3');
    fixture.redirects.set('/loop/b.mp3', '/loop/a.mp3');
    const moved = await source.audio(`${fixture.url}/moved/souer.mp3`);
    assert.deepEqual(moved.bytes, (await source.audio(audioUrl)).bytes);
    await assert.rejects(source.audio(`${fixture.url}/away/souer.mp3`), /169\.254\.169\.254 is not an audio source/);
    await assert.rejects(source.timing('/api/BSB/JUD/1.away.timing.json'), /not on http:\/\/127\.0\.0\.1/);
    await assert.rejects(source.audio(`${fixture.url}/loop/a.mp3`), /more than 3 redirects/);
    // Each refusal is final: none of them is retried.
    assert.equal(fixture.requests.filter((r) => r === '/away/souer.mp3').length, 1);
    assert.equal(fixture.requests.filter((r) => r === '/loop/a.mp3').length, 2);
  });

  test('408 and 429 are retried like a 5xx; other 4xx fail at once', async () => {
    for (const [status, tries] of [
      [429, 3],
      [408, 3],
      [503, 3],
      [403, 1],
    ]) {
      fixture.requests.length = 0;
      fixture.audioStatus.set('/audio/JUD/1/souer.mp3', status);
      await assert.rejects(source.audio(`${fixture.url}/audio/JUD/1/souer.mp3`), new RegExp(`HTTP ${status}`));
      assert.equal(fixture.requests.length, tries, `HTTP ${status}`);
    }
    // The worker keeps a rate-limited recording preparing rather than failing it.
    const worker = createAudioWorker(deps());
    fixture.audioStatus.set('/audio/JUD/1/souer.mp3', 429);
    await get('/api/content/BSB/JUD/1/recordings');
    await worker.runOnce();
    const listing = (await get('/api/content/BSB/JUD/1/recordings')).json();
    assert.deepEqual(listing.preparing, ['souer']);
    assert.deepEqual(listing.failed, []);
  });

  test('a queued recording by a narrator disabled since fails for good; its stored media is no longer served', async () => {
    const summary = await importAudio(deps(), { translationId: 'BSB', bookId: 'JUD', chapters: [1], narrators: ['souer'] });
    const sha = summary.items[0].status === 'inserted' ? summary.items[0].mediaSha256 : '';
    await get('/api/content/BSB/3JN/1/recordings');
    await h.db.query(`UPDATE narrators SET enabled = false WHERE id = 'souer'`);
    try {
      assert.equal((await get(`/media/${sha}`)).statusCode, 404);
      await createAudioWorker(deps()).runOnce();
      const job = await h.db.query(`SELECT status, reason FROM audio_jobs WHERE book_id = '3JN' AND narrator_id = 'souer'`);
      assert.equal(job.rows[0].status, 'failed');
      assert.match(job.rows[0].reason, /narrator souer is disabled/);
    } finally {
      await h.db.query(`UPDATE narrators SET enabled = true WHERE id = 'souer'`);
    }
    assert.equal((await get(`/media/${sha}`)).statusCode, 200);
  });

  test('CSB lists no recordings; unimported text and unknown chapters are refused', async () => {
    assert.deepEqual((await get('/api/content/CSB/JUD/1/recordings')).json(), { recordings: [], preparing: [], failed: [] });
    const rom = await get('/api/content/BSB/ROM/1/recordings');
    assert.equal(rom.statusCode, 409);
    assert.equal(rom.json().error, 'translation_unavailable');
    assert.equal((await get('/api/content/BSB/JUD/2/recordings')).json().error, 'chapter_not_found');
    assert.equal((await h.db.query('SELECT 1 FROM audio_jobs')).rowCount, 0);
  });

  test('media needs a session; unknown hashes, stale validators, backwards ranges and ranges past the end are handled', async () => {
    const summary = await importAudio(deps(), { translationId: 'BSB', bookId: 'JUD', chapters: [1], narrators: ['souer'] });
    const sha = summary.items[0].status === 'inserted' ? summary.items[0].mediaSha256 : '';
    const size = statSync(mediaFile(sha)).size;
    assert.equal((await h.app.inject({ method: 'GET', url: `/media/${sha}` })).statusCode, 401);
    assert.equal((await get(`/media/${'0'.repeat(64)}`)).statusCode, 404);
    assert.equal((await get('/media/not-a-hash')).statusCode, 404);
    assert.equal((await get(`/media/${sha}`, { 'if-none-match': `"${sha}"` })).statusCode, 304);
    const past = await get(`/media/${sha}`, { range: `bytes=${size}-` });
    assert.equal(past.statusCode, 416);
    assert.equal(past.headers['content-range'], `bytes */${size}`);
    assert.equal(past.headers['cache-control'], 'no-store', 'a refusal is not cached as immutable');
    const backwards = await get(`/media/${sha}`, { range: 'bytes=5-2' });
    assert.equal(backwards.statusCode, 200);
    assert.equal(backwards.rawPayload.length, size);
    assert.equal(backwards.headers['cache-control'], 'private, max-age=31536000, immutable');
    const stale = await get(`/media/${sha}`, { range: 'bytes=0-9', 'if-range': '"something-else"' });
    assert.equal(stale.statusCode, 200);
    assert.equal(stale.rawPayload.length, size);
  });

  test('S14 a download manifest names each asset with the hash and length of the exact bytes the device will receive', async () => {
    const manifestUrl = '/api/content/BSB/JUD/1/download-manifest';
    assert.equal((await h.app.inject({ method: 'GET', url: manifestUrl })).statusCode, 401);

    const text = await get(manifestUrl);
    assert.equal(text.statusCode, 200);
    assert.equal(text.headers['cache-control'], 'no-store');
    const chapter = await get('/api/content/BSB/JUD/1');
    assert.deepEqual(text.json(), {
      assets: [{ url: '/api/content/BSB/JUD/1', sha256: sha256Hex(chapter.rawPayload), bytes: chapter.rawPayload.length, kind: 'chapter' }],
      totalBytes: chapter.rawPayload.length,
      expiresAt: null,
    });

    // Narration not yet stored: refused and queued, so asking again shortly succeeds.
    const early = await get(`${manifestUrl}?narration=true`);
    assert.equal(early.statusCode, 409);
    assert.equal(early.json().error, 'narration_unavailable');
    assert.equal(early.json().retryable, true);
    assert.equal((await h.db.query('SELECT 1 FROM audio_jobs')).rowCount, 2);

    await createAudioWorker(deps()).runOnce();
    const full = (await get(`${manifestUrl}?narration=true`)).json();
    const listed = (await get('/api/content/BSB/JUD/1/recordings')).json().recordings[0];
    assert.equal(full.assets.length, 2);
    const audio = full.assets[1];
    assert.deepEqual(audio, { url: listed.mediaUrl, sha256: listed.mediaSha256, bytes: listed.bytes, kind: 'audio' });
    const media = await get(audio.url);
    assert.equal(sha256Hex(media.rawPayload), audio.sha256);
    assert.equal(media.rawPayload.length, audio.bytes);
    assert.equal(full.totalBytes, chapter.rawPayload.length + audio.bytes);

    assert.equal((await get('/api/content/BSB/JUD/2/download-manifest')).json().error, 'chapter_not_found');
  });
});

describe('Romans narration imported live from AO Lab', () => {
  let items: Awaited<ReturnType<typeof importAudio>>['items'];
  before(async () => {
    await freshMember();
    const source = createAoLabSource({ baseUrl: aoLabUrl });
    const text = await runImport({ db: h.db, clock: h.clock, source }, { translationId: 'BSB', books: ['ROM'] });
    assert.equal(text.status, 'succeeded');
    const audio = await importAudio({ db: h.db, clock: h.clock, source, mediaDir: h.config.mediaDir, concurrency: 4 }, { translationId: 'BSB', bookId: 'ROM', chapters: Array.from({ length: 16 }, (_, i) => i + 1) });
    assert.equal(audio.status, 'succeeded', JSON.stringify(audio.items.filter((i) => i.status === 'failed')));
    items = audio.items;
  });

  test('S3.1 souer and hays recordings of Romans 1–16 are stored under their SHA-256, with bytes and hash in the manifest; no david', async () => {
    assert.equal(items.length, 32);
    for (const chapter of Array.from({ length: 16 }, (_, i) => i + 1)) {
      assert.deepEqual(
        items.filter((i) => i.chapter === chapter).map((i) => i.narratorId),
        ['hays', 'souer'],
        `chapter ${chapter}`,
      );
    }
    for (const item of items) {
      assert.ok(item.status === 'inserted', JSON.stringify(item));
      const path = mediaFile(item.mediaSha256);
      assert.ok(existsSync(path), path);
      const bytes = readFileSync(path);
      assert.equal(sha256Hex(bytes), item.mediaSha256);
      assert.equal(bytes.length, item.bytes);
    }
    const manifest = await h.db.query(`SELECT items FROM import_manifests WHERE scope->>'kind' = 'audio'`);
    assert.equal(manifest.rowCount, 1);
    assert.deepEqual(
      manifest.rows[0].items.map((i: { mediaSha256: string; bytes: number }) => `${i.mediaSha256}:${i.bytes}`),
      items.map((i) => ('mediaSha256' in i ? `${i.mediaSha256}:${i.bytes}` : '')),
    );
    assert.equal((await h.db.query(`SELECT 1 FROM recordings WHERE narrator_id = 'david'`)).rowCount, 0);
  });

  test('S3.2 Romans 1 by Bob Souer has verified timing: 32 increasing starts inside the recording', async () => {
    const listing = (await get('/api/content/BSB/ROM/1/recordings')).json();
    const souer = listing.recordings.find((r: { narratorId: string }) => r.narratorId === 'souer');
    assert.equal(souer.timing.status, 'verified');
    const starts: number[] = souer.timing.verseStarts;
    assert.equal(starts.length, 32);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i] > starts[i - 1], `verse ${i + 1}`);
    assert.ok(starts[31] < souer.durationSeconds);
  });

  test('S3.3 a byte range returns 206 with exactly those bytes; the whole file hashes to its name', async () => {
    const souer = items.find((i) => i.chapter === 1 && i.narratorId === 'souer')!;
    const sha = 'mediaSha256' in souer ? souer.mediaSha256 : '';
    const size = 'bytes' in souer ? souer.bytes : 0;
    const part = await get(`/media/${sha}`, { range: 'bytes=0-99' });
    assert.equal(part.statusCode, 206);
    assert.equal(part.rawPayload.length, 100);
    assert.equal(part.headers['content-range'], `bytes 0-99/${size}`);
    assert.equal(part.headers['content-type'], 'audio/mpeg');
    assert.deepEqual(part.rawPayload, readFileSync(mediaFile(sha)).subarray(0, 100));

    const whole = await get(`/media/${sha}`);
    assert.equal(whole.statusCode, 200);
    assert.equal(whole.headers['accept-ranges'], 'bytes');
    assert.equal(whole.headers['cache-control'], 'private, max-age=31536000, immutable');
    assert.equal(whole.headers.etag, `"${sha}"`);
    assert.equal(sha256Hex(whole.rawPayload), sha);
  });
});

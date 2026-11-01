/// <reference lib="dom" />
// Real browser storage and production shell; synthetic HTTP content avoids keys, SMTP and live content services.
// These checks supplement offline.test.ts's real database/import coverage, not physical-phone acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import type {
  ChapterView,
  DownloadManifest,
  RecordingView,
  TranslationView,
} from '../../src/shared/api.ts';
import { formatBytes } from '../../src/client/offline.ts';

const userId = '00000000-0000-4000-8000-000000000001';
const mobile = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const sha = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');
// A decodable, silent PCM WAV: using a real audio element tests offline decoding/playback without upstream recordings.
const audio = Buffer.alloc(44 + 8000 * 2 * 5);
audio.write('RIFF');
audio.writeUInt32LE(audio.length - 8, 4);
audio.write('WAVEfmt ', 8);
audio.writeUInt32LE(16, 16);
audio.writeUInt16LE(1, 20);
audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(8000, 24);
audio.writeUInt32LE(16000, 28);
audio.writeUInt16LE(2, 32);
audio.writeUInt16LE(16, 34);
audio.write('data', 36);
audio.writeUInt32LE(audio.length - 44, 40);
const mediaUrl = `/media/${sha(audio)}`;
const recording: RecordingView = {
  id: '00000000-0000-4000-8000-000000000002',
  narratorId: 'fixture',
  narratorName: 'Synthetic narration',
  license: 'Test fixture',
  mediaUrl,
  mediaSha256: sha(audio),
  bytes: audio.length,
  durationSeconds: 5,
  timing: { status: 'verified', verseStarts: [0, 1, 3] },
};
const translations: TranslationView[] = ['BSB', 'CSB'].map((id) => ({
  id: id as 'BSB' | 'CSB',
  name: `Synthetic ${id}`,
  copyrightNotice: 'Synthetic test content only.',
  availability: { state: 'available' },
  narration:
    id === 'BSB'
      ? { state: 'available' }
      : { state: 'unavailable', reason: 'No licensed CSB recording.' },
}));
let expiresAt: string | null;
let restrictedToUserId: string | undefined;
let corruptText: boolean;
let holdAudio: boolean;
let unavailable: boolean;
let missingChapter: boolean;
let requests: string[];
let server: Server;
let baseUrl: string;
let browser: Browser;

function chapter(translationId: 'BSB' | 'CSB', n: number): ChapterView {
  return {
    ...(translationId === 'CSB' && expiresAt === null && restrictedToUserId ? { restrictedToUserId } : {}),
    translationId,
    bookId: 'ROM',
    chapter: n,
    verseCount: 3,
    contentSha256: '0'.repeat(64),
    expiresAt: translationId === 'CSB' ? expiresAt : null,
    verses: [1, 2, 3].map((number) => ({
      number,
      text: `Synthetic verse ${number} of chapter ${n}.`,
    })),
    headings: [],
    footnotes: [],
  };
}

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    requests.push(url.pathname);
    const json = (body: unknown, status = 200) =>
      res
        .writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify(body));
    if (url.pathname === '/api/me')
      return void json({
        id: userId,
        email: 'offline@example.test',
        displayName: 'Offline reader',
        timeZone: 'Europe/Sofia',
        displayTranslationId: null,
      });
    if (url.pathname === '/api/groups') return void json([]);
    if (url.pathname === '/api/sync/pull')
      return void json({ notes: [], soloPosition: null, conflicts: [], cursor: '0' });
    if (url.pathname === '/api/sync/push') {
      // Position updates only; note preservation below is exercised offline through the existing S15 outbox.
      let body = '';
      for await (const part of req) body += part;
      return void json({
        results: (JSON.parse(body).ops as { opId: string }[]).map((op) => ({
          opId: op.opId,
          outcome: 'applied',
          revision: 1,
        })),
      });
    }
    if (url.pathname === '/api/assistant/status')
      return void json(
        {
          error: 'assistant_not_permitted',
          message: 'Not enabled in this fixture.',
          retryable: false,
        },
        403
      );
    if (url.pathname === '/api/content/translations') return void json(translations);
    const match = /^\/api\/content\/(BSB|CSB)\/ROM\/(\d+)(.*)$/.exec(url.pathname);
    if (match) {
      const translation = match[1] as 'BSB' | 'CSB';
      const body = JSON.stringify(chapter(translation, Number(match[2])));
      if (match[3] === '/recordings')
        return void json({
          recordings: translation === 'BSB' ? [recording] : [],
          preparing: [],
          failed: [],
        });
      if (match[3] === '/download-manifest') {
        if (unavailable)
          return void json(
            {
              error: 'translation_unavailable',
              message: 'This licensed chapter is unavailable.',
              retryable: false,
            },
            409
          );
        const assets: DownloadManifest['assets'] = missingChapter
          ? []
          : [
              {
                url: url.pathname.replace('/download-manifest', ''),
                sha256: sha(body),
                bytes: Buffer.byteLength(body),
                kind: 'chapter',
              },
            ];
        if (url.searchParams.get('narration') === 'true')
          assets.push({ url: mediaUrl, sha256: sha(audio), bytes: audio.length, kind: 'audio' });
        return void json({
          ...(translation === 'CSB' && expiresAt === null && restrictedToUserId ? { restrictedToUserId } : {}),
          assets,
          totalBytes: assets.reduce((n, a) => n + a.bytes, 0),
          expiresAt: translation === 'CSB' ? expiresAt : null,
        });
      }
      if (!match[3]) {
        const bytes = Buffer.from(body);
        if (corruptText) bytes[body.indexOf('Synthetic verse')] = 'X'.charCodeAt(0);
        return void res
          .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          .end(bytes);
      }
    }
    if (url.pathname === mediaUrl) {
      if (holdAudio) {
        // Chunked, not Content-Length: some Chromium builds (seen on Windows) withhold a fixed-length body from the
        // reader until it is complete, so the progress bar would never move.
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.write(audio.subarray(0, Math.floor(audio.length / 2)));
        return;
      }
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': audio.length });
      return void res.end(audio);
    }
    if (url.pathname.startsWith('/api/'))
      return void json({ error: 'not_found', message: 'Not in fixture.', retryable: false }, 404);
    try {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (name.includes('..')) {
        res.writeHead(404).end();
        return;
      }
      const types: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.webmanifest': 'application/manifest+json',
        '.png': 'image/png',
      };
      res
        .writeHead(200, { 'content-type': types[extname(name)] ?? 'application/octet-stream' })
        .end(await readFile(join('dist/client', name)));
    } catch {
      res.writeHead(404).end();
    }
  });
  requests = [];
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});
beforeEach(() => {
  expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  restrictedToUserId = undefined;
  corruptText = false;
  holdAudio = false;
  unavailable = false;
  missingChapter = false;
  requests = [];
});

async function open(context: BrowserContext): Promise<Page> {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(baseUrl);
  await page.locator('.verse').first().waitFor();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  return page;
}
async function start(page: Page, narrated = true) {
  await page.getByRole('button', { name: 'Download for offline' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText(narrated ? 'Text and narration' : 'Text only').click();
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
}
async function stored(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open('biblestudy', 1);
      r.onsuccess = () => resolve(r.result);
    });
    const all = async (name: string) =>
      new Promise<unknown[]>((resolve) => {
        const r = db.transaction(name).objectStore(name).getAll();
        r.onsuccess = () => resolve(r.result);
      });
    const result = {
      downloads: await all('downloads'),
      notes: await all('notes'),
      pendingOps: await all('pendingOps'),
      media: (await (await caches.open('media-v1')).keys()).length,
    };
    db.close();
    return result;
  });
}

// Each browser profile is isolated: no ready records, cached assets or previous sign-ins can leak between cases.
describe('S14 download integrity and offline browser regressions', () => {
  test('cold offline startup reads text-only and narrated chapters, decodes audio and follows verses; unavailable chapters stay unavailable', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'bs-integrity-'));
    try {
      const online = await chromium.launchPersistentContext(profile, mobile);
      try {
        const page = await open(online);
        await page.getByRole('button', { name: 'Download for offline' }).click();
        const dialog = page.getByRole('dialog');
        const textBytes = Buffer.byteLength(JSON.stringify(chapter('BSB', 1)));
        await dialog.getByText(`Text only · ${formatBytes(textBytes)}`).waitFor();
        await dialog
          .getByText(`Text and narration · ${formatBytes(textBytes + audio.length)}`)
          .click();
        assert.deepEqual((await stored(page)).downloads, []);
        await dialog.getByRole('button', { name: 'Download', exact: true }).click();
        await page.getByText('Downloaded with narration — readable offline.').waitFor();
        await page.getByLabel('Chapter', { exact: true }).selectOption('3');
        await page.locator('.verse').first().waitFor();
        await start(page, false);
        await page.getByText('Downloaded — readable offline.').waitFor();
      } finally {
        await online.close();
      }
      // Also stop the origin: older Chromium versions can let service-worker fetches bypass context.setOffline.
      const port = (server.address() as AddressInfo).port;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      requests = [];
      const offline = await chromium.launchPersistentContext(profile, { ...mobile, offline: true });
      try {
        const page = await open(offline);
        await page.getByText('Reading the copy downloaded to this device.').waitFor();
        assert.equal(await page.locator('.verse').count(), 3);
        await page.locator('audio').click({ position: { x: 20, y: 25 } });
        await page.waitForFunction(() => {
          const a = document.querySelector('audio');
          return a && !a.paused && a.currentTime > 0;
        });
        await page.evaluate(() => {
          document.querySelector('audio')!.currentTime = 1.2;
        });
        await page.waitForFunction(() => document.querySelector('.verse.playing')?.id === 'v-2');
        await page.getByLabel('Chapter', { exact: true }).selectOption('2');
        await page.getByText('Not downloaded — needs a connection.').waitFor();
        await page.getByLabel('Chapter', { exact: true }).selectOption('3');
        await page.getByText('Narration needs a connection.').waitFor();
        assert.equal(await page.locator('audio').count(), 0);
        assert.deepEqual(requests, []);
      } finally {
        await offline.close();
        await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
      }
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });

  test(
    'cutting browser networking at half the audio stream fails and commits no partial download',
    { timeout: 20_000 },
    async () => {
      const context = await browser.newContext(mobile);
      try {
        const page = await open(context);
        holdAudio = true;
        await start(page);
        await page.waitForFunction(
          () => Number(document.querySelector('progress')?.value) >= 45,
          undefined,
          { timeout: 10_000 }
        );
        await context.setOffline(true);
        server.closeAllConnections();
        await page.getByText(/^Download failed — /).waitFor({ timeout: 10_000 });
        const state = await stored(page);
        assert.deepEqual(state.downloads, []);
        assert.equal(state.media, 0);
        assert.equal(await page.getByText(/readable offline/).count(), 0);
      } finally {
        await context.close();
      }
    }
  );

  test('a same-length but hash-invalid chapter is never ready', async () => {
    const context = await browser.newContext(mobile);
    try {
      const page = await open(context);
      corruptText = true;
      await start(page, false);
      await page.getByText(/Download failed — A downloaded file did not match/).waitFor();
      assert.deepEqual((await stored(page)).downloads, []);
    } finally {
      await context.close();
    }
  });

  test('reusing same-length corrupted cached audio fails verification and removes it', async () => {
    const context = await browser.newContext(mobile);
    try {
      const page = await open(context);
      await page.evaluate(
        async ({ url, bytes }) => {
          await (await caches.open('media-v1')).put(url, new Response(new Uint8Array(bytes)));
        },
        { url: mediaUrl, bytes: audio.length }
      );
      await start(page);
      await page
        .getByText(/Download failed — Stored narration failed integrity verification/)
        .waitFor();
      const state = await stored(page);
      assert.deepEqual(state.downloads, []);
      assert.equal(state.media, 0);
    } finally {
      await context.close();
    }
  });

  test('a storage transaction aborted after request success never publishes readiness and cleans staged audio', async () => {
    const context = await browser.newContext(mobile);
    try {
      await context.addInitScript(() => {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
          const req = put.apply(this, args);
          if (this.name === 'downloads')
            req.addEventListener('success', () => this.transaction.abort());
          return req;
        };
      });
      const page = await open(context);
      await start(page);
      await page.getByText(/^Download failed — /).waitFor();
      const state = await stored(page);
      assert.deepEqual(state.downloads, []);
      assert.equal(state.media, 0);
    } finally {
      await context.close();
    }
  });

  test('damaged stored chapter bytes are not displayed after an offline reload', async () => {
    const context = await browser.newContext(mobile);
    try {
      const page = await open(context);
      await start(page, false);
      await page.getByText('Downloaded — readable offline.').waitFor();
      await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const r = indexedDB.open('biblestudy', 1);
          r.onsuccess = () => resolve(r.result);
        });
        await new Promise<void>((resolve) => {
          const tx = db.transaction('downloads', 'readwrite');
          const req = tx.objectStore('downloads').getAll();
          req.onsuccess = () => {
            for (const record of req.result)
              tx.objectStore('downloads').put({
                ...record,
                chapterBody: record.chapterBody.replace('Synthetic verse', 'Corrupted verse'),
              });
          };
          tx.oncomplete = () => resolve();
        });
        db.close();
      });
      await context.setOffline(true);
      await page.reload();
      await page.getByText('Not downloaded — needs a connection.').waitFor();
      assert.equal(await page.locator('.verse').count(), 0);
      assert.deepEqual((await stored(page)).downloads, []);
    } finally {
      await context.close();
    }
  });

  test('install guidance names Safari home-screen steps and the Android Chrome install prompt', async () => {
    for (const [userAgent, ios] of [
      [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
        true,
      ],
      [
        'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36',
        false,
      ],
    ] as const) {
      const context = await browser.newContext({ ...mobile, userAgent });
      try {
        const page = await open(context);
        await page.locator('.account-toggle').click();
        const help = page.getByRole('region', { name: 'Install on your phone' });
        if (ios) {
          await help.getByText('Tap the Share button').waitFor();
          await help.getByText('Add to Home Screen').waitFor();
        } else {
          await help.getByText("Open Chrome's menu").waitFor();
          await page.evaluate(() => {
            window.dispatchEvent(
              Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
                prompt: async () => undefined,
                userChoice: Promise.resolve({ outcome: 'accepted' }),
              })
            );
          });
          await help.getByRole('button', { name: 'Install Bible Study' }).click();
          await page.getByText('This app is installed on this device.').waitFor();
        }
      } finally {
        await context.close();
      }
    }
  });

  test('a manifest missing chapter content fails, and unavailable licensed content shows its server reason', async () => {
    const context = await browser.newContext(mobile);
    try {
      const page = await open(context);
      missingChapter = true;
      await start(page);
      await page.getByText(/Download failed — The download manifest is incomplete/).waitFor();
      assert.deepEqual((await stored(page)).downloads, []);
      unavailable = true;
      await page.getByRole('button', { name: 'Retry' }).click();
      await page.getByRole('dialog').getByText('This licensed chapter is unavailable.').waitFor();
      assert.equal(
        await page
          .getByRole('dialog')
          .getByRole('button', { name: 'Download', exact: true })
          .isEnabled(),
        false
      );
    } finally {
      await context.close();
    }
  });

  test("CSB without an expiration (imported from the owner's files) is kept offline", async () => {
    restrictedToUserId = userId;
    const context = await browser.newContext(mobile);
    try {
      expiresAt = null;
      const page = await open(context);
      await page.getByLabel('Translation', { exact: true }).selectOption('CSB');
      await page.locator('.verse').first().waitFor();
      await start(page, false);
      await page.getByText('Downloaded — readable offline.').waitFor();
      assert.equal((await stored(page)).downloads.length, 1);
    } finally {
      await context.close();
    }
  });

  test('CSB expires in an already open offline reader: text and downloaded bytes are removed', async () => {
    const context = await browser.newContext(mobile);
    try {
      const page = await open(context);
      await page.clock.install();
      expiresAt = new Date(Date.now() + 60_000).toISOString();
      await page.getByLabel('Translation', { exact: true }).selectOption('CSB');
      await page.locator('.verse').first().waitFor();
      await start(page, false);
      await page.getByText('Downloaded — readable offline.').waitFor();
      await context.setOffline(true);
      await page.reload();
      await page.getByLabel('Translation', { exact: true }).selectOption('CSB');
      await page.getByText('Reading the copy downloaded to this device.').waitFor();
      await page.clock.fastForward(61_000);
      await page
        .getByText('The download of this chapter has expired — connect to download it again.')
        .waitFor();
      assert.equal(await page.locator('.verse').count(), 0);
      await page.waitForFunction(async () => {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const r = indexedDB.open('biblestudy', 1);
          r.onsuccess = () => resolve(r.result);
        });
        const records = await new Promise<{ chapterBody: string }[]>((resolve) => {
          const r = db.transaction('downloads').objectStore('downloads').getAll();
          r.onsuccess = () => resolve(r.result);
        });
        db.close();
        return records.length === 1 && records[0].chapterBody === '';
      });
    } finally {
      await context.close();
    }
  });

  test('removing a narrated download offline preserves notes and pending operations through reload', async () => {
    const context = await browser.newContext(mobile);
    try {
      const page = await open(context);
      await start(page);
      await page.getByText('Downloaded with narration — readable offline.').waitFor();
      await context.setOffline(true);
      await page.reload();
      await page.getByText('Reading the copy downloaded to this device.').waitFor();
      await page.getByLabel('Note on Romans 1').fill('Keep this private offline note.');
      await page.getByRole('button', { name: 'Save note' }).click();
      await page.locator('[data-note]').getByText('Keep this private offline note.').waitFor();
      const before = await stored(page);
      assert.equal(before.notes.length, 1);
      assert.ok(before.pendingOps.length > 0);
      await page.locator('.account-toggle').click();
      await page.getByRole('button', { name: 'Remove Romans 1 (BSB)' }).click();
      await page.getByText('No chapters downloaded on this device.').waitFor();
      const after = await stored(page);
      assert.deepEqual(after.notes, before.notes);
      assert.deepEqual(after.pendingOps, before.pendingOps);
      assert.deepEqual(after.downloads, []);
      assert.equal(after.media, 0);
      await page.reload();
      await page.locator('[data-note]').getByText('Keep this private offline note.').waitFor();
    } finally {
      await context.close();
    }
  });
});


describe('imported CSB offline account boundary', () => {
  test('a missing or other-account manifest scope cannot create a ready download', async () => {
    expiresAt = null;
    for (const scope of [undefined, 'some-other-account']) {
      restrictedToUserId = scope;
      const context = await browser.newContext(mobile);
      try {
        const page = await open(context);
        await page.getByLabel('Translation').selectOption('CSB');
        await page.locator('.verse').first().waitFor();
        await start(page, false);
        await page.getByText(/Download failed — This imported CSB download is not authorized/).waitFor();
        assert.deepEqual((await stored(page)).downloads, []);
      } finally { await context.close(); }
    }
  });

  for (const legacy of [false, true]) {
    test(legacy ? 'old unscoped imported copies are purged before offline display' : 'a scoped owner download remains readable offline', async () => {
      expiresAt = null;
      restrictedToUserId = userId;
      const context = await browser.newContext(mobile);
      try {
        const page = await open(context);
        await page.getByLabel('Translation').selectOption('CSB');
        await page.locator('.verse').first().waitFor();
        await start(page, false);
        await page.getByText('Downloaded — readable offline.').waitFor();
        if (legacy) await page.evaluate(async () => {
          const db = await new Promise<IDBDatabase>((resolve) => {
            const req = indexedDB.open('biblestudy', 1);
            req.onsuccess = () => resolve(req.result);
          });
          const records = await new Promise<{ chapterBody: string; chapterAsset?: unknown }[]>((resolve) => {
            const req = db.transaction('downloads').objectStore('downloads').getAll();
            req.onsuccess = () => resolve(req.result);
          });
          const tx = db.transaction('downloads', 'readwrite');
          for (const record of records) {
            const body = JSON.parse(record.chapterBody);
            delete body.restrictedToUserId;
            // Old builds had no account scope, and older records may lack an asset digest too.
            tx.objectStore('downloads').put({ ...record, chapterBody: JSON.stringify(body), chapterAsset: undefined });
          }
          await new Promise<void>((resolve) => { tx.oncomplete = () => resolve(); });
          db.close();
        });
        // Refuse API requests while leaving the shell available: this exercises offline fallback deterministically.
        await context.route('**/api/**', (route) => route.abort('internetdisconnected'));
        await page.getByLabel('Chapter', { exact: true }).selectOption('2');
        await page.getByText('Not downloaded — needs a connection.').waitFor();
        await page.getByLabel('Chapter', { exact: true }).selectOption('1');
        if (legacy) {
          await page.getByText('Not downloaded — needs a connection.').waitFor();
          assert.equal(await page.locator('.verse').count(), 0);
          assert.deepEqual((await stored(page)).downloads, []);
        } else {
          await page.getByText('Reading the copy downloaded to this device.').waitFor();
          assert.equal(await page.locator('.verse').count(), 3);
        }
      } finally { await context.close(); }
    });
  }
});

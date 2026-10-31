/// <reference lib="dom" />
// Browser tests for installing and offline reading (S14): Romans 1 text and narration imported live from AO Lab,
// downloaded through the real routes, then read after a full browser close with the network blocked. Needs `npm run build` first.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { createAoLabSource } from '../../src/server/content/aolab.ts';
import { runImport } from '../../src/server/content/import.ts';
import { importAudio } from '../../src/server/content/narration.ts';
import { formatBytes } from '../../src/client/offline.ts';
import type { Harness } from '../support/harness.ts';
import { clearMailbox, signIn, startHarness } from '../support/harness.ts';

const aoLabUrl = process.env.AOLAB_BASE_URL ?? 'https://bible.helloao.org';
const mobile = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const android = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
let h: Harness;
let browser: Browser;
let baseUrl: string;
let cookie: string;
let starts: number[];

before(async () => {
  assert.ok(existsSync('dist/client/sw.js'), 'run `npm run build` before the browser tests');
  h = await startHarness({ STATIC_DIR: 'dist/client' });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  await clearMailbox();
  h.clock.set('2026-11-01T12:00:00Z');
  const source = createAoLabSource({ baseUrl: aoLabUrl });
  assert.equal((await runImport({ db: h.db, clock: h.clock, source }, { translationId: 'BSB', books: ['ROM'] })).status, 'succeeded');
  const audio = await importAudio({ db: h.db, clock: h.clock, source, mediaDir: h.config.mediaDir }, { translationId: 'BSB', bookId: 'ROM', chapters: [1] });
  assert.equal(audio.status, 'succeeded');
  cookie = (await signIn(h, 'listener@example.test')).cookie;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await h?.close();
});

beforeEach(async () => {
  await h.db.query('DELETE FROM sync_operations; DELETE FROM note_conflicts; DELETE FROM notes; DELETE FROM solo_positions');
  await h.db.query(`UPDATE recordings SET timing_status = 'verified', timing_reason = NULL WHERE timing IS NOT NULL`);
  const timing = await h.db.query(`SELECT timing FROM recordings WHERE book_id = 'ROM' AND chapter = 1 ORDER BY narrator_id LIMIT 1`);
  starts = timing.rows[0].timing;
});

async function open(context: BrowserContext): Promise<Page> {
  await context.addCookies([{ name: 'bs_session', value: cookie, url: baseUrl }]);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(baseUrl);
  await page.locator('.verse').first().waitFor();
  return page;
}

const manifestBytes = async (chapter: number, narration: boolean) =>
  (await h.app.inject({ method: 'GET', url: `/api/content/BSB/ROM/${chapter}/download-manifest${narration ? '?narration=true' : ''}`, cookies: { bs_session: cookie } })).json().totalBytes as number;

async function goTo(page: Page, chapter: number): Promise<void> {
  await page.getByLabel('Chapter', { exact: true }).selectOption(String(chapter));
  await page.getByTestId('reference').getByText(`Romans ${chapter}`, { exact: true }).waitFor();
}

async function download(page: Page, kind: 'Text only' | 'Text and narration'): Promise<void> {
  await page.getByRole('button', { name: 'Download for offline' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText(kind).click();
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  await page.getByText(kind === 'Text only' ? 'Downloaded — readable offline.' : 'Downloaded with narration — readable offline.').waitFor();
}

const stored = (page: Page) =>
  page.evaluate(async () => {
    const media = (await (await caches.open('media-v1')).keys()).length;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('biblestudy', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const downloads = await new Promise<number>((resolve) => {
      const req = db.transaction('downloads').objectStore('downloads').count();
      req.onsuccess = () => resolve(req.result);
    });
    db.close();
    return { media, downloads };
  });

describe('installing and reading offline (S14)', () => {
  test('S14.1 S14.3 S14.4 Romans 1 downloaded with narration reads, plays and follows verses after a full close with no network', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'bs-offline-'));
    try {
      const online = await chromium.launchPersistentContext(profile, mobile);
      try {
        const page = await open(online);
        // S14.1: the size comes from the manifest, shown before anything is fetched.
        await page.getByRole('button', { name: 'Download for offline' }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByText(`Text and narration · ${formatBytes(await manifestBytes(1, true))}`).waitFor();
        await dialog.getByText(`Text only · ${formatBytes(await manifestBytes(1, false))}`).waitFor();
        await dialog.getByText('Text and narration').click();
        await dialog.getByRole('button', { name: 'Download', exact: true }).click();
        await page.getByText('Downloaded with narration — readable offline.').waitFor();
        await goTo(page, 3);
        await download(page, 'Text only');
        await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
      } finally {
        await online.close();
      }

      // A cold start: a new browser on the same profile, with the network blocked; the server must see nothing.
      const seen: string[] = [];
      const listen = (request: { url?: string }) => seen.push(request.url ?? '');
      h.app.server.on('request', listen);
      const offline = await chromium.launchPersistentContext(profile, { ...mobile, offline: true, args: ['--autoplay-policy=no-user-gesture-required'] });
      try {
        const cold = offline.pages()[0] ?? (await offline.newPage());
        await cold.goto(baseUrl);
        await cold.getByText('Server unavailable — showing what is on this device.').waitFor();
        await cold.getByTestId('reference').getByText('Romans 1', { exact: true }).waitFor();
        await cold.locator('.verse').first().waitFor();
        assert.equal(await cold.locator('.verse').count(), 32);
        await cold.getByText('Reading the copy downloaded to this device.').waitFor();

        await cold.locator('audio').waitFor({ state: 'attached' });
        assert.match((await cold.locator('audio').getAttribute('src')) ?? '', /^blob:/);
        await cold.waitForFunction(() => document.querySelector('audio')!.readyState >= HTMLMediaElement.HAVE_METADATA);
        await cold.evaluate((seconds) => {
          const audio = document.querySelector('audio')!;
          audio.currentTime = seconds;
          return audio.play();
        }, starts[6] + 0.2);
        await cold.waitForFunction(() => document.querySelector('.verse.playing')?.id === 'v-7', undefined, { timeout: 5000 });
        await cold.evaluate(() => document.querySelector('audio')!.pause());

        // S14.4: a chapter never downloaded, and a text-only download with nothing to play.
        await goTo(cold, 2);
        await cold.getByText('Not downloaded — needs a connection.').waitFor();
        await goTo(cold, 3);
        await cold.locator('.verse').first().waitFor();
        await cold.getByText('Narration needs a connection.').waitFor();
        assert.equal(await cold.locator('audio').count(), 0);
        assert.deepEqual(seen, []);
      } finally {
        h.app.server.off('request', listen);
        await offline.close();
      }
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });

  test('S14.2 a download whose connection drops halfway ends failed, never ready, and keeps nothing', async () => {
    const context = await browser.newContext(mobile);
    try {
      const page = await open(context);
      await context.route('**/media/**', async (route) => {
        const response = await route.fetch();
        const body = await response.body();
        await route.fulfill({ response, body: body.subarray(0, Math.floor(body.length / 2)) });
      });
      await page.getByRole('button', { name: 'Download for offline' }).click();
      await page.getByRole('dialog').getByText('Text and narration').click();
      await page.getByRole('dialog').getByRole('button', { name: 'Download', exact: true }).click();
      await page.getByText(/^Download failed — /).waitFor();
      assert.equal(await page.getByText(/readable offline/).count(), 0);
      assert.deepEqual(await stored(page), { media: 0, downloads: 0 });
      // Retrying with the connection back completes it.
      await context.unroute('**/media/**');
      await page.getByRole('button', { name: 'Retry' }).click();
      await page.getByRole('dialog').getByText('Text and narration').click();
      await page.getByRole('dialog').getByRole('button', { name: 'Download', exact: true }).click();
      await page.getByText('Downloaded with narration — readable offline.').waitFor();
      assert.deepEqual(await stored(page), { media: 1, downloads: 1 });
    } finally {
      await context.close();
    }
  });

  test('S14.5 removing a download keeps the notes on that chapter', async () => {
    const context = await browser.newContext(mobile);
    try {
      const page = await open(context);
      await page.getByLabel('Note on Romans 1').fill('Not ashamed of the gospel.');
      await page.getByRole('button', { name: 'Save note' }).click();
      await page.locator('[data-note]').getByText('Not ashamed of the gospel.').waitFor();
      await download(page, 'Text only');

      await page.locator('.account-toggle').click();
      const list = page.getByRole('region', { name: 'Downloads on this device' });
      await list.getByText('Romans 1 (BSB) · text only').waitFor();
      await list.getByRole('button', { name: 'Remove Romans 1 (BSB)' }).click();
      await list.getByText('No chapters downloaded on this device.').waitFor();
      assert.deepEqual(await stored(page), { media: 0, downloads: 0 });

      await page.reload();
      await page.locator('[data-note]').getByText('Not ashamed of the gospel.').waitFor();
      assert.equal((await h.db.query('SELECT body FROM notes WHERE deleted_at IS NULL')).rows[0].body, 'Not ashamed of the gospel.');
    } finally {
      await context.close();
    }
  });

  test('an expired download keeps no chapter text or audio on the device, only its listing', async () => {
    const context = await browser.newContext(mobile);
    try {
      const page = await open(context);
      await download(page, 'Text and narration');
      // A CSB download carries the 14-day expiry; this one is aged past it in place.
      await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const req = indexedDB.open('biblestudy', 1);
          req.onsuccess = () => resolve(req.result);
        });
        const all = await new Promise<{ expiresAt: string | null }[]>((resolve) => {
          const req = db.transaction('downloads').objectStore('downloads').getAll();
          req.onsuccess = () => resolve(req.result);
        });
        const tx = db.transaction('downloads', 'readwrite');
        for (const record of all) tx.objectStore('downloads').put({ ...record, expiresAt: '2000-01-01T00:00:00Z' });
        await new Promise((resolve) => (tx.oncomplete = resolve));
        db.close();
      });
      await page.reload();
      await page.getByText('This download has expired.').waitFor();
      const left = await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const req = indexedDB.open('biblestudy', 1);
          req.onsuccess = () => resolve(req.result);
        });
        const all = await new Promise<{ chapterBody: string; audio: unknown }[]>((resolve) => {
          const req = db.transaction('downloads').objectStore('downloads').getAll();
          req.onsuccess = () => resolve(req.result);
        });
        db.close();
        return all.map((r) => ({ chapterBody: r.chapterBody, audio: r.audio }));
      });
      assert.deepEqual(left, [{ chapterBody: '', audio: null }]);
      assert.deepEqual(await stored(page), { media: 0, downloads: 1 });
    } finally {
      await context.close();
    }
  });

  test('S14.6 install help names the Share steps on iPhone and the Chrome prompt or menu steps on Android', async () => {
    const help = async (userAgent: string) => {
      const context = await browser.newContext({ ...mobile, userAgent });
      const page = await open(context);
      await page.locator('.account-toggle').click();
      return { context, page, region: page.getByRole('region', { name: 'Install on your phone' }) };
    };

    const ios = await help(iphone);
    try {
      await ios.region.getByText('Tap the Share button').waitFor();
      await ios.region.getByText('Add to Home Screen').waitFor();
      assert.equal(await ios.region.getByRole('button', { name: 'Install Bible Study' }).count(), 0);
    } finally {
      await ios.context.close();
    }

    const droid = await help(android);
    try {
      await droid.region.getByText("Open Chrome's menu").waitFor();
      // Chrome offers its own prompt once the app qualifies; the help then offers it as a button.
      await droid.page.evaluate(() => {
        const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
          prompt: async () => undefined,
          userChoice: Promise.resolve({ outcome: 'accepted' }),
        });
        window.dispatchEvent(event);
      });
      await droid.region.getByRole('button', { name: 'Install Bible Study' }).click();
      await droid.page.getByText('This app is installed on this device.').waitFor();
    } finally {
      await droid.context.close();
    }
  });
});

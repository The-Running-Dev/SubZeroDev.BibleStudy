/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { books } from '../../src/shared/books.ts';
import { contentHash, serializeContent } from '../../src/server/content/normalize.ts';
import { signIn, startHarness } from '../support/harness.ts';

for (const translationId of ['BSB', 'CSB', 'ESV'] as const) {
  test(`entire ${translationId} download pauses, resumes after restart, repairs corruption and reads the whole canon offline`, { timeout: 180_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), `${translationId}-bulk-browser-`));
    const profile = join(dir, 'profile');
    const h = await startHarness({ STATIC_DIR: 'dist/client', OWNER_EMAIL: '' });
    const content = serializeContent({
      verses: [{ number: 1, text: 'Synthetic entire Bible fixture.' }],
      headings: [{ beforeVerse: 1, text: 'Synthetic heading' }],
      footnotes: [{ verse: 1, text: 'Synthetic note.' }],
    });
    try {
      for (const [index, book] of books.entries()) {
        await h.db.query('INSERT INTO books (translation_id, book_id, name, book_order, chapters) VALUES ($1,$2,$3,$4,$5)', [translationId, book.id, book.name, index + 1, book.chapters]);
        await h.db.query(`INSERT INTO chapters (translation_id, book_id, chapter, verse_count, content, content_sha256, source_ref, fetched_at)
          SELECT $5, $1, n, 1, $2, $3, 'synthetic', now() FROM generate_series(1, $4::integer) n`, [book.id, content, contentHash(content), book.chapters, translationId]);
      }
      await h.app.listen({ port: 0, host: '127.0.0.1' });
      const baseUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
      const { cookie, userId } = await signIn(h, `${translationId.toLowerCase()}-bulk@example.test`);
      const requested: string[] = [];
      let online = await chromium.launchPersistentContext(profile);
      try {
        await online.addCookies([{ name: 'bs_session', value: cookie, url: baseUrl }]);
        let page = online.pages()[0];
        await page.goto(baseUrl);
        await page.getByLabel('Translation', { exact: true }).selectOption(translationId);
        await page.getByLabel('Book', { exact: true }).selectOption('MAT');
        await page.locator('#v-1').waitFor();
        // Existing individual downloads count toward the Bible and must not be fetched again.
        await page.getByRole('button', { name: 'Download for offline' }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Download', exact: true }).click();
        const bulk = () => page.getByRole('region', { name: `Entire ${translationId} Bible offline`, exact: true });
        await bulk().getByText('1 of 1,189 chapters saved', { exact: true }).waitFor();
        // A different translation has its own count and download state.
        const other = translationId === 'BSB' ? 'CSB' : 'BSB';
        await page.getByLabel('Translation', { exact: true }).selectOption(other);
        const otherBulk = page.getByRole('region', { name: `Entire ${other} Bible offline`, exact: true });
        await otherBulk.getByText('0 of 1,189 chapters saved', { exact: true }).waitFor();
        await otherBulk.getByRole('button', { name: `Download entire ${other} Bible` }).waitFor();
        await page.getByLabel('Translation', { exact: true }).selectOption(translationId);
        await bulk().getByText('1 of 1,189 chapters saved', { exact: true }).waitFor();
        await page.route(`**/api/content/${translationId}/GEN/2/download-manifest*`, (route) => route.fulfill({ status: 503, json: { error: 'fixture_interruption' } }));
        await bulk().getByRole('button', { name: `Resume ${translationId} download` }).click();
        await bulk().getByRole('alert').waitFor();
        await bulk().getByText('2 of 1,189 chapters saved', { exact: true }).waitFor();
        // Finish position synchronization before the cold restart.
        await page.waitForFunction(async (translationId) => {
          const p = (await (await fetch('/api/sync/pull')).json()).soloPosition;
          return p?.translationId === translationId && p.bookId === 'MAT';
        }, translationId);
        await online.close();
        online = await chromium.launchPersistentContext(profile);
        await online.addCookies([{ name: 'bs_session', value: cookie, url: baseUrl }]);
        page = online.pages()[0];
        await page.goto(baseUrl);
        await page.getByLabel('Translation', { exact: true }).selectOption(translationId);
        await bulk().getByText('2 of 1,189 chapters saved', { exact: true }).waitFor();
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        await page.route(`**/api/content/${translationId}/GEN/3/download-manifest*`, async (route) => {
          await held;
          await route.abort().catch(() => undefined);
        });
        await bulk().getByRole('button', { name: `Resume ${translationId} download` }).click();
        await bulk().getByText('Saving Genesis 3…', { exact: true }).waitFor();
        await bulk().getByRole('button', { name: `Pause ${translationId} download` }).click();
        release();
        await bulk().getByText('Download paused.', { exact: false }).waitFor();
        await bulk().getByText('3 of 1,189 chapters saved', { exact: true }).waitFor();
        await page.unroute(`**/api/content/${translationId}/GEN/3/download-manifest*`);
        page.on('request', (request) => { if (request.url().includes('/download-manifest')) requested.push(new URL(request.url()).pathname); });
        await bulk().getByRole('button', { name: `Resume ${translationId} download` }).click();
        await bulk().getByText(`${translationId} Bible downloaded — all 1,189 chapters are readable offline.`, { exact: true }).waitFor({ timeout: 90_000 });
        assert.equal(requested.length, 1186);
        for (const ref of ['GEN/1', 'GEN/2', 'MAT/1']) assert.ok(!requested.some((url) => url.includes(`/${translationId}/${ref}/`)), `${ref} was already downloaded`);

        // Damaged stored text must be excluded from completion and repaired by Resume.
        await page.evaluate(async ({ userId, translationId }) => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('biblestudy');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('downloads', 'readwrite');
            const store = tx.objectStore('downloads');
            const get = store.get([userId, `${translationId}/GEN/1`]);
            get.onsuccess = () => store.put({ ...get.result, chapterBody: 'corrupted' });
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error);
          });
          db.close();
        }, { userId, translationId });
        await page.reload();
        await bulk().getByText('1,188 of 1,189 chapters saved', { exact: true }).waitFor();
        const beforeRepair = requested.length;
        await bulk().getByRole('button', { name: `Resume ${translationId} download` }).click();
        await bulk().getByText(`${translationId} Bible downloaded — all 1,189 chapters are readable offline.`, { exact: true }).waitFor();
        assert.deepEqual(requested.slice(beforeRepair), [`/api/content/${translationId}/GEN/1/download-manifest`]);
        if (translationId === 'CSB') {
          // Expired API-backed CSB copies must not count as an entire offline Bible.
          await page.evaluate(async (userId) => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const request = indexedDB.open('biblestudy');
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            await new Promise<void>((resolve, reject) => {
              const tx = db.transaction('downloads', 'readwrite');
              const store = tx.objectStore('downloads');
              const get = store.get([userId, 'CSB/GEN/1']);
              get.onsuccess = () => store.put({ ...get.result, expiresAt: '2000-01-01T00:00:00.000Z' });
              tx.oncomplete = () => resolve();
              tx.onabort = () => reject(tx.error);
            });
            db.close();
          }, userId);
          await page.reload();
          await bulk().getByText('1,188 of 1,189 chapters saved', { exact: true }).waitFor();
          const beforeRenewal = requested.length;
          await bulk().getByRole('button', { name: 'Resume CSB download' }).click();
          await bulk().getByText('CSB Bible downloaded — all 1,189 chapters are readable offline.', { exact: true }).waitFor();
          assert.deepEqual(requested.slice(beforeRenewal), ['/api/content/CSB/GEN/1/download-manifest']);
        }
        // Removing a single chapter immediately invalidates the full-Bible status.
        await page.getByRole('button', { name: 'Remove download', exact: true }).click();
        await bulk().getByText('1,188 of 1,189 chapters saved', { exact: true }).waitFor();
        await bulk().getByRole('button', { name: `Resume ${translationId} download` }).click();
        await bulk().getByText(`${translationId} Bible downloaded — all 1,189 chapters are readable offline.`, { exact: true }).waitFor();
        await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
      } finally { await online.close(); }

      const offline = await chromium.launchPersistentContext(profile, { offline: true });
      try {
        const page = offline.pages()[0];
        await page.goto(baseUrl);
        await page.getByLabel('Translation', { exact: true }).selectOption(translationId);
        await page.getByText(`${translationId} Bible downloaded — all 1,189 chapters are readable offline.`, { exact: true }).waitFor();
        for (const [book, chapter] of [['GEN', '1'], ['REV', '22']]) {
          await page.getByLabel('Book', { exact: true }).selectOption(book);
          await page.getByLabel('Chapter', { exact: true }).selectOption(chapter);
          await page.getByText('Reading the copy downloaded to this device.').waitFor();
          assert.match(await page.locator('#v-1').innerText(), /Synthetic entire Bible fixture/);
          await page.getByRole('heading', { name: 'Synthetic heading' }).waitFor();
          await page.getByText('Synthetic note.', { exact: false }).waitFor();
        }
      } finally { await offline.close(); }
    } finally {
      await h.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

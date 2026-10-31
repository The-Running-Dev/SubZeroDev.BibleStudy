/// <reference lib="dom" />
// Browser tests for saving offline and syncing (S15): notes and question drafts kept on the device, sent once the
// server answers, and conflicts chosen by the reader. Romans imported live from AO Lab. Needs `npm run build` first.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { createAoLabSource } from '../../src/server/content/aolab.ts';
import { runImport } from '../../src/server/content/import.ts';
import type { Harness } from '../support/harness.ts';
import { clearMailbox, ownerEmail, signIn, startHarness } from '../support/harness.ts';

const aoLabUrl = process.env.AOLAB_BASE_URL ?? 'https://bible.helloao.org';
const mobile = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
let h: Harness;
let browser: Browser;
let baseUrl: string;
let cookie: string;
let contexts: BrowserContext[] = [];

before(async () => {
  assert.ok(existsSync('dist/client/sw.js'), 'run `npm run build` before the browser tests');
  h = await startHarness({ STATIC_DIR: 'dist/client' });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  await clearMailbox();
  h.clock.set('2026-11-01T12:00:00Z');
  assert.equal((await runImport({ db: h.db, clock: h.clock, source: createAoLabSource({ baseUrl: aoLabUrl }) }, { translationId: 'BSB', books: ['ROM'] })).status, 'succeeded');
  cookie = (await signIn(h, ownerEmail)).cookie;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await h?.close();
});

beforeEach(async () => {
  await h.db.query('DELETE FROM sync_operations; DELETE FROM note_conflicts; DELETE FROM notes; DELETE FROM solo_positions; TRUNCATE questions CASCADE');
});
afterEach(async () => {
  for (const context of contexts) await context.close();
  contexts = [];
});

async function eventually<T>(read: () => Promise<T>, expected: T): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      assert.deepEqual(await read(), expected);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.deepEqual(await read(), expected);
}

async function open(context: BrowserContext): Promise<Page> {
  await context.addCookies([{ name: 'bs_session', value: cookie, url: baseUrl }]);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(baseUrl);
  await page.locator('.verse').first().waitFor();
  return page;
}

async function fresh(): Promise<Page> {
  const context = await browser.newContext(mobile);
  contexts.push(context);
  return open(context);
}

const noteBox = (page: Page) => page.getByLabel(/^Note on Romans 1/);
const serverNotes = async () => (await h.db.query('SELECT body FROM notes WHERE deleted_at IS NULL ORDER BY body')).rows.map((r) => r.body as string);

describe('saving offline and syncing (S15)', () => {
  test('S15.1 S15.3 a note saved offline is kept through a full close and offline restart, then sent once', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'bs-sync-'));
    try {
      let context = await chromium.launchPersistentContext(profile, mobile);
      try {
        const page = await open(context);
        // Romans 1 on the device, so the offline restart has a chapter to show the note on.
        await page.getByRole('button', { name: 'Download for offline' }).click();
        await page.getByRole('dialog').getByText('Text only').click();
        await page.getByRole('dialog').getByRole('button', { name: 'Download', exact: true }).click();
        await page.getByText('Downloaded — readable offline.').waitFor();
        await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));

        await context.setOffline(true);
        await noteBox(page).fill('Written on the train.');
        await page.getByRole('button', { name: 'Save note' }).click();
        const note = page.locator('[data-note]');
        await note.getByText('Written on the train.').waitFor();
        await note.locator('[data-save-state="saved_on_device"]').getByText('Saved on this device').waitFor();
        assert.deepEqual(await serverNotes(), []);
      } finally {
        await context.close();
      }

      context = await chromium.launchPersistentContext(profile, { ...mobile, offline: true });
      try {
        // The test's session cookie has no expiry, so a restart drops it; a real sign-in keeps its cookie.
        await context.addCookies([{ name: 'bs_session', value: cookie, url: baseUrl }]);
        const page = context.pages()[0] ?? (await context.newPage());
        await page.goto(baseUrl);
        await page.getByText('Server unavailable — showing what is on this device.').waitFor();
        await page.locator('[data-note]').getByText('Written on the train.').waitFor();
        await page.locator('[data-save-state="saved_on_device"]').waitFor();
        assert.deepEqual(await serverNotes(), []);

        // S15.3: back online, the waiting save is sent once.
        await context.setOffline(false);
        await page.locator('[data-save-state]').waitFor({ state: 'detached', timeout: 15_000 });
        await eventually(serverNotes, ['Written on the train.']);
        const ops = await h.db.query(`SELECT count(*)::int AS n FROM sync_operations WHERE entity = 'note'`);
        assert.equal(ops.rows[0].n, 1);
      } finally {
        await context.close();
      }
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });

  test('S15.2 a full device says "Save failed" and keeps the previous version readable', async () => {
    const page = await fresh();
    await noteBox(page).fill('The first version.');
    await page.getByRole('button', { name: 'Save note' }).click();
    const note = page.locator('[data-note]');
    await note.getByText('The first version.').waitFor();
    await eventually(serverNotes, ['The first version.']);
    // Sent and acknowledged, so the failing save below races nothing.
    await note.locator('[data-save-state]').waitFor({ state: 'detached' });

    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
        if (this.name === 'notes') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        return put.apply(this, args);
      };
    });
    await note.getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel(/^Edit note on Romans 1/).fill('A second version that will not fit.');
    await note.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('alert').getByText(/^Save failed/).waitFor();
    assert.equal(await note.locator('.note-body').textContent(), 'The first version.');
    assert.equal(await page.getByLabel(/^Edit note on Romans 1/).inputValue(), 'A second version that will not fit.');
    assert.deepEqual(await serverNotes(), ['The first version.']);
  });

  test('S15.1 a note saved and deleted offline stays deleted once sent', async () => {
    const page = await fresh();
    await page.context().setOffline(true);
    await noteBox(page).fill('Never mind.');
    await page.getByRole('button', { name: 'Save note' }).click();
    const note = page.locator('[data-note]');
    await note.getByText('Never mind.').waitFor();
    await note.getByRole('button', { name: 'Delete' }).click();
    await note.waitFor({ state: 'detached' });

    await page.context().setOffline(false);
    // The save may have reached the server already, so it is sent first and the delete follows it.
    await eventually(async () => (await h.db.query(`SELECT count(*)::int AS n FROM sync_operations WHERE entity = 'note'`)).rows[0].n as number, 2);
    await eventually(serverNotes, []);
    await page.reload();
    await page.locator('.verse').first().waitFor();
    assert.equal(await page.locator('[data-note]').count(), 0);
  });

  test('S15.5 a question written offline says "Not posted", and posts once only when tapped online', async () => {
    const page = await fresh();
    await page.getByRole('button', { name: 'Ask a question' }).click();
    await page.context().setOffline(true);
    await page.getByLabel('Your question').fill('Who are the called?');
    await page.locator('[data-save-state="not_posted"]').getByText('Not posted').waitFor();
    await page.getByText('Posting needs a connection.').waitFor();
    assert.ok(await page.getByRole('button', { name: 'Post question' }).isDisabled());

    // Back online, nothing is posted until the tap; the draft is still there after a reload.
    await page.context().setOffline(false);
    await page.reload();
    await page.getByLabel('Your question').waitFor();
    assert.equal(await page.getByLabel('Your question').inputValue(), 'Who are the called?');
    const posted = async () => (await h.db.query('SELECT body FROM questions')).rows.map((r) => r.body as string);
    assert.deepEqual(await posted(), []);
    await page.getByRole('button', { name: 'Post question' }).click();
    await page.getByRole('button', { name: 'Ask a question' }).waitFor();
    await eventually(posted, ['Who are the called?']);

    // Posted means the draft is gone.
    await page.reload();
    await page.getByRole('button', { name: 'Ask a question' }).waitFor();
    assert.equal(await page.getByLabel('Your question').count(), 0);
  });
});

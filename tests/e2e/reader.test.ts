/// <reference lib="dom" />
// Browser tests: the built client served by the real server, driven in Chromium at phone size.
// Needs `npm run build` first, and the same Postgres and Mailpit as the integration tests.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { createAoLabSource } from '../../src/server/content/aolab.ts';
import { runImport } from '../../src/server/content/import.ts';
import type { Harness } from '../support/harness.ts';
import { clearMailbox, signIn, startHarness } from '../support/harness.ts';

const aoLabUrl = process.env.AOLAB_BASE_URL ?? 'https://bible.helloao.org';
let h: Harness;
let browser: Browser;
let baseUrl: string;
let cookie: string;
let page: Page;

before(async () => {
  assert.ok(existsSync('dist/client/index.html'), 'run `npm run build` before the browser tests');
  h = await startHarness({ STATIC_DIR: 'dist/client' });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  await clearMailbox();
  h.clock.set('2026-11-01T12:00:00Z');
  const result = await runImport({ db: h.db, clock: h.clock, source: createAoLabSource({ baseUrl: aoLabUrl }) }, { translationId: 'BSB', books: ['ROM', '1CO'] });
  assert.equal(result.status, 'succeeded');
  cookie = (await signIn(h, 'reader@example.test')).cookie;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await h?.close();
});

beforeEach(async () => {
  // Each test starts at Romans 1 with no notes, not where the one before it left the reader.
  await h.db.query('DELETE FROM sync_operations; DELETE FROM note_conflicts; DELETE FROM notes; DELETE FROM solo_positions');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addCookies([{ name: 'bs_session', value: cookie, url: baseUrl }]);
  page = await context.newPage();
  await page.goto(baseUrl);
});
// A page left open would keep saving its own position into the next test.
afterEach(async () => {
  await page?.context().close();
});

async function eventually<T>(read: () => Promise<T>, expected: T): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      assert.deepEqual(await read(), expected);
      return;
    } catch {
      await page.waitForTimeout(100);
    }
  }
  assert.deepEqual(await read(), expected);
}

const reference = () => page.getByTestId('reference');
async function expectReference(text: string): Promise<void> {
  await page.waitForFunction((expected) => document.querySelector('[data-testid="reference"]')?.textContent === expected, text);
  await page.locator('.verse').first().waitFor();
}
const verseText = (n: number) => page.locator(`#v-${n}`).textContent();
const jump = async (text: string) => {
  await page.getByLabel('Reference').fill(text);
  await page.getByRole('button', { name: 'Go', exact: true }).click();
};

describe('the reader', () => {
  test('S2.4 a member first sees Romans 1 with the reference visible', async () => {
    await expectReference('Romans 1');
    assert.ok(await reference().isVisible());
    assert.match((await verseText(1)) ?? '', /Paul, a servant of Christ Jesus/);
    assert.equal(await page.locator('.verse').count(), 32);
  });

  test('S2.5 next, previous, the selectors and reference entry move between chapters and books', async () => {
    await expectReference('Romans 1');
    await page.getByRole('button', { name: /Romans 2 ›/ }).click();
    await expectReference('Romans 2');
    await page.getByLabel('Chapter', { exact: true }).selectOption('3');
    await expectReference('Romans 3');
    await page.getByRole('button', { name: /‹ Romans 2/ }).click();
    await expectReference('Romans 2');
    await jump('rom 1');
    await expectReference('Romans 1');

    await page.getByLabel('Chapter', { exact: true }).selectOption('16');
    await expectReference('Romans 16');
    await page.getByRole('button', { name: /1 Corinthians 1 ›/ }).click();
    await expectReference('1 Corinthians 1');
    assert.equal(await page.getByLabel('Book').inputValue(), '1CO');
    await page.getByRole('button', { name: /‹ Romans 16/ }).click();
    await expectReference('Romans 16');

    await page.getByLabel('Book').selectOption('1CO');
    await expectReference('1 Corinthians 1');
  });

  test('S2.6 jumping to Romans 3:12 scrolls verse 12 into view and marks it', async () => {
    await expectReference('Romans 1');
    await jump('Romans 3:12');
    await expectReference('Romans 3:12');
    const verse = page.locator('#v-12');
    await page.waitForFunction(() => {
      // In view means below the sticky reference bar, not just inside the window.
      const box = document.getElementById('v-12')?.getBoundingClientRect();
      const bar = document.querySelector('.reader-bar')!.getBoundingClientRect();
      return box !== undefined && box.top >= bar.bottom && box.bottom <= window.innerHeight;
    });
    assert.equal(await verse.getAttribute('aria-current'), 'true');
    assert.match((await verse.getAttribute('class')) ?? '', /\bmarked\b/);
    assert.equal(await page.locator('.verse.marked').count(), 1);
    assert.ok((await page.evaluate(() => window.scrollY)) > 0);
    if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/romans-3-12.png` });
  });

  test('entering the same reference again scrolls back to it; a verse past the chapter says how many there are', async () => {
    await expectReference('Romans 1');
    await jump('Romans 1:20');
    await expectReference('Romans 1:20');
    await page.waitForFunction(() => window.scrollY > 0);
    await page.evaluate(() => window.scrollTo({ top: 0 }));
    await jump('Romans 1:20');
    await page.waitForFunction(() => window.scrollY > 0);
    assert.equal(await page.locator('.verse.marked').count(), 1);

    await jump('Romans 1:40');
    await page.getByRole('alert').getByText('Romans 1 has 32 verses.').waitFor();
    assert.equal(await page.locator('.verse.marked').count(), 0);
  });

  test('a reference that is not one says so and stays put', async () => {
    await expectReference('Romans 1');
    await jump('Romans 17');
    assert.match((await page.getByRole('alert').textContent()) ?? '', /"Romans 17" is not a reference/);
    assert.equal(await reference().textContent(), 'Romans 1');
  });

  test('S2.7 choosing CSB says it is not available and shows no text', async () => {
    await expectReference('Romans 1');
    await page.getByLabel('Translation').selectOption('CSB');
    await page.getByText("CSB needs the owner's CSB files (import-content --translation CSB) or API.Bible key (APIBIBLE_KEY).").waitFor();
    assert.equal(await page.locator('.verse').count(), 0);
    await page.getByLabel('Translation').selectOption('BSB');
    await expectReference('Romans 1');
  });
});

describe('reading alone (S12)', () => {
  test('S12.1 a reader in no group writes, edits and deletes a private note on Romans 4:3', async () => {
    await expectReference('Romans 1');
    await jump('Romans 4:3');
    await expectReference('Romans 4:3');
    await page.getByLabel('Note on Romans 4:3').fill('Credited, not earned.');
    await page.getByRole('button', { name: 'Save note' }).click();
    const note = page.locator('[data-note]');
    await note.getByText('Credited, not earned.').waitFor();
    assert.equal(await note.locator('.note-reference').textContent(), 'Romans 4:3');
    assert.equal(await page.getByLabel('Note on Romans 4:3').inputValue(), '');

    // Straight back, before the reader has stayed put long enough to save its place.
    await page.reload();
    await jump('Romans 4');
    await note.getByText('Credited, not earned.').waitFor();
    await note.getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel('Edit note on Romans 4:3').fill('Counted as righteousness.');
    await note.getByRole('button', { name: 'Save', exact: true }).click();
    await note.getByText('Counted as righteousness.').waitFor();
    await eventually(async () => (await h.db.query('SELECT body, revision FROM notes WHERE deleted_at IS NULL')).rows, [{ body: 'Counted as righteousness.', revision: 2 }]);

    await note.getByRole('button', { name: 'Delete' }).click();
    await note.waitFor({ state: 'detached' });
    await page.reload();
    await page.getByRole('heading', { name: 'My notes' }).waitFor();
    assert.equal(await note.count(), 0);
  });

  test('S15.4 an edit that meets a newer version from another device offers both, and keeping both leaves two notes', async () => {
    await expectReference('Romans 1');
    await jump('Romans 4:3');
    await expectReference('Romans 4:3');
    await page.getByLabel('Note on Romans 4:3').fill('First thought.');
    await page.getByRole('button', { name: 'Save note' }).click();
    const note = page.locator('[data-note]');
    await note.getByText('First thought.').waitFor();
    await eventually(async () => (await h.db.query('SELECT body FROM notes')).rows, [{ body: 'First thought.' }]);

    await note.getByRole('button', { name: 'Edit' }).click();
    // Another device saves first.
    await h.db.query(`UPDATE notes SET body = 'Changed on the phone.', revision = revision + 1`);
    await page.getByLabel('Edit note on Romans 4:3').fill('My laptop edit.');
    await note.getByRole('button', { name: 'Save', exact: true }).click();
    const chooser = page.getByRole('group', { name: 'Two versions of this note' });
    await chooser.locator('[data-version=saved]').getByText('Changed on the phone.').waitFor();
    await chooser.locator('[data-version=other]').getByText('My laptop edit.').waitFor();
    const rows = await h.db.query('SELECT n.body, c.incoming_body FROM notes n JOIN note_conflicts c ON c.note_id = n.id');
    assert.deepEqual(rows.rows, [{ body: 'Changed on the phone.', incoming_body: 'My laptop edit.' }]);

    await chooser.getByRole('button', { name: 'Keep both' }).click();
    await chooser.waitFor({ state: 'detached' });
    await note.getByText('My laptop edit.').waitFor();
    assert.equal(await note.count(), 2);
    const kept = await h.db.query('SELECT body FROM notes WHERE deleted_at IS NULL ORDER BY body');
    assert.deepEqual(kept.rows, [{ body: 'Changed on the phone.' }, { body: 'My laptop edit.' }]);
  });

  test('S12.2 the reader comes back to where they stopped reading alone', async () => {
    await expectReference('Romans 1');
    await jump('Romans 4:17');
    await expectReference('Romans 4:17');
    await eventually(async () => (await h.db.query('SELECT book_id, chapter, verse FROM solo_positions')).rows, [{ book_id: 'ROM', chapter: 4, verse: 17 }]);

    await page.reload();
    await expectReference('Romans 4:17');
  });
});

/// <reference lib="dom" />
// Browser tests: the built client served by the real server, driven in Chromium at phone size.
// Needs `npm run build` first, and the same Postgres and Mailpit as the integration tests.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
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
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addCookies([{ name: 'bs_session', value: cookie, url: baseUrl }]);
  page = await context.newPage();
  await page.goto(baseUrl);
});

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

  test('a reference that is not one says so and stays put', async () => {
    await expectReference('Romans 1');
    await jump('Romans 17');
    assert.match((await page.getByRole('alert').textContent()) ?? '', /"Romans 17" is not a reference/);
    assert.equal(await reference().textContent(), 'Romans 1');
  });

  test('S2.7 choosing CSB says it is not available and shows no text', async () => {
    await expectReference('Romans 1');
    await page.getByLabel('Translation').selectOption('CSB');
    await page.getByText('CSB text not available from a licensed source').waitFor();
    assert.equal(await page.locator('.verse').count(), 0);
    await page.getByLabel('Translation').selectOption('BSB');
    await expectReference('Romans 1');
  });
});

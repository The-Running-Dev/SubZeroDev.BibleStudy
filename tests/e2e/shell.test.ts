/// <reference lib="dom" />
// Browser tests for updates and accounts across windows (S16): a new build applied only on approval and when it cuts
// nothing off, and a logout that hides the account in every open window. The built client is copied so a test can
// publish a new build by rewriting its sw.js. Romans imported live from AO Lab. Needs `npm run build` first.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { importAudio } from '../../src/server/content/narration.ts';
import { createAoLabSource } from '../../src/server/content/aolab.ts';
import { runImport } from '../../src/server/content/import.ts';
import type { Harness } from '../support/harness.ts';
import { clearMailbox, ownerEmail, signIn, startHarness } from '../support/harness.ts';

const aoLabUrl = process.env.AOLAB_BASE_URL ?? 'https://bible.helloao.org';
const mobile = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
let h: Harness;
let browser: Browser;
let baseUrl: string;
let staticDir: string;
let owner: { cookie: string; userId: string };
let mark: { cookie: string; userId: string };
let contexts: BrowserContext[] = [];
let builds = 0;

before(async () => {
  assert.ok(existsSync('dist/client/sw.js'), 'run `npm run build` before the browser tests');
  staticDir = mkdtempSync(join(tmpdir(), 'bs-shell-'));
  cpSync('dist/client', staticDir, { recursive: true });
  h = await startHarness({ STATIC_DIR: staticDir });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  await clearMailbox();
  const source = createAoLabSource({ baseUrl: aoLabUrl });
  assert.equal((await runImport({ db: h.db, clock: h.clock, source }, { translationId: 'BSB', books: ['ROM'] })).status, 'succeeded');
  const audio = await importAudio({ db: h.db, clock: h.clock, source, mediaDir: h.config.mediaDir }, { translationId: 'BSB', bookId: 'ROM', chapters: [1] });
  assert.equal(audio.status, 'succeeded');
  h.clock.set(new Date());
  h.clock.run();
  owner = await signIn(h, ownerEmail);
  const groupId = (await h.app.inject({ method: 'GET', url: '/api/groups', cookies: { bs_session: owner.cookie } })).json()[0].id as string;
  const link = (await h.app.inject({ method: 'POST', url: `/api/groups/${groupId}/invitations`, cookies: { bs_session: owner.cookie } })).json().link as string;
  mark = await signIn(h, 'mark@example.test', new URL(link).pathname.replace('/join/', ''));
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => {
  await browser?.close();
  await h?.close();
  rmSync(staticDir, { recursive: true, force: true });
});
afterEach(async () => {
  for (const context of contexts) await context.close();
  contexts = [];
  await h.db.query(`UPDATE study_sessions SET status = 'ended', play_status = 'ended', ended_at = now() WHERE status = 'active'`);
});

async function context(cookie?: string): Promise<BrowserContext> {
  const created = await browser.newContext(mobile);
  contexts.push(created);
  if (cookie) await created.addCookies([{ name: 'bs_session', value: cookie, url: baseUrl }]);
  return created;
}

// Opens the app and waits until the service worker controls the page, so a later build replaces it.
async function open(target: BrowserContext, ready: (page: Page) => Promise<void> = (page) => page.locator('.verse').first().waitFor()): Promise<Page> {
  const page = await target.newPage();
  await page.goto(baseUrl);
  await ready(page);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  return page;
}

// Publishes a new build and has the page look for it; the page then shows "Update ready".
async function publishBuild(page: Page): Promise<string> {
  const file = join(staticDir, 'sw.js');
  const version = `test-build-${++builds}`;
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^const version = .*$/m, `const version = ${JSON.stringify(version)};`));
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r!.update()));
  await page.getByRole('status').getByText('Update ready').waitFor();
  return version;
}

const update = (page: Page) => page.locator('.update-ready').getByRole('button', { name: 'Update' }).click();
const refusal = (page: Page) => page.locator('.update-refused');

describe('updates and accounts (S16)', () => {
  test('S16.1 an approved update applies while idle, with notes and downloads intact', async () => {
    const page = await open(await context(owner.cookie));
    await page.getByLabel(/^Note on Romans 1/).fill('Kept through the update.');
    await page.getByRole('button', { name: 'Save note' }).click();
    await page.locator('[data-note]').getByText('Kept through the update.').waitFor();
    await page.locator('[data-save-state]').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Download for offline' }).click();
    await page.getByRole('dialog').getByText('Text only').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Download', exact: true }).click();
    await page.getByText('Downloaded — readable offline.').waitFor();

    const version = await publishBuild(page);
    // Nothing is applied before the member approves it.
    assert.ok(await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r!.waiting !== null)));
    const reloaded = page.waitForEvent('load');
    await update(page);
    await reloaded;
    await page.locator('.verse').first().waitFor();
    assert.ok((await page.evaluate(() => caches.keys())).includes(`shell-${version}`));
    assert.equal(await page.locator('.update-ready').count(), 0);

    // The note and the download are still on the device: the new build starts with no connection and shows both.
    await page.context().setOffline(true);
    await page.reload();
    await page.getByText('Server unavailable — showing what is on this device.').waitFor();
    await page.locator('[data-note]').getByText('Kept through the update.').waitFor();
    await page.locator('.verse').first().waitFor();
  });

  test('S16.2 approval is refused with two windows open', async () => {
    const shared = await context(owner.cookie);
    const page = await open(shared);
    await open(shared);
    await publishBuild(page);
    await update(page);
    await refusal(page).getByText('Close the other windows of this app first, then update.').waitFor();
    assert.ok(await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r!.waiting !== null)));
  });

  test('S16.2 approval is refused during sign-in', async () => {
    const page = await open(await context(), (p) => p.getByLabel('Email').waitFor());
    await page.getByLabel('Email').fill('mark@example.test');
    await page.getByRole('button', { name: 'Email me a code' }).click();
    await page.getByRole('heading', { name: 'Enter your code' }).waitFor();
    await publishBuild(page);
    await update(page);
    await refusal(page).getByText('Finish signing in first, then update.').waitFor();
  });

  test('S16.2 approval is refused while joined to a live session', async () => {
    const page = await open(await context(owner.cookie));
    await page.getByRole('button', { name: 'Study', exact: true }).click();
    await page.getByRole('button', { name: /^(Start study|Join study|Resume study at)/ }).click();
    await page.getByTestId('study-status').waitFor();
    await publishBuild(page);
    await update(page);
    await refusal(page).getByText('Leave the study session first, then update.').waitFor();
  });

  test('S16.3 logging out in one window hides the account in the other, and the next account sees none of it', async () => {
    const shared = await context(owner.cookie);
    const first = await open(shared);
    await first.getByLabel(/^Note on Romans 1/).fill('Only for the owner.');
    await first.getByRole('button', { name: 'Save note' }).click();
    await first.locator('[data-save-state]').waitFor({ state: 'detached' });
    await first.getByRole('button', { name: 'Ask a question' }).click();
    await first.getByLabel('Your question').fill('A draft of the owner.');
    await first.locator('[data-save-state="not_posted"]').waitFor();
    await first.getByRole('button', { name: 'Download for offline' }).click();
    await first.getByRole('dialog').getByText('Text only').click();
    await first.getByRole('dialog').getByRole('button', { name: 'Download', exact: true }).click();
    await first.getByText('Downloaded — readable offline.').waitFor();

    const second = await open(shared);
    await second.locator('[data-note]').getByText('Only for the owner.').waitFor();

    await first.locator('.account-toggle').click();
    await first.getByRole('button', { name: 'Sign out' }).click();
    await second.getByRole('button', { name: 'Email me a code' }).waitFor({ timeout: 2_000 });
    assert.equal(await second.getByText('Only for the owner.').count(), 0);

    // Another member signs in on this device: none of the owner's notes, drafts or downloads.
    await shared.addCookies([{ name: 'bs_session', value: mark.cookie, url: baseUrl }]);
    await second.reload();
    await second.locator('.verse').first().waitFor();
    assert.equal(await second.locator('[data-note]').count(), 0);
    if (await second.getByRole('button', { name: 'Ask a question' }).count()) await second.getByRole('button', { name: 'Ask a question' }).click();
    assert.notEqual(await second.getByLabel('Your question').inputValue().catch(() => ''), 'A draft of the owner.');
    await second.locator('.account-toggle').click();
    await second.getByText('No chapters downloaded on this device.').waitFor();
  });
});

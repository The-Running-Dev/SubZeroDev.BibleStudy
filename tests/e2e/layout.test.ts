/// <reference lib="dom" />
// Browser checks for small phones (S17): every main screen at 320×568 and 360×640, in portrait and landscape, with
// text at 200 %, has no horizontal page scroll; the composers keep their buttons in view with the keyboard open; and
// safe-area insets are kept clear. Romans imported live from AO Lab. Needs `npm run build` first.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, describe, test } from 'node:test';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { createAoLabSource } from '../../src/server/content/aolab.ts';
import { runImport } from '../../src/server/content/import.ts';
import { importAudio } from '../../src/server/content/narration.ts';
import type { Harness } from '../support/harness.ts';
import { clearMailbox, ownerEmail, signIn, startHarness } from '../support/harness.ts';

const aoLabUrl = process.env.AOLAB_BASE_URL ?? 'https://bible.helloao.org';
let h: Harness;
let browser: Browser;
let baseUrl: string;
let owner: { cookie: string; userId: string };
let contexts: BrowserContext[] = [];

before(async () => {
  assert.ok(existsSync('dist/client/index.html'), 'run `npm run build` before the browser tests');
  // The assistant is set up for the owner, so its panel is laid out too; its connector is never started.
  h = await startHarness({ STATIC_DIR: 'dist/client', ASSISTANT_OWNER_EMAIL: ownerEmail, CONNECTOR_TOKEN: 'layout-e2e-connector-token-0123456789abcdef' });
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
  await signIn(h, 'mark@example.test', new URL(link).pathname.replace('/join/', ''));
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => {
  await browser?.close();
  await h?.close();
});
afterEach(async () => {
  for (const context of contexts) await context.close();
  contexts = [];
  await h.db.query(`UPDATE study_sessions SET status = 'ended', play_status = 'ended', ended_at = now() WHERE status = 'active'`);
});

const phones = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
];
const sizes = phones.flatMap((p) => [
  { name: `${p.width}×${p.height} portrait`, viewport: p },
  { name: `${p.width}×${p.height} landscape`, viewport: { width: p.height, height: p.width } },
]);

async function phone(viewport: { width: number; height: number }, cookie?: string, largeText = true): Promise<Page> {
  const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
  contexts.push(context);
  if (cookie) await context.addCookies([{ name: 'bs_session', value: cookie, url: baseUrl }]);
  const page = await context.newPage();
  // Text at 200 %: every size in the stylesheet is in rem or em, so doubling the root size doubles all text. Verdana,
  // spaced out, is wider than the system font on every platform, so a layout that fits here fits Windows and Linux alike.
  if (largeText) {
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = 'html { font-size: 200% !important; } body, button, input, select, textarea { font-family: Verdana, sans-serif !important; letter-spacing: 0.05em !important; }';
        document.head.append(style);
      });
    });
  }
  return page;
}

// The page scrolls sideways when anything is wider than the viewport.
async function assertNoSideScroll(page: Page, screen: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((e) => e.getBoundingClientRect().right > width + 1 && getComputedStyle(e).position !== 'fixed')
      .slice(0, 3)
      .map((e) => `${e.tagName.toLowerCase()}.${e.className} (${Math.round(e.getBoundingClientRect().right)}px)`);
    return { scroll: document.documentElement.scrollWidth - width, wide };
  });
  assert.ok(overflow.scroll <= 0, `${screen} scrolls sideways by ${overflow.scroll}px: ${overflow.wide.join(', ')}`);
}

describe('small phones (S17)', () => {
  for (const size of sizes) {
    test(`S17.1 no screen scrolls sideways at ${size.name} with 200 % text`, async () => {
      const signedOut = await phone(size.viewport);
      await signedOut.goto(baseUrl);
      await signedOut.getByLabel('Email').waitFor();
      await assertNoSideScroll(signedOut, 'sign-in');
      await signedOut.getByLabel('Email').fill('mark@example.test');
      await signedOut.getByRole('button', { name: 'Email me a code' }).click();
      await signedOut.getByRole('heading', { name: 'Enter your code' }).waitFor();
      await assertNoSideScroll(signedOut, 'sign-in code');

      const page = await phone(size.viewport, owner.cookie);
      await page.goto(baseUrl);
      await page.locator('.verse').first().waitFor();
      await page.locator('.assistant').waitFor();
      await assertNoSideScroll(page, 'reader');

      await page.getByRole('button', { name: 'Ask a question' }).click();
      await page.getByLabel('Your question').waitFor();
      await assertNoSideScroll(page, 'question composer');

      await page.getByRole('button', { name: 'Download for offline' }).click();
      await page.getByRole('dialog').waitFor();
      await assertNoSideScroll(page, 'download dialog');
      await page.getByRole('dialog').getByRole('button', { name: 'Not now' }).click();

      await page.locator('.account-toggle').click();
      await page.getByRole('region', { name: 'Account' }).waitFor();
      await page.getByRole('button', { name: 'Edit profile' }).click();
      await assertNoSideScroll(page, 'account, downloads and install help');
      await page.locator('.account-toggle').click();

      await page.locator('.home-bar').getByRole('button').first().click();
      await page.getByRole('region', { name: 'Group' }).waitFor();
      await assertNoSideScroll(page, 'group, meetings and reminders');
      await page.locator('.home-bar').getByRole('button').first().click();

      await page.getByRole('button', { name: 'Study', exact: true }).click();
      await page.getByRole('button', { name: /^(Start study|Join study|Resume study at)/ }).click();
      await page.getByTestId('study-status').waitFor();
      await assertNoSideScroll(page, 'study session');
      await page.getByRole('button', { name: 'Ask a question' }).click();
      await page.getByLabel('Your question').waitFor();
      await assertNoSideScroll(page, 'study questions');
    });
  }

  // Playwright cannot raise a real on-screen keyboard; it is modelled as the viewport shrinking to what is left above it.
  for (const size of [phones[0], { width: phones[0].height, height: phones[0].width }]) {
    test(`S17.2 with the keyboard open at ${size.width}×${size.height}, the composer keeps its buttons in view`, async () => {
      // S17.2 asks for the buttons with the keyboard open at the phone's usual text size; S17.1 covers 200 %.
      const page = await phone(size, owner.cookie, false);
      await page.goto(baseUrl);
      await page.locator('.verse').first().waitFor();
      const keyboard = { width: size.width, height: Math.round(size.height * (size.width < size.height ? 0.55 : 0.45)) };

      const inView = async (button: string) => {
        const box = await page.getByRole('button', { name: button, exact: true }).boundingBox();
        assert.ok(box, `${button} is not shown`);
        assert.ok(box.y >= 0 && box.y + box.height <= keyboard.height + 1, `${button} is under the keyboard (${Math.round(box.y)}–${Math.round(box.y + box.height)} of ${keyboard.height}px)`);
      };

      await page.getByLabel(/^Note on Romans 1/).click();
      await page.setViewportSize(keyboard);
      await page.getByLabel(/^Note on Romans 1/).fill('Typed with the keyboard up.');
      await inView('Save note');

      await page.setViewportSize(size);
      await page.getByRole('button', { name: 'Ask a question' }).click();
      await page.getByLabel('Your question').click();
      await page.setViewportSize(keyboard);
      await page.getByLabel('Your question').fill('Asked with the keyboard up?');
      await inView('Post question');
    });
  }

  test('S17.3 standalone safe-area insets are kept clear in portrait and landscape', async () => {
    const page = await phone(phones[1], owner.cookie);
    const cdp = await page.context().newCDPSession(page);
    const inset = async (insets: { top: number; right: number; bottom: number; left: number }) => {
      await cdp.send('Emulation.setSafeAreaInsetsOverride' as never, { insets } as never);
    };
    await inset({ top: 47, right: 0, bottom: 34, left: 0 });
    await page.goto(baseUrl);
    await page.locator('.verse').first().waitFor();
    const edges = () =>
      page.evaluate(() => {
        const bar = document.querySelector('.home-bar')!.getBoundingClientRect();
        const reader = document.querySelector('.reader')!;
        const content = [...reader.querySelectorAll<HTMLElement>('button, p, textarea, .verse')].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
        window.scrollTo(0, document.documentElement.scrollHeight);
        const last = reader.lastElementChild!.getBoundingClientRect();
        return {
          barTop: bar.top + window.scrollY,
          left: Math.min(...content.map((r) => r.left)),
          right: document.documentElement.clientWidth - Math.max(...content.map((r) => r.right)),
          bottomGap: window.innerHeight - last.bottom,
        };
      });
    const portrait = await edges();
    assert.ok(portrait.barTop >= 47, `the top bar starts at ${portrait.barTop}px, under the status bar`);
    assert.ok(portrait.bottomGap >= 34, `the page ends ${portrait.bottomGap}px from the bottom, under the home indicator`);

    await page.setViewportSize({ width: phones[1].height, height: phones[1].width });
    await inset({ top: 0, right: 47, bottom: 21, left: 47 });
    await page.reload();
    await page.locator('.verse').first().waitFor();
    const landscape = await edges();
    assert.ok(landscape.left >= 47, `content starts ${landscape.left}px from the left edge, under the notch`);
    assert.ok(landscape.right >= 47, `content ends ${landscape.right}px from the right edge, under the notch`);
    assert.ok(landscape.bottomGap >= 21, `the page ends ${landscape.bottomGap}px from the bottom, under the home indicator`);
  });
});

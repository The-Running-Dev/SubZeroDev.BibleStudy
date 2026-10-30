/// <reference lib="dom" />
// Browser tests for the chapter player: Romans 1 text and narration imported live from AO Lab,
// played by Chromium through the real /media route. Needs `npm run build` first.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { createAoLabSource } from '../../src/server/content/aolab.ts';
import { runImport } from '../../src/server/content/import.ts';
import { importAudio } from '../../src/server/content/narration.ts';
import { verseAt } from '../../src/client/timing.ts';
import type { Harness } from '../support/harness.ts';
import { clearMailbox, signIn, startHarness } from '../support/harness.ts';

const aoLabUrl = process.env.AOLAB_BASE_URL ?? 'https://bible.helloao.org';
let h: Harness;
let browser: Browser;
let baseUrl: string;
let cookie: string;
let page: Page;
let starts: number[];

before(async () => {
  assert.ok(existsSync('dist/client/index.html'), 'run `npm run build` before the browser tests');
  h = await startHarness({ STATIC_DIR: 'dist/client' });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  await clearMailbox();
  h.clock.set('2026-11-01T12:00:00Z');
  const source = createAoLabSource({ baseUrl: aoLabUrl });
  assert.equal((await runImport({ db: h.db, clock: h.clock, source }, { translationId: 'BSB', books: ['ROM'] })).status, 'succeeded');
  const audio = await importAudio({ db: h.db, clock: h.clock, source, mediaDir: h.config.mediaDir }, { translationId: 'BSB', bookId: 'ROM', chapters: [1] });
  assert.equal(audio.status, 'succeeded');
  const timing = await h.db.query(`SELECT timing FROM recordings WHERE book_id = 'ROM' AND chapter = 1 AND narrator_id = 'souer'`);
  starts = timing.rows[0].timing;
  assert.equal(starts.length, 32);
  cookie = (await signIn(h, 'listener@example.test')).cookie;
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => {
  await browser?.close();
  await h?.close();
});

beforeEach(async () => {
  await h.db.query(`UPDATE recordings SET timing_status = 'verified', timing_reason = NULL WHERE timing IS NOT NULL`);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addCookies([{ name: 'bs_session', value: cookie, url: baseUrl }]);
  page = await context.newPage();
  await page.goto(baseUrl);
  await page.locator('.verse').first().waitFor();
  await page.locator('audio').waitFor({ state: 'attached' });
  await page.waitForFunction(() => document.querySelector('audio')!.readyState >= HTMLMediaElement.HAVE_METADATA);
});

async function chooseSouer(): Promise<void> {
  await page.getByLabel('Narrator').selectOption('souer');
  await page.waitForFunction(() => document.querySelector('audio')!.getAttribute('aria-label')!.endsWith('Bob Souer') && document.querySelector('audio')!.readyState >= HTMLMediaElement.HAVE_METADATA);
}
const audioTime = () => page.evaluate(() => document.querySelector('audio')!.currentTime);
const playingVerse = () => page.evaluate(() => document.querySelector('.verse.playing')?.id ?? null);
async function expectPlaying(id: string | null): Promise<void> {
  await page.waitForFunction((expected) => (document.querySelector('.verse.playing')?.id ?? null) === expected, id, { timeout: 5000 });
}
const jump = async (text: string) => {
  await page.getByLabel('Reference').fill(text);
  await page.getByRole('button', { name: 'Go', exact: true }).click();
};

describe('the chapter player', () => {
  test('S3.8 the player names the narrator and the translation', async () => {
    assert.deepEqual(await page.getByLabel('Narrator').locator('option').allTextContents(), ['Barry Hays', 'Bob Souer']);
    assert.equal(await page.getByTestId('narration-label').textContent(), 'Barry Hays · Berean Standard Bible');
    await page.getByLabel('Narrator').selectOption('souer');
    assert.equal(await page.getByTestId('narration-label').textContent(), 'Bob Souer · Berean Standard Bible');
    assert.equal(await page.getByRole('region', { name: 'Narration' }).locator('audio').getAttribute('aria-label'), 'Romans 1 read by Bob Souer');
  });

  test('S3.4 while Romans 1 plays, the highlighted verse is the one whose start precedes the position', async () => {
    await chooseSouer();
    await expectPlaying(null);
    for (const verse of [1, 7, 16, 24, 32]) {
      await page.evaluate((seconds) => {
        const audio = document.querySelector('audio')!;
        audio.currentTime = seconds;
        return audio.play();
      }, starts[verse - 1] + 0.2);
      // Sample while it plays: the position and the highlight, read in the same frame.
      await page.waitForTimeout(400);
      const sample = await page.evaluate(
        () =>
          new Promise<{ t: number; id: string | null; paused: boolean }>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve({ t: document.querySelector('audio')!.currentTime, id: document.querySelector('.verse.playing')?.id ?? null, paused: document.querySelector('audio')!.paused }))),
          ),
      );
      assert.equal(sample.paused, false, `verse ${verse} is playing`);
      assert.ok(sample.t > starts[verse - 1], `position ${sample.t} moved past the start of verse ${verse}`);
      assert.equal(sample.id, `v-${verseAt(starts, sample.t)}`, `at ${sample.t} s`);
      await page.evaluate(() => document.querySelector('audio')!.pause());
    }
    if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/romans-1-playing.png` });
  });

  test('S3.5 playing Romans 1:16-17 starts at verse 16 and stops within 250 ms of verse 18', async () => {
    await chooseSouer();
    await jump('Romans 1:16-17');
    const play = page.getByRole('button', { name: 'Play Romans 1:16–17' });
    await play.waitFor();
    // Record the position on every frame from the moment playback starts.
    await page.evaluate(() => {
      const audio = document.querySelector('audio')!;
      const samples: number[] = [];
      (window as unknown as { samples: number[] }).samples = samples;
      const record = () => {
        if (!audio.paused) samples.push(audio.currentTime);
        requestAnimationFrame(record);
      };
      requestAnimationFrame(record);
    });
    await play.click();
    await page.waitForFunction(() => (window as unknown as { samples: number[] }).samples.length > 0);
    await expectPlaying('v-16');
    const length = starts[17] - starts[15];
    await page.waitForFunction(() => document.querySelector('audio')!.paused, undefined, { timeout: (length + 10) * 1000 });
    const samples = await page.evaluate(() => (window as unknown as { samples: number[] }).samples);
    const stoppedAt = await audioTime();
    assert.ok(Math.abs(samples[0] - starts[15]) < 0.25, `started at ${samples[0]}, verse 16 starts at ${starts[15]}`);
    assert.ok(Math.abs(stoppedAt - starts[17]) <= 0.25, `stopped at ${stoppedAt}, verse 18 starts at ${starts[17]}`);
    assert.ok(Math.max(...samples) < starts[17] + 0.25);
    assert.equal(await playingVerse(), 'v-17', 'the last verse of the range stays highlighted');
  });

  test('S3.6 a recording without verified timing plays the whole chapter, says verse following is unavailable, and offers no range play', async () => {
    await h.db.query(
      `UPDATE recordings SET timing_status = 'rejected', timing_reason = 'verse count 31 ≠ 32' WHERE book_id = 'ROM' AND chapter = 1 AND narrator_id = 'hays'`,
    );
    await page.reload();
    await page.getByLabel('Narrator').selectOption('hays');
    await page.getByText('Verse following unavailable for this recording').waitFor();
    assert.equal(await page.getByTestId('narration-label').textContent(), 'Barry Hays · Berean Standard Bible');
    await jump('Romans 1:16-17');
    assert.ok(await page.getByRole('button', { name: 'Play Romans 1:16–17' }).isDisabled());

    await page.waitForFunction(() => document.querySelector('audio')!.readyState >= HTMLMediaElement.HAVE_METADATA);
    assert.equal(await audioTime(), 0);
    const duration = await page.evaluate(() => document.querySelector('audio')!.duration);
    assert.ok(duration > starts[31], `the whole chapter (${duration} s) is loaded`);
    await page.evaluate(() => document.querySelector('audio')!.play());
    await page.waitForFunction(() => document.querySelector('audio')!.currentTime > 1);
    assert.equal(await playingVerse(), null);
    await page.evaluate(() => document.querySelector('audio')!.pause());
  });

  test('S3.8 no BSB recording is offered while CSB is the displayed translation', async () => {
    await page.getByLabel('Translation').selectOption('CSB');
    await page.waitForFunction(() => document.querySelector('audio') === null);
    assert.equal(await page.getByLabel('Narrator').count(), 0);
  });
});

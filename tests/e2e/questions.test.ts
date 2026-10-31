/// <reference lib="dom" />
// Browser tests for questions: Romans text and Romans 2 narration imported live from AO Lab, against one server
// whose clock runs in real time. Needs `npm run build` first.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { createAoLabSource } from '../../src/server/content/aolab.ts';
import { runImport } from '../../src/server/content/import.ts';
import { importAudio } from '../../src/server/content/narration.ts';
import type { QuestionView } from '../../src/shared/api.ts';
import type { Harness } from '../support/harness.ts';
import { clearMailbox, ownerEmail, signIn, startHarness } from '../support/harness.ts';

const aoLabUrl = process.env.AOLAB_BASE_URL ?? 'https://bible.helloao.org';
let h: Harness;
let browser: Browser;
let baseUrl: string;
let groupId: string;
const people: Record<'olive' | 'mark', { cookie: string; userId: string }> = {} as never;
let contexts: BrowserContext[] = [];

before(async () => {
  assert.ok(existsSync('dist/client/index.html'), 'run `npm run build` before the browser tests');
  h = await startHarness({ STATIC_DIR: 'dist/client' });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  await clearMailbox();
  const source = createAoLabSource({ baseUrl: aoLabUrl });
  assert.equal((await runImport({ db: h.db, clock: h.clock, source }, { translationId: 'BSB', books: ['ROM'] })).status, 'succeeded');
  const audio = await importAudio({ db: h.db, clock: h.clock, source, mediaDir: h.config.mediaDir }, { translationId: 'BSB', bookId: 'ROM', chapters: [2] });
  assert.equal(audio.status, 'succeeded');
  h.clock.set(new Date());
  h.clock.run();

  people.olive = await signIn(h, ownerEmail);
  groupId = (await h.app.inject({ method: 'GET', url: '/api/groups', cookies: { bs_session: people.olive.cookie } })).json()[0].id;
  const link = (await h.app.inject({ method: 'POST', url: `/api/groups/${groupId}/invitations`, cookies: { bs_session: people.olive.cookie } })).json().link as string;
  people.mark = await signIn(h, 'mark@example.test', new URL(link).pathname.replace('/join/', ''));
  for (const [name, displayName] of [
    ['olive', 'Olive'],
    ['mark', 'Mark'],
  ] as const) {
    const response = await h.app.inject({ method: 'PATCH', url: '/api/me', cookies: { bs_session: people[name].cookie }, payload: { displayName, timeZone: 'America/Chicago' } });
    assert.equal(response.statusCode, 200, response.body);
  }
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => {
  await browser?.close();
  await h?.close();
});

beforeEach(async () => {
  await h.db.query('TRUNCATE questions CASCADE');
  await h.db.query(`UPDATE study_sessions SET status = 'ended', play_status = 'ended', ended_at = now() WHERE status = 'active'`);
});
afterEach(async () => {
  for (const context of contexts) await context.close();
  contexts = [];
});

async function ask(who: keyof typeof people, startVerse: number | null, body: string): Promise<QuestionView> {
  const anchor = { translationId: 'BSB', bookId: 'ROM', chapter: 2, startVerse, endVerse: startVerse };
  const response = await h.app.inject({ method: 'POST', url: `/api/groups/${groupId}/questions`, cookies: { bs_session: people[who].cookie }, payload: { clientOpId: randomUUID(), anchor, body } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function open(who: keyof typeof people): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  contexts.push(context);
  await context.addCookies([{ name: 'bs_session', value: people[who].cookie, url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(baseUrl);
  return page;
}

async function openStudy(who: keyof typeof people): Promise<Page> {
  const page = await open(who);
  await page.getByRole('button', { name: 'Study', exact: true }).click();
  await page.getByRole('button', { name: /^(Start|Join) study$/ }).click();
  await page.getByTestId('study-status').waitFor();
  await page.waitForFunction(() => document.querySelector('.study-connection') === null, undefined, { timeout: 10_000 });
  return page;
}

async function waitForAudio(page: Page): Promise<void> {
  await page.locator('audio').waitFor({ state: 'attached' });
  await page.waitForFunction(() => document.querySelector('audio')!.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA);
}

async function readRomans2(page: Page): Promise<void> {
  await page.getByLabel('Reference').fill('Romans 2');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="reference"]')?.textContent === 'Romans 2');
}

const questions = (page: Page, text: string) => page.getByTestId('question').filter({ hasText: text });
const playingVerse = (page: Page) => page.evaluate(() => Number(document.querySelector('.verse.playing')?.id.replace('v-', '') ?? 0));

describe('questions in the study', () => {
  test('S8.3 the Romans 2:4 question appears when verse 4 starts, without pausing, and only once; a chapter question shows from the start', async () => {
    const timing = await h.db.query(`SELECT timing FROM recordings WHERE book_id = 'ROM' AND chapter = 2 AND timing IS NOT NULL`);
    assert.ok(timing.rowCount, 'AO Lab publishes verse timing for Romans 2');
    await ask('olive', 4, 'What does God’s kindness lead to?');
    await ask('olive', null, 'What is this chapter answering?');

    const olive = await openStudy('olive');
    await olive.getByLabel('Study passage').fill('Romans 2');
    await olive.getByRole('button', { name: 'Set', exact: true }).click();
    await olive.waitForFunction(() => document.querySelector('[data-testid="study-reference"]')?.textContent === 'Romans 2');
    const mark = await openStudy('mark');
    await mark.waitForFunction(() => document.querySelector('[data-testid="study-reference"]')?.textContent === 'Romans 2');
    for (const page of [olive, mark]) {
      await waitForAudio(page);
      await questions(page, 'What is this chapter answering?').waitFor();
      assert.equal(await questions(page, 'kindness').count(), 0, 'the verse 4 question waits for verse 4');
    }

    await olive.getByRole('button', { name: 'Play', exact: true }).click();
    // The verse being read when the question first appears.
    const appearedAt = await mark.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-testid="question"]')].some((q) => q.textContent?.includes('kindness')) ? Number(document.querySelector('.verse.playing')?.id.replace('v-', '')) : false,
      undefined,
      { timeout: 90_000 },
    );
    assert.equal(await appearedAt.jsonValue(), 4);
    assert.equal(await mark.getByTestId('study-status').textContent(), 'Playing', 'the question does not pause the reading');
    if (process.env.E2E_SCREENSHOTS) await mark.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/study-question.png`, fullPage: true });

    // Back over verse 4 and through it again: still one.
    await olive.getByRole('button', { name: 'Back 10 seconds' }).click();
    await mark.waitForFunction(() => Number(document.querySelector('.verse.playing')?.id.replace('v-', '') ?? 99) < 4, undefined, { timeout: 5_000 });
    assert.equal(await questions(mark, 'kindness').count(), 1);
    await mark.waitForFunction(() => Number(document.querySelector('.verse.playing')?.id.replace('v-', '') ?? 0) >= 5, undefined, { timeout: 60_000 });
    assert.equal(await questions(mark, 'kindness').count(), 1);
    assert.ok((await playingVerse(mark)) >= 5);
  });

  test('a question posted during the study reaches the other member at once', async () => {
    const olive = await openStudy('olive');
    const mark = await openStudy('mark');
    await mark.getByRole('button', { name: 'Ask a question' }).click();
    await mark.getByLabel('Verses (blank for the whole chapter)').fill('');
    await mark.getByLabel('Your question').fill('Who is Paul writing to?');
    await mark.getByRole('button', { name: 'Post question' }).click();
    await questions(mark, 'Who is Paul writing to?').waitFor();
    await questions(olive, 'Who is Paul writing to?').waitFor({ timeout: 3_000 });
  });
});

describe('questions in the reader', () => {
  test('S8.1, S8.4–S8.6 members read, reply, edit and delete without a session, filtered by status', async () => {
    const theirs = await ask('olive', 4, 'What does God’s kindness lead to?');
    const mark = await open('mark');
    await readRomans2(mark);
    const kindness = questions(mark, 'kindness');
    await kindness.waitFor();
    assert.equal(await kindness.getByRole('button', { name: 'Edit' }).count(), 0, 'only its author can edit');

    await kindness.getByRole('button', { name: 'Reply' }).click();
    await kindness.getByLabel('Your reply').fill('Repentance.');
    await kindness.getByRole('button', { name: 'Post reply' }).click();
    await kindness.getByTestId('reply').filter({ hasText: 'Repentance.' }).waitFor();

    await mark.getByRole('button', { name: 'Ask a question' }).click();
    await mark.getByLabel('Verses (blank for the whole chapter)').fill('7-8');
    await mark.getByLabel('Your question').fill('Is this about works?');
    await mark.getByRole('button', { name: 'Post question' }).click();
    await questions(mark, 'Is this about works?').waitFor();
    const works = mark.locator(`[data-question="${await questions(mark, 'Is this about works?').getAttribute('data-question')}"]`);
    await works.getByRole('button', { name: 'Edit' }).click();
    await works.getByLabel('Edit post').fill('Is this about earning salvation?');
    await works.getByRole('button', { name: 'Save' }).click();
    await works.getByText('Is this about earning salvation?').waitFor();
    await works.getByText('· edited').waitFor();
    await works.getByRole('button', { name: 'Delete' }).click();
    await works.getByRole('button', { name: 'Delete for everyone' }).click();
    await works.waitFor({ state: 'detached' });
    const marks = await h.db.query('SELECT body FROM questions WHERE author_id = $1', [people.mark.userId]);
    assert.deepEqual(
      marks.rows.map((r) => r.body),
      [null],
      'no replies, so nothing of it is left to show',
    );

    // Olive removes hers; Mark's reply stays under the placeholder.
    const olive = await open('olive');
    await readRomans2(olive);
    const hers = questions(olive, 'kindness');
    await hers.getByRole('button', { name: 'Delete' }).first().click();
    await hers.getByRole('button', { name: 'Delete for everyone' }).click();
    const placeholder = olive.getByTestId('question').filter({ hasText: 'Repentance.' });
    await placeholder.getByText('removed', { exact: true }).waitFor();

    // S8.6: settled questions are behind the filter.
    await h.db.query(`UPDATE questions SET status = 'resolved' WHERE id = $1`, [theirs.id]);
    await mark.reload();
    await readRomans2(mark);
    await mark.getByText('No questions here yet.').waitFor();
    await mark.getByLabel('Show questions').selectOption('Resolved');
    await mark.getByTestId('question').filter({ hasText: 'Repentance.' }).waitFor();
    if (process.env.E2E_SCREENSHOTS) await mark.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/reader-questions.png`, fullPage: true });
  });
});

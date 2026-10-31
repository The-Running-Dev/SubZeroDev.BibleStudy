/// <reference lib="dom" />
// Browser tests for studying together: Romans 1 narration imported live from AO Lab, played by several
// Chromium clients against one server whose clock runs in real time. Needs `npm run build` first.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page, WebSocketRoute } from 'playwright';
import { createAoLabSource } from '../../src/server/content/aolab.ts';
import { runImport } from '../../src/server/content/import.ts';
import { importAudio } from '../../src/server/content/narration.ts';
import type { DriftReport } from '../../src/shared/api.ts';
import type { Harness } from '../support/harness.ts';
import { clearMailbox, ownerEmail, signIn, startHarness } from '../support/harness.ts';

const aoLabUrl = process.env.AOLAB_BASE_URL ?? 'https://bible.helloao.org';
let h: Harness;
let browser: Browser;
let baseUrl: string;
let groupId: string;
const people: Record<'olive' | 'mark' | 'ruth', { cookie: string; userId: string }> = {} as never;
let contexts: BrowserContext[] = [];

before(async () => {
  assert.ok(existsSync('dist/client/index.html'), 'run `npm run build` before the browser tests');
  h = await startHarness({ STATIC_DIR: 'dist/client' });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  await clearMailbox();
  const source = createAoLabSource({ baseUrl: aoLabUrl });
  assert.equal((await runImport({ db: h.db, clock: h.clock, source }, { translationId: 'BSB', books: ['ROM'] })).status, 'succeeded');
  const audio = await importAudio({ db: h.db, clock: h.clock, source, mediaDir: h.config.mediaDir }, { translationId: 'BSB', bookId: 'ROM', chapters: [1] });
  assert.equal(audio.status, 'succeeded');
  // Playback positions derive from the server clock, which the browsers' audio follows in real time.
  h.clock.set(new Date());
  h.clock.run();

  people.olive = await signIn(h, ownerEmail);
  groupId = (await h.app.inject({ method: 'GET', url: '/api/groups', cookies: { bs_session: people.olive.cookie } })).json()[0].id;
  for (const [name, email] of [
    ['mark', 'mark@example.test'],
    ['ruth', 'ruth@example.test'],
  ] as const) {
    const link = (await h.app.inject({ method: 'POST', url: `/api/groups/${groupId}/invitations`, cookies: { bs_session: people.olive.cookie } })).json().link as string;
    people[name] = await signIn(h, email, new URL(link).pathname.replace('/join/', ''));
  }
  for (const [name, displayName] of [
    ['olive', 'Olive'],
    ['mark', 'Mark'],
    ['ruth', 'Ruth'],
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
  await h.db.query(`UPDATE recordings SET timing_status = 'verified', timing_reason = NULL WHERE timing IS NOT NULL`);
  await h.db.query(`UPDATE study_sessions SET status = 'ended', play_status = 'ended', ended_at = now() WHERE status = 'active'`);
});
afterEach(async () => {
  for (const context of contexts) await context.close();
  contexts = [];
});

interface Client {
  page: Page;
  // For a client opened with a switchable connection: drop it now and refuse reconnects, or allow them again.
  setOffline(offline: boolean): void;
}

// Opens the app as one person, switches to Study, and starts or joins the group's session.
async function openStudy(who: keyof typeof people, options: { switchable?: boolean } = {}): Promise<Client> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  contexts.push(context);
  await context.addCookies([{ name: 'bs_session', value: people[who].cookie, url: baseUrl }]);
  const page = await context.newPage();
  let offline = false;
  const routes: WebSocketRoute[] = [];
  if (options.switchable) {
    await page.routeWebSocket(/\/ws$/, (ws) => {
      if (offline) {
        ws.close();
        return;
      }
      ws.connectToServer();
      routes.push(ws);
    });
  }
  await page.goto(baseUrl);
  await page.getByRole('button', { name: 'Study', exact: true }).click();
  await page.getByRole('button', { name: /^(Start study|Join study|Resume study at)/ }).click();
  await page.getByTestId('study-status').waitFor();
  await page.waitForFunction(() => document.querySelector('.study-connection') === null, undefined, { timeout: 10_000 });
  await page.locator('audio').waitFor({ state: 'attached' });
  await page.waitForFunction(() => document.querySelector('audio')!.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA);
  return {
    page,
    setOffline(value) {
      offline = value;
      if (value) for (const route of routes.splice(0)) void route.close();
    },
  };
}

const status = (client: Client) => client.page.getByTestId('study-status').textContent();
async function expectStatus(client: Client, text: string, timeout = 5_000): Promise<void> {
  await client.page.waitForFunction((expected) => document.querySelector('[data-testid="study-status"]')?.textContent === expected, text, { timeout });
}
const audioState = (client: Client) => client.page.evaluate(() => ({ t: document.querySelector('audio')!.currentTime, paused: document.querySelector('audio')!.paused }));

async function activeSessionId(): Promise<string> {
  return (await h.db.query(`SELECT id FROM study_sessions WHERE status = 'active'`)).rows[0].id;
}

describe('studying together', () => {
  test('S5.4 three clients play Romans 1 for 120 s with drift p95 ≤ 500 ms', async () => {
    const clients = [await openStudy('olive'), await openStudy('mark'), await openStudy('ruth')];
    await clients[0].page.getByRole('button', { name: 'Play', exact: true }).click();
    for (const client of clients) await expectStatus(client, 'Playing');
    const startedAt = Date.now();
    // Spot-check while playing: every client is playing, and they are close to each other.
    const spread: number[] = [];
    while (Date.now() - startedAt < 120_000) {
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      const states = await Promise.all(clients.map(audioState));
      for (const state of states) assert.equal(state.paused, false);
      spread.push(Math.max(...states.map((s) => s.t)) - Math.min(...states.map((s) => s.t)));
    }
    const sessionId = await activeSessionId();
    const report = (await h.app.inject({ method: 'GET', url: `/api/groups/${groupId}/session/${sessionId}/drift-report`, cookies: { bs_session: people.olive.cookie } })).json() as DriftReport;
    // Reported in the pull request, pass or fail.
    console.log(`S5.4 drift report after ${Math.round((Date.now() - startedAt) / 1000)} s: ${JSON.stringify(report)}; position spread between clients (s): ${JSON.stringify(spread.map((s) => Number(s.toFixed(3))))}`);
    assert.equal(report.perClient.length, 3, 'all three clients reported drift');
    assert.ok(report.samples >= 60, `${report.samples} samples`);
    assert.ok(report.p95Ms <= 500, `p95 ${report.p95Ms} ms`);
  });

  test('S5.5 a member’s pause reaches the other clients within 1 s, and all show that member’s name', async () => {
    const [olive, mark, ruth] = [await openStudy('olive'), await openStudy('mark'), await openStudy('ruth')];
    await olive.page.getByRole('button', { name: 'Play', exact: true }).click();
    for (const client of [olive, mark, ruth]) await expectStatus(client, 'Playing');
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const clickedAt = Date.now();
    await mark.page.getByRole('button', { name: 'Pause', exact: true }).click();
    const arrivals = await Promise.all(
      [olive, ruth].map(async (client) => {
        await expectStatus(client, 'Paused by Mark', 2_000);
        return Date.now() - clickedAt;
      }),
    );
    console.log(`S5.5 pause arrival (ms): ${JSON.stringify(arrivals)}`);
    for (const ms of arrivals) assert.ok(ms <= 1_000, `arrived after ${ms} ms`);
    await expectStatus(mark, 'Paused by Mark');
    for (const client of [olive, mark, ruth]) {
      await client.page.waitForFunction(() => document.querySelector('audio')!.paused);
    }
    const positions = await Promise.all([olive, mark, ruth].map(async (c) => (await audioState(c)).t));
    assert.ok(Math.max(...positions) - Math.min(...positions) < 0.1, `paused at ${JSON.stringify(positions)}`);
  });

  test('S5.6 a client offline for 20 s returns to a snapshot, and its commands while offline were not applied', async () => {
    const olive = await openStudy('olive');
    const mark = await openStudy('mark', { switchable: true });
    await olive.page.getByRole('button', { name: 'Play', exact: true }).click();
    await expectStatus(mark, 'Playing');

    const sessionId = await activeSessionId();
    const offlineAt = new Date(h.clock.now().getTime());
    mark.setOffline(true);
    await mark.page.getByText('Reconnecting…').waitFor({ timeout: 5_000 });
    await mark.page.getByRole('button', { name: 'Pause', exact: true }).click();
    await mark.page.getByText('Not connected — your change was not sent.').waitFor();
    await mark.page.getByRole('button', { name: 'Forward 10 seconds' }).click();

    // Meanwhile Olive moves on and pauses.
    await olive.page.getByRole('button', { name: 'Forward 10 seconds' }).click();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await olive.page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expectStatus(olive, 'Paused by Olive');
    const shared = (await h.db.query('SELECT revision, position_seconds FROM study_sessions WHERE id = $1', [sessionId])).rows[0];

    await new Promise((resolve) => setTimeout(resolve, 20_000 - (h.clock.now().getTime() - offlineAt.getTime())));
    assert.equal(await status(mark), 'Playing', 'still showing what it had before it went offline');
    mark.setOffline(false);
    await expectStatus(mark, 'Paused by Olive', 15_000);
    await mark.page.waitForFunction(() => document.querySelector('.study-connection') === null);
    await mark.page.waitForFunction((seconds) => Math.abs(document.querySelector('audio')!.currentTime - seconds) < 0.1 && document.querySelector('audio')!.paused, shared.position_seconds);

    const fromMark = await h.db.query('SELECT count(*)::int AS n FROM session_commands WHERE session_id = $1 AND user_id = $2 AND received_at >= $3', [sessionId, people.mark.userId, offlineAt]);
    assert.equal(fromMark.rows[0].n, 0, 'nothing Mark did offline reached the server');
    const after = (await h.db.query('SELECT revision, position_seconds FROM study_sessions WHERE id = $1', [sessionId])).rows[0];
    assert.deepEqual(after, shared);
  });

  test('S5.9 with CSB shared the study runs in manual mode, and a member’s verse mark highlights for everyone', async () => {
    const olive = await openStudy('olive');
    const mark = await openStudy('mark');
    await olive.page.getByLabel('Shared translation').selectOption('CSB');
    for (const client of [olive, mark]) {
      await client.page.getByText('Reading together — tap a verse to mark it for everyone.').waitFor();
      assert.equal(await client.page.locator('audio').count(), 0);
      assert.equal(await client.page.getByRole('button', { name: 'Play', exact: true }).count(), 0);
    }
    await mark.page.locator('#v-5').click();
    for (const client of [olive, mark]) await client.page.waitForFunction(() => document.querySelector('.verse.playing')?.id === 'v-5', undefined, { timeout: 3_000 });
    await olive.page.locator('#v-12').click();
    for (const client of [olive, mark]) await client.page.waitForFunction(() => document.querySelector('.verse.playing')?.id === 'v-12', undefined, { timeout: 3_000 });
    if (process.env.E2E_SCREENSHOTS) await mark.page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/study-manual.png` });
    const row = await h.db.query(`SELECT mode, translation_id, manual_verse FROM study_sessions WHERE status = 'active'`);
    assert.deepEqual(row.rows[0], { mode: 'manual', translation_id: 'CSB', manual_verse: 12 });
  });
});

describe('wrapping up', () => {
  beforeEach(async () => {
    await h.db.query('DELETE FROM group_progress');
    await h.db.query(`UPDATE groups SET shared_translation_id = 'BSB'`);
  });

  test('S9.1–S9.4 two members wrap up: the later confirmation is shown the earlier one, a question is carried, and the next study resumes there with it', async () => {
    const asked = await h.app.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/questions`,
      cookies: { bs_session: people.mark.cookie },
      payload: { clientOpId: crypto.randomUUID(), anchor: { translationId: 'BSB', bookId: 'ROM', chapter: 1, startVerse: 3, endVerse: 3 }, body: 'Descended from David how?' },
    });
    assert.equal(asked.statusCode, 200, asked.body);
    const questionId = asked.json().id as string;
    const olive = await openStudy('olive');
    const mark = await openStudy('mark');
    for (const client of [olive, mark]) {
      await client.page.getByRole('button', { name: 'Wrap up', exact: true }).click();
      await client.page.getByRole('button', { name: 'Confirm stopping point' }).waitFor();
      await client.page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.wrap-up button[type="submit"]')!.disabled);
    }

    const item = olive.page.locator(`[data-testid="wrap-question"][data-question="${questionId}"]`);
    await item.getByRole('button', { name: 'Carry forward' }).click();
    await item.locator('button[aria-pressed="true"]', { hasText: 'Carry forward' }).waitFor();
    assert.equal((await h.db.query('SELECT status FROM questions WHERE id = $1', [questionId])).rows[0].status, 'carried');

    await olive.page.getByLabel('Stopping point').fill('Romans 1:11');
    await olive.page.getByRole('button', { name: 'Confirm stopping point' }).click();
    await olive.page.getByRole('status').filter({ hasText: 'Saved: the next study starts at Romans 1:11.' }).waitFor();

    await mark.page.getByLabel('Stopping point').fill('Romans 1:7');
    await mark.page.getByRole('button', { name: 'Confirm stopping point' }).click();
    await mark.page.getByRole('alert').filter({ hasText: 'Olive confirmed Romans 1:11 first. Confirm again to replace it.' }).waitFor();
    await mark.page.getByText('Current stopping point: Romans 1:11, confirmed by Olive.').waitFor();
    await mark.page.getByRole('button', { name: 'Confirm stopping point' }).click();
    await mark.page.getByRole('status').filter({ hasText: 'Saved: the next study starts at Romans 1:7.' }).waitFor();
    if (process.env.E2E_SCREENSHOTS) await mark.page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/study-wrap-up.png`, fullPage: true });

    // Ending the study keeps an open wrap-up; it leaves when its member is done with it.
    await olive.page.getByRole('button', { name: 'End study' }).click();
    await olive.page.getByRole('status').filter({ hasText: 'This study has ended.' }).waitFor();
    assert.ok(await olive.page.getByLabel('Stopping point').isVisible(), 'the wrap-up stays open after the study ends');
    await olive.page.getByRole('button', { name: 'Done' }).click();
    const resume = olive.page.getByRole('button', { name: 'Resume study at Romans 1:7' });
    await resume.waitFor();
    await resume.click();
    await olive.page.getByTestId('study-status').waitFor();
    const verse7 = (await h.db.query(`SELECT (timing->>6)::float AS t FROM recordings WHERE book_id = 'ROM' AND chapter = 1`)).rows[0].t as number;
    await olive.page.waitForFunction((seconds) => Math.abs(document.querySelector('audio')!.currentTime - seconds) < 0.25, verse7, { timeout: 10_000 });
    await olive.page.locator(`[data-testid="question"][data-question="${questionId}"]`).waitFor();
  });

  test('S9.5 with no study running, a member sets where the next one starts', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    contexts.push(context);
    await context.addCookies([{ name: 'bs_session', value: people.ruth.cookie, url: baseUrl }]);
    const page = await context.newPage();
    await page.goto(baseUrl);
    await page.getByRole('button', { name: 'Study', exact: true }).click();
    await page.getByRole('button', { name: 'Start study' }).waitFor();
    await page.getByText('Set the starting point').click();
    await page.getByLabel('Stopping point').fill('Romans 3:1');
    await page.getByRole('button', { name: 'Confirm starting point' }).click();
    await page.getByRole('button', { name: 'Resume study at Romans 3:1' }).waitFor();
    await page.getByText('Change where the next study starts').waitFor();
    const row = await h.db.query('SELECT book_id, chapter, verse, confirmed_by FROM group_progress');
    assert.deepEqual(row.rows, [{ book_id: 'ROM', chapter: 3, verse: 1, confirmed_by: people.ruth.userId }]);
  });
});

describe('your own translation (S12.4)', () => {
  afterEach(async () => {
    await h.db.query('UPDATE users SET display_translation_id = NULL');
  });

  test('S12.4 Mark shows CSB for himself while the group shares BSB; Olive and the group are unchanged', async () => {
    await h.db.query(`UPDATE groups SET shared_translation_id = 'BSB'`);
    // Narration is imported for Romans 1 only; start there rather than where the last test left the group.
    await h.db.query('DELETE FROM group_progress');
    const olive = await openStudy('olive');
    const mark = await openStudy('mark');
    await mark.page.getByLabel('Your display translation').selectOption('CSB');
    await mark.page.getByTestId('display-translation').getByText('Your display translation is CSB. The group reads BSB.').waitFor();

    const users = await h.db.query('SELECT id, display_translation_id FROM users WHERE id = ANY($1) ORDER BY email', [[people.mark.userId, people.olive.userId]]);
    assert.deepEqual(
      Object.fromEntries(users.rows.map((r) => [r.id, r.display_translation_id])),
      { [people.mark.userId]: 'CSB', [people.olive.userId]: null },
    );
    const group = await h.db.query('SELECT shared_translation_id FROM groups');
    assert.deepEqual(group.rows, [{ shared_translation_id: 'BSB' }]);
    assert.equal(await olive.page.getByTestId('display-translation').count(), 0);
    assert.equal(await olive.page.getByLabel('Your display translation').inputValue(), '');

    await mark.page.getByLabel('Your display translation').selectOption('');
    await mark.page.getByTestId('display-translation').waitFor({ state: 'detached' });
  });
});

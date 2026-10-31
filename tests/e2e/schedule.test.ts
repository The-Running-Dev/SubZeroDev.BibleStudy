/// <reference lib="dom" />
// Browser tests for meeting times: shown in the member's profile zone whatever zone the phone is in (S10.5).
// Needs `npm run build` first, and the same Postgres and Mailpit as the integration tests.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { OccurrenceView } from '../../src/shared/api.ts';
import type { Harness } from '../support/harness.ts';
import { clearMailbox, ownerEmail, signIn, startHarness, truncateAll } from '../support/harness.ts';

let h: Harness;
let browser: Browser;
let baseUrl: string;
let contexts: BrowserContext[] = [];
let owner: string;
let member: string;
let groupId: string;

before(async () => {
  assert.ok(existsSync('dist/client/index.html'), 'run `npm run build` before the browser tests');
  h = await startHarness({ STATIC_DIR: 'dist/client' });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await h?.close();
});
beforeEach(async () => {
  await truncateAll(h.db);
  await clearMailbox();
  h.clock.set('2026-11-01T12:00:00Z');
  owner = (await signIn(h, ownerEmail)).cookie;
  groupId = (await h.app.inject({ method: 'GET', url: '/api/groups', cookies: { bs_session: owner } })).json()[0].id;
  const link = (await h.app.inject({ method: 'POST', url: `/api/groups/${groupId}/invitations`, cookies: { bs_session: owner } })).json().link as string;
  member = (await signIn(h, 'member@example.test', new URL(link).pathname.replace('/join/', ''))).cookie;
  await h.app.inject({ method: 'PATCH', url: '/api/me', cookies: { bs_session: owner }, payload: { displayName: 'Olive', timeZone: 'America/Chicago' } });
  await h.app.inject({ method: 'PATCH', url: '/api/me', cookies: { bs_session: member }, payload: { displayName: 'Mark', timeZone: 'Europe/Sofia' } });
});
afterEach(async () => {
  for (const context of contexts) await context.close();
  contexts = [];
});

// The phone's own zone is deliberately neither member's profile zone.
async function openGroup(cookie: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Tokyo' });
  contexts.push(context);
  await context.addCookies([{ name: 'bs_session', value: cookie, url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(baseUrl);
  await page.getByRole('button', { name: 'Bible Study' }).click();
  await page.getByRole('heading', { name: 'Next meetings' }).waitFor();
  return page;
}

async function meetings(cookie: string): Promise<OccurrenceView[]> {
  return (await h.app.inject({ method: 'GET', url: `/api/groups/${groupId}/occurrences`, cookies: { bs_session: cookie } })).json();
}

describe('meeting times', () => {
  test('S10.5 a member in Sofia sees 14:15 on a phone set to Tokyo, with the time it was set in', async () => {
    const page = await openGroup(member);
    const first = page.locator('.meetings li').first();
    await first.getByText('Mon 2 Nov, 14:15 GMT+2').waitFor();
    await first.getByText('(06:15 America/Chicago)').waitFor();
    assert.equal(await page.locator('.meetings li').count(), 8);
    if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/meetings.png` });
  });

  test('a member moves a meeting in their own zone, plans its passage and cancels another', async () => {
    const page = await openGroup(member);
    const second = page.locator('.meetings li').nth(1);
    await second.getByRole('button', { name: 'Move…' }).click();
    await second.getByLabel('Date').fill('2026-11-10');
    await second.getByLabel('Time (GMT+2)').fill('15:30');
    await second.getByRole('button', { name: 'Move meeting' }).click();
    await page.locator('.meetings li').nth(1).getByText('Tue 10 Nov, 15:30 GMT+2').waitFor();
    const moved = (await meetings(owner)).find((m) => m.anchor.localDate === '2026-11-10');
    assert.deepEqual(moved?.anchor, { localDate: '2026-11-10', localTime: '07:30', timeZone: 'America/Chicago' });

    const first = page.locator('.meetings li').first();
    await first.getByRole('button', { name: 'Plan passage…' }).click();
    await first.getByLabel('Passage').fill('Romans 3:1-8');
    await first.getByRole('button', { name: 'Save plan' }).click();
    await first.getByText('· Romans 3:1–8').waitFor();

    const third = page.locator('.meetings li').nth(2);
    await third.getByRole('button', { name: 'Cancel meeting' }).click();
    await third.getByText('· Cancelled').waitFor();
    await third.getByRole('button', { name: 'Restore' }).waitFor();
  });

  test('a move onto the repeated hour of the meeting’s own zone is refused before it is sent', async () => {
    const page = await openGroup(member);
    const second = page.locator('.meetings li').nth(1);
    await second.getByRole('button', { name: 'Move…' }).click();
    // 09:30 in Sofia on 7 November 2027 is the second 01:30 in Chicago.
    await second.getByLabel('Date').fill('2027-11-07');
    await second.getByLabel('Time (GMT+2)').fill('09:30');
    await second.getByRole('button', { name: 'Move meeting' }).click();
    await second.getByRole('alert').getByText('That time happens twice in America/Chicago that night.', { exact: false }).waitFor();
    assert.equal((await meetings(owner))[1].anchor.localDate, '2026-11-09');
  });

  test('S10.4 a change made meanwhile is shown, not overwritten', async () => {
    const page = await openGroup(member);
    const first = page.locator('.meetings li').first();
    await first.getByText('Mon 2 Nov, 14:15 GMT+2').waitFor();
    const seen = (await meetings(owner))[0];
    const moved = await h.app.inject({
      method: 'PATCH',
      url: `/api/groups/${groupId}/occurrences/${seen.id}`,
      cookies: { bs_session: owner },
      payload: { expectedRevision: seen.revision, localTime: '08:00' },
    });
    assert.equal(moved.statusCode, 200, moved.body);

    await first.getByRole('button', { name: 'Cancel meeting' }).click();
    await first.getByRole('alert').getByText('Someone changed this meeting first. Check it, then try again.').waitFor();
    await first.getByText('Mon 2 Nov, 16:00 GMT+2').waitFor();
    assert.equal((await meetings(owner))[0].status, 'scheduled');
  });

  test('S10.3 the owner changes the schedule and the meetings ahead follow', async () => {
    const page = await openGroup(owner);
    const group = page.getByRole('region', { name: 'Group' });
    await group.getByRole('button', { name: 'Change schedule' }).click();
    const form = group.getByRole('form', { name: 'Change schedule' });
    await form.getByLabel('Day').selectOption('Tuesday');
    await form.getByLabel('Time', { exact: true }).fill('19:00');
    await form.getByRole('button', { name: 'Save schedule' }).click();
    await group.getByText('Meets Tuesdays at 19:00 (America/Chicago).').waitFor();
    await page.locator('.meetings li').first().getByText('Tue 3 Nov, 19:00 CST').waitFor();
    assert.equal(await page.locator('.meetings li').count(), 8);
  });
});

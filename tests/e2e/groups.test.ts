/// <reference lib="dom" />
// Browser tests for joining a group: the built client served by the real server, in Chromium at phone size.
// Needs `npm run build` first, and the same Postgres and Mailpit as the integration tests.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import { chromium } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';
import type { Harness } from '../support/harness.ts';
import { clearMailbox, ownerEmail, signIn, startHarness, truncateAll, waitForCode } from '../support/harness.ts';

let h: Harness;
let browser: Browser;
let baseUrl: string;
let context: BrowserContext;

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
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Chicago' });
});

async function ownerLink(): Promise<{ cookie: string; groupId: string; link: string }> {
  const owner = await signIn(h, ownerEmail);
  const groupId = (await h.app.inject({ method: 'GET', url: '/api/groups', cookies: { bs_session: owner.cookie } })).json()[0].id;
  const created = await h.app.inject({ method: 'POST', url: `/api/groups/${groupId}/invitations`, cookies: { bs_session: owner.cookie } });
  const token = new URL(created.json().link).pathname;
  return { cookie: owner.cookie, groupId, link: `${baseUrl}${token}` };
}

// The harness runs the mail worker by hand.
async function deliverCode(email: string): Promise<string> {
  await h.worker.runOnce();
  return waitForCode(email, 1);
}

describe('joining a group', () => {
  test('S4.6 a new member opens the link, requests a code, reloads, types the code and is in the group', async () => {
    const { link } = await ownerLink();
    const email = 'newcomer@example.test';
    const page = await context.newPage();
    await page.goto(link);
    await page.getByText('You have been invited to a Bible study group.').waitFor();
    assert.equal(new URL(page.url()).pathname, '/', 'the token leaves the address bar');

    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Email me a code' }).click();
    await page.getByRole('heading', { name: 'Enter your code' }).waitFor();
    const code = await deliverCode(email);

    // Switching to the mail app often reloads the installed app.
    await page.reload();
    await page.getByRole('heading', { name: 'Enter your code' }).waitFor();
    await page.getByLabel('Code').fill(code);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await page.getByRole('heading', { name: 'Welcome' }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
    await page.getByLabel('Name', { exact: true }).fill('Newcomer');
    await page.getByRole('button', { name: 'Save' }).click();

    await page.getByRole('button', { name: 'Bible Study' }).click();
    const group = page.getByRole('region', { name: 'Group' });
    await group.getByRole('heading', { name: 'Bible Study' }).waitFor();
    await group.getByText('Meets Mondays at 06:15 (America/Chicago).').waitFor();
    const members = await group.locator('.members li').allTextContents();
    assert.equal(members.length, 2);
    assert.ok(members.some((text) => text.startsWith('Newcomer')));
    assert.equal(await group.getByRole('heading', { name: 'Invitations' }).count(), 0, 'members do not manage invitations');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('bs_invitation')), null);
    if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/group-joined.png` });
  });

  test('a used link signs the person in without a group and says the invitation is no longer valid', async () => {
    const { link } = await ownerLink();
    await signIn(h, 'first@example.test', new URL(link).pathname.replace('/join/', ''));
    const email = 'second@example.test';
    const page = await context.newPage();
    await page.goto(link);
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Email me a code' }).click();
    await page.getByRole('heading', { name: 'Enter your code' }).waitFor();
    await page.getByLabel('Code').fill(await deliverCode(email));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Welcome' }).waitFor();
    await page.getByRole('alert').getByText("This invitation is no longer valid — ask the group's owner for a new link.").waitFor();
  });

  test('the owner creates a link, sees it listed, and removes a member in two taps', async () => {
    const { cookie, link } = await ownerLink();
    await signIn(h, 'member@example.test', new URL(link).pathname.replace('/join/', ''));
    await context.addCookies([{ name: 'bs_session', value: cookie, url: baseUrl }]);
    const page = await context.newPage();
    await page.goto(baseUrl);
    await page.getByRole('button', { name: 'Bible Study' }).click();
    const group = page.getByRole('region', { name: 'Group' });
    await group.getByRole('heading', { name: 'Invitations' }).waitFor();
    await group.getByText(/, accepted$/).waitFor();

    await group.getByRole('button', { name: 'Create invitation link' }).click();
    const created = await group.getByLabel('New link').inputValue();
    assert.match(created, /^http:\/\/localhost:3000\/join\/[A-Za-z0-9_-]+$/);
    await group.getByText(/, open, expires /).waitFor();

    assert.equal(await group.locator('.members li').count(), 2);
    await group.getByRole('button', { name: 'Remove…' }).click();
    await group.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await group.locator('.members li').count(), 2);
    await group.getByRole('button', { name: 'Remove…' }).click();
    await group.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.members li').length === 1);
  });
});

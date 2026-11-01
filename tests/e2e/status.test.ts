/// <reference lib="dom" />
// S20: the built client with real authorization, PostgreSQL and connector WebSockets.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import WebSocket from 'ws';
import type { Harness } from '../support/harness.ts';
import { clearMailbox, ownerEmail, signIn, startHarness, truncateAll } from '../support/harness.ts';

const token = 's20-browser-connector-token-0123456789abcdef';
let h: Harness;
let browser: Browser;
let context: BrowserContext;
let baseUrl: string;
let owner: Awaited<ReturnType<typeof signIn>>;
before(async () => {
  assert.ok(existsSync('dist/client/index.html'), 'run npm run build first');
  h = await startHarness({
    STATIC_DIR: 'dist/client',
    ASSISTANT_OWNER_EMAIL: ownerEmail,
    CONNECTOR_TOKEN: token,
  });
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
  owner = await signIn(h, ownerEmail);
  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
});
afterEach(async () => {
  await context?.close();
});

async function open(cookie = owner.cookie): Promise<Page> {
  await context.addCookies([{ name: 'bs_session', value: cookie, url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(baseUrl);
  await page.locator('.account-toggle').click();
  return page;
}
async function openStatus(): Promise<Page> {
  const page = await open();
  await page.getByRole('button', { name: 'Operational status', exact: true }).click();
  await page.getByText('Stored delivery records only;', { exact: false }).waitFor();
  return page;
}
async function email(status: string, attempts: number, error: string | null, recipient: string) {
  const id = randomUUID();
  await h.db.query(
    `INSERT INTO email_jobs (id, kind, idempotency_key, to_address, subject, text_body, html_body, sealed_secrets, status, attempts, next_attempt_at, created_at, last_error)
     VALUES ($1::uuid, 'reminder', $1::text, $2, 'private subject', 'private text 123456', '<p>private html</p>', 'private sealed values', $3, $4, $5, $6, $7)`,
    [id, recipient, status, attempts, new Date('2026-11-01T12:05:00Z'), h.clock.now(), error]
  );
  return id;
}

describe('owner status UI (S20)', () => {
  test('S20.2/3 permanent failures and transient retries display separately with safe actionable details on small screens', async () => {
    const failed = await email(
      'failed',
      1,
      '550 rejected smtp://user:password@internal:587; code 123456',
      'failed@example.test'
    );
    await email('queued', 1, 'ECONNREFUSED private-host', 'retry@example.test');
    await email('sending', 2, '450 temporarily rejected', 'sending@example.test');
    await email('failed', 0, 'reminder suppressed', 'suppressed@example.test');
    const page = await openStatus();
    const panel = page.getByRole('region', { name: 'Operational status', exact: true });
    await panel.getByText('Permanent delivery failures require attention. Retrying: 2.').waitFor();
    const failures = panel.getByRole('region', { name: 'Permanent failures', exact: true });
    await failures.getByText('Permanently failed', { exact: true }).waitFor();
    await failures.getByText('Study reminder to failed@example.test').waitFor();
    await failures.getByText(/Check the recipient and relay policy/).waitFor();
    await failures.getByText(`Job ID: ${failed}`).waitFor();
    const retries = panel.getByRole('region', { name: 'Retrying deliveries', exact: true });
    await retries.getByText('Retry scheduled', { exact: true }).waitFor();
    await retries.getByText('Sending retry', { exact: true }).waitFor();
    await retries.getByText(/Next attempt:.*Automatic retries remain active/).waitFor();
    assert.doesNotMatch(
      await panel.innerText(),
      /password|internal:587|123456|private text|private html|private sealed|private-host|suppressed@example/
    );
    await page.setViewportSize({ width: 320, height: 568 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false
    );
    if (process.env.E2E_SCREENSHOTS) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '';
      });
      await page.screenshot({
        path: `${process.env.E2E_SCREENSHOTS}/owner-status.png`,
        fullPage: true,
      });
    }
  });

  test('S20.2/5 healthy and empty states are explicit, and refresh replaces the stored snapshot', async () => {
    await email('queued', 1, '450 relay busy', 'retry@example.test');
    const page = await openStatus();
    const panel = page.getByRole('region', { name: 'Operational status', exact: true });
    await panel.getByText('No permanent delivery failures. Retrying: 1.').waitFor();
    await h.db.query(
      "UPDATE email_jobs SET status = 'sent', last_error = NULL, sealed_secrets = NULL"
    );
    await panel.getByRole('button', { name: 'Refresh status' }).click();
    await panel.getByText('No permanent delivery failures. Retrying: 0.').waitFor();
    assert.equal(await panel.getByText('None.', { exact: true }).count(), 2);
    assert.equal(await panel.getByText(/Study reminder to/).count(), 0);
    // Unreachable status must not leave the last healthy snapshot on screen.
    await page.route('**/api/owner/status', (route) => route.abort());
    await panel.getByRole('button', { name: 'Refresh status' }).click();
    await panel
      .getByRole('alert')
      .getByText(/Status unavailable/)
      .waitFor();
    assert.equal(await panel.getByText('No permanent delivery failures. Retrying: 0.').count(), 0);
  });

  test('S20.4 connector offline, online and not configured states display honestly', async () => {
    const page = await openStatus();
    const panel = page.getByRole('region', { name: 'Operational status', exact: true });
    await panel.getByText(/Offline — start the connector/).waitFor();
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/connector`, {
      headers: { authorization: `Bearer ${token}` },
    });
    try {
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      ws.send(
        JSON.stringify({
          t: 'hello',
          runtimeVersion: 'private-version',
          provider: 'private-provider',
          sandbox: null,
        })
      );
      for (let i = 0; i < 100; i++) {
        const response = await h.app.inject({
          method: 'GET',
          url: '/api/assistant/status',
          cookies: { bs_session: owner.cookie },
        });
        if (response.json().state === 'online') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await panel.getByRole('button', { name: 'Refresh status' }).click();
      await panel
        .getByText('Online — connector ready. This does not check the model provider.')
        .waitFor();
      assert.doesNotMatch(await panel.innerText(), /private-version|private-provider/);
    } finally {
      await new Promise<void>((resolve) => {
        ws.once('close', resolve);
        ws.close();
      });
    }
    const configured = h.config.connectorToken;
    h.config.connectorToken = null;
    try {
      await panel.getByRole('button', { name: 'Refresh status' }).click();
      await panel.getByText(/Not configured — complete the assistant setup/).waitFor();
    } finally {
      h.config.connectorToken = configured;
    }
  });

  test('S20.1 members have no status control and direct requests are denied; revoked owner refresh clears records', async () => {
    const groupId = (await h.db.query('SELECT id FROM groups')).rows[0].id;
    const link = (
      await h.app.inject({
        method: 'POST',
        url: `/api/groups/${groupId}/invitations`,
        cookies: { bs_session: owner.cookie },
      })
    ).json().link;
    const member = await signIn(
      h,
      'member@example.test',
      new URL(link).pathname.slice('/join/'.length)
    );
    await email('failed', 1, '550 private', 'private-recipient@example.test');
    const memberPage = await open(member.cookie);
    assert.equal(
      await memberPage.getByRole('button', { name: 'Operational status', exact: true }).count(),
      0
    );
    const response = await context.request.get(`${baseUrl}/api/owner/status`);
    assert.equal(response.status(), 403);
    assert.doesNotMatch(await response.text(), /private-recipient|counts/);
    await memberPage.close();
    const page = await openStatus();
    const panel = page.getByRole('region', { name: 'Operational status', exact: true });
    await panel.getByText('Study reminder to private-recipient@example.test').waitFor();
    await h.db.query("UPDATE memberships SET role = 'member', removed_at = $1 WHERE user_id = $2", [
      h.clock.now(),
      owner.userId,
    ]);
    await panel.getByRole('button', { name: 'Refresh status' }).click();
    await panel
      .getByRole('alert')
      .getByText(/Status unavailable/)
      .waitFor();
    assert.doesNotMatch(await panel.innerText(), /private-recipient/);
  });
});

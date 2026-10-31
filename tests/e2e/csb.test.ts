/// <reference lib="dom" />
// Browser test for S13.6: showing CSB text reports its Fair Use token to API.Bible, and a report made while
// fums.api.bible cannot be reached waits until the device is back online. API.Bible is a local fixture with synthetic text.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import type { Harness } from '../support/harness.ts';
import { signIn, startHarness } from '../support/harness.ts';

const bibleId = 'csb-fixture';
let api: Server;
let h: Harness;
let browser: Browser;
let baseUrl: string;
let session: { cookie: string; userId: string };
let page: Page;
let fumsReachable = true;
const reports: URL[] = [];

before(async () => {
  assert.ok(existsSync('dist/client/index.html'), 'run `npm run build` before the browser tests');
  api = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    const match = /^\/v1\/bibles\/csb-fixture\/chapters\/ROM\.(\d+)$/.exec(url.pathname);
    const body = url.pathname === `/v1/bibles/${bibleId}`
      ? { data: { id: bibleId } }
      : match
        ? {
            data: {
              id: `ROM.${match[1]}`,
              verseCount: 1,
              copyright: 'Synthetic copyright notice for tests.',
              content: [{ type: 'tag', name: 'para', attrs: { style: 'p' }, items: [{ type: 'text', text: 'Synthetic fixture verse.', attrs: { verseId: `ROM.${match[1]}.1` } }] }],
            },
            meta: { fumsToken: `token-ROM.${match[1]}` },
          }
        : null;
    response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? { message: 'not found' }));
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  h = await startHarness({
    STATIC_DIR: 'dist/client',
    APIBIBLE_KEY: 'fixture-key',
    APIBIBLE_CSB_BIBLE_ID: bibleId,
    APIBIBLE_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}/v1`,
  });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  session = await signIn(h, 'csb-reader@example.test');
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await h?.db.query(`DELETE FROM chapters WHERE translation_id = 'CSB'`);
  await h?.close();
  api?.close();
});

beforeEach(async () => {
  reports.length = 0;
  fumsReachable = true;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addCookies([{ name: 'bs_session', value: session.cookie, url: baseUrl }]);
  await context.route('https://fums.api.bible/**', async (route) => {
    if (!fumsReachable) return route.abort('internetdisconnected');
    reports.push(new URL(route.request().url()));
    await route.fulfill({ status: 200, body: '' });
  });
  page = await context.newPage();
  await page.goto(baseUrl);
});

async function readCsb(): Promise<void> {
  await page.getByLabel('Translation').selectOption('CSB');
  await page.getByText('Synthetic fixture verse.').waitFor();
}

// Waits for the reports, then a little longer, so a report sent twice is caught too.
async function eventuallyReported(count: number): Promise<void> {
  for (let i = 0; i < 50 && reports.length < count; i++) await page.waitForTimeout(100);
  await page.waitForTimeout(500);
  assert.equal(reports.length, count);
}

const queued = () => page.evaluate(() => JSON.parse(localStorage.getItem('fums-queue') ?? '[]') as { token: string }[]);

describe('Fair Use reporting (S13.6)', () => {
  test('S13.6 showing CSB text sends its token with device, session and hashed user ids', async () => {
    await readCsb();
    await eventuallyReported(1);
    const [report] = reports;
    assert.equal(report.origin + report.pathname, 'https://fums.api.bible/f3');
    assert.deepEqual(report.searchParams.getAll('t'), ['token-ROM.1']);
    assert.equal(report.searchParams.get('uId'), createHash('sha256').update(session.userId).digest('hex'));
    assert.match(report.searchParams.get('dId') ?? '', /^[0-9a-f-]{36}$/);
    assert.match(report.searchParams.get('sId') ?? '', /^[0-9a-f-]{36}$/);
    assert.deepEqual(await queued(), []);
    await page.context().close();
  });

  test('S13.6 a report that cannot be sent waits and goes out once the device is back online', async () => {
    fumsReachable = false;
    await readCsb();
    for (let i = 0; i < 50 && (await queued()).length === 0; i++) await page.waitForTimeout(100);
    assert.deepEqual((await queued()).map((e) => e.token), ['token-ROM.1']);
    assert.equal(reports.length, 0);

    await page.context().setOffline(true);
    fumsReachable = true;
    await page.context().setOffline(false);
    await eventuallyReported(1);
    assert.deepEqual(reports[0].searchParams.getAll('t'), ['token-ROM.1']);
    for (let i = 0; i < 50 && (await queued()).length > 0; i++) await page.waitForTimeout(100);
    assert.deepEqual(await queued(), []);
    await page.context().close();
  });

  test('S13.6 storage that refuses the queue: each report still goes out once, and the stale stored queue is dropped', async () => {
    await page.addInitScript(() => {
      localStorage.setItem('fums-queue', JSON.stringify([{ token: 'token-earlier', userId: 'earlier-user' }]));
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
        if (key === 'fums-queue') throw new DOMException('full', 'QuotaExceededError');
        setItem.call(this, key, value);
      };
    });
    await page.reload();
    await readCsb();
    await eventuallyReported(2);
    assert.deepEqual(reports.map((r) => r.searchParams.getAll('t')).sort(), [['token-ROM.1'], ['token-earlier']]);
    assert.equal(await page.evaluate(() => localStorage.getItem('fums-queue')), null);
    await page.context().close();
  });
});

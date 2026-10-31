/// <reference lib="dom" />
// The assistant panel in Chromium at phone size: the built client, the real server, the real connector code
// over a real /connector link, and a fake AgentConsole runtime. Needs `npm run build` first.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import WebSocket from 'ws';
import { createConnector } from '../../src/connector/connector.ts';
import type { AoBook, AoChapter } from '../../src/server/content/aolab.ts';
import { createAoLabSource } from '../../src/server/content/aolab.ts';
import { runImport } from '../../src/server/content/import.ts';
import type { ServerToConnector } from '../../src/shared/api.ts';
import { FakeRuntime } from '../support/fake-runtime.ts';
import type { Harness } from '../support/harness.ts';
import { ownerEmail, signIn, startHarness } from '../support/harness.ts';

const connectorToken = 'e2e-connector-token-0123456789abcdef0123';
let h: Harness;
let browser: Browser;
let baseUrl: string;
let ownerCookie: string;
let memberCookie: string;
let closeFixture: () => Promise<void>;
let page: Page;
let socket: WebSocket | null = null;
let runtime: FakeRuntime;

// BSB Romans 1 whose verse N reads "Romans 1:N", without narration.
async function startFixture(): Promise<string> {
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    const json = (body: unknown) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const translation = { id: 'BSB', name: 'Berean Standard Bible', sha256: 'translation', numberOfBooks: 1, totalNumberOfChapters: 1 };
    const book: AoBook = { id: 'ROM', name: 'Romans', order: 45, numberOfChapters: 1, sha256: 'book' };
    if (path === '/api/BSB/books.json') return json({ translation, books: [book] });
    if (path === '/api/BSB/ROM/1.json') {
      const body: AoChapter = {
        translation,
        book,
        numberOfVerses: 32,
        thisChapterLink: path,
        chapter: {
          number: 1,
          content: Array.from({ length: 32 }, (_, i) => ({ type: 'verse' as const, number: i + 1, content: [`Romans 1:${i + 1}`] })),
          footnotes: [],
        },
        thisChapterAudioLinks: {},
        thisChapterAudioTimings: {},
      };
      return json(body);
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closeFixture = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function status(): Promise<string> {
  const response = await h.app.inject({ method: 'GET', url: '/api/assistant/status', cookies: { bs_session: ownerCookie } });
  return response.json().state;
}

// The connector as src/connector/main.ts runs it, against a fresh fake runtime.
async function connect(): Promise<void> {
  runtime = new FakeRuntime();
  const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/connector`, { headers: { authorization: `Bearer ${connectorToken}` } });
  const connector = createConnector({
    runtime,
    principal: 'e2e-principal',
    workspace: (conversationId) => `C:/e2e/work/${conversationId}`,
    provider: 'claude',
    send(message) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    },
  });
  let chain: Promise<void> = Promise.resolve();
  ws.on('message', (raw) => {
    chain = chain.then(() => connector.handle(JSON.parse(String(raw)) as ServerToConnector)).catch(() => ws.close());
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ t: 'hello', runtimeVersion: '0.9.0-test', provider: 'claude', sandbox: null }));
  socket = ws;
  for (let i = 0; (await status()) !== 'online'; i++) {
    assert.ok(i < 100, 'the assistant did not come online');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function disconnect(): Promise<void> {
  if (!socket) return;
  const closed = new Promise((resolve) => socket!.once('close', resolve));
  socket.close();
  await closed;
  socket = null;
}

async function open(cookie: string, setup?: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addCookies([{ name: 'bs_session', value: cookie, url: baseUrl }]);
  page = await context.newPage();
  await setup?.(page);
  // The panel decides what to show from the first status call.
  const statusSeen = page.waitForResponse((r) => r.url().endsWith('/api/assistant/status'));
  await page.goto(baseUrl);
  await page.locator('.verse').first().waitFor();
  await statusSeen;
}

const panel = () => page.getByRole('region', { name: 'Study assistant' });
const question = () => page.getByLabel('Question for the study assistant');

async function ask(text: string): Promise<void> {
  await question().fill(text);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
}

before(async () => {
  assert.ok(existsSync('dist/client/index.html'), 'run `npm run build` before the browser tests');
  const fixtureUrl = await startFixture();
  const source = createAoLabSource({ baseUrl: fixtureUrl, sleep: async () => {} });
  h = await startHarness({ STATIC_DIR: 'dist/client', AOLAB_BASE_URL: fixtureUrl, ASSISTANT_OWNER_EMAIL: ownerEmail, CONNECTOR_TOKEN: connectorToken }, { source });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  h.clock.set('2026-11-01T12:00:00Z');
  assert.equal((await runImport({ db: h.db, clock: h.clock, source }, { translationId: 'BSB' })).status, 'succeeded');
  ownerCookie = (await signIn(h, ownerEmail)).cookie;
  memberCookie = (await signIn(h, 'member@example.test')).cookie;
  browser = await chromium.launch();
});
after(async () => {
  await disconnect();
  await browser?.close();
  await h?.close();
  await closeFixture?.();
});

describe('the assistant panel', () => {
  beforeEach(async () => {
    await h.db.query('TRUNCATE assistant_conversations CASCADE');
  });
  afterEach(async () => {
    await page?.context().close();
    await disconnect();
  });

  test('S6.6 offline: the owner sees the assistant is offline, cannot ask, and still reads', async () => {
    await open(ownerCookie);
    await panel().getByText('Study assistant offline (PC not connected)').waitFor();
    await question().fill('Who is the righteous?');
    assert.equal(await page.getByRole('button', { name: 'Ask', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('#v-16').textContent(), '16Romans 1:16');
  });

  test('S6.7 a member who is not the owner has no assistant panel', async () => {
    await connect();
    await open(memberCookie);
    await page.waitForTimeout(200);
    assert.equal(await panel().count(), 0);
  });

  test('S6.1/S6.3 an answer streams in, completes, and shows once after a reload', async () => {
    await connect();
    await open(ownerCookie);
    await page.getByLabel('Reference').fill('Romans 1:16-17');
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await panel().getByRole('heading', { name: 'Ask about Romans 1:16–17' }).waitFor();
    await ask('Who is the righteous?');
    await panel().getByText('The righteous shall live by faith.').waitFor();
    assert.equal(await question().inputValue(), '');
    assert.equal(runtime.sent.length, 1);
    assert.match(runtime.sent[0].text, /Passage: Romans 1:16–17 \(BSB\)\n16 Romans 1:16\n17 Romans 1:17/);

    await page.reload();
    await panel().getByText('Who is the righteous?').waitFor();
    await panel().getByText('The righteous shall live by faith.').waitFor();
    assert.equal(await panel().locator('.assistant-answer').count(), 1);
  });

  test('S6.2 Stop ends a streaming answer', async () => {
    await connect();
    runtime.script = 'hold';
    await open(ownerCookie);
    await ask('Explain the whole chapter.');
    await panel().locator('.assistant-answer[aria-busy="true"]').getByText('The righteous').waitFor();
    await page.getByRole('button', { name: 'Stop' }).click();
    await panel().getByText('Stopped.').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Ask', exact: true }).isVisible(), true);
  });

  test('S6.5 a turn that tries a tool is stopped and says so', async () => {
    await connect();
    runtime.script = 'tool';
    await open(ownerCookie);
    await ask('List the files in your working directory.');
    await panel().getByRole('alert').getByText('The assistant tried to use a tool; this turn was stopped').waitFor();
  });

  test('S6.5 a tool turn that fails before the live channel opens still says so', async () => {
    await connect();
    runtime.script = 'tool';
    // The page's live channel opens only after the turn has failed, so the failure is never pushed to it.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    await open(ownerCookie, (p) =>
      p.routeWebSocket(/\/ws$/, async (ws) => {
        await released;
        ws.connectToServer();
      }),
    );
    await ask('List the files in your working directory.');
    for (let i = 0; i < 250; i++) {
      const failed = await h.db.query(`SELECT 1 FROM assistant_turns WHERE failure = 'tool_attempt'`);
      if (failed.rowCount) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    release();
    await panel().getByRole('alert').getByText('The assistant tried to use a tool; this turn was stopped').waitFor({ timeout: 10_000 });
  });

  test('a link dropped mid-answer shows the answer is being checked', async () => {
    await connect();
    runtime.script = 'hold';
    await open(ownerCookie);
    await ask('Explain the whole chapter.');
    await panel().locator('.assistant-answer[aria-busy="true"]').waitFor();
    await disconnect();
    await panel().getByText('Connection lost — checking whether the answer finished').waitFor();
  });
});

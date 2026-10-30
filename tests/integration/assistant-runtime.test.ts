import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createConnector } from '../../src/connector/connector.ts';
import type { RuntimeClient } from '../../src/connector/runtime-client.ts';
import { startRuntime } from '../../src/connector/runtime-client.ts';
import type { AoBook, AoChapter } from '../../src/server/content/aolab.ts';
import { createAoLabSource } from '../../src/server/content/aolab.ts';
import { runImport } from '../../src/server/content/import.ts';
import type { AssistantEvent, ServerMessage, ServerToConnector } from '../../src/shared/api.ts';
import type { Harness } from '../support/harness.ts';
import { ownerEmail, signIn, startHarness, truncateAll } from '../support/harness.ts';

// S6.1 and S6.5 against the real AgentConsole runtime and model, through the locked Claude launcher.
// Runs only when AGENTCONSOLE_RUNTIME names the runtime entry (and the owner's Claude CLI is signed in);
// each run spends a few model turns.

const runtimeEntry = process.env.AGENTCONSOLE_RUNTIME?.trim();
const provider = process.env.AGENTCONSOLE_PROVIDER?.trim() || 'claude';
const connectorToken = 'runtime-connector-token-0123456789abcdef';
const turnTimeoutMs = 150_000;

describe('the study assistant against the real AgentConsole runtime', { skip: runtimeEntry ? false : 'AGENTCONSOLE_RUNTIME is not set' }, () => {
  let h: Harness;
  let fixtureUrl: string;
  let closeFixture: () => Promise<void>;
  let runtime: RuntimeClient;
  let socket: WebSocket;
  let page: WebSocket;
  let keepAlive: NodeJS.Timeout;
  let stateDir: string;
  let cookie: string;
  let events: AssistantEvent[] = [];

  // A local stand-in for AO Lab: BSB Romans 1 with the real verse 16 and 17 text.
  async function startFixture(): Promise<void> {
    const verses: Record<number, string> = {
      16: 'I am not ashamed of the gospel, because it is the power of God for salvation to everyone who believes, first to the Jew, then to the Greek.',
      17: 'For the gospel reveals the righteousness of God that comes by faith from start to finish, just as it is written: “The righteous will live by faith.”',
    };
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
            content: Array.from({ length: 32 }, (_, i) => ({ type: 'verse' as const, number: i + 1, content: [verses[i + 1] ?? `Romans 1:${i + 1}`] })),
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
    fixtureUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    closeFixture = () => new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async function until(check: () => Promise<boolean> | boolean, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await check()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const api = (method: 'GET' | 'POST', url: string, payload?: object) => h.app.inject({ method, url, cookies: { bs_session: cookie }, ...(payload ? { payload } : {}) });

  async function ask(prompt: string, startVerse: number, endVerse: number): Promise<{ conversationId: string; turnId: string }> {
    const created = await api('POST', '/api/assistant/conversations');
    assert.equal(created.statusCode, 201, created.body);
    const response = await api('POST', `/api/assistant/conversations/${created.json().id}/turns`, {
      clientTurnId: randomUUID(),
      prompt,
      context: { translationId: 'BSB', ref: { bookId: 'ROM', chapter: 1, startVerse, endVerse }, noteIds: [] },
    });
    assert.equal(response.statusCode, 202, response.body);
    return { conversationId: created.json().id, turnId: response.json().turnId };
  }

  const terminal = (turnId: string) => events.find((e) => e.kind === 'turn_status' && e.turnId === turnId && ['completed', 'interrupted', 'failed'].includes(e.status));

  before(async () => {
    await startFixture();
    const source = createAoLabSource({ baseUrl: fixtureUrl, sleep: async () => {} });
    h = await startHarness({ AOLAB_BASE_URL: fixtureUrl, ASSISTANT_OWNER_EMAIL: ownerEmail, CONNECTOR_TOKEN: connectorToken }, { source });
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    const baseWs = `ws://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
    await truncateAll(h.db);
    assert.equal((await runImport({ db: h.db, clock: h.clock, source }, { translationId: 'BSB' })).status, 'succeeded');
    cookie = (await signIn(h, ownerEmail)).cookie;

    // The connector as src/connector/main.ts starts it: its own state, and Claude behind the locked launcher.
    stateDir = mkdtempSync(join(tmpdir(), 'biblestudy-runtime-'));
    for (const dir of ['runtime', 'work']) mkdirSync(join(stateDir, dir));
    const locked = fileURLToPath(new URL('../../src/connector/claude-locked.mjs', import.meta.url));
    runtime = startRuntime({ entry: runtimeEntry!, env: { ...process.env, SKYNET_CLAUDE_EXECUTABLE: locked } });
    const hello = await runtime.call<{ version: string }>('runtime.hello', {
      version: '1.0.0',
      storage: { kind: 'fs', root: join(stateDir, 'runtime') },
      workspaceRoots: [join(stateDir, 'work')],
      hostMethods: [],
      options: { streamDeltas: true },
    });

    socket = new WebSocket(`${baseWs}/connector`, { headers: { authorization: `Bearer ${connectorToken}` } });
    const connector = createConnector({
      runtime,
      principal: `connector-${randomUUID()}`,
      workspace(conversationId) {
        const dir = join(stateDir, 'work', conversationId);
        mkdirSync(dir, { recursive: true });
        return dir;
      },
      provider,
      send(message) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      },
    });
    let chain: Promise<void> = Promise.resolve();
    socket.on('message', (raw) => {
      chain = chain.then(() => connector.handle(JSON.parse(String(raw)) as ServerToConnector)).catch(() => socket.close());
    });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ t: 'hello', runtimeVersion: String(hello.version), provider, sandbox: null }));
    await until(async () => (await api('GET', '/api/assistant/status')).json().state === 'online', 10_000, 'the assistant to come online');

    page = new WebSocket(`${baseWs}/ws`, { headers: { cookie: `bs_session=${cookie}` } });
    page.on('message', (data) => {
      const message = JSON.parse(String(data)) as ServerMessage;
      if (message.t === 'assistant') events.push(message.event);
    });
    await new Promise((resolve) => page.once('open', resolve));
    page.send(JSON.stringify({ t: 'hello', clientId: randomUUID() }));
    // The server drops a page it has not heard from in 15 s; a model turn can take longer.
    keepAlive = setInterval(() => page.send(JSON.stringify({ t: 'ping', clientSentMs: Date.now() })), 5_000);
  });

  after(async () => {
    clearInterval(keepAlive);
    page?.close();
    socket?.close();
    runtime?.stop();
    await h?.close();
    await closeFixture?.();
    // The runtime may still hold its files for a moment after it is stopped.
    if (stateDir) rmSync(stateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  test('S6.1 a turn about Romans 1:16-17 streams deltas into the app and completes', async () => {
    events = [];
    const { turnId } = await ask('In one sentence, what does this passage say about faith?', 16, 17);
    await until(() => Boolean(terminal(turnId)), turnTimeoutMs, 'the turn to end');
    assert.ok(events.some((e) => e.kind === 'delta' && e.turnId === turnId), 'no delta reached the app');
    const ended = terminal(turnId)!;
    assert.equal(ended.kind === 'turn_status' && ended.status, 'completed');
    const message = events.find((e) => e.kind === 'message' && e.turnId === turnId);
    assert.ok(message && message.kind === 'message' && message.text.trim().length > 0, 'no assistant message');
  });

  test('S6.5 a prompt asking for tools executes none: the turn completes without them or fails tool_attempt', async () => {
    events = [];
    // A second conversation, so this also shows each conversation's session gets its own workspace.
    const { conversationId, turnId } = await ask(
      'Use your tools to create a file named proof.txt in your current working directory containing the word hello, then list the files in that directory.',
      16,
      16,
    );
    await until(() => Boolean(terminal(turnId)), turnTimeoutMs, 'the turn to end');
    const ended = terminal(turnId)!;
    const row = (await h.db.query<{ status: string; failure: string | null }>('SELECT status, failure FROM assistant_turns WHERE id = $1', [turnId])).rows[0];
    assert.ok(row.status === 'completed' || (row.status === 'failed' && row.failure === 'tool_attempt'), `turn ended ${row.status} (${row.failure})`);
    assert.equal(ended.kind === 'turn_status' && ended.status, row.status);
    const workspace = join(stateDir, 'work', conversationId);
    assert.equal(existsSync(join(workspace, 'proof.txt')), false);
    assert.deepEqual(readdirSync(workspace), []);
  });
});

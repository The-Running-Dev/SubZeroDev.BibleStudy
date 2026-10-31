import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import WebSocket from 'ws';
import { createConnector } from '../../src/connector/connector.ts';
import type { AoBook, AoChapter } from '../../src/server/content/aolab.ts';
import { createAoLabSource } from '../../src/server/content/aolab.ts';
import { runImport } from '../../src/server/content/import.ts';
import { importAudio } from '../../src/server/content/narration.ts';
import type { AssistantEvent, AssistantTurnStatus, ServerMessage, ServerToConnector } from '../../src/shared/api.ts';
import { FakeRuntime } from '../support/fake-runtime.ts';
import type { Harness } from '../support/harness.ts';
import { clearMailbox, ownerEmail, signIn, startHarness, truncateAll } from '../support/harness.ts';
import { synthMp3 } from '../support/mp3.ts';

// The study assistant end to end, short of the model: browser ⇄ server ⇄ the real connector code ⇄ a fake
// AgentConsole runtime. assistant-runtime.test.ts runs the real runtime when one is configured.

const connectorToken = 'integration-connector-token-0123456789abcdef';
const principal = 'connector-integration-principal';
const cwd = 'C:/connector-integration/work';

let h: Harness;
let fixtureUrl: string;
let closeFixture: () => Promise<void>;
let baseWs: string;

// A local stand-in for AO Lab: BSB Romans 1, with one narrator, whose verse N reads "Romans 1:N".
async function startFixture(): Promise<void> {
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
        thisChapterAudioLinks: { hays: `${fixtureUrl}/audio/hays.mp3` },
        thisChapterAudioTimings: { hays: '/api/BSB/ROM/1.hays.timing.json' },
      };
      return json(body);
    }
    if (path === '/api/BSB/ROM/1.hays.timing.json') return json({ reader: 'hays', verses: Array.from({ length: 32 }, (_, i) => i * 1.8) });
    if (path === '/audio/hays.mp3') {
      const bytes = synthMp3(2300);
      return response.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': bytes.length }).end(bytes);
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fixtureUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeFixture = () => new Promise<void>((resolve) => server.close(() => resolve()));
}

before(async () => {
  await startFixture();
  const source = createAoLabSource({ baseUrl: fixtureUrl, sleep: async () => {} });
  h = await startHarness({ AOLAB_BASE_URL: fixtureUrl, ASSISTANT_OWNER_EMAIL: ownerEmail, CONNECTOR_TOKEN: connectorToken }, { source });
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  baseWs = `ws://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
});
after(async () => {
  await h.close();
  await closeFixture();
});

// Every API body and browser message, for the I-25 check.
let browserSaw: string[] = [];
const links: Linked[] = [];

beforeEach(async () => {
  for (const linked of links.splice(0)) linked.socket.terminate();
  // Lets the server see those links go before the next test signs in.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await truncateAll(h.db);
  await clearMailbox();
  browserSaw = [];
  h.clock.set('2026-11-01T12:00:00Z');
  const source = createAoLabSource({ baseUrl: fixtureUrl, sleep: async () => {} });
  assert.equal((await runImport({ db: h.db, clock: h.clock, source }, { translationId: 'BSB' })).status, 'succeeded');
  assert.equal((await importAudio({ db: h.db, clock: h.clock, source, mediaDir: h.config.mediaDir }, { translationId: 'BSB', bookId: 'ROM', chapters: [1], narrators: ['hays'] })).status, 'succeeded');
});

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function api(method: 'GET' | 'POST', cookie: string, url: string, payload?: object) {
  const response = await h.app.inject({ method, url, cookies: { bs_session: cookie }, ...(payload ? { payload } : {}) });
  browserSaw.push(response.body);
  return response;
}

interface Browser {
  events: AssistantEvent[];
  next(predicate: (event: AssistantEvent) => boolean, timeoutMs?: number): Promise<AssistantEvent>;
  close(): void;
}

async function browser(cookie: string): Promise<Browser> {
  const socket = new WebSocket(`${baseWs}/ws`, { headers: { cookie: `bs_session=${cookie}` } });
  const events: AssistantEvent[] = [];
  let seen = 0;
  socket.on('message', (data) => {
    browserSaw.push(String(data));
    const message = JSON.parse(String(data)) as ServerMessage;
    if (message.t === 'assistant') events.push(message.event);
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({ t: 'hello', clientId: randomUUID() }));
  return {
    events,
    async next(predicate, timeoutMs = 5000) {
      let found: AssistantEvent | undefined;
      await until(
        () => {
          const index = events.findIndex((e, i) => i >= seen && predicate(e));
          if (index < 0) return false;
          seen = index + 1;
          found = events[index];
          return true;
        },
        timeoutMs,
        'an assistant event',
      );
      return found!;
    },
    close: () => socket.close(),
  };
}

interface Linked {
  socket: WebSocket;
  received: ServerToConnector[];
  closed: Promise<number>;
}

// The connector as src/connector/main.ts runs it, over a real /connector link, against `runtime`.
async function link(runtime: FakeRuntime, ownerCookie: string): Promise<Linked> {
  const socket = new WebSocket(`${baseWs}/connector`, { headers: { authorization: `Bearer ${connectorToken}` } });
  const received: ServerToConnector[] = [];
  const connector = createConnector({
    runtime,
    principal,
    workspace: (conversationId) => `${cwd}/${conversationId}`,
    provider: 'claude',
    send(message) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    },
  });
  let chain: Promise<void> = Promise.resolve();
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw)) as ServerToConnector;
    received.push(message);
    chain = chain.then(() => connector.handle(message)).catch(() => socket.close());
  });
  const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('unexpected-response', (_request, response) => reject(new Error(`refused: ${response.statusCode}`)));
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({ t: 'hello', runtimeVersion: '0.9.0-test', provider: 'claude', sandbox: null }));
  await until(async () => (await api('GET', ownerCookie, '/api/assistant/status')).json().state === 'online', 5000, 'the assistant to come online');
  const linked = { socket, received, closed };
  links.push(linked);
  return linked;
}

// A link refused at the upgrade resolves to its HTTP status.
function refusedStatus(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseWs}/connector`, { headers });
    socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
    socket.once('open', () => {
      socket.close();
      reject(new Error('the link was accepted'));
    });
    socket.once('error', reject);
  });
}

const romans = (startVerse: number, endVerse: number) => ({ translationId: 'BSB', ref: { bookId: 'ROM', chapter: 1, startVerse, endVerse }, noteIds: [] });

async function conversation(cookie: string): Promise<string> {
  const response = await api('POST', cookie, '/api/assistant/conversations');
  assert.equal(response.statusCode, 201, response.body);
  return response.json().id;
}

async function ask(cookie: string, conversationId: string, prompt = 'What does this passage say about faith?', clientTurnId: string = randomUUID()) {
  return api('POST', cookie, `/api/assistant/conversations/${conversationId}/turns`, { clientTurnId, prompt, context: romans(16, 17) });
}

async function turnRow(turnId: string) {
  const result = await h.db.query<{
    status: AssistantTurnStatus;
    failure: string | null;
    runtime_turn_id: string | null;
    context: { reference: string; translationId: string; verses: { number: number; text: string }[]; notes: { id: string; reference: string; body: string }[] };
  }>(
    'SELECT status, failure, runtime_turn_id, context FROM assistant_turns WHERE id = $1',
    [turnId],
  );
  return result.rows[0];
}

async function owner() {
  return signIn(h, ownerEmail);
}

describe('the connector link', () => {
  test('a link without the connector token is refused (401)', async () => {
    assert.equal(await refusedStatus({}), 401);
    assert.equal(await refusedStatus({ authorization: 'Bearer not-the-connector-token-0123456789abcdef' }), 401);
    assert.equal(await refusedStatus({ authorization: connectorToken }), 401);
  });

  test('a second connector replaces the first, which is closed with 4409', async () => {
    const { cookie } = await owner();
    const first = await link(new FakeRuntime(), cookie);
    await link(new FakeRuntime(), cookie);
    assert.equal(await first.closed, 4409);
    assert.equal((await api('GET', cookie, '/api/assistant/status')).json().state, 'online');
  });
});

describe('asking (S6.1 with a fake runtime, S6.4)', () => {
  test('a turn about Romans 1:16-17 streams into the app and completes; the runtime received the exact verses', async () => {
    const { cookie } = await owner();
    const runtime = new FakeRuntime();
    await link(runtime, cookie);
    const page = await browser(cookie);
    const id = await conversation(cookie);

    const response = await ask(cookie, id);
    assert.equal(response.statusCode, 202, response.body);
    const { turnId, status, existing } = response.json();
    assert.equal(status, 'dispatched');
    assert.equal(existing, false);

    assert.equal((await page.next((e) => e.kind === 'delta')).turnId, turnId);
    const message = await page.next((e) => e.kind === 'message');
    assert.equal(message.kind === 'message' && message.text, 'The righteous shall live by faith.');
    await page.next((e) => e.kind === 'turn_status' && e.status === 'completed');

    assert.equal(runtime.sent.length, 1);
    const sent = runtime.sent[0].text;
    assert.match(sent, /Passage: Romans 1:16–17 \(BSB\)/);
    assert.match(sent, /\n16 Romans 1:16\n17 Romans 1:17\n/);
    assert.match(sent, /Question: What does this passage say about faith\?/);
    const row = await turnRow(turnId);
    assert.equal(row.status, 'completed');
    assert.equal(row.context.reference, 'Romans 1:16–17');
    assert.equal(row.context.translationId, 'BSB');
    assert.deepEqual(row.context.verses, [
      { number: 16, text: 'Romans 1:16' },
      { number: 17, text: 'Romans 1:17' },
    ]);
    page.close();
  });

  test('a conversation keeps its runtime session across turns', async () => {
    const { cookie } = await owner();
    const runtime = new FakeRuntime();
    await link(runtime, cookie);
    const id = await conversation(cookie);
    for (const prompt of ['First question?', 'Second question?']) {
      const { turnId } = (await ask(cookie, id, prompt)).json();
      await until(async () => (await turnRow(turnId)).status === 'completed', 5000, 'the turn to complete');
    }
    assert.equal(runtime.sessions.size, 1);
    assert.deepEqual(
      runtime.sent.map((s) => s.sessionId),
      [...runtime.sessions.keys(), ...runtime.sessions.keys()],
    );
  });

  test('S6.4 the same clientTurnId twice returns existing: true and dispatches one runtime turn', async () => {
    const { cookie } = await owner();
    const runtime = new FakeRuntime();
    runtime.script = 'hold';
    await link(runtime, cookie);
    const id = await conversation(cookie);
    const clientTurnId = randomUUID();

    const [a, b] = await Promise.all([ask(cookie, id, 'Why?', clientTurnId), ask(cookie, id, 'Why?', clientTurnId)]);
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 202]);
    assert.equal(a.json().turnId, b.json().turnId);
    assert.deepEqual([a.json().existing, b.json().existing].sort(), [false, true]);
    const again = await ask(cookie, id, 'Why?', clientTurnId);
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().existing, true);

    await until(() => runtime.sent.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(runtime.sent.length, 1);
    const count = await h.db.query('SELECT count(*)::int AS n FROM assistant_turns');
    assert.equal(count.rows[0].n, 1);
  });

  test('a second question while one is unfinished is refused with turn_in_progress', async () => {
    const { cookie } = await owner();
    const runtime = new FakeRuntime();
    runtime.script = 'hold';
    await link(runtime, cookie);
    const id = await conversation(cookie);
    assert.equal((await ask(cookie, id)).statusCode, 202);
    const second = await ask(cookie, id, 'And another?');
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().error, 'turn_in_progress');
  });

  test('a prompt that is empty, too long or holds NUL, or names a note that is not the asker\'s, is refused', async () => {
    const { cookie } = await owner();
    await link(new FakeRuntime(), cookie);
    const id = await conversation(cookie);
    const turns = `/api/assistant/conversations/${id}/turns`;
    for (const payload of [
      { clientTurnId: randomUUID(), prompt: '   ', context: romans(16, 17) },
      { clientTurnId: randomUUID(), prompt: 'x'.repeat(4001), context: romans(16, 17) },
      { clientTurnId: randomUUID(), prompt: 'Why\u0000?', context: romans(16, 17) },
      { clientTurnId: randomUUID(), prompt: 'Why?', context: { ...romans(16, 17), noteIds: [randomUUID()] } },
      { clientTurnId: 'not-a-uuid', prompt: 'Why?', context: romans(16, 17) },
      { clientTurnId: randomUUID(), prompt: 'Why?', context: romans(16, 40) },
    ]) {
      const response = await api('POST', cookie, turns, payload);
      assert.equal(response.statusCode, 400, JSON.stringify(payload).slice(0, 80));
      assert.equal(response.json().error, 'invalid_request');
    }
  });

  test('S12.5 two of the asker\'s notes go with the question: stored in the turn context and sent to the runtime', async () => {
    const { cookie } = await owner();
    const runtime = new FakeRuntime();
    await link(runtime, cookie);
    const id = await conversation(cookie);
    const anchor = (verse: number) => ({ translationId: 'BSB', bookId: 'ROM', chapter: 1, startVerse: verse, endVerse: verse });
    const [first, second, gone] = [randomUUID(), randomUUID(), randomUUID()];
    const note = (entityId: string, verse: number, body: string) => ({ opId: randomUUID(), entity: 'note', entityId, op: 'upsert', baseRevision: null, anchor: anchor(verse), body, deviceId: 'd' });
    const pushed = await api('POST', cookie, '/api/sync/push', {
      ops: [
        note(first, 16, 'Not ashamed.'),
        note(second, 17, 'Faith to faith.'),
        note(gone, 18, 'Removed.'),
        { opId: randomUUID(), entity: 'note', entityId: gone, op: 'delete', baseRevision: 1, deviceId: 'd' },
      ],
    });
    assert.equal(pushed.statusCode, 200, pushed.body);

    const response = await api('POST', cookie, `/api/assistant/conversations/${id}/turns`, {
      clientTurnId: randomUUID(),
      prompt: 'How do my notes fit the passage?',
      // An uppercase id names the same note.
      context: { ...romans(16, 17), noteIds: [second.toUpperCase(), first] },
    });
    assert.equal(response.statusCode, 202, response.body);
    const { turnId } = response.json();
    await until(async () => (await turnRow(turnId)).status === 'completed', 5000, 'the turn to complete');
    assert.deepEqual((await turnRow(turnId)).context.notes, [
      { id: second, reference: 'Romans 1:17', body: 'Faith to faith.' },
      { id: first, reference: 'Romans 1:16', body: 'Not ashamed.' },
    ]);
    assert.match(runtime.sent[0].text, /The reader's own notes:\n- Romans 1:17: Faith to faith\.\n- Romans 1:16: Not ashamed\.\n/);

    // A deleted note, an unknown one, and another member's note each refuse the whole turn.
    const groupId = (await api('GET', cookie, '/api/groups')).json()[0].id;
    const invite = (await api('POST', cookie, `/api/groups/${groupId}/invitations`)).json().link as string;
    const member = await signIn(h, 'member@example.test', new URL(invite).pathname.replace('/join/', ''));
    const theirs = randomUUID();
    assert.equal((await api('POST', member.cookie, '/api/sync/push', { ops: [note(theirs, 16, 'Mine alone.')] })).statusCode, 200);
    for (const noteIds of [[gone], [randomUUID()], [first, theirs], [first, first], [first, first.toUpperCase()]]) {
      const refused = await api('POST', cookie, `/api/assistant/conversations/${id}/turns`, { clientTurnId: randomUUID(), prompt: 'Why?', context: { ...romans(16, 17), noteIds } });
      assert.equal(refused.statusCode, 400, JSON.stringify(noteIds));
      assert.equal(refused.json().error, 'invalid_request');
    }
    assert.equal(runtime.sent.length, 1);
  });
});

describe('stopping (S6.2, S6.5 with a fake runtime)', () => {
  test('S6.2 interrupting a streaming turn ends it interrupted within 5 s', async () => {
    const { cookie } = await owner();
    const runtime = new FakeRuntime();
    runtime.script = 'hold';
    await link(runtime, cookie);
    const page = await browser(cookie);
    const id = await conversation(cookie);
    const { turnId } = (await ask(cookie, id)).json();
    await page.next((e) => e.kind === 'turn_status' && e.status === 'streaming');
    await page.next((e) => e.kind === 'delta');

    const started = Date.now();
    const response = await api('POST', cookie, `/api/assistant/turns/${turnId}/interrupt`);
    assert.equal(response.statusCode, 200, response.body);
    await page.next((e) => e.kind === 'turn_status' && e.status === 'interrupted', 5000);
    assert.ok(Date.now() - started < 5000);
    assert.equal((await turnRow(turnId)).status, 'interrupted');
    assert.equal(runtime.interrupts.length, 1);

    // A finished turn stays finished; the next question goes through.
    assert.equal((await api('POST', cookie, `/api/assistant/turns/${turnId}/interrupt`)).json().status, 'interrupted');
    runtime.script = 'complete';
    assert.equal((await ask(cookie, id, 'Next?')).statusCode, 202);
    page.close();
  });

  test('S6.5 a permission request is denied, the turn interrupted and failed tool_attempt', async () => {
    const { cookie } = await owner();
    const runtime = new FakeRuntime();
    runtime.script = 'tool';
    await link(runtime, cookie);
    const page = await browser(cookie);
    const id = await conversation(cookie);
    const { turnId } = (await ask(cookie, id, 'List the files in your working directory.')).json();

    const failed = await page.next((e) => e.kind === 'turn_status' && e.status === 'failed');
    assert.equal(failed.kind === 'turn_status' && failed.failure, 'tool_attempt');
    assert.deepEqual(
      runtime.decisions.map((d) => d.decision),
      ['deny'],
    );
    // The connector interrupts at once; the server's own interrupt on tool_attempt may follow, for the same turn.
    await until(() => runtime.interrupts.length >= 1, 5000, 'the runtime turn to be interrupted');
    assert.deepEqual(new Set(runtime.interrupts), new Set([runtime.sent[0].turnId]));
    // The runtime's own interrupted ending does not move a failed turn.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const row = await turnRow(turnId);
    assert.equal(row.status, 'failed');
    assert.equal(row.failure, 'tool_attempt');
    page.close();
  });
});

describe('reloading and reconnecting (S6.3)', () => {
  test('the transcript reads the same on every reload, one entry per runtime seq', async () => {
    const { cookie } = await owner();
    await link(new FakeRuntime(), cookie);
    const id = await conversation(cookie);
    const { turnId } = (await ask(cookie, id)).json();
    await until(async () => (await turnRow(turnId)).status === 'completed', 5000, 'the turn to complete');

    const first = (await api('GET', cookie, `/api/assistant/conversations/${id}`)).json();
    const second = (await api('GET', cookie, `/api/assistant/conversations/${id}`)).json();
    assert.deepEqual(first, second);
    assert.deepEqual(first.turns, [{ id: turnId, prompt: 'What does this passage say about faith?', status: 'completed' }]);
    assert.equal(first.entries.filter((e: AssistantEvent) => e.kind === 'message').length, 1);
    assert.deepEqual(
      first.entries.map((e: AssistantEvent) => e.kind === 'turn_status' && e.status).filter(Boolean),
      ['streaming', 'completed'],
    );
    // afterSeq returns only what came later.
    const seqs = first.entries.filter((e: AssistantEvent) => e.kind === 'message').map((e: { seq: number }) => e.seq);
    const later = (await api('GET', cookie, `/api/assistant/conversations/${id}?afterSeq=${seqs[0]}`)).json();
    assert.equal(later.entries.filter((e: AssistantEvent) => e.kind === 'message').length, 0);
    assert.equal((await api('GET', cookie, `/api/assistant/conversations/${id}?afterSeq=-1`)).statusCode, 400);
  });

  test('an event resent with a seq already stored adds nothing and reaches no browser', async () => {
    const { cookie } = await owner();
    const runtime = new FakeRuntime();
    await link(runtime, cookie);
    const page = await browser(cookie);
    const id = await conversation(cookie);
    const { turnId } = (await ask(cookie, id)).json();
    await page.next((e) => e.kind === 'message');
    await page.next((e) => e.kind === 'turn_status' && e.status === 'completed');
    const [[sessionId, session]] = [...runtime.sessions];
    const seq = session.events.find((e) => e.kind === 'message' && e.data.role === 'assistant')!.seq!;

    // A connector of its own, replaying the stored event with other text.
    const raw = new WebSocket(`${baseWs}/connector`, { headers: { authorization: `Bearer ${connectorToken}` } });
    await new Promise((resolve) => raw.once('open', resolve));
    raw.send(JSON.stringify({ t: 'hello', runtimeVersion: '0.9.0-test', provider: 'claude', sandbox: null }));
    raw.send(JSON.stringify({ t: 'event', conversationId: id, runtimeSessionId: sessionId, seq, turnId, kind: 'message', text: 'A different answer.' }));
    raw.send(JSON.stringify({ t: 'event', conversationId: id, runtimeSessionId: sessionId, seq: seq + 1, turnId, kind: 'status', status: 'streaming' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    raw.terminate();

    const transcript = (await api('GET', cookie, `/api/assistant/conversations/${id}`)).json();
    const messages = transcript.entries.filter((e: AssistantEvent) => e.kind === 'message');
    assert.deepEqual(
      messages.map((e: { text: string }) => e.text),
      ['The righteous shall live by faith.'],
    );
    assert.equal(page.events.filter((e) => e.kind === 'message').length, 1);
    assert.equal((await turnRow(turnId)).status, 'completed', 'a finished turn never moves');
    page.close();
  });

  test('killing the connector mid-turn, and the turn finishing meanwhile, yields one terminal state and no duplicates', async () => {
    const { cookie } = await owner();
    const runtime = new FakeRuntime();
    runtime.script = 'hold';
    const first = await link(runtime, cookie);
    const page = await browser(cookie);
    const id = await conversation(cookie);
    const { turnId } = (await ask(cookie, id)).json();
    await page.next((e) => e.kind === 'turn_status' && e.status === 'streaming');

    first.socket.terminate();
    await page.next((e) => e.kind === 'turn_status' && e.status === 'uncertain');
    assert.equal((await api('GET', cookie, '/api/assistant/status')).json().state, 'offline');

    // The runtime outlives the connector and finishes the turn while nobody is listening.
    runtime.restart();
    const [sessionId] = runtime.sessions.keys();
    runtime.finish(sessionId, runtime.sent[0].turnId);

    const second = await link(runtime, cookie);
    await page.next((e) => e.kind === 'turn_status' && e.status === 'completed');
    assert.equal(second.received.filter((m) => m.t === 'resume').length, 1);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // A third connector has nothing left to resume.
    second.socket.terminate();
    const third = await link(runtime, cookie);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(third.received.filter((m) => m.t === 'resume').length, 0);

    const transcript = (await api('GET', cookie, `/api/assistant/conversations/${id}`)).json();
    assert.equal(transcript.turns[0].status, 'completed');
    assert.deepEqual(
      transcript.entries.filter((e: AssistantEvent) => e.kind === 'message').map((e: { text: string }) => e.text),
      ['The righteous shall live by faith.'],
    );
    assert.equal(page.events.filter((e) => e.kind === 'turn_status' && e.status === 'completed').length, 1);
    assert.equal(page.events.filter((e) => e.kind === 'message').length, 1);
    const seqs = await h.db.query<{ n: number; distinct: number }>('SELECT count(*)::int AS n, count(DISTINCT runtime_seq)::int AS distinct FROM transcript_entries');
    assert.equal(seqs.rows[0].n, seqs.rows[0].distinct);
    assert.equal((await turnRow(turnId)).status, 'completed');
    page.close();
  });

  test('a turn still open when the connector comes back keeps streaming and completes', async () => {
    const { cookie } = await owner();
    const runtime = new FakeRuntime();
    runtime.script = 'hold';
    const first = await link(runtime, cookie);
    const page = await browser(cookie);
    const id = await conversation(cookie);
    const { turnId } = (await ask(cookie, id)).json();
    await page.next((e) => e.kind === 'turn_status' && e.status === 'streaming');

    first.socket.terminate();
    await page.next((e) => e.kind === 'turn_status' && e.status === 'uncertain');
    runtime.restart();
    await link(runtime, cookie);
    await page.next((e) => e.kind === 'turn_status' && e.status === 'streaming');

    const [sessionId] = runtime.sessions.keys();
    runtime.finish(sessionId, runtime.sent[0].turnId);
    await page.next((e) => e.kind === 'turn_status' && e.status === 'completed');
    assert.equal((await turnRow(turnId)).status, 'completed');
  });

  test('a turn the runtime never logged is failed when its session is gone', async () => {
    const { cookie } = await owner();
    const runtime = new FakeRuntime();
    runtime.script = 'hold';
    const first = await link(runtime, cookie);
    const page = await browser(cookie);
    const id = await conversation(cookie);
    const { turnId } = (await ask(cookie, id)).json();
    await page.next((e) => e.kind === 'turn_status' && e.status === 'streaming');
    first.socket.terminate();
    await page.next((e) => e.kind === 'turn_status' && e.status === 'uncertain');

    // A runtime that lost its storage.
    await link(new FakeRuntime(), cookie);
    const failed = await page.next((e) => e.kind === 'turn_status' && e.status === 'failed');
    assert.equal(failed.kind === 'turn_status' && failed.failure, 'lost');
    assert.equal((await turnRow(turnId)).status, 'failed');
    // The next question opens a new runtime session.
    const next = await ask(cookie, id, 'Again?');
    assert.equal(next.statusCode, 202);
    // The new session's ids and seqs restart at 1, as the lost session's did; nothing of it lands on the old turn.
    await page.next((e) => e.kind === 'turn_status' && e.turnId === next.json().turnId && e.status === 'completed');
    assert.equal((await turnRow(turnId)).status, 'failed');
    const transcript = (await api('GET', cookie, `/api/assistant/conversations/${id}`)).json();
    assert.deepEqual(
      transcript.entries.filter((e: AssistantEvent) => e.kind === 'message').map((e: { turnId: string }) => e.turnId),
      [next.json().turnId],
    );
  });
});

describe('without the connector (S6.6) and for other members (S6.7)', () => {
  test('S6.6 offline: status says so, a send returns assistant_offline, reading and narration still work', async () => {
    const { cookie } = await owner();
    const status = (await api('GET', cookie, '/api/assistant/status')).json();
    assert.equal(status.state, 'offline');
    const id = await conversation(cookie);
    const response = await ask(cookie, id);
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, 'assistant_offline');
    assert.equal(response.json().retryable, true);
    assert.equal((await h.db.query('SELECT count(*)::int AS n FROM assistant_turns')).rows[0].n, 0);

    const chapter = await api('GET', cookie, '/api/content/BSB/ROM/1');
    assert.equal(chapter.statusCode, 200);
    assert.equal(chapter.json().verses[15].text, 'Romans 1:16');
    const recordings = await api('GET', cookie, '/api/content/BSB/ROM/1/recordings');
    // 202 only because the fixture has no recording for the other enabled narrators; hays is playable.
    assert.ok([200, 202].includes(recordings.statusCode));
    const hays = recordings.json().recordings.find((r: { narratorId: string }) => r.narratorId === 'hays');
    const media = await h.app.inject({ method: 'GET', url: hays.mediaUrl, cookies: { bs_session: cookie }, headers: { range: 'bytes=0-99' } });
    assert.equal(media.statusCode, 206);
  });

  test('S6.7 a member who is not ASSISTANT_OWNER_EMAIL gets assistant_not_permitted', async () => {
    const { cookie: ownerCookie } = await owner();
    const groupId = (await api('GET', ownerCookie, '/api/groups')).json()[0].id;
    const invite = (await api('POST', ownerCookie, `/api/groups/${groupId}/invitations`)).json().link as string;
    const member = await signIn(h, 'member@example.test', new URL(invite).pathname.replace('/join/', ''));
    await link(new FakeRuntime(), ownerCookie);
    const ownerConversation = await conversation(ownerCookie);

    assert.deepEqual((await api('GET', member.cookie, '/api/assistant/status')).json(), { state: 'not_permitted' });
    for (const [method, url] of [
      ['GET', '/api/assistant/conversations'],
      ['POST', '/api/assistant/conversations'],
      ['GET', `/api/assistant/conversations/${ownerConversation}`],
      ['POST', `/api/assistant/turns/${randomUUID()}/interrupt`],
    ] as const) {
      const response = await api(method, member.cookie, url);
      assert.equal(response.statusCode, 403, url);
      assert.equal(response.json().error, 'assistant_not_permitted');
    }
    const send = await ask(member.cookie, ownerConversation);
    assert.equal(send.statusCode, 403);
    assert.equal(send.json().error, 'assistant_not_permitted');
    assert.equal((await api('GET', member.cookie, '/api/content/BSB/ROM/1')).statusCode, 200);
  });

  test('signed out, every assistant route answers 401', async () => {
    for (const url of ['/api/assistant/status', '/api/assistant/conversations']) {
      assert.equal((await h.app.inject({ method: 'GET', url })).statusCode, 401);
    }
  });
});

describe('what reaches the browser (S6.8)', () => {
  test('no API response or browser message carries the token, a runtime id, the principal or the cwd', async () => {
    const { cookie } = await owner();
    const runtime = new FakeRuntime();
    const first = await link(runtime, cookie);
    const page = await browser(cookie);
    const id = await conversation(cookie);

    // Completed, interrupted, tool_attempt, then a turn across a reconnect.
    const done = (await ask(cookie, id, 'One?')).json().turnId;
    await page.next((e) => e.kind === 'turn_status' && e.turnId === done && e.status === 'completed');
    runtime.script = 'hold';
    const held = (await ask(cookie, id, 'Two?')).json().turnId;
    await page.next((e) => e.kind === 'turn_status' && e.turnId === held && e.status === 'streaming');
    await api('POST', cookie, `/api/assistant/turns/${held}/interrupt`);
    await page.next((e) => e.kind === 'turn_status' && e.turnId === held && e.status === 'interrupted');
    runtime.script = 'tool';
    const tool = (await ask(cookie, id, 'Three?')).json().turnId;
    await page.next((e) => e.kind === 'turn_status' && e.turnId === tool && e.status === 'failed');
    runtime.script = 'hold';
    const resumed = (await ask(cookie, id, 'Four?')).json().turnId;
    await page.next((e) => e.kind === 'turn_status' && e.turnId === resumed && e.status === 'streaming');
    first.socket.terminate();
    await page.next((e) => e.kind === 'turn_status' && e.turnId === resumed && e.status === 'uncertain');
    runtime.restart();
    await link(runtime, cookie);
    const [sessionId] = runtime.sessions.keys();
    runtime.finish(sessionId, runtime.sent.at(-1)!.turnId);
    await page.next((e) => e.kind === 'turn_status' && e.turnId === resumed && e.status === 'completed');
    await api('GET', cookie, `/api/assistant/conversations/${id}`);
    await api('GET', cookie, '/api/assistant/conversations');
    await api('GET', cookie, '/api/assistant/status');
    page.close();

    const secrets = [connectorToken, principal, cwd, ...runtime.sessions.keys(), ...runtime.sent.map((s) => s.turnId), 'rt-session', 'rt-turn', 'sub-'];
    assert.ok(browserSaw.length > 20, `${browserSaw.length} payloads checked`);
    for (const payload of browserSaw) {
      for (const secret of secrets) assert.ok(!payload.includes(secret), `a browser payload carries ${secret}: ${payload.slice(0, 200)}`);
    }
  });
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import WebSocket from 'ws';
import type { AoBook, AoChapter } from '../../src/server/content/aolab.ts';
import { createAoLabSource } from '../../src/server/content/aolab.ts';
import { runImport } from '../../src/server/content/import.ts';
import { importAudio } from '../../src/server/content/narration.ts';
import type { Command, PlaybackState, ServerMessage } from '../../src/shared/api.ts';
import type { Harness } from '../support/harness.ts';
import { clearMailbox, databaseUrl, ownerEmail, signIn, smtpUrl, startHarness, truncateAll } from '../support/harness.ts';
import { frameSeconds, synthMp3 } from '../support/mp3.ts';

// The room-empty grace is 20 s in production; short here so S5.7 runs in a moment.
const graceMs = 300;
const frames = 2300; // about 60 s
const verseSeconds = 1.8;

let h: Harness;
let fixtureUrl: string;
let closeFixture: () => Promise<void>;
let wsUrl: string;

// A local stand-in for AO Lab: BSB Romans 1 with two narrators of synthetic audio.
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
        thisChapterAudioLinks: { hays: `${fixtureUrl}/audio/hays.mp3`, souer: `${fixtureUrl}/audio/souer.mp3` },
        thisChapterAudioTimings: { hays: '/api/BSB/ROM/1.hays.timing.json', souer: '/api/BSB/ROM/1.souer.timing.json' },
      };
      return json(body);
    }
    const timing = /^\/api\/BSB\/ROM\/1\.(hays|souer)\.timing\.json$/.exec(path);
    if (timing) return json({ reader: timing[1], verses: Array.from({ length: 32 }, (_, i) => i * verseSeconds) });
    const audio = /^\/audio\/(hays|souer)\.mp3$/.exec(path);
    if (audio) {
      const bytes = synthMp3(frames + (audio[1] === 'souer' ? 40 : 0));
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
  h = await startHarness({ AOLAB_BASE_URL: fixtureUrl }, { source, emptyRoomGraceMs: graceMs });
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  wsUrl = `ws://127.0.0.1:${(h.app.server.address() as AddressInfo).port}/ws`;
});
after(async () => {
  await h.close();
  await closeFixture();
});

beforeEach(async () => {
  await truncateAll(h.db);
  await clearMailbox();
  h.clock.set('2026-11-01T12:00:00Z');
  const source = createAoLabSource({ baseUrl: fixtureUrl, sleep: async () => {} });
  assert.equal((await runImport({ db: h.db, clock: h.clock, source }, { translationId: 'BSB' })).status, 'succeeded');
  assert.equal((await importAudio({ db: h.db, clock: h.clock, source, mediaDir: h.config.mediaDir }, { translationId: 'BSB', bookId: 'ROM', chapters: [1] })).status, 'succeeded');
});

const inject = (method: 'GET' | 'POST', cookie: string, url: string) => h.app.inject({ method, url, cookies: { bs_session: cookie } });

interface Member {
  cookie: string;
  userId: string;
}

// The owner (whose first sign-in creates the group) and one member who joined by link.
async function ownerAndMember(): Promise<{ owner: Member; member: Member; groupId: string }> {
  const owner = await signIn(h, ownerEmail);
  const groupId = (await inject('GET', owner.cookie, '/api/groups')).json()[0].id;
  const link = (await inject('POST', owner.cookie, `/api/groups/${groupId}/invitations`)).json().link as string;
  const member = await signIn(h, 'member@example.test', new URL(link).pathname.replace('/join/', ''));
  await h.app.inject({ method: 'PATCH', url: '/api/me', cookies: { bs_session: owner.cookie }, payload: { displayName: 'Olive', timeZone: 'America/Chicago' } });
  await h.app.inject({ method: 'PATCH', url: '/api/me', cookies: { bs_session: member.cookie }, payload: { displayName: 'Mark', timeZone: 'America/Chicago' } });
  return { owner, member, groupId };
}

async function start(cookie: string, groupId: string): Promise<{ sessionId: string; state: PlaybackState }> {
  const response = await inject('POST', cookie, `/api/groups/${groupId}/session`);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

interface Client {
  socket: WebSocket;
  messages: ServerMessage[];
  closed: Promise<number>;
  next(predicate: (message: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  send(message: object): void;
  join(sessionId: string): Promise<Extract<ServerMessage, { t: 'snapshot' }>>;
  command(sessionId: string, expectedRevision: number, command: Command, commandId?: string): Promise<Extract<ServerMessage, { t: 'result' }>>;
}

function connect(cookie: string, url = wsUrl, headers: Record<string, string> = {}): Promise<Client> {
  const socket = new WebSocket(url, { headers: { cookie: `bs_session=${cookie}`, ...headers } });
  const messages: ServerMessage[] = [];
  let seen = 0;
  socket.on('message', (data) => messages.push(JSON.parse(String(data))));
  const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
  // Waits for the next message after the last one returned that matches.
  async function next(predicate: (message: ServerMessage) => boolean, timeoutMs = 5000): Promise<ServerMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = messages.findIndex((m, i) => i >= seen && predicate(m));
      if (index >= 0) {
        seen = index + 1;
        return messages[index];
      }
      if (Date.now() > deadline) throw new Error(`no matching message; got ${JSON.stringify(messages.slice(seen))}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const client: Client = {
    socket,
    messages,
    closed,
    next,
    send: (message) => socket.send(JSON.stringify(message)),
    async join(sessionId) {
      client.send({ t: 'join', sessionId });
      return (await next((m) => m.t === 'snapshot' || m.t === 'error')) as Extract<ServerMessage, { t: 'snapshot' }>;
    },
    async command(sessionId, expectedRevision, command, commandId = randomUUID()) {
      client.send({ t: 'command', sessionId, commandId, expectedRevision, command });
      return (await next((m) => (m.t === 'result' && m.commandId === commandId) || m.t === 'error')) as Extract<ServerMessage, { t: 'result' }>;
    },
  };
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(client));
    socket.once('unexpected-response', (_request, response) => reject(new Error(`upgrade refused: ${response.statusCode}`)));
    socket.once('error', reject);
  });
}

async function closeClient(client: Client): Promise<void> {
  client.socket.close();
  await client.closed;
}

async function sessionRow(sessionId: string) {
  const result = await h.db.query<{ status: string; revision: number; play_status: string; paused_reason: string | null; position_seconds: number; changed_at: Date }>(
    'SELECT status, revision, play_status, paused_reason, position_seconds, changed_at FROM study_sessions WHERE id = $1',
    [sessionId],
  );
  return result.rows[0];
}

describe('starting and joining', () => {
  test('S5.1 two members starting at once end up in one active session', async () => {
    const { owner, member, groupId } = await ownerAndMember();
    for (let round = 0; round < 5; round++) {
      const [a, b, c] = await Promise.all([start(owner.cookie, groupId), start(member.cookie, groupId), start(owner.cookie, groupId)]);
      assert.equal(a.sessionId, b.sessionId);
      assert.equal(b.sessionId, c.sessionId);
      const active = await h.db.query(`SELECT id FROM study_sessions WHERE group_id = $1 AND status = 'active'`, [groupId]);
      assert.deepEqual(
        active.rows.map((r) => r.id),
        [a.sessionId],
      );
      // End it so the next round races a fresh start.
      const client = await connect(owner.cookie);
      await client.join(a.sessionId);
      assert.equal((await client.command(a.sessionId, a.state.revision, { kind: 'end_session' })).outcome, 'applied');
      await closeClient(client);
    }
  });

  test('a new session starts paused at Romans 1 with the first narrator, and GET finds it', async () => {
    const { owner, member, groupId } = await ownerAndMember();
    const missing = await inject('GET', owner.cookie, `/api/groups/${groupId}/session`);
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error, 'no_active_session');
    const { sessionId, state } = await start(owner.cookie, groupId);
    assert.deepEqual(state.passage, { bookId: 'ROM', chapter: 1, startVerse: null, endVerse: null });
    assert.equal(state.mode, 'narration');
    assert.equal(state.status, 'paused');
    assert.equal(state.narratorId, 'hays');
    assert.ok(state.recording && Math.abs(state.recording.durationSeconds - frames * frameSeconds) < 0.1);
    assert.equal(state.recording.mediaUrl, `/media/${state.recording.mediaSha256}`);
    const found = (await inject('GET', member.cookie, `/api/groups/${groupId}/session`)).json();
    assert.equal(found.sessionId, sessionId);
  });
});

describe('commands', () => {
  test('S5.2 a stale pause is applied; a stale seek is rejected_stale with the current state and no new revision', async () => {
    const { owner, member, groupId } = await ownerAndMember();
    const { sessionId } = await start(owner.cookie, groupId);
    const olive = await connect(owner.cookie);
    const mark = await connect(member.cookie);
    await olive.join(sessionId);
    await mark.join(sessionId);

    const played = await olive.command(sessionId, 0, { kind: 'play' });
    assert.equal(played.outcome, 'applied');
    assert.equal(played.state.revision, 1);
    h.clock.advance(4_000);

    const paused = await mark.command(sessionId, 0, { kind: 'pause' });
    assert.equal(paused.outcome, 'applied');
    assert.equal(paused.state.revision, 2);
    assert.equal(paused.state.status, 'paused');
    assert.equal(paused.state.positionSeconds, 4);
    assert.deepEqual(paused.state.changedBy, { userId: member.userId, displayName: 'Mark' });
    assert.equal(paused.state.pausedReason, 'member');

    const seek = await olive.command(sessionId, 1, { kind: 'seek', positionSeconds: 30 });
    assert.equal(seek.outcome, 'rejected_stale');
    assert.equal(seek.state.revision, 2);
    assert.equal(seek.state.positionSeconds, 4);
    assert.equal((await sessionRow(sessionId)).revision, 2);

    // Mark's pause reached Olive as a state, naming Mark, before her seek was answered.
    const broadcast = olive.messages.find((m) => m.t === 'state' && m.state.revision === 2) as Extract<ServerMessage, { t: 'state' }> | undefined;
    assert.equal(broadcast?.state.changedBy?.displayName, 'Mark');
    await closeClient(olive);
    await closeClient(mark);
  });

  test('S5.3 resending a commandId returns the original outcome and does not change the revision', async () => {
    const { owner, groupId } = await ownerAndMember();
    const { sessionId } = await start(owner.cookie, groupId);
    const client = await connect(owner.cookie);
    await client.join(sessionId);
    const commandId = randomUUID();
    const first = await client.command(sessionId, 0, { kind: 'seek', positionSeconds: 12 }, commandId);
    assert.equal(first.outcome, 'applied');
    assert.equal(first.state.revision, 1);
    const again = await client.command(sessionId, 0, { kind: 'seek', positionSeconds: 12 }, commandId);
    assert.equal(again.outcome, 'applied');
    assert.equal(again.state.revision, 1);

    const staleId = randomUUID();
    assert.equal((await client.command(sessionId, 0, { kind: 'play' }, staleId)).outcome, 'rejected_stale');
    assert.equal((await client.command(sessionId, 1, { kind: 'play' }, staleId)).outcome, 'rejected_stale', 'the first outcome stands');
    assert.equal((await sessionRow(sessionId)).revision, 1);
    const recorded = await h.db.query('SELECT outcome FROM session_commands WHERE session_id = $1 ORDER BY received_at', [sessionId]);
    assert.deepEqual(
      recorded.rows.map((r) => r.outcome),
      ['applied', 'rejected_stale'],
    );
    await closeClient(client);
  });

  test('play, rate, narrator and passage commands move the shared position', async () => {
    const { owner, groupId } = await ownerAndMember();
    const { sessionId } = await start(owner.cookie, groupId);
    const client = await connect(owner.cookie);
    let revision = (await client.join(sessionId)).state.revision;
    const run = async (command: Command) => {
      const result = await client.command(sessionId, revision, command);
      assert.equal(result.outcome, 'applied', result.reason);
      revision = result.state.revision;
      return result.state;
    };
    await run({ kind: 'seek', positionSeconds: 9 });
    await run({ kind: 'set_rate', rate: 1.5 });
    await run({ kind: 'play' });
    h.clock.advance(2_000);
    const souer = await run({ kind: 'set_narrator', narratorId: 'souer' });
    assert.equal(souer.recording?.narratorName, 'Bob Souer');
    assert.equal(souer.positionSeconds, 6 * verseSeconds, 'the verse being read (12 s → verse 7) starts the new reading');
    assert.equal(souer.status, 'playing');
    const range = await run({ kind: 'set_passage', passage: { bookId: 'ROM', chapter: 1, startVerse: 3, endVerse: 5 } });
    assert.equal(range.status, 'paused');
    assert.equal(range.positionSeconds, 2 * verseSeconds);
    await run({ kind: 'play' });
    h.clock.advance(60_000);
    const ended = (await client.join(sessionId)).state;
    assert.equal(ended.status, 'paused');
    assert.equal(ended.pausedReason, 'range_end');
    assert.ok(Math.abs(ended.positionSeconds - 5 * verseSeconds) < 1e-9);
    const bad = await client.command(sessionId, revision, { kind: 'set_passage', passage: { bookId: 'ROM', chapter: 1, startVerse: 30, endVerse: 40 } });
    assert.equal(bad.outcome, 'rejected_invalid');
    assert.equal(bad.reason, 'Verses must be within 1–32.');
    await closeClient(client);
  });

  test('S5.9 with CSB shared the session is manual, and any member’s verse mark reaches everyone', async () => {
    const { owner, member, groupId } = await ownerAndMember();
    const { sessionId } = await start(owner.cookie, groupId);
    const olive = await connect(owner.cookie);
    const mark = await connect(member.cookie);
    await olive.join(sessionId);
    await mark.join(sessionId);
    const csb = await olive.command(sessionId, 0, { kind: 'set_translation', translationId: 'CSB' });
    assert.equal(csb.outcome, 'applied');
    assert.equal(csb.state.mode, 'manual');
    assert.equal(csb.state.recording, null);
    assert.equal(csb.state.manualVerse, 1);
    assert.equal((await mark.command(sessionId, 1, { kind: 'play' })).outcome, 'rejected_invalid');

    const marked = await mark.command(sessionId, 1, { kind: 'set_manual_verse', verse: 5 });
    assert.equal(marked.outcome, 'applied');
    const seen = (await olive.next((m) => m.t === 'state' && m.state.revision === 2)) as Extract<ServerMessage, { t: 'state' }>;
    assert.equal(seen.state.manualVerse, 5);
    assert.equal((await mark.command(sessionId, 2, { kind: 'set_manual_verse', verse: 33 })).outcome, 'rejected_invalid');

    // Back to BSB: the narration starts at the marked verse.
    const bsb = await olive.command(sessionId, 2, { kind: 'set_translation', translationId: 'BSB' });
    assert.equal(bsb.state.mode, 'narration');
    assert.equal(bsb.state.positionSeconds, 4 * verseSeconds);
    assert.equal((await olive.command(sessionId, 3, { kind: 'set_manual_verse', verse: 2 })).outcome, 'rejected_invalid');
    await closeClient(olive);
    await closeClient(mark);
  });
});

describe('the room', () => {
  test('S5.7 the starter leaving does not end the session; the last connection leaving pauses it after the grace', async () => {
    const { owner, member, groupId } = await ownerAndMember();
    const { sessionId } = await start(owner.cookie, groupId);
    const olive = await connect(owner.cookie);
    const mark = await connect(member.cookie);
    await olive.join(sessionId);
    await mark.join(sessionId);
    assert.equal((await olive.command(sessionId, 0, { kind: 'play' })).outcome, 'applied');

    await closeClient(olive);
    const presence = (await mark.next((m) => m.t === 'presence')) as Extract<ServerMessage, { t: 'presence' }>;
    assert.deepEqual(
      presence.presence.map((p) => p.displayName),
      ['Mark'],
    );
    await new Promise((resolve) => setTimeout(resolve, graceMs * 2));
    assert.equal((await sessionRow(sessionId)).play_status, 'playing', 'Mark is still here');

    h.clock.advance(7_000);
    await closeClient(mark);
    await new Promise((resolve) => setTimeout(resolve, graceMs / 3));
    assert.equal((await sessionRow(sessionId)).play_status, 'playing', 'still within the grace');
    await new Promise((resolve) => setTimeout(resolve, graceMs * 2));
    const row = await sessionRow(sessionId);
    assert.equal(row.status, 'active');
    assert.equal(row.play_status, 'paused');
    assert.equal(row.paused_reason, 'room_empty');
    assert.equal(row.position_seconds, 7);
  });

  test('S5.6 a client that reconnects gets a snapshot of what changed meanwhile', async () => {
    const { owner, member, groupId } = await ownerAndMember();
    const { sessionId } = await start(owner.cookie, groupId);
    const olive = await connect(owner.cookie);
    let mark = await connect(member.cookie);
    await olive.join(sessionId);
    await mark.join(sessionId);
    await closeClient(mark);
    assert.equal((await olive.command(sessionId, 0, { kind: 'seek', positionSeconds: 20 })).outcome, 'applied');
    mark = await connect(member.cookie);
    const snapshot = await mark.join(sessionId);
    assert.equal(snapshot.t, 'snapshot');
    assert.equal(snapshot.state.revision, 1);
    assert.equal(snapshot.state.positionSeconds, 20);
    assert.deepEqual(
      snapshot.presence.map((p) => p.displayName),
      ['Mark', 'Olive'],
    );
    await closeClient(olive);
    await closeClient(mark);
  });

  test('drift from ready clients during playback feeds the drift report', async () => {
    const { owner, member, groupId } = await ownerAndMember();
    const { sessionId } = await start(owner.cookie, groupId);
    const olive = await connect(owner.cookie);
    const mark = await connect(member.cookie);
    const ids = [randomUUID(), randomUUID()];
    olive.send({ t: 'hello', clientId: ids[0] });
    mark.send({ t: 'hello', clientId: ids[1] });
    await olive.join(sessionId);
    await mark.join(sessionId);
    olive.send({ t: 'drift', sessionId, driftMs: 999, ready: true });
    await olive.command(sessionId, 0, { kind: 'play' });
    for (const [client, values] of [
      [olive, [10, -20, 30]],
      [mark, [100, -200, 0]],
    ] as const) {
      for (const driftMs of values) client.send({ t: 'drift', sessionId, driftMs, ready: true });
      client.send({ t: 'drift', sessionId, driftMs: 5000, ready: false });
    }
    const ready = (await olive.next((m) => m.t === 'presence' && m.presence.every((p) => p.ready))) as Extract<ServerMessage, { t: 'presence' }>;
    assert.equal(ready.presence.length, 2);
    // Let the last drift messages land.
    await olive.join(sessionId);
    await mark.join(sessionId);
    const report = (await inject('GET', member.cookie, `/api/groups/${groupId}/session/${sessionId}/drift-report`)).json();
    assert.equal(report.samples, 6, 'not the sample before play, nor the ones from a client not ready');
    assert.equal(report.maxMs, 200);
    assert.equal(report.p50Ms, 25);
    assert.deepEqual(
      report.perClient.map((c: { clientId: string }) => c.clientId),
      [...ids].sort(),
    );
    await closeClient(olive);
    await closeClient(mark);
  });
});

describe('membership', () => {
  test('S5.10 a signed-in non-member gets not_member for the session routes, join and command', async () => {
    const { owner, groupId } = await ownerAndMember();
    const { sessionId } = await start(owner.cookie, groupId);
    const stranger = await signIn(h, 'stranger@example.test');
    for (const method of ['GET', 'POST'] as const) {
      const response = await inject(method, stranger.cookie, `/api/groups/${groupId}/session`);
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error, 'not_member');
    }
    assert.equal((await inject('GET', stranger.cookie, `/api/groups/${groupId}/session/${sessionId}/drift-report`)).json().error, 'not_member');
    const client = await connect(stranger.cookie);
    assert.deepEqual(await client.join(sessionId), { t: 'error', error: 'not_member', retryable: false });
    client.send({ t: 'command', sessionId, commandId: randomUUID(), expectedRevision: 0, command: { kind: 'pause' } });
    assert.deepEqual(await client.next((m) => m.t === 'error'), { t: 'error', error: 'not_member', retryable: false });
    assert.equal((await sessionRow(sessionId)).revision, 0);
    await closeClient(client);
  });

  test('an upgrade from another site is refused, and a signed-out upgrade is unauthenticated', async () => {
    const { owner } = await ownerAndMember();
    await assert.rejects(connect(owner.cookie, wsUrl, { origin: 'https://evil.example' }), /upgrade refused: 403/);
    await assert.rejects(connect('not-a-session'), /upgrade refused: 401/);
  });
});

// ---- S5.8: the real server process, killed during playback ----

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function spawnServer(port: number): { child: ChildProcess; output: string[] } {
  const output: string[] = [];
  const child = spawn(process.execPath, ['src/server/web/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_URL: databaseUrl,
      APP_SECRET: h.config.appSecret,
      SMTP_URL: smtpUrl,
      MAIL_FROM: h.config.mailFrom,
      PUBLIC_URL: `http://127.0.0.1:${port}`,
      OWNER_EMAIL: ownerEmail,
      MEDIA_DIR: h.config.mediaDir,
      AOLAB_BASE_URL: fixtureUrl,
      STATIC_DIR: 'does-not-exist',
      BUILD_ID: 'restart-test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => output.push(String(d)));
  child.stderr!.on('data', (d) => output.push(String(d)));
  return { child, output };
}

async function waitListening(port: number, server: { output: string[] }): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__build-id`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not listen: ${server.output.join('')}`);
}

function exited(child: ChildProcess): Promise<void> {
  return child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', () => resolve()));
}

describe('S5.8 restart', () => {
  test('killing and restarting the server during playback leaves the session paused for server_restart at the derived position ±1 s', async () => {
    // The spawned server keeps real time; sign in at real time so its sessions are current.
    h.clock.set(new Date());
    const { owner, groupId } = await ownerAndMember();
    const { sessionId } = await start(owner.cookie, groupId);
    const port = await freePort();
    const first = spawnServer(port);
    let second: ReturnType<typeof spawnServer> | null = null;
    try {
      await waitListening(port, first);
      const client = await connect(owner.cookie, `ws://127.0.0.1:${port}/ws`);
      await client.join(sessionId);
      const played = await client.command(sessionId, 0, { kind: 'play' });
      assert.equal(played.outcome, 'applied');
      const anchor = played.state.anchorServerTimeMs;
      await new Promise((resolve) => setTimeout(resolve, 3_000));

      const killedAt = Date.now();
      first.child.kill('SIGKILL');
      await exited(first.child);
      assert.equal((await sessionRow(sessionId)).play_status, 'playing', 'a killed server writes nothing');
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      second = spawnServer(port);
      await waitListening(port, second);
      const listenedAt = Date.now();
      const row = await sessionRow(sessionId);
      assert.equal(row.status, 'active');
      assert.equal(row.play_status, 'paused');
      assert.equal(row.paused_reason, 'server_restart');
      const derived = (row.changed_at.getTime() - anchor) / 1000;
      assert.ok(Math.abs(row.position_seconds - derived) <= 1, `position ${row.position_seconds} vs derived ${derived}`);
      assert.ok(row.position_seconds >= (killedAt - anchor) / 1000 - 1 && row.position_seconds <= (listenedAt - anchor) / 1000 + 1, `position ${row.position_seconds}`);

      const again = await connect(owner.cookie, `ws://127.0.0.1:${port}/ws`);
      const snapshot = await again.join(sessionId);
      assert.equal(snapshot.state.status, 'paused');
      assert.equal(snapshot.state.pausedReason, 'server_restart');
      assert.equal(snapshot.state.positionSeconds, row.position_seconds);
      assert.equal(snapshot.state.revision, 2);
      await closeClient(again);
    } finally {
      first.child.kill('SIGKILL');
      second?.child.kill('SIGKILL');
      await exited(first.child);
      if (second) await exited(second.child);
    }
  });
});

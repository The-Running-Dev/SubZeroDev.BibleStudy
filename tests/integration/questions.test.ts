import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import WebSocket from 'ws';
import type { AoBook, AoChapter } from '../../src/server/content/aolab.ts';
import { createAoLabSource } from '../../src/server/content/aolab.ts';
import { runImport } from '../../src/server/content/import.ts';
import type { QuestionView, ReplyView, ServerMessage } from '../../src/shared/api.ts';
import type { Harness } from '../support/harness.ts';
import { clearMailbox, ownerEmail, signIn, startHarness, truncateAll } from '../support/harness.ts';

let h: Harness;
let fixtureUrl: string;
let closeFixture: () => Promise<void>;
let wsUrl: string;

const verseCounts = [32, 29];

// A local stand-in for AO Lab: the text of BSB Romans 1–2, no audio.
async function startFixture(): Promise<void> {
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    const json = (body: unknown) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const translation = { id: 'BSB', name: 'Berean Standard Bible', sha256: 'translation', numberOfBooks: 1, totalNumberOfChapters: 2 };
    const book: AoBook = { id: 'ROM', name: 'Romans', order: 45, numberOfChapters: 2, sha256: 'book' };
    if (path === '/api/BSB/books.json') return json({ translation, books: [book] });
    const chapter = /^\/api\/BSB\/ROM\/([12])\.json$/.exec(path);
    if (chapter) {
      const number = Number(chapter[1]);
      const count = verseCounts[number - 1];
      const body: AoChapter = {
        translation,
        book,
        numberOfVerses: count,
        thisChapterLink: path,
        chapter: {
          number,
          content: Array.from({ length: count }, (_, i) => ({ type: 'verse' as const, number: i + 1, content: [`Romans ${number}:${i + 1}`] })),
          footnotes: [],
        },
      };
      return json(body);
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
  h = await startHarness({ AOLAB_BASE_URL: fixtureUrl }, { source });
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
});

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const call = (method: Method, cookie: string, url: string, payload?: object) => h.app.inject({ method, url, cookies: { bs_session: cookie }, payload });

interface Member {
  cookie: string;
  userId: string;
}

async function ownerAndMember(): Promise<{ owner: Member; member: Member; groupId: string }> {
  const owner = await signIn(h, ownerEmail);
  const groupId = (await call('GET', owner.cookie, '/api/groups')).json()[0].id;
  const link = (await call('POST', owner.cookie, `/api/groups/${groupId}/invitations`)).json().link as string;
  const member = await signIn(h, 'member@example.test', new URL(link).pathname.replace('/join/', ''));
  await call('PATCH', owner.cookie, '/api/me', { displayName: 'Olive', timeZone: 'America/Chicago' });
  await call('PATCH', member.cookie, '/api/me', { displayName: 'Mark', timeZone: 'America/Chicago' });
  return { owner, member, groupId };
}

const romans = (chapter: number, startVerse: number | null, endVerse = startVerse) => ({ translationId: 'BSB', bookId: 'ROM', chapter, startVerse, endVerse });

async function ask(cookie: string, groupId: string, anchor: object, body: string, clientOpId = randomUUID()): Promise<QuestionView> {
  const response = await call('POST', cookie, `/api/groups/${groupId}/questions`, { clientOpId, anchor, body });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function reply(cookie: string, groupId: string, questionId: string, body: string): Promise<ReplyView> {
  const response = await call('POST', cookie, `/api/groups/${groupId}/questions/${questionId}/replies`, { clientOpId: randomUUID(), body });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function list(cookie: string, groupId: string, query = 'book=ROM&chapter=2'): Promise<QuestionView[]> {
  const response = await call('GET', cookie, `/api/groups/${groupId}/questions?${query}`);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

describe('posting and replying', () => {
  test('S8.1 a question on Romans 2:4 is listed for another member without a session, and their reply reaches the asker', async () => {
    const { owner, member, groupId } = await ownerAndMember();
    const question = await ask(owner.cookie, groupId, romans(2, 4), 'What does kindness lead to here?');
    assert.equal(question.kind, 'verse');
    assert.deepEqual(question.author, { userId: owner.userId, displayName: 'Olive' });
    assert.equal(question.status, 'open');

    const seen = await list(member.cookie, groupId);
    assert.deepEqual(
      seen.map((q) => q.body),
      ['What does kindness lead to here?'],
    );
    await reply(member.cookie, groupId, question.id, 'Repentance, verse 4 says.');
    const [withReply] = await list(owner.cookie, groupId);
    assert.deepEqual(
      withReply.replies.map((r) => [r.author.displayName, r.body]),
      [['Mark', 'Repentance, verse 4 says.']],
    );
    assert.equal(withReply.revision, question.revision, 'a reply does not make the asker’s pending edit stale');

    // Nothing here starts a study or records where the group stopped (that lands in S9, which re-checks it in S9.3).
    const sessions = await h.db.query('SELECT 1 FROM study_sessions WHERE group_id = $1', [groupId]);
    assert.equal(sessions.rowCount, 0);
  });

  test('S8.2 re-posting with the same clientOpId returns the same question and leaves one row', async () => {
    const { owner, groupId } = await ownerAndMember();
    const clientOpId = randomUUID();
    const first = await ask(owner.cookie, groupId, romans(2, 4), 'Once?', clientOpId);
    const again = await ask(owner.cookie, groupId, romans(2, 4), 'Once?', clientOpId);
    assert.equal(again.id, first.id);
    const rows = await h.db.query('SELECT 1 FROM questions WHERE client_op_id = $1', [clientOpId]);
    assert.equal(rows.rowCount, 1);
  });

  test('concurrent posts with one clientOpId leave one row, and a retry after deleting returns it deleted', async () => {
    const { owner, groupId } = await ownerAndMember();
    const clientOpId = randomUUID();
    const post = () => call('POST', owner.cookie, `/api/groups/${groupId}/questions`, { clientOpId, anchor: romans(2, 4), body: 'Twice at once?' });
    const [a, b] = await Promise.all([post(), post()]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    assert.equal(a.json().id, b.json().id);
    assert.equal((await h.db.query('SELECT 1 FROM questions WHERE client_op_id = $1', [clientOpId])).rowCount, 1);

    await call('DELETE', owner.cookie, `/api/groups/${groupId}/questions/${a.json().id}`);
    const late = await post();
    assert.equal(late.json().id, a.json().id);
    assert.equal(late.json().removed, true, 'the late retry finds the deleted question rather than posting it again');
    assert.equal((await h.db.query('SELECT 1 FROM questions WHERE client_op_id = $1', [clientOpId])).rowCount, 1);
    assert.deepEqual(await list(owner.cookie, groupId), []);
  });

  test('a reply raises the question’s version but not its revision; a reply to a deleted question is not_found', async () => {
    const { owner, member, groupId } = await ownerAndMember();
    const question = await ask(owner.cookie, groupId, romans(2, 4), 'Versioned');
    await reply(member.cookie, groupId, question.id, 'One');
    const [after] = await list(owner.cookie, groupId);
    assert.equal(after.revision, question.revision);
    assert.ok(after.version > question.version);

    const lonely = await ask(owner.cookie, groupId, romans(2, 5), 'Gone soon');
    await call('DELETE', owner.cookie, `/api/groups/${groupId}/questions/${lonely.id}`);
    const late = await call('POST', member.cookie, `/api/groups/${groupId}/questions/${lonely.id}/replies`, { clientOpId: randomUUID(), body: 'Too late' });
    assert.equal(late.json().error, 'not_found');
  });

  test('anchors are bounded by the chapter, and a body must have text', async () => {
    const { owner, groupId } = await ownerAndMember();
    const post = (anchor: object, body = 'Why?') => call('POST', owner.cookie, `/api/groups/${groupId}/questions`, { clientOpId: randomUUID(), anchor, body });
    assert.equal((await post(romans(2, 30))).json().error, 'invalid_request', 'Romans 2 has 29 verses');
    assert.equal((await post(romans(2, 6, 5))).json().error, 'invalid_request');
    assert.equal((await post(romans(17, null))).json().error, 'invalid_request');
    assert.equal((await post(romans(2, 4), '   ')).json().error, 'empty_body');
    assert.equal((await post(romans(2, 4), 'A\u0000B')).json().error, 'invalid_request');
    const range = (await post(romans(2, 4, 6))).json() as QuestionView;
    assert.equal(range.kind, 'range');
    const chapter = (await post(romans(2, null))).json() as QuestionView;
    assert.equal(chapter.kind, 'chapter');
    assert.deepEqual(
      (await list(owner.cookie, groupId)).map((q) => q.kind),
      ['chapter', 'range'],
      'chapter questions first, then by verse',
    );
  });

  test('a signed-in non-member gets not_member for every question route', async () => {
    const { owner, groupId } = await ownerAndMember();
    const question = await ask(owner.cookie, groupId, romans(2, 4), 'Mine');
    const outsider = await signIn(h, 'outsider@example.test');
    const routes: [Method, string, object?][] = [
      ['GET', `/api/groups/${groupId}/questions?book=ROM&chapter=2`],
      ['POST', `/api/groups/${groupId}/questions`, { clientOpId: randomUUID(), anchor: romans(2, 4), body: 'Hi' }],
      ['POST', `/api/groups/${groupId}/questions/${question.id}/replies`, { clientOpId: randomUUID(), body: 'Hi' }],
      ['PATCH', `/api/groups/${groupId}/questions/${question.id}`, { expectedRevision: question.revision, body: 'Hi' }],
      ['DELETE', `/api/groups/${groupId}/questions/${question.id}`],
    ];
    for (const [method, url, payload] of routes) {
      const response = await call(method, outsider.cookie, url, payload);
      assert.equal(response.json().error, 'not_member', `${method} ${url}`);
    }
  });
});

describe('editing and deleting', () => {
  test('S8.4 editing one’s own post sets editedAt; another member’s edit is not_author; an old revision is stale', async () => {
    const { owner, member, groupId } = await ownerAndMember();
    const question = await ask(owner.cookie, groupId, romans(2, 4), 'First wording');
    assert.equal(question.editedAt, null);
    h.clock.advance(60_000);
    const edited = await call('PATCH', owner.cookie, `/api/groups/${groupId}/questions/${question.id}`, { expectedRevision: question.revision, body: 'Second wording' });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.equal(edited.json().body, 'Second wording');
    assert.equal(edited.json().editedAt, '2026-11-01T12:01:00.000Z');

    const theirs = await call('PATCH', member.cookie, `/api/groups/${groupId}/questions/${question.id}`, { expectedRevision: edited.json().revision, body: 'Hijacked' });
    assert.equal(theirs.statusCode, 403);
    assert.equal(theirs.json().error, 'not_author');

    const stale = await call('PATCH', owner.cookie, `/api/groups/${groupId}/questions/${question.id}`, { expectedRevision: question.revision, body: 'Third' });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error, 'stale_revision');
    assert.equal(stale.json().details.current.body, 'Second wording');

    const answer = await reply(member.cookie, groupId, question.id, 'An answer');
    const staleReply = await call('PATCH', member.cookie, `/api/groups/${groupId}/replies/${answer.id}`, { expectedRevision: answer.revision + 5, body: 'Stale' });
    assert.equal(staleReply.json().error, 'stale_revision');
    const editedReply = await call('PATCH', member.cookie, `/api/groups/${groupId}/replies/${answer.id}`, { expectedRevision: answer.revision, body: 'A better answer' });
    assert.equal(editedReply.json().body, 'A better answer');
    assert.ok(editedReply.json().editedAt);
    assert.equal((await call('PATCH', owner.cookie, `/api/groups/${groupId}/replies/${answer.id}`, { expectedRevision: 1, body: 'No' })).json().error, 'not_author');
  });

  test('S8.5 a question with no replies is deleted; one with replies keeps them under a removed placeholder', async () => {
    // Deleted posts keep their rows without a body, so their clientOpIds stay used; nothing deleted is listed.
    const { owner, member, groupId } = await ownerAndMember();
    const lonely = await ask(owner.cookie, groupId, romans(2, 1), 'Nobody answers this');
    const answered = await ask(owner.cookie, groupId, romans(2, 4), 'Somebody answers this');
    await reply(member.cookie, groupId, answered.id, 'Here I am');

    assert.equal((await call('DELETE', member.cookie, `/api/groups/${groupId}/questions/${lonely.id}`)).json().error, 'not_author');
    assert.deepEqual((await call('DELETE', owner.cookie, `/api/groups/${groupId}/questions/${lonely.id}`)).json(), { outcome: 'deleted' });
    assert.deepEqual((await call('DELETE', owner.cookie, `/api/groups/${groupId}/questions/${answered.id}`)).json(), { outcome: 'body_removed' });

    const remaining = await list(member.cookie, groupId);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, answered.id);
    assert.equal(remaining[0].removed, true);
    assert.equal(remaining[0].body, null);
    assert.deepEqual(
      remaining[0].replies.map((r) => r.body),
      ['Here I am'],
    );
    assert.equal((await call('DELETE', owner.cookie, `/api/groups/${groupId}/questions/${answered.id}`)).json().error, 'not_found', 'a removed body is not removed twice');

    // A deleted reply is not listed; the removed question with nothing left under it then drops off the list.
    const replyId = remaining[0].replies[0].id;
    assert.deepEqual((await call('DELETE', member.cookie, `/api/groups/${groupId}/replies/${replyId}`)).json(), { outcome: 'deleted' });
    assert.deepEqual(await list(member.cookie, groupId), []);
    const kept = await h.db.query('SELECT body FROM questions WHERE id = ANY($1::uuid[])', [[lonely.id, answered.id]]);
    assert.deepEqual(
      kept.rows.map((r) => r.body),
      [null, null],
    );
  });
});

describe('S8.6 the reader’s list', () => {
  test('filters by chapter and status', async () => {
    const { owner, groupId } = await ownerAndMember();
    const open = await ask(owner.cookie, groupId, romans(2, 4), 'Open one');
    const settled = await ask(owner.cookie, groupId, romans(2, 5), 'Settled one');
    await ask(owner.cookie, groupId, romans(1, 16), 'Another chapter');
    // Dispositions arrive in S9; set one directly to see the filter work.
    await h.db.query(`UPDATE questions SET status = 'resolved' WHERE id = $1`, [settled.id]);

    assert.deepEqual(
      (await list(owner.cookie, groupId)).map((q) => q.body),
      ['Open one', 'Settled one'],
      'no status filter lists them all',
    );
    assert.deepEqual(
      (await list(owner.cookie, groupId, 'book=ROM&chapter=2&status=open,carried')).map((q) => q.id),
      [open.id],
    );
    assert.deepEqual(
      (await list(owner.cookie, groupId, 'book=ROM&chapter=2&status=resolved')).map((q) => q.id),
      [settled.id],
    );
    for (const query of ['book=ROM&chapter=2&status=maybe', 'book=ROM&chapter=2&status=', 'book=ROM&chapter=17', 'chapter=151']) {
      assert.equal((await call('GET', owner.cookie, `/api/groups/${groupId}/questions?${query}`)).json().error, 'invalid_request', query);
    }
  });
});

describe('in the study', () => {
  test('the snapshot carries the open questions on the session’s chapter, and changes reach everyone in it', async () => {
    const { owner, member, groupId } = await ownerAndMember();
    const onChapter = await ask(owner.cookie, groupId, romans(1, 3), 'On the session’s chapter');
    await ask(owner.cookie, groupId, romans(2, 4), 'On another chapter');
    h.clock.advance(1000); // asked before the study, which shows only its own chapter's
    const { sessionId } = (await call('POST', owner.cookie, `/api/groups/${groupId}/session`)).json();

    const socket = new WebSocket(wsUrl, { headers: { cookie: `bs_session=${member.cookie}` } });
    const messages: ServerMessage[] = [];
    socket.on('message', (data) => messages.push(JSON.parse(String(data))));
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const waitFor = async <T extends ServerMessage['t']>(t: T, match: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true) => {
      const deadline = Date.now() + 5000;
      for (;;) {
        const found = messages.find((m): m is Extract<ServerMessage, { t: T }> => m.t === t && match(m as Extract<ServerMessage, { t: T }>));
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`no ${t}; got ${JSON.stringify(messages)}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    socket.send(JSON.stringify({ t: 'join', sessionId }));
    const snapshot = await waitFor('snapshot');
    assert.deepEqual(
      snapshot.questions.map((q) => q.id),
      [onChapter.id],
    );

    const posted = await ask(owner.cookie, groupId, romans(1, null), 'A chapter question');
    assert.equal((await waitFor('question', (m) => m.question.id === posted.id)).question.kind, 'chapter');
    await reply(owner.cookie, groupId, onChapter.id, 'Answered live');
    const replied = await waitFor('question', (m) => m.question.id === onChapter.id);
    assert.deepEqual(
      replied.question.replies.map((r) => r.body),
      ['Answered live'],
    );
    await call('DELETE', owner.cookie, `/api/groups/${groupId}/questions/${posted.id}`);
    const gone = await waitFor('question', (m) => m.question.id === posted.id && m.question.removed);
    assert.deepEqual(gone.question.replies, []);
    socket.close();
  });
});

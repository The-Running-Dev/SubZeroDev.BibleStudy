import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { SyncOp } from '../../src/shared/api.ts';
import type { Harness } from '../support/harness.ts';
import { clearMailbox, ownerEmail, signIn, startHarness, truncateAll } from '../support/harness.ts';

// A member's personal export (S16): their own data as a file, and nothing of anyone else's.

let h: Harness;

before(async () => {
  h = await startHarness({ ASSISTANT_OWNER_EMAIL: ownerEmail, CONNECTOR_TOKEN: 'export-integration-connector-token-0123456789' });
});
after(async () => {
  await h.close();
});
beforeEach(async () => {
  await truncateAll(h.db);
  await clearMailbox();
  h.clock.set('2026-11-01T12:00:00Z');
});

type Method = 'GET' | 'POST';
const inject = (method: Method, cookie: string | undefined, url: string, payload?: object) =>
  h.app.inject({ method, url, cookies: cookie ? { bs_session: cookie } : {}, payload });

const note = (body: string, op: 'upsert' | 'delete' = 'upsert', entityId: string = randomUUID()): SyncOp =>
  op === 'upsert'
    ? { opId: randomUUID(), entity: 'note', entityId, op, baseRevision: null, anchor: { translationId: 'BSB', bookId: 'ROM', chapter: 4, startVerse: 3, endVerse: 3 }, body, deviceId: 'device-a' }
    : ({ opId: randomUUID(), entity: 'note', entityId, op, baseRevision: 1, deviceId: 'device-a' } as SyncOp);

async function question(groupId: string, authorId: string, body: string): Promise<string> {
  const id = randomUUID();
  await h.db.query(
    `INSERT INTO questions (id, group_id, author_id, client_op_id, translation_id, book_id, chapter, start_verse, end_verse, body, created_at, status, revision)
     VALUES ($1, $2, $3, $4, 'BSB', 'ROM', 4, 3, 3, $5, $6, 'open', 0)`,
    [id, groupId, authorId, randomUUID(), body, h.clock.now()],
  );
  return id;
}

async function reply(questionId: string, authorId: string, body: string): Promise<void> {
  await h.db.query(
    `INSERT INTO replies (id, question_id, author_id, client_op_id, body, created_at, revision) VALUES ($1, $2, $3, $4, $5, $6, 0)`,
    [randomUUID(), questionId, authorId, randomUUID(), body, h.clock.now()],
  );
}

async function conversation(userId: string, prompt: string, answer: string): Promise<void> {
  const conversationId = randomUUID();
  const turnId = randomUUID();
  await h.db.query(`INSERT INTO assistant_conversations (id, user_id, runtime_session_id, created_at) VALUES ($1, $2, 'runtime-session-secret', $3)`, [
    conversationId,
    userId,
    h.clock.now(),
  ]);
  await h.db.query(
    `INSERT INTO assistant_turns (id, conversation_id, client_turn_id, prompt, context, runtime_session_id, runtime_turn_id, status, created_at)
     VALUES ($1, $2, $3, $4, '{"reference":"Romans 4:3"}', 'runtime-session-secret', 'runtime-turn-1', 'completed', $5)`,
    [turnId, conversationId, randomUUID(), prompt, h.clock.now()],
  );
  await h.db.query(
    `INSERT INTO transcript_entries (conversation_id, runtime_session_id, runtime_seq, turn_id, kind, text, received_at)
     VALUES ($1, 'runtime-session-secret', 1, $2, 'assistant_message', $3, $4)`,
    [conversationId, turnId, answer, h.clock.now()],
  );
}

describe('personal export (S16)', () => {
  test('S16.4 the export holds the caller’s own profile, notes, position, posts and conversations, and nothing of others', async () => {
    const owner = await signIn(h, ownerEmail);
    const groupId = (await inject('GET', owner.cookie, '/api/groups')).json()[0].id as string;
    const link = (await inject('POST', owner.cookie, `/api/groups/${groupId}/invitations`)).json().link as string;
    const member = await signIn(h, 'member@example.test', new URL(link).pathname.replace('/join/', ''));

    const deleted = randomUUID();
    const push = (cookie: string, ops: SyncOp[]) => inject('POST', cookie, '/api/sync/push', { ops });
    assert.equal((await push(member.cookie, [note('Faith counted as righteousness.'), note('Gone soon.', 'upsert', deleted)])).statusCode, 200);
    assert.equal((await push(member.cookie, [note('', 'delete', deleted)])).statusCode, 200);
    assert.equal(
      (await push(member.cookie, [{ opId: randomUUID(), entity: 'solo_position', op: 'set', baseRevision: null, position: { translationId: 'BSB', bookId: 'ROM', chapter: 4, verse: 3 } }]))
        .statusCode,
      200,
    );
    assert.equal((await push(owner.cookie, [note('The owner’s private note.')])).statusCode, 200);

    const ownersQuestion = await question(groupId, owner.userId, 'The owner asks.');
    await reply(ownersQuestion, member.userId, 'The member answers.');
    await reply(ownersQuestion, owner.userId, 'The owner answers back.');
    await question(groupId, member.userId, 'The member asks.');
    await conversation(member.userId, 'What is imputed righteousness?', 'It is credited, not earned.');
    await conversation(owner.userId, 'The owner’s private prompt.', 'The owner’s private answer.');

    const response = await inject('GET', member.cookie, '/api/export');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(String(response.headers['content-disposition']), /^attachment; filename="bible-study-export-2026-11-01\.json"$/);
    const text = response.body;
    const data = JSON.parse(text);

    assert.equal(data.exportedAt, '2026-11-01T12:00:00.000Z');
    assert.equal(data.profile.id, member.userId);
    assert.equal(data.profile.email, 'member@example.test');
    assert.deepEqual(
      data.notes.map((n: { body: string }) => n.body),
      ['Faith counted as righteousness.'],
    );
    assert.deepEqual(data.notes[0].anchor, { translationId: 'BSB', bookId: 'ROM', chapter: 4, startVerse: 3, endVerse: 3 });
    assert.equal(data.soloPosition.chapter, 4);
    assert.deepEqual(
      data.questions.map((q: { body: string }) => q.body),
      ['The member asks.'],
    );
    assert.deepEqual(
      data.replies.map((r: { body: string; questionId: string }) => [r.body, r.questionId]),
      [['The member answers.', ownersQuestion]],
    );
    assert.equal(data.conversations.length, 1);
    assert.equal(data.conversations[0].turns[0].prompt, 'What is imputed righteousness?');
    assert.deepEqual(
      data.conversations[0].turns[0].transcript.map((e: { kind: string; text: string }) => [e.kind, e.text]),
      [['assistant_message', 'It is credited, not earned.']],
    );

    // Nothing another member wrote, and no runtime ids.
    for (const absent of ['owner@example.test', 'The owner’s private note.', 'The owner asks.', 'The owner answers back.', 'The owner’s private prompt.', 'runtime-session-secret', 'runtime-turn-1', 'Gone soon.']) {
      assert.ok(!text.includes(absent), `export leaks ${absent}`);
    }
  });

  test('S16.4 the export needs a signed-in member', async () => {
    assert.equal((await inject('GET', undefined, '/api/export')).statusCode, 401);
  });
});

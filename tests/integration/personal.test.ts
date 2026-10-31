import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { NoteAnchor, PullResponse, PushResult, SyncOp } from '../../src/shared/api.ts';
import type { Harness } from '../support/harness.ts';
import { clearMailbox, ownerEmail, signIn, startHarness, truncateAll } from '../support/harness.ts';

// A member's own notes and solo position (S12): pushed and pulled by their devices, never seen by anyone else.

let h: Harness;

before(async () => {
  // The assistant is set up for the owner, and its connector is never started.
  h = await startHarness({ ASSISTANT_OWNER_EMAIL: ownerEmail, CONNECTOR_TOKEN: 'personal-integration-connector-token-0123456789' });
});
after(async () => {
  await h.close();
});
beforeEach(async () => {
  await truncateAll(h.db);
  await clearMailbox();
  h.clock.set('2026-11-01T12:00:00Z');
});

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const inject = (method: Method, cookie: string, url: string, payload?: object) => h.app.inject({ method, url, cookies: { bs_session: cookie }, payload });

interface Member {
  cookie: string;
  userId: string;
}

async function ownerAndMember(): Promise<{ owner: Member; member: Member; groupId: string }> {
  const owner = await signIn(h, ownerEmail);
  const groupId = (await inject('GET', owner.cookie, '/api/groups')).json()[0].id;
  const link = (await inject('POST', owner.cookie, `/api/groups/${groupId}/invitations`)).json().link as string;
  const member = await signIn(h, 'member@example.test', new URL(link).pathname.replace('/join/', ''));
  return { owner, member, groupId };
}

const romans4 = (verse: number | null): NoteAnchor => ({ translationId: 'BSB', bookId: 'ROM', chapter: 4, startVerse: verse, endVerse: verse });
const device = 'device-a';

const upsert = (entityId: string, body: string, baseRevision: number | null = null, anchor = romans4(3)): SyncOp => ({
  opId: randomUUID(),
  entity: 'note',
  entityId,
  op: 'upsert',
  baseRevision,
  anchor,
  body,
  deviceId: device,
});

const moveTo = (chapter: number, verse: number): SyncOp => ({
  opId: randomUUID(),
  entity: 'solo_position',
  op: 'set',
  baseRevision: null,
  position: { translationId: 'BSB', bookId: 'ROM', chapter, verse },
});

async function push(cookie: string, ops: SyncOp[]): Promise<PushResult[]> {
  const response = await inject('POST', cookie, '/api/sync/push', { ops });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().results;
}

async function pull(cookie: string, cursor?: string): Promise<PullResponse> {
  const response = await inject('GET', cookie, cursor === undefined ? '/api/sync/pull' : `/api/sync/pull?cursor=${cursor}`);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

describe('solo mode (S12.1, S12.2)', () => {
  test('S12.1 a user in no group, with the assistant offline, keeps notes and a solo position', async () => {
    const { owner, member, groupId } = await ownerAndMember();
    assert.equal((await inject('DELETE', owner.cookie, `/api/groups/${groupId}/members/${member.userId}`)).statusCode, 204);
    assert.deepEqual((await inject('GET', member.cookie, '/api/groups')).json(), []);
    // No connector is linked: the assistant is offline for the one member who may use it.
    assert.equal((await inject('GET', owner.cookie, '/api/assistant/status')).json().state, 'offline');

    const id = randomUUID();
    assert.deepEqual(
      (await push(member.cookie, [upsert(id, 'Counted as righteousness.'), moveTo(4, 3)])).map((r) => [r.outcome, r.revision]),
      [
        ['applied', 1],
        ['applied', 1],
      ],
    );
    const personal = await pull(member.cookie);
    assert.deepEqual(
      personal.notes.map((n) => [n.id, n.body, n.anchor]),
      [[id, 'Counted as righteousness.', romans4(3)]],
    );
    assert.deepEqual(personal.soloPosition, { translationId: 'BSB', bookId: 'ROM', chapter: 4, verse: 3, revision: 1 });
  });

  test('S12.2 moving through Romans 4 alone leaves the group stopping point; confirming the group stop leaves the solo position', async () => {
    const { owner, groupId } = await ownerAndMember();
    // No chapter is imported in this harness, so the group's stops are written directly; S9 tests the confirm endpoint.
    await h.db.query(
      `INSERT INTO group_progress (id, group_id, book_id, chapter, verse, confirmed_by, confirmed_at) VALUES (gen_random_uuid(), $1, 'ROM', 2, 11, $2, $3)`,
      [groupId, owner.userId, h.clock.now()],
    );
    const before = (await inject('GET', owner.cookie, `/api/groups/${groupId}/progress`)).json();

    for (const verse of [1, 9, 17, 25]) await push(owner.cookie, [moveTo(4, verse)]);
    assert.deepEqual((await pull(owner.cookie)).soloPosition, { translationId: 'BSB', bookId: 'ROM', chapter: 4, verse: 25, revision: 4 });
    assert.deepEqual((await inject('GET', owner.cookie, `/api/groups/${groupId}/progress`)).json(), before);

    h.clock.set('2026-11-01T13:00:00Z');
    await h.db.query(
      `INSERT INTO group_progress (id, group_id, book_id, chapter, verse, confirmed_by, confirmed_at, based_on_id)
       SELECT gen_random_uuid(), $1, 'ROM', 3, 8, $2, $3, id FROM group_progress WHERE group_id = $1`,
      [groupId, owner.userId, h.clock.now()],
    );
    assert.equal((await inject('GET', owner.cookie, `/api/groups/${groupId}/progress`)).json().progress.ref.chapter, 3);
    assert.deepEqual((await pull(owner.cookie)).soloPosition, { translationId: 'BSB', bookId: 'ROM', chapter: 4, verse: 25, revision: 4 });
  });
});

describe('private notes (S12.3)', () => {
  test('S12.3 a note on Romans 4:3 is pulled by its author only, and no group endpoint carries it', async () => {
    const { owner, member, groupId } = await ownerAndMember();
    const secret = 'Abraham believed — note only for me.';
    await push(member.cookie, [upsert(randomUUID(), secret)]);

    assert.deepEqual((await pull(member.cookie)).notes.map((n) => n.body), [secret]);
    const theirs = await pull(owner.cookie);
    assert.deepEqual(theirs.notes, []);
    assert.equal(theirs.soloPosition, null);

    for (const url of [
      `/api/groups/${groupId}`,
      `/api/groups/${groupId}/progress`,
      `/api/groups/${groupId}/occurrences`,
      `/api/groups/${groupId}/questions?book=ROM&chapter=4`,
      '/api/groups',
      '/api/me',
    ]) {
      for (const who of [owner, member]) {
        const response = await inject('GET', who.cookie, url);
        assert.ok(!response.body.includes('Abraham believed'), `${url} carries the note`);
      }
    }
  });

  test("another member cannot write over a note by reusing its id or an operation's id", async () => {
    const { owner, member } = await ownerAndMember();
    const id = randomUUID();
    const op = upsert(id, 'Mine.');
    await push(member.cookie, [op]);

    const taken = await inject('POST', owner.cookie, '/api/sync/push', { ops: [upsert(id, 'Overwritten.', 1)] });
    assert.equal(taken.statusCode, 400);
    const replayed = await inject('POST', owner.cookie, '/api/sync/push', { ops: [{ ...op, body: 'Overwritten.' }] });
    assert.equal(replayed.statusCode, 400);
    assert.deepEqual((await pull(member.cookie)).notes.map((n) => n.body), ['Mine.']);
  });

  test('an operation sent twice applies once and reports what the first attempt did (I-22)', async () => {
    const { member } = await ownerAndMember();
    const id = randomUUID();
    const op = upsert(id, 'First.');
    assert.deepEqual(await push(member.cookie, [op]), [{ opId: op.opId, outcome: 'applied', revision: 1 }]);
    assert.deepEqual(await push(member.cookie, [op]), [{ opId: op.opId, outcome: 'already_applied', revision: 1 }]);
    const rows = await h.db.query<{ revision: number }>('SELECT revision FROM notes WHERE id = $1', [id]);
    assert.deepEqual(rows.rows, [{ revision: 1 }]);
  });

  test('edits apply on the revision they saw; a stale edit with other text is kept as a conflict, not written over', async () => {
    const { member } = await ownerAndMember();
    const id = randomUUID();
    await push(member.cookie, [upsert(id, 'One.')]);
    assert.deepEqual((await push(member.cookie, [upsert(id, 'Two.', 1)])).map((r) => [r.outcome, r.revision]), [['applied', 2]]);

    // A second device still on revision 1.
    const [stale] = await push(member.cookie, [upsert(id, 'Other device.', 1)]);
    assert.equal(stale.outcome, 'conflict');
    assert.equal(stale.revision, 2);
    assert.ok(stale.conflictId);
    // The same text as the server holds is no conflict.
    assert.equal((await push(member.cookie, [upsert(id, 'Two.', 1)]))[0].outcome, 'already_applied');

    const personal = await pull(member.cookie);
    assert.deepEqual(personal.notes.map((n) => [n.body, n.revision]), [['Two.', 2]]);
    assert.deepEqual(personal.conflicts, [{ id: stale.conflictId, noteId: id, serverBody: 'Two.', incomingBody: 'Other device.' }]);
  });

  test('a conflicted operation sent again reports the same conflict and records no second one', async () => {
    const { member } = await ownerAndMember();
    const id = randomUUID();
    await push(member.cookie, [upsert(id, 'One.')]);
    await push(member.cookie, [upsert(id, 'Two.', 1)]);
    const stale = upsert(id, 'Other device.', 1);
    const [first] = await push(member.cookie, [stale]);
    assert.equal(first.outcome, 'conflict');
    assert.deepEqual(await push(member.cookie, [stale]), [{ opId: stale.opId, outcome: 'conflict', revision: 2, conflictId: first.conflictId }]);
    assert.equal((await pull(member.cookie)).conflicts.length, 1);
  });

  test('a delete on the current revision removes the note; pull after a cursor reports it deleted', async () => {
    const { member } = await ownerAndMember();
    const keep = randomUUID();
    const gone = randomUUID();
    await push(member.cookie, [upsert(keep, 'Keep.'), upsert(gone, 'Gone.', null, romans4(4))]);
    const { cursor } = await pull(member.cookie);

    const stale = await push(member.cookie, [{ opId: randomUUID(), entity: 'note', entityId: gone, op: 'delete', baseRevision: 0, deviceId: device }]);
    assert.equal(stale[0].outcome, 'conflict');
    const [removed] = await push(member.cookie, [{ opId: randomUUID(), entity: 'note', entityId: gone, op: 'delete', baseRevision: 1, deviceId: device }]);
    assert.deepEqual([removed.outcome, removed.revision], ['applied', 2]);

    const since = await pull(member.cookie, cursor);
    assert.deepEqual(since.notes.map((n) => [n.id, n.deleted, n.body]), [[gone, true, '']]);
    assert.ok(BigInt(since.cursor) > BigInt(cursor));
    assert.deepEqual((await pull(member.cookie, since.cursor)).notes, []);
    assert.deepEqual((await pull(member.cookie)).notes.map((n) => n.id), [keep]);
  });

  test('pushes that are malformed, too many or too large are refused whole', async () => {
    const { member } = await ownerAndMember();
    const id = randomUUID();
    for (const ops of [
      [{ ...upsert(id, 'x'), opId: 'not-a-uuid' }],
      [{ ...upsert(id, 'x'), anchor: { ...romans4(3), bookId: 'XYZ' } }],
      [{ ...upsert(id, 'x'), anchor: { ...romans4(3), chapter: 17 } }],
      [{ ...upsert(id, 'x'), anchor: { ...romans4(5), endVerse: 4 } }],
      [{ ...upsert(id, 'x'), body: 'nul\u0000' }],
      [{ ...upsert(id, 'x'), deviceId: '' }],
      [{ ...upsert(id, 'x'), deviceId: 'nul\u0000' }],
      [{ opId: randomUUID(), entity: 'note', entityId: id, op: 'delete', baseRevision: null, deviceId: device }],
      [{ ...moveTo(4, 3), position: { translationId: 'NIV', bookId: 'ROM', chapter: 4, verse: 3 } }],
      [upsert(id, 'Fine.'), { ...upsert(randomUUID(), 'x'), entity: 'bookmark' }],
    ]) {
      const response = await inject('POST', member.cookie, '/api/sync/push', { ops });
      assert.equal(response.statusCode, 400, JSON.stringify(ops).slice(0, 120));
      assert.equal(response.json().error, 'invalid_request');
    }
    assert.equal((await inject('GET', member.cookie, '/api/sync/pull?cursor=abc')).statusCode, 400);

    const tooMany = await inject('POST', member.cookie, '/api/sync/push', { ops: Array.from({ length: 201 }, () => moveTo(4, 1)) });
    assert.equal(tooMany.statusCode, 413);
    assert.equal(tooMany.json().error, 'payload_too_large');
    const tooLong = await inject('POST', member.cookie, '/api/sync/push', { ops: [upsert(randomUUID(), 'x'.repeat(64 * 1024 + 1))] });
    assert.equal(tooLong.statusCode, 413);
    const tooBig = await inject('POST', member.cookie, '/api/sync/push', { ops: [upsert(randomUUID(), 'x'.repeat(17 * 1024 * 1024))] });
    assert.equal(tooBig.statusCode, 413);
    assert.equal(tooBig.json().error, 'payload_too_large');

    assert.deepEqual((await pull(member.cookie)).notes, [], 'nothing from a refused push was kept');
  });

  test('push and pull need a session', async () => {
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/sync/pull' })).statusCode, 401);
    assert.equal((await h.app.inject({ method: 'POST', url: '/api/sync/push', payload: { ops: [] } })).statusCode, 401);
  });
});

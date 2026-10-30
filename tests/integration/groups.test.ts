import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import WebSocket from 'ws';
import { closeNotMember } from '../../src/shared/api.ts';
import { acceptInvitation } from '../../src/server/groups/groups.ts';
import { withTransaction } from '../../src/server/platform/db.ts';
import type { Harness } from '../support/harness.ts';
import { clearMailbox, ownerEmail, requestAndReceiveCode, signIn, startHarness, truncateAll } from '../support/harness.ts';

let h: Harness;

before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});
beforeEach(async () => {
  await truncateAll(h.db);
  await clearMailbox();
  h.clock.set('2026-11-01T12:00:00Z');
});

const day = 24 * 60 * 60 * 1000;
const get = (cookie: string, url: string) => h.app.inject({ method: 'GET', url, cookies: { bs_session: cookie } });
const post = (cookie: string, url: string, payload?: object) => h.app.inject({ method: 'POST', url, cookies: { bs_session: cookie }, payload });
const del = (cookie: string, url: string) => h.app.inject({ method: 'DELETE', url, cookies: { bs_session: cookie } });

async function ownerWithGroup(): Promise<{ cookie: string; userId: string; groupId: string }> {
  const owner = await signIn(h, ownerEmail);
  const groups = (await get(owner.cookie, '/api/groups')).json();
  return { ...owner, groupId: groups[0].id };
}

async function createLink(cookie: string, groupId: string): Promise<{ id: string; token: string }> {
  const response = await post(cookie, `/api/groups/${groupId}/invitations`);
  assert.equal(response.statusCode, 200, response.body);
  const { id, link } = response.json();
  return { id, token: new URL(link).pathname.replace('/join/', '') };
}

async function memberships(groupId: string): Promise<{ user_id: string; role: string; removed: boolean }[]> {
  const rows = await h.db.query<{ user_id: string; role: string; removed: boolean }>(
    'SELECT user_id, role, removed_at IS NOT NULL AS removed FROM memberships WHERE group_id = $1 ORDER BY joined_at',
    [groupId],
  );
  return rows.rows;
}

describe('S4.1 the owner bootstraps the group', () => {
  test('the first sign-in by OWNER_EMAIL creates one group, Monday 06:15 America/Chicago from Romans 1, owned by that user', async () => {
    const owner = await signIn(h, 'Owner@Example.test');
    const groups = (await get(owner.cookie, '/api/groups')).json();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].role, 'owner');

    const view = (await get(owner.cookie, `/api/groups/${groups[0].id}`)).json();
    assert.deepEqual(view.schedule, { weekday: 1, localTime: '06:15', timeZone: 'America/Chicago' });
    assert.deepEqual(view.members, [{ userId: owner.userId, displayName: view.members[0].displayName, role: 'owner' }]);
    assert.equal(view.sharedTranslationId, 'BSB');
    const row = await h.db.query('SELECT owner_id, start_book_id, start_chapter FROM groups');
    assert.deepEqual(row.rows, [{ owner_id: owner.userId, start_book_id: 'ROM', start_chapter: 1 }]);
  });

  test('signing in again, or anyone else signing in first, creates no further group', async () => {
    const other = await signIn(h, 'someone@example.test');
    assert.deepEqual((await get(other.cookie, '/api/groups')).json(), []);
    assert.equal((await h.db.query('SELECT 1 FROM groups')).rowCount, 0);

    await signIn(h, ownerEmail);
    await signIn(h, ownerEmail);
    assert.equal((await h.db.query('SELECT 1 FROM groups')).rowCount, 1);
    assert.deepEqual((await get(other.cookie, '/api/groups')).json(), []);
  });
});

describe('S4.2 joining through a link', () => {
  test('a new user signing in through the link joins; the same link used by a third user is invalid and adds nobody', async () => {
    const owner = await ownerWithGroup();
    const link = await createLink(owner.cookie, owner.groupId);

    const invitee = await signIn(h, 'invitee@example.test', link.token);
    assert.equal(invitee.invitation, 'accepted');
    assert.equal(invitee.joinedGroupId, owner.groupId);
    const view = (await get(invitee.cookie, `/api/groups/${owner.groupId}`)).json();
    assert.equal(view.role, 'member');
    assert.deepEqual(
      view.members.map((m: { userId: string; role: string }) => [m.userId, m.role]),
      [
        [owner.userId, 'owner'],
        [invitee.userId, 'member'],
      ],
    );

    const third = await signIn(h, 'third@example.test', link.token);
    assert.equal(third.invitation, 'invalid');
    assert.equal(third.joinedGroupId, null);
    assert.equal((await memberships(owner.groupId)).length, 2);
    assert.equal((await get(third.cookie, `/api/groups/${owner.groupId}`)).statusCode, 403);

    const listed = (await get(owner.cookie, `/api/groups/${owner.groupId}/invitations`)).json();
    assert.deepEqual(
      listed.map((i: { id: string; state: string }) => [i.id, i.state]),
      [[link.id, 'accepted']],
    );
  });

  test('the token sent at verify works too, and a link opened while signed in joins without a code', async () => {
    const owner = await ownerWithGroup();
    const first = await createLink(owner.cookie, owner.groupId);
    const email = 'verify-token@example.test';
    const code = await requestAndReceiveCode(h, email);
    const verified = await h.app.inject({ method: 'POST', url: '/api/auth/verify', payload: { email, code, invitationToken: first.token } });
    assert.deepEqual([verified.json().invitation, verified.json().joinedGroupId], ['accepted', owner.groupId]);

    const second = await createLink(owner.cookie, owner.groupId);
    const signedIn = await signIn(h, 'already@example.test');
    const accepted = await post(signedIn.cookie, '/api/invitations/accept', { token: second.token });
    assert.deepEqual(accepted.json(), { joinedGroupId: owner.groupId, invitation: 'accepted' });
    const again = await post((await signIn(h, 'late@example.test')).cookie, '/api/invitations/accept', { token: second.token });
    assert.deepEqual(again.json(), { joinedGroupId: null, invitation: 'invalid' });
  });

  test('a current member opening a link joins nothing new and leaves the link for its invitee', async () => {
    const owner = await ownerWithGroup();
    const link = await createLink(owner.cookie, owner.groupId);
    const opened = await post(owner.cookie, '/api/invitations/accept', { token: link.token });
    assert.deepEqual(opened.json(), { joinedGroupId: owner.groupId, invitation: 'accepted' });
    assert.equal((await signIn(h, 'invitee@example.test', link.token)).invitation, 'accepted');
  });

  test('two people accepting one link at the same moment produce one membership (I-05)', async () => {
    const owner = await ownerWithGroup();
    const link = await createLink(owner.cookie, owner.groupId);
    const a = await signIn(h, 'a@example.test');
    const b = await signIn(h, 'b@example.test');
    const results = await Promise.all(
      [a.userId, b.userId].map((userId) => withTransaction(h.db, (tx) => acceptInvitation(tx, h.clock, userId, link.token))),
    );
    assert.equal(results.filter((r) => 'groupId' in r).length, 1);
    assert.deepEqual(
      results.filter((r) => 'invalid' in r),
      [{ invalid: 'accepted' }],
    );
    assert.equal((await memberships(owner.groupId)).length, 2);
  });

  test('an unknown token and a non-string token are invalid without an error', async () => {
    const owner = await ownerWithGroup();
    const email = 'user@example.test';
    const code = await requestAndReceiveCode(h, email, '203.0.113.10', 'not-a-real-token');
    const verified = await h.app.inject({ method: 'POST', url: '/api/auth/verify', payload: { email, code, invitationToken: 'not-a-real-token' } });
    assert.equal(verified.statusCode, 200);
    assert.equal(verified.json().invitation, 'invalid');
    const user = await signIn(h, 'other@example.test');
    assert.deepEqual((await post(user.cookie, '/api/invitations/accept', { token: 42 })).json(), { joinedGroupId: null, invitation: 'invalid' });
    assert.equal((await memberships(owner.groupId)).length, 1);
  });
});

describe('S4.3 revoked and expired links', () => {
  test('a revoked link is invalid', async () => {
    const owner = await ownerWithGroup();
    const link = await createLink(owner.cookie, owner.groupId);
    assert.equal((await del(owner.cookie, `/api/groups/${owner.groupId}/invitations/${link.id}`)).statusCode, 204);
    const user = await signIn(h, 'late@example.test', link.token);
    assert.equal(user.invitation, 'invalid');
    assert.equal((await memberships(owner.groupId)).length, 1);
    const listed = (await get(owner.cookie, `/api/groups/${owner.groupId}/invitations`)).json();
    assert.equal(listed[0].state, 'revoked');
  });

  test('a link 14 days and 1 second old is invalid; one a second short of 14 days still works', async () => {
    const owner = await ownerWithGroup();
    const old = await createLink(owner.cookie, owner.groupId);
    h.clock.advance(2000);
    const fresh = await createLink(owner.cookie, owner.groupId);

    h.clock.set(new Date(Date.parse('2026-11-01T12:00:00Z') + 14 * day + 1000).toISOString());
    // The code request happens before the deadline, so the code itself is valid when typed.
    const expired = await signIn(h, 'expired@example.test', old.token);
    assert.equal(expired.invitation, 'invalid');
    const states = (await get(owner.cookie, `/api/groups/${owner.groupId}/invitations`)).json().map((i: { id: string; state: string }) => [i.id, i.state]);
    assert.deepEqual(states, [
      [fresh.id, 'open'],
      [old.id, 'expired'],
    ]);

    const inTime = await signIn(h, 'intime@example.test', fresh.token);
    assert.equal(inTime.invitation, 'accepted');
  });

  test('revoking an accepted link leaves it accepted', async () => {
    const owner = await ownerWithGroup();
    const link = await createLink(owner.cookie, owner.groupId);
    await signIn(h, 'invitee@example.test', link.token);
    assert.equal((await del(owner.cookie, `/api/groups/${owner.groupId}/invitations/${link.id}`)).statusCode, 204);
    assert.equal((await get(owner.cookie, `/api/groups/${owner.groupId}/invitations`)).json()[0].state, 'accepted');
    assert.equal((await del(owner.cookie, `/api/groups/${owner.groupId}/invitations/00000000-0000-7000-8000-000000000000`)).statusCode, 404);
  });
});

describe('S4.4 owner-only and member-only operations', () => {
  test('a member calling create, list, revoke or remove gets not_owner', async () => {
    const owner = await ownerWithGroup();
    const link = await createLink(owner.cookie, owner.groupId);
    const member = await signIn(h, 'member@example.test', link.token);
    const other = await createLink(owner.cookie, owner.groupId);

    const calls = [
      await post(member.cookie, `/api/groups/${owner.groupId}/invitations`),
      await get(member.cookie, `/api/groups/${owner.groupId}/invitations`),
      await del(member.cookie, `/api/groups/${owner.groupId}/invitations/${other.id}`),
      await del(member.cookie, `/api/groups/${owner.groupId}/members/${owner.userId}`),
      await del(member.cookie, `/api/groups/${owner.groupId}/members/${member.userId}`),
    ];
    for (const response of calls) {
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error, 'not_owner');
    }
    assert.equal((await get(owner.cookie, `/api/groups/${owner.groupId}/invitations`)).json().find((i: { id: string }) => i.id === other.id).state, 'open');
  });

  test('a signed-in non-member gets not_member for the group and its invitations; a malformed id is not_member too', async () => {
    const owner = await ownerWithGroup();
    const outsider = await signIn(h, 'outsider@example.test');
    for (const url of [`/api/groups/${owner.groupId}`, `/api/groups/${owner.groupId}/invitations`, '/api/groups/not-a-uuid']) {
      const response = await get(outsider.cookie, url);
      assert.equal(response.statusCode, 403, url);
      assert.equal(response.json().error, 'not_member');
    }
    assert.equal((await post(outsider.cookie, `/api/groups/${owner.groupId}/invitations`)).json().error, 'not_member');
  });

  test('group routes need a session', async () => {
    const owner = await ownerWithGroup();
    for (const url of ['/api/groups', `/api/groups/${owner.groupId}`]) {
      const response = await h.app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 401);
    }
    assert.equal((await h.app.inject({ method: 'POST', url: '/api/invitations/accept', payload: { token: 'x' } })).statusCode, 401);
  });

  test('the owner cannot remove themselves', async () => {
    const owner = await ownerWithGroup();
    const response = await del(owner.cookie, `/api/groups/${owner.groupId}/members/${owner.userId}`);
    assert.equal(response.statusCode, 400);
    assert.equal((await memberships(owner.groupId))[0].removed, false);
  });
});

describe('S4.5 removing a member', () => {
  let baseUrl: string;

  before(async () => {
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = `ws://127.0.0.1:${(h.app.server.address() as AddressInfo).port}/ws`;
  });

  function connect(cookie?: string): Promise<{ socket: WebSocket; messages: unknown[]; closed: Promise<number> }> {
    const socket = new WebSocket(baseUrl, { headers: cookie ? { cookie: `bs_session=${cookie}` } : {} });
    const messages: unknown[] = [];
    socket.on('message', (data) => messages.push(JSON.parse(String(data))));
    const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve({ socket, messages, closed }));
      socket.once('unexpected-response', (_request, response) => reject(new Error(`upgrade refused: ${response.statusCode}`)));
      socket.once('error', reject);
    });
  }

  async function nextMessage(messages: unknown[], count: number): Promise<unknown> {
    const deadline = Date.now() + 5000;
    while (messages.length < count) {
      if (Date.now() > deadline) throw new Error('no message');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return messages[count - 1];
  }

  test("the removed member's next request is not_member and their open realtime connection closes", async () => {
    const owner = await ownerWithGroup();
    const link = await createLink(owner.cookie, owner.groupId);
    const member = await signIn(h, 'member@example.test', link.token);

    const memberSocket = await connect(member.cookie);
    const ownerSocket = await connect(owner.cookie);
    memberSocket.socket.send(JSON.stringify({ t: 'ping', clientSentMs: 5 }));
    const pong = (await nextMessage(memberSocket.messages, 1)) as { t: string; clientSentMs: number; serverMs: number };
    assert.deepEqual(pong, { t: 'pong', clientSentMs: 5, serverMs: h.clock.now().getTime() });

    assert.equal((await del(owner.cookie, `/api/groups/${owner.groupId}/members/${member.userId}`)).statusCode, 204);
    assert.equal(await memberSocket.closed, closeNotMember);
    assert.deepEqual(memberSocket.messages[1], { t: 'error', error: 'not_member', retryable: false });
    assert.equal(h.hub.connections(member.userId), 0);
    assert.equal(h.hub.connections(owner.userId), 1);

    const after = await get(member.cookie, `/api/groups/${owner.groupId}`);
    assert.equal(after.statusCode, 403);
    assert.equal(after.json().error, 'not_member');
    assert.deepEqual((await get(member.cookie, '/api/groups')).json(), []);
    assert.deepEqual(
      (await get(owner.cookie, `/api/groups/${owner.groupId}`)).json().members.map((m: { userId: string }) => m.userId),
      [owner.userId],
    );
    assert.equal((await del(owner.cookie, `/api/groups/${owner.groupId}/members/${member.userId}`)).statusCode, 404);

    ownerSocket.socket.close();
    await ownerSocket.closed;
  });

  test('a removed member needs a new link to come back, and the old one stays used', async () => {
    const owner = await ownerWithGroup();
    const link = await createLink(owner.cookie, owner.groupId);
    const member = await signIn(h, 'member@example.test', link.token);
    await del(owner.cookie, `/api/groups/${owner.groupId}/members/${member.userId}`);

    assert.deepEqual((await post(member.cookie, '/api/invitations/accept', { token: link.token })).json(), { joinedGroupId: null, invitation: 'invalid' });
    const fresh = await createLink(owner.cookie, owner.groupId);
    assert.deepEqual((await post(member.cookie, '/api/invitations/accept', { token: fresh.token })).json(), {
      joinedGroupId: owner.groupId,
      invitation: 'accepted',
    });
    assert.equal((await get(member.cookie, `/api/groups/${owner.groupId}`)).statusCode, 200);
  });

  test('the realtime channel refuses an upgrade without a session and answers unknown messages with invalid_request', async () => {
    await assert.rejects(connect(), /upgrade refused: 401/);
    const user = await signIn(h, 'user@example.test');
    const { socket, messages, closed } = await connect(user.cookie);
    socket.send('not json');
    assert.deepEqual(await nextMessage(messages, 1), { t: 'error', error: 'invalid_request', retryable: false });
    socket.close();
    await closed;
  });
});

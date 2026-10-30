import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { closeNotMember, closeSignedOut } from '../../src/shared/api.ts';
import { createRealtimeHub } from '../../src/server/study/realtime.ts';
import type { RealtimeHub, Socket } from '../../src/server/study/realtime.ts';

type FakeSocket = Socket & { sent: string[]; closed: [number, string?][]; messages(): { t: string; [key: string]: unknown }[] };

function fakeSocket(failSend = false): FakeSocket {
  const socket: FakeSocket = {
    sent: [],
    closed: [],
    send(data: string) {
      if (failSend) throw new Error('socket closing');
      socket.sent.push(data);
    },
    close(code: number, reason?: string) {
      socket.closed.push([code, reason]);
    },
    messages() {
      return socket.sent.map((m) => JSON.parse(m));
    },
  };
  return socket;
}

function connect(hub: RealtimeHub, userId: string, displayName = userId, authSessionId = `auth-${userId}`, failSend = false) {
  const socket = fakeSocket(failSend);
  return { socket, connection: hub.add({ userId, authSessionId, displayName, socket }) };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('realtime hub', () => {
  test("closeUser tells each of the user's sockets not_member and closes it with 4403, leaving others open", () => {
    const hub = createRealtimeHub();
    const a = connect(hub, 'u1');
    const b = connect(hub, 'u1', 'u1', 'auth-u1', true);
    const other = connect(hub, 'u2');
    hub.closeUser('u1');
    assert.deepEqual(a.socket.messages(), [{ t: 'error', error: 'not_member', retryable: false }]);
    assert.deepEqual(a.socket.closed, [[closeNotMember, 'not_member']]);
    assert.deepEqual(b.socket.closed, [[closeNotMember, 'not_member']], 'a failed send still closes');
    assert.equal(hub.connections('u1'), 0);
    assert.equal(hub.connections('u2'), 1);
    assert.deepEqual(other.socket.closed, []);
    hub.closeUser('nobody');
  });

  test('closeAuthSession closes only the connections of that sign-in with 4401', () => {
    const hub = createRealtimeHub();
    const phone = connect(hub, 'u1', 'u1', 'auth-phone');
    const laptop = connect(hub, 'u1', 'u1', 'auth-laptop');
    hub.closeAuthSession('auth-phone');
    assert.deepEqual(phone.socket.messages(), [{ t: 'error', error: 'unauthenticated', retryable: false }]);
    assert.deepEqual(phone.socket.closed, [[closeSignedOut, 'unauthenticated']]);
    assert.deepEqual(laptop.socket.closed, []);
    assert.equal(hub.connections('u1'), 1);
  });

  test('remove is idempotent and removes just that connection', () => {
    const hub = createRealtimeHub();
    const first = connect(hub, 'u1');
    connect(hub, 'u1');
    hub.remove(first.connection);
    hub.remove(first.connection);
    assert.equal(hub.connections('u1'), 1);
  });

  test('presence is one entry per user, counting connections, ready if any connection is ready', () => {
    const hub = createRealtimeHub();
    const anna1 = connect(hub, 'u-anna', 'Anna');
    const anna2 = connect(hub, 'u-anna', 'Anna');
    const ben = connect(hub, 'u-ben', 'Ben');
    for (const c of [ben, anna1, anna2]) hub.join(c.connection, 's1');
    hub.setReady(anna2.connection, true);
    assert.deepEqual(hub.presence('s1'), [
      { userId: 'u-anna', displayName: 'Anna', connections: 2, ready: true },
      { userId: 'u-ben', displayName: 'Ben', connections: 1, ready: false },
    ]);
    assert.deepEqual(hub.presence('other'), []);
  });

  test('joining tells the others in the room, not the joiner; leaving tells those who remain', () => {
    const hub = createRealtimeHub();
    const anna = connect(hub, 'u-anna', 'Anna');
    const ben = connect(hub, 'u-ben', 'Ben');
    hub.join(anna.connection, 's1');
    assert.deepEqual(anna.socket.messages(), []);
    hub.join(ben.connection, 's1');
    assert.deepEqual(ben.socket.messages(), []);
    assert.deepEqual(anna.socket.messages().at(-1), {
      t: 'presence',
      presence: [
        { userId: 'u-anna', displayName: 'Anna', connections: 1, ready: false },
        { userId: 'u-ben', displayName: 'Ben', connections: 1, ready: false },
      ],
    });
    hub.remove(ben.connection);
    assert.deepEqual(anna.socket.messages().at(-1), { t: 'presence', presence: [{ userId: 'u-anna', displayName: 'Anna', connections: 1, ready: false }] });
  });

  test('setReady broadcasts only when presence changes', () => {
    const hub = createRealtimeHub();
    const anna1 = connect(hub, 'u-anna', 'Anna');
    const anna2 = connect(hub, 'u-anna', 'Anna');
    const ben = connect(hub, 'u-ben', 'Ben');
    for (const c of [anna1, anna2, ben]) hub.join(c.connection, 's1');
    const before = ben.socket.sent.length;
    hub.setReady(anna1.connection, true);
    assert.equal(ben.socket.sent.length, before + 1);
    hub.setReady(anna2.connection, true);
    hub.setReady(anna2.connection, true);
    assert.equal(ben.socket.sent.length, before + 1, "Anna's second ready tab changes nothing");
  });

  test('broadcast skips the excepted connection and other rooms', () => {
    const hub = createRealtimeHub();
    const a = connect(hub, 'u1');
    const b = connect(hub, 'u2');
    const elsewhere = connect(hub, 'u3');
    hub.join(a.connection, 's1');
    hub.join(b.connection, 's1');
    hub.join(elsewhere.connection, 's2');
    const counts = [a, b, elsewhere].map((c) => c.socket.sent.length);
    hub.broadcast('s1', { t: 'pong', clientSentMs: 1, serverMs: 2 }, a.connection);
    assert.deepEqual(
      [a, b, elsewhere].map((c, i) => c.socket.sent.length - counts[i]),
      [0, 1, 0],
    );
  });

  test('the room-empty handler runs once the last connection has been gone for the grace period', async () => {
    const hub = createRealtimeHub({ emptyRoomGraceMs: 30 });
    const emptied: string[] = [];
    hub.onRoomEmpty((sessionId) => emptied.push(sessionId));
    const a = connect(hub, 'u1');
    const b = connect(hub, 'u2');
    hub.join(a.connection, 's1');
    hub.join(b.connection, 's1');
    hub.remove(a.connection);
    await wait(60);
    assert.deepEqual(emptied, [], 'someone is still in the room');
    hub.remove(b.connection);
    await wait(60);
    assert.deepEqual(emptied, ['s1']);
    hub.stop();
  });

  test('a rejoin within the grace period cancels the pause', async () => {
    const hub = createRealtimeHub({ emptyRoomGraceMs: 40 });
    const emptied: string[] = [];
    hub.onRoomEmpty((sessionId) => emptied.push(sessionId));
    const a = connect(hub, 'u1');
    hub.join(a.connection, 's1');
    hub.remove(a.connection);
    await wait(10);
    const again = connect(hub, 'u1');
    hub.join(again.connection, 's1');
    await wait(70);
    assert.deepEqual(emptied, []);
    hub.stop();
  });

  test('stop cancels pending room-empty timers', async () => {
    const hub = createRealtimeHub({ emptyRoomGraceMs: 20 });
    const emptied: string[] = [];
    hub.onRoomEmpty((sessionId) => emptied.push(sessionId));
    const a = connect(hub, 'u1');
    hub.join(a.connection, 's1');
    hub.remove(a.connection);
    hub.stop();
    await wait(50);
    assert.deepEqual(emptied, []);
  });

  test('sockets closing after stop start no room-empty timers', async () => {
    const hub = createRealtimeHub({ emptyRoomGraceMs: 20 });
    const emptied: string[] = [];
    hub.onRoomEmpty((sessionId) => emptied.push(sessionId));
    const a = connect(hub, 'u1');
    hub.join(a.connection, 's1');
    hub.stop();
    hub.remove(a.connection);
    await wait(50);
    assert.deepEqual(emptied, []);
  });

  test('a removed connection cannot join', () => {
    const hub = createRealtimeHub();
    const a = connect(hub, 'u1');
    hub.remove(a.connection);
    hub.join(a.connection, 's1');
    assert.deepEqual(hub.presence('s1'), []);
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { closeNotMember } from '../../src/shared/api.ts';
import { createRealtimeHub } from '../../src/server/study/realtime.ts';
import type { Socket } from '../../src/server/study/realtime.ts';

function fakeSocket(failSend = false): Socket & { sent: string[]; closed: [number, string?][] } {
  const socket = {
    sent: [] as string[],
    closed: [] as [number, string?][],
    send(data: string) {
      if (failSend) throw new Error('socket closing');
      socket.sent.push(data);
    },
    close(code: number, reason?: string) {
      socket.closed.push([code, reason]);
    },
  };
  return socket;
}

describe('realtime hub', () => {
  test("closeUser tells each of the user's sockets not_member and closes it with 4403, leaving others open", () => {
    const hub = createRealtimeHub();
    const [a, b, other] = [fakeSocket(), fakeSocket(true), fakeSocket()];
    hub.register('u1', a);
    hub.register('u1', b);
    hub.register('u2', other);
    hub.closeUser('u1');
    assert.deepEqual(a.sent.map((m) => JSON.parse(m)), [{ t: 'error', error: 'not_member', retryable: false }]);
    assert.deepEqual(a.closed, [[closeNotMember, 'not_member']]);
    assert.deepEqual(b.closed, [[closeNotMember, 'not_member']], 'a failed send still closes');
    assert.equal(hub.connections('u1'), 0);
    assert.equal(hub.connections('u2'), 1);
    assert.deepEqual(other.closed, []);
    hub.closeUser('nobody');
  });

  test('an old socket unregistering after a reconnect leaves the new one registered', () => {
    const hub = createRealtimeHub();
    const unregisterOld = hub.register('u1', fakeSocket());
    hub.closeUser('u1');
    hub.register('u1', fakeSocket());
    unregisterOld();
    assert.equal(hub.connections('u1'), 1);
  });

  test('unregister removes just that socket', () => {
    const hub = createRealtimeHub();
    const first = hub.register('u1', fakeSocket());
    hub.register('u1', fakeSocket());
    first();
    first();
    assert.equal(hub.connections('u1'), 1);
  });
});

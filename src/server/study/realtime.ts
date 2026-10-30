import type { Presence, ServerMessage } from '../../shared/api.ts';
import { closeNotMember, closeSignedOut } from '../../shared/api.ts';

// The part of a WebSocket the hub needs; `ws` sockets satisfy it.
export interface Socket {
  send(data: string): void;
  close(code: number, reason?: string): void;
}

// One open /ws connection. `sessionId` is the study session it joined; presence is per session.
export interface Connection {
  readonly userId: string;
  readonly authSessionId: string;
  displayName: string;
  readonly socket: Socket;
  clientId: string | null;
  sessionId: string | null;
  ready: boolean;
}

export interface RealtimeHub {
  add(connection: { userId: string; authSessionId: string; displayName: string; socket: Socket }): Connection;
  // Safe to call more than once; a connection leaving its room updates presence.
  remove(connection: Connection): void;
  join(connection: Connection, sessionId: string): void;
  setReady(connection: Connection, ready: boolean): void;
  presence(sessionId: string): Presence[];
  broadcast(sessionId: string, message: ServerMessage, except?: Connection): void;
  closeUser(userId: string): void;
  closeAuthSession(authSessionId: string): void;
  connections(userId: string): number;
  // Called once a session's room has stayed empty for the grace period.
  onRoomEmpty(handler: (sessionId: string) => void): void;
  stop(): void;
}

function send(socket: Socket, message: ServerMessage): void {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // Already closing; its close event removes it.
  }
}

export function createRealtimeHub(options: { emptyRoomGraceMs?: number } = {}): RealtimeHub {
  const graceMs = options.emptyRoomGraceMs ?? 20_000;
  const all = new Set<Connection>();
  const rooms = new Map<string, Set<Connection>>();
  const emptyTimers = new Map<string, NodeJS.Timeout>();
  // After stop, sockets closing with the server start no grace periods: restart recovery pauses their sessions.
  let stopped = false;
  let roomEmpty: (sessionId: string) => void = () => undefined;

  function presence(sessionId: string): Presence[] {
    const byUser = new Map<string, Presence>();
    for (const c of rooms.get(sessionId) ?? []) {
      const entry = byUser.get(c.userId) ?? { userId: c.userId, displayName: c.displayName, connections: 0, ready: false };
      entry.connections += 1;
      entry.ready ||= c.ready;
      byUser.set(c.userId, entry);
    }
    return [...byUser.values()].sort((a, b) => a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId));
  }

  function broadcast(sessionId: string, message: ServerMessage, except?: Connection): void {
    for (const c of rooms.get(sessionId) ?? []) if (c !== except) send(c.socket, message);
  }

  function leave(connection: Connection): void {
    const sessionId = connection.sessionId;
    if (!sessionId) return;
    connection.sessionId = null;
    connection.ready = false;
    const room = rooms.get(sessionId);
    room?.delete(connection);
    if (room?.size) {
      broadcast(sessionId, { t: 'presence', presence: presence(sessionId) });
      return;
    }
    rooms.delete(sessionId);
    if (stopped) return;
    // The starter leaving changes nothing; only the last connection leaving starts the grace period.
    clearTimeout(emptyTimers.get(sessionId));
    emptyTimers.set(
      sessionId,
      setTimeout(() => {
        emptyTimers.delete(sessionId);
        if (!rooms.get(sessionId)?.size) roomEmpty(sessionId);
      }, graceMs),
    );
  }

  function close(connections: Connection[], code: number, message: ServerMessage): void {
    for (const c of connections) {
      remove(c);
      send(c.socket, message);
      c.socket.close(code, message.t === 'error' ? message.error : undefined);
    }
  }

  function remove(connection: Connection): void {
    if (!all.delete(connection)) return;
    leave(connection);
  }

  return {
    add(fields) {
      const connection: Connection = { ...fields, clientId: null, sessionId: null, ready: false };
      all.add(connection);
      return connection;
    },
    remove,
    join(connection, sessionId) {
      if (!all.has(connection)) return;
      if (connection.sessionId !== sessionId) leave(connection);
      connection.sessionId = sessionId;
      let room = rooms.get(sessionId);
      if (!room) rooms.set(sessionId, (room = new Set()));
      room.add(connection);
      clearTimeout(emptyTimers.get(sessionId));
      emptyTimers.delete(sessionId);
      broadcast(sessionId, { t: 'presence', presence: presence(sessionId) }, connection);
    },
    setReady(connection, ready) {
      if (connection.ready === ready || !connection.sessionId) return;
      const before = JSON.stringify(presence(connection.sessionId));
      connection.ready = ready;
      const after = presence(connection.sessionId);
      if (JSON.stringify(after) !== before) broadcast(connection.sessionId, { t: 'presence', presence: after });
    },
    presence,
    broadcast,
    // v1 has one group, so a removed member has nothing left the channel could serve.
    closeUser(userId) {
      close([...all].filter((c) => c.userId === userId), closeNotMember, { t: 'error', error: 'not_member', retryable: false });
    },
    closeAuthSession(authSessionId) {
      close([...all].filter((c) => c.authSessionId === authSessionId), closeSignedOut, { t: 'error', error: 'unauthenticated', retryable: false });
    },
    connections(userId) {
      let count = 0;
      for (const c of all) if (c.userId === userId) count += 1;
      return count;
    },
    onRoomEmpty(handler) {
      roomEmpty = handler;
    },
    stop() {
      stopped = true;
      for (const timer of emptyTimers.values()) clearTimeout(timer);
      emptyTimers.clear();
    },
  };
}

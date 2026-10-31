// The realtime channel: one WebSocket per tab, a server clock estimate, and the joined study session.
// Commands are never queued: a command sent while disconnected is refused, and a reconnect starts from a fresh snapshot.
import type { ClientMessage, Command, ServerMessage } from '../shared/api.ts';
import { closeNotMember, closeSignedOut, closeTooMany, closeUnavailable } from '../shared/api.ts';

// 'unavailable' is reconnecting after the server said its database is down.
export type LiveStatus = 'connecting' | 'open' | 'reconnecting' | 'unavailable' | { closed: 'not_member' | 'signed_out' | 'too_many' };

export interface Live {
  join(sessionId: string): void;
  // The command's id, or null when the channel is not open and nothing was sent.
  command(sessionId: string, expectedRevision: number, command: Command): string | null;
  drift(sessionId: string, driftMs: number, ready: boolean): void;
  // The server's clock now, in ms, from the lowest-latency of the recent pings.
  serverNow(): number;
  // True once a pong has measured the server clock.
  clockReady(): boolean;
  close(): void;
}

const pingEveryMs = 5_000;
const quickPings = 8;
const samplesKept = 8;
// Clients ping every 5 s; a server that answers nothing for this long is gone.
const silenceMs = 15_000;
const maxBackoffMs = 10_000;

const now = () => performance.timeOrigin + performance.now();

export function connectLive(handlers: { onMessage: (message: ServerMessage) => void; onStatus: (status: LiveStatus) => void }): Live {
  const clientId = crypto.randomUUID();
  const samples: { rtt: number; offset: number }[] = [];
  let offset = 0;
  let socket: WebSocket | null = null;
  let sessionId: string | null = null;
  let attempt = 0;
  let stopped = false;
  let pingTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastHeard = 0;

  function send(message: ClientMessage): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function ping(count: number) {
    if (now() - lastHeard > silenceMs) {
      // Half-open: close and let the close handler reconnect.
      socket?.close();
      return;
    }
    send({ t: 'ping', clientSentMs: now() });
    pingTimer = setTimeout(() => ping(count + 1), count < quickPings ? 250 : pingEveryMs);
  }

  function open() {
    handlers.onStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      lastHeard = now();
      handlers.onStatus('open');
      send({ t: 'hello', clientId });
      if (sessionId) send({ t: 'join', sessionId });
      ping(0);
    };
    ws.onmessage = (event) => {
      lastHeard = now();
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (message.t === 'pong') {
        const received = now();
        const rtt = received - message.clientSentMs;
        samples.push({ rtt, offset: message.serverMs - (message.clientSentMs + rtt / 2) });
        if (samples.length > samplesKept) samples.shift();
        offset = samples.reduce((best, s) => (s.rtt < best.rtt ? s : best)).offset;
        return;
      }
      handlers.onMessage(message);
    };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = null;
      clearTimeout(pingTimer);
      if (stopped) return;
      const closed = event.code === closeNotMember ? 'not_member' : event.code === closeSignedOut ? 'signed_out' : event.code === closeTooMany ? 'too_many' : null;
      if (closed) {
        handlers.onStatus({ closed });
        return;
      }
      attempt += 1;
      handlers.onStatus(event.code === closeUnavailable ? 'unavailable' : 'reconnecting');
      const delay = Math.min(maxBackoffMs, 500 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
      retryTimer = setTimeout(open, delay);
    };
  }

  open();

  return {
    join(id) {
      sessionId = id;
      send({ t: 'join', sessionId: id });
    },
    command(id, expectedRevision, command) {
      const commandId = crypto.randomUUID();
      return send({ t: 'command', sessionId: id, commandId, expectedRevision, command }) ? commandId : null;
    },
    drift(id, driftMs, ready) {
      send({ t: 'drift', sessionId: id, driftMs, ready });
    },
    serverNow: () => now() + offset,
    clockReady: () => samples.length > 0,
    close() {
      stopped = true;
      clearTimeout(pingTimer);
      clearTimeout(retryTimer);
      socket?.close();
      socket = null;
    },
  };
}

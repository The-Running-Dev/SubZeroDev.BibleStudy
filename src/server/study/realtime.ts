import type { ServerMessage } from '../../shared/api.ts';
import { closeNotMember } from '../../shared/api.ts';

// The part of a WebSocket the hub needs; `ws` sockets satisfy it.
export interface Socket {
  send(data: string): void;
  close(code: number, reason?: string): void;
}

// Open realtime connections by user, so losing access can end them at once.
export interface RealtimeHub {
  register(userId: string, socket: Socket): () => void;
  closeUser(userId: string): void;
  connections(userId: string): number;
}

export function createRealtimeHub(): RealtimeHub {
  const byUser = new Map<string, Set<Socket>>();
  return {
    register(userId, socket) {
      let sockets = byUser.get(userId);
      if (!sockets) byUser.set(userId, (sockets = new Set()));
      sockets.add(socket);
      return () => {
        sockets.delete(socket);
        if (!sockets.size && byUser.get(userId) === sockets) byUser.delete(userId);
      };
    },
    // v1 has one group, so a removed member has nothing left the channel could serve.
    closeUser(userId) {
      const sockets = byUser.get(userId);
      if (!sockets) return;
      byUser.delete(userId);
      const message: ServerMessage = { t: 'error', error: 'not_member', retryable: false };
      for (const socket of sockets) {
        try {
          socket.send(JSON.stringify(message));
        } catch {
          // Already closing; the close below still ends it.
        }
        socket.close(closeNotMember, 'not_member');
      }
    },
    connections(userId) {
      return byUser.get(userId)?.size ?? 0;
    },
  };
}

import { spawn } from 'node:child_process';
import readline from 'node:readline';

// A JSON-RPC 2.0 client for the AgentConsole runtime: one JSON object per line over the child's stdio.
// Only the session, turn, event and permission methods are used; never admin.* or host.*.

export interface RuntimeEvent {
  seq?: number;
  kind: string;
  data: Record<string, unknown>;
}

export interface RuntimeClient {
  call<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T>;
  // `events.event` notifications: the subscription and the event (a frame such as message.delta has no seq).
  onEvent(listener: (subscriptionId: string, event: RuntimeEvent) => void): void;
  onExit(listener: (code: number | null) => void): void;
  stop(): void;
}

export class RuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RuntimeOptions {
  entry: string;
  env: NodeJS.ProcessEnv;
}

export function startRuntime(options: RuntimeOptions): RuntimeClient {
  const child = spawn(process.execPath, [options.entry], { stdio: ['pipe', 'pipe', 'inherit'], env: options.env });
  const lines = readline.createInterface({ input: child.stdout });
  const waiting = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
  const eventListeners: ((subscriptionId: string, event: RuntimeEvent) => void)[] = [];
  const exitListeners: ((code: number | null) => void)[] = [];
  let nextId = 0;
  let exited = false;

  const write = (message: object) => {
    if (!exited) child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  lines.on('line', (line) => {
    let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string; data?: { code?: string } } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id === 'number' && waiting.has(message.id)) {
      const pending = waiting.get(message.id)!;
      waiting.delete(message.id);
      if (message.error) pending.reject(new RuntimeError(message.error.data?.code ?? 'rpc_error', message.error.message ?? 'runtime error'));
      else pending.resolve(message.result as never);
      return;
    }
    if (message.method === 'events.event' && message.params) {
      const event = message.params.event as RuntimeEvent;
      for (const listener of eventListeners) listener(String(message.params.subscriptionId), event);
    }
  });

  child.stdin.on('error', () => undefined);
  child.on('exit', (code) => {
    exited = true;
    clearInterval(heartbeat);
    for (const pending of waiting.values()) pending.reject(new RuntimeError('runtime_exited', 'The AgentConsole runtime exited.'));
    waiting.clear();
    for (const listener of exitListeners) listener(code);
  });

  // The runtime expects a heartbeat every 10 s.
  const heartbeat = setInterval(() => write({ jsonrpc: '2.0', method: 'runtime.heartbeat', params: {} }), 10_000);

  return {
    call(method, params) {
      return new Promise((resolve, reject) => {
        if (exited) return reject(new RuntimeError('runtime_exited', 'The AgentConsole runtime exited.'));
        const id = ++nextId;
        waiting.set(id, { resolve: resolve as (value: never) => void, reject });
        write({ jsonrpc: '2.0', id, method, params });
      });
    },
    onEvent(listener) {
      eventListeners.push(listener);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
    stop() {
      clearInterval(heartbeat);
      child.stdin.end();
    },
  };
}

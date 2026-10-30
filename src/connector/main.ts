import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import type { ServerToConnector } from '../shared/api.ts';
import { createConnector } from './connector.ts';
import { startRuntime } from './runtime-client.ts';

// The PC connector: links the owner's AgentConsole runtime to the server (npm run connector).
// It dials out, so the PC needs no inbound port; the server never reaches the runtime directly.

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required; see .env.example.`);
    process.exit(1);
  }
  return value;
}

const serverUrl = required('CONNECTOR_SERVER_URL');
const token = required('CONNECTOR_TOKEN');
const runtimeEntry = required('AGENTCONSOLE_RUNTIME');
const provider = process.env.AGENTCONSOLE_PROVIDER?.trim() || 'claude';
const stateDir = resolve(process.env.CONNECTOR_STATE_DIR?.trim() || 'data/connector');
const linkUrl = new URL('/connector', serverUrl.replace(/^http/, 'ws')).toString();

const say = (msg: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...fields }));

for (const dir of ['runtime', 'work']) mkdirSync(join(stateDir, dir), { recursive: true });
// The runtime principal is this connector's own; kept so its sessions stay reachable after a restart.
const principalFile = join(stateDir, 'principal');
if (!existsSync(principalFile)) writeFileSync(principalFile, `connector-${randomUUID()}`);
const principal = readFileSync(principalFile, 'utf8').trim();

// The provider runs Claude through a launcher that adds the flags that take every tool away (I-26).
const locked = fileURLToPath(new URL('./claude-locked.mjs', import.meta.url));
// The link token stays in this process; the runtime and Claude never need it.
const runtimeEnv = { ...process.env };
delete runtimeEnv.CONNECTOR_TOKEN;
const runtime = startRuntime({ entry: runtimeEntry, env: { ...runtimeEnv, SKYNET_CLAUDE_EXECUTABLE: locked } });
runtime.onExit((code) => {
  say('AgentConsole runtime exited', { code });
  process.exit(1);
});

const hello = await runtime.call<{ version: string }>('runtime.hello', {
  version: '1.0.0',
  storage: { kind: 'fs', root: join(stateDir, 'runtime') },
  workspaceRoots: [join(stateDir, 'work')],
  hostMethods: [],
  options: { streamDeltas: true },
});
say('AgentConsole runtime ready', { version: hello.version, provider });

let socket: WebSocket | null = null;
const connector = createConnector({
  runtime,
  principal,
  workspace(conversationId) {
    // The id names a directory, so nothing but a UUID gets that far.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)) throw new Error('conversation id is not a UUID');
    const dir = join(stateDir, 'work', conversationId);
    mkdirSync(dir, { recursive: true });
    return dir;
  },
  provider,
  send(message) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  },
});

let backoffMs = 1_000;
function connect() {
  const current = new WebSocket(linkUrl, { headers: { authorization: `Bearer ${token}` } });
  socket = current;
  let chain: Promise<void> = Promise.resolve();
  current.on('open', () => {
    backoffMs = 1_000;
    say('linked to server', { url: linkUrl });
    current.send(JSON.stringify({ t: 'hello', runtimeVersion: String(hello.version), provider, sandbox: null }));
  });
  current.on('message', (raw) => {
    let message: ServerToConnector;
    try {
      message = JSON.parse(String(raw)) as ServerToConnector;
    } catch {
      return;
    }
    // Handled in arrival order, so a resume finishes before the dispatch after it.
    chain = chain
      .then(() => connector.handle(message))
      .catch((error: Error) => {
        say('could not handle a server message; relinking', { t: message.t, error: error.message });
        current.close();
      });
  });
  // No 'unexpected-response' listener: with one, ws leaves a refused handshake open and 'close' never comes.
  current.on('error', (error) => say('link error', { error: error.message }));
  current.on('close', (code) => {
    if (socket === current) socket = null;
    say('link closed; retrying', { code, inMs: backoffMs });
    setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30_000);
  });
}

connect();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    runtime.stop();
    process.exit(0);
  });
}

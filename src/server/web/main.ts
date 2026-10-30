import { createOutbox } from '../mail/outbox.ts';
import { createSmtpTransport } from '../mail/transport.ts';
import { createMailWorker } from '../mail/worker.ts';
import { systemClock } from '../platform/clock.ts';
import { loadConfig } from '../platform/config.ts';
import { createPool } from '../platform/db.ts';
import { log } from '../platform/log.ts';
import { migrate } from '../platform/migrate.ts';
import { deriveKey } from '../platform/secrets.ts';
import { buildApp } from './app.ts';

const config = loadConfig();
const db = createPool(config.databaseUrl);
await migrate(db);

const sealKey = deriveKey(config.appSecret, 'email-job-secrets');
const transport = createSmtpTransport(config.smtpUrl, config.mailFrom);
const worker = createMailWorker({ db, clock: systemClock, transport, sealKey });
const app = await buildApp({
  config,
  db,
  clock: systemClock,
  outbox: createOutbox({ clock: systemClock, sealKey }),
  codePepper: deriveKey(config.appSecret, 'login-code-pepper'),
  onEmailQueued: () => worker.notify(),
});

const stop = new AbortController();
const workerDone = worker.run(stop.signal);
await app.listen({ host: config.host, port: config.port });
log('info', 'listening', { port: config.port, buildId: config.buildId });

async function shutdown(signal: string): Promise<void> {
  log('info', 'shutting down', { signal });
  stop.abort();
  await app.close();
  await workerDone;
  transport.close();
  await db.end();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

// Integration harness: a real PostgreSQL and a real SMTP sink (Mailpit), with a movable clock.
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createOutbox } from '../../src/server/mail/outbox.ts';
import { createSmtpTransport } from '../../src/server/mail/transport.ts';
import type { MailTransport } from '../../src/server/mail/transport.ts';
import { createMailWorker } from '../../src/server/mail/worker.ts';
import type { MailWorker } from '../../src/server/mail/worker.ts';
import { FakeClock } from '../../src/server/platform/clock.ts';
import { loadConfig } from '../../src/server/platform/config.ts';
import type { Config } from '../../src/server/platform/config.ts';
import { createPool } from '../../src/server/platform/db.ts';
import type { Db } from '../../src/server/platform/db.ts';
import { migrate } from '../../src/server/platform/migrate.ts';
import { deriveKey } from '../../src/server/platform/secrets.ts';
import { buildApp } from '../../src/server/web/app.ts';

export const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://biblestudy:biblestudy@localhost:55432/biblestudy';
export const smtpUrl = process.env.TEST_SMTP_URL ?? 'smtp://localhost:1025';
export const mailpitUrl = process.env.TEST_MAILPIT_URL ?? 'http://localhost:8025';

export interface Harness {
  app: FastifyInstance;
  db: Db;
  clock: FakeClock;
  config: Config;
  worker: MailWorker;
  transport: MailTransport;
  close(): Promise<void>;
}

// Drops every table, then migrates from empty: each file starts from the state a fresh install has.
export async function resetDatabase(db: Db): Promise<void> {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(db);
}

export async function truncateAll(db: Db): Promise<void> {
  const tables = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  if (tables.rowCount) await db.query(`TRUNCATE ${tables.rows.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`);
}

export async function startHarness(): Promise<Harness> {
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    APP_SECRET: 'integration-test-secret-0123456789abcdef',
    SMTP_URL: smtpUrl,
    MAIL_FROM: 'Bible Study <no-reply@example.test>',
    PUBLIC_URL: 'http://localhost:3000',
    BUILD_ID: 'test-build',
    STATIC_DIR: 'does-not-exist',
  });
  const db = createPool(config.databaseUrl);
  await resetDatabase(db);
  const clock = new FakeClock();
  const sealKey = deriveKey(config.appSecret, 'email-job-secrets');
  const transport = createSmtpTransport(config.smtpUrl, config.mailFrom);
  const worker = createMailWorker({ db, clock, transport, sealKey });
  const app = await buildApp({
    config,
    db,
    clock,
    outbox: createOutbox({ clock, sealKey }),
    codePepper: deriveKey(config.appSecret, 'login-code-pepper'),
    onEmailQueued: () => worker.notify(),
  });
  return {
    app,
    db,
    clock,
    config,
    worker,
    transport,
    async close() {
      await app.close();
      transport.close();
      await db.end();
    },
  };
}

export function cookieFrom(response: LightMyRequestResponse, name = 'bs_session'): string {
  const cookie = response.cookies.find((c) => c.name === name);
  if (!cookie) throw new Error(`no ${name} cookie in response`);
  return cookie.value;
}

// ---- Mailpit ----

interface MailpitSummary {
  ID: string;
  To: { Address: string }[];
  Created: string;
}

export async function clearMailbox(): Promise<void> {
  const response = await fetch(`${mailpitUrl}/api/v1/messages`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`Mailpit clear failed: ${response.status}`);
}

export async function messagesTo(address: string): Promise<MailpitSummary[]> {
  const response = await fetch(`${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`);
  if (!response.ok) throw new Error(`Mailpit search failed: ${response.status}`);
  const body = (await response.json()) as { messages: MailpitSummary[] };
  return body.messages;
}

export async function messageText(id: string): Promise<string> {
  const response = await fetch(`${mailpitUrl}/api/v1/message/${id}`);
  if (!response.ok) throw new Error(`Mailpit read failed: ${response.status}`);
  const body = (await response.json()) as { Text: string };
  return body.Text;
}

// Waits for the count of messages to `address` to reach `count`, then returns the newest message's code.
export async function waitForCode(address: string, count: number, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await messagesTo(address);
    if (messages.length >= count) {
      const text = await messageText(messages[0].ID);
      const match = /sign-in code is (\d{6})/.exec(text);
      if (!match) throw new Error(`no code in message: ${text}`);
      return match[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no message ${count} for ${address} within ${timeoutMs} ms`);
}

// Requests a code, delivers it through the real worker and Mailpit, and returns it.
export async function requestAndReceiveCode(h: Harness, email: string, ip = '203.0.113.10'): Promise<string> {
  const before = (await messagesTo(email)).length;
  const response = await h.app.inject({ method: 'POST', url: '/api/auth/code', payload: { email }, remoteAddress: ip });
  if (response.statusCode !== 200) throw new Error(`code request failed: ${response.statusCode} ${response.body}`);
  await h.worker.runOnce();
  return waitForCode(email, before + 1);
}

export async function signIn(h: Harness, email: string): Promise<{ cookie: string; userId: string }> {
  const code = await requestAndReceiveCode(h, email);
  const response = await h.app.inject({ method: 'POST', url: '/api/auth/verify', payload: { email, code } });
  if (response.statusCode !== 200) throw new Error(`verify failed: ${response.statusCode} ${response.body}`);
  return { cookie: cookieFrom(response), userId: response.json().user.id };
}

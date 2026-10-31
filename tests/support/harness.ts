// Integration harness: a real PostgreSQL and a real SMTP sink (Mailpit), with a movable clock.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createAoLabSource } from '../../src/server/content/aolab.ts';
import type { ContentSource } from '../../src/server/content/aolab.ts';
import { createAudioWorker } from '../../src/server/content/audio-worker.ts';
import type { AudioWorker } from '../../src/server/content/audio-worker.ts';
import { createOutbox } from '../../src/server/mail/outbox.ts';
import type { Outbox } from '../../src/server/mail/outbox.ts';
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
import { reminderTick } from '../../src/server/reminders/reminders.ts';
import type { TickResult } from '../../src/server/reminders/reminders.ts';
import { createRealtimeHub } from '../../src/server/study/realtime.ts';
import type { RealtimeHub } from '../../src/server/study/realtime.ts';
import { buildApp } from '../../src/server/web/app.ts';

export const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://biblestudy:biblestudy@localhost:55432/biblestudy';
export const smtpUrl = process.env.TEST_SMTP_URL ?? 'smtp://localhost:1025';
export const mailpitUrl = process.env.TEST_MAILPIT_URL ?? 'http://localhost:8025';
export const ownerEmail = 'owner@example.test';

export interface Harness {
  app: FastifyInstance;
  db: Db;
  clock: FakeClock;
  config: Config;
  worker: MailWorker;
  audioWorker: AudioWorker;
  transport: MailTransport;
  hub: RealtimeHub;
  outbox: Outbox;
  // One reminder tick at the fake clock's time; tests call it instead of running the minute loop.
  tick(): Promise<TickResult>;
  close(): Promise<void>;
}

// Drops every table, then migrates from empty: each file starts from the state a fresh install has.
export async function resetDatabase(db: Db): Promise<void> {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(db);
}

// Keeps migration-seeded reference rows (translations, narrators).
export async function truncateAll(db: Db): Promise<void> {
  const tables = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('schema_migrations', 'translations', 'narrators')`,
  );
  if (tables.rowCount) await db.query(`TRUNCATE ${tables.rows.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`);
}

// `env` overrides the test configuration, e.g. STATIC_DIR to serve the built client.
// Recordings go to a fresh temporary MEDIA_DIR unless one is given; `source` replaces the live AO Lab for the audio worker.
// The audio worker is notified but not run: tests drive it with runOnce().
export async function startHarness(
  env: Record<string, string> = {},
  options: { source?: ContentSource; emptyRoomGraceMs?: number } = {},
): Promise<Harness> {
  const tempMedia = env.MEDIA_DIR ? null : mkdtempSync(join(tmpdir(), 'biblestudy-media-'));
  const config = loadConfig({
    MEDIA_DIR: tempMedia ?? '',
    DATABASE_URL: databaseUrl,
    APP_SECRET: 'integration-test-secret-0123456789abcdef',
    SMTP_URL: smtpUrl,
    MAIL_FROM: 'Bible Study <no-reply@example.test>',
    PUBLIC_URL: 'http://localhost:3000',
    OWNER_EMAIL: ownerEmail,
    BUILD_ID: 'test-build',
    STATIC_DIR: 'does-not-exist',
    ...env,
  });
  const db = createPool(config.databaseUrl);
  await resetDatabase(db);
  const clock = new FakeClock();
  const sealKey = deriveKey(config.appSecret, 'email-job-secrets');
  const transport = createSmtpTransport(config.smtpUrl, config.mailFrom);
  const worker = createMailWorker({ db, clock, transport, sealKey });
  const source = options.source ?? createAoLabSource({ baseUrl: config.aolabBaseUrl });
  const audioWorker = createAudioWorker({ db, clock, source, mediaDir: config.mediaDir });
  const hub = createRealtimeHub({ emptyRoomGraceMs: options.emptyRoomGraceMs });
  const outbox = createOutbox({ clock, sealKey });
  const app = await buildApp({
    config,
    db,
    clock,
    outbox,
    codePepper: deriveKey(config.appSecret, 'login-code-pepper'),
    onEmailQueued: () => worker.notify(),
    onAudioQueued: () => audioWorker.notify(),
    hub,
  });
  return {
    app,
    db,
    clock,
    config,
    worker,
    audioWorker,
    transport,
    hub,
    outbox,
    tick: () => reminderTick({ db, clock, outbox, publicUrl: config.publicUrl, onEmailQueued: () => worker.notify() }),
    async close() {
      await app.close();
      transport.close();
      await db.end();
      if (tempMedia) rmSync(tempMedia, { recursive: true, force: true });
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
export async function requestAndReceiveCode(h: Harness, email: string, ip = '203.0.113.10', invitationToken?: string): Promise<string> {
  const before = (await messagesTo(email)).length;
  const response = await h.app.inject({ method: 'POST', url: '/api/auth/code', payload: { email, invitationToken }, remoteAddress: ip });
  if (response.statusCode !== 200) throw new Error(`code request failed: ${response.statusCode} ${response.body}`);
  await h.worker.runOnce();
  return waitForCode(email, before + 1);
}

// `invitationToken` goes with the code request only, as when the code is typed on another device.
export async function signIn(
  h: Harness,
  email: string,
  invitationToken?: string,
): Promise<{ cookie: string; userId: string; joinedGroupId: string | null; invitation: 'accepted' | 'invalid' | 'none' }> {
  const code = await requestAndReceiveCode(h, email, '203.0.113.10', invitationToken);
  const response = await h.app.inject({ method: 'POST', url: '/api/auth/verify', payload: { email, code } });
  if (response.statusCode !== 200) throw new Error(`verify failed: ${response.statusCode} ${response.body}`);
  const body = response.json();
  return { cookie: cookieFrom(response), userId: body.user.id, joinedGroupId: body.joinedGroupId, invitation: body.invitation };
}

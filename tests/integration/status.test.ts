import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import WebSocket from 'ws';
import type { OwnerStatus } from '../../src/shared/api.ts';
import { createMailWorker, maxAttempts } from '../../src/server/mail/worker.ts';
import { AppError } from '../../src/server/platform/errors.ts';
import { deriveKey } from '../../src/server/platform/secrets.ts';
import type { Harness } from '../support/harness.ts';
import { clearMailbox, ownerEmail, signIn, startHarness, truncateAll } from '../support/harness.ts';

const token = 's20-test-connector-token-0123456789abcdef';
let h: Harness;
let baseUrl: string;
before(async () => {
  // The group owner and assistant user need not be the same person.
  h = await startHarness({
    ASSISTANT_OWNER_EMAIL: 'assistant@example.test',
    CONNECTOR_TOKEN: token,
  });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `ws://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
});
after(async () => {
  await h?.close();
});
beforeEach(async () => {
  await truncateAll(h.db);
  await clearMailbox();
  h.clock.set('2026-11-01T12:00:00Z');
});

const get = (cookie?: string, url = '/api/owner/status') =>
  h.app.inject({ method: 'GET', url, cookies: cookie ? { bs_session: cookie } : {} });

async function email(
  status: string,
  attempts: number,
  error: string | null,
  to = 'recipient@example.test',
  kind = 'reminder'
) {
  const id = randomUUID();
  await h.db.query(
    `INSERT INTO email_jobs (id, kind, idempotency_key, to_address, subject, text_body, html_body, sealed_secrets, status, attempts, next_attempt_at, created_at, last_error)
     VALUES ($1::uuid, $2, $1::text, $3, 'private subject', 'private text 123456', '<p>private html</p>', 'sealed-private', $4, $5, $6, $7, $8)`,
    [id, kind, to, status, attempts, new Date('2026-11-01T12:05:00Z'), h.clock.now(), error]
  );
  return id;
}

describe('owner operational status (S20)', () => {
  test('S20.1 anonymous, ordinary, ungrouped, assistant-only and removed owners cannot retrieve operational records', async () => {
    const owner = await signIn(h, ownerEmail);
    const groupId = (await h.db.query('SELECT id FROM groups')).rows[0].id;
    const link = (
      await h.app.inject({
        method: 'POST',
        url: `/api/groups/${groupId}/invitations`,
        cookies: { bs_session: owner.cookie },
      })
    ).json().link;
    const member = await signIn(
      h,
      'member@example.test',
      new URL(link).pathname.slice('/join/'.length)
    );
    const outsider = await signIn(h, 'outsider@example.test');
    const assistantUser = await signIn(h, 'assistant@example.test');
    await email('failed', 1, '550 private-operational-error', 'private-recipient@example.test');
    assert.equal((await get()).statusCode, 401);
    for (const cookie of [member.cookie, outsider.cookie, assistantUser.cookie]) {
      for (const path of [
        '/api/owner/status',
        '/%61pi/owner/status',
        '/api/owner/status?role=owner',
      ]) {
        const response = await get(cookie, path);
        assert.equal(response.statusCode, 403);
        assert.equal(response.json().error, 'not_owner');
        assert.doesNotMatch(
          response.body,
          /private-recipient|private-operational-error|counts|connector/
        );
      }
    }
    await h.db.query("UPDATE memberships SET role = 'member', removed_at = $1 WHERE user_id = $2", [
      h.clock.now(),
      owner.userId,
    ]);
    assert.equal((await get(owner.cookie)).statusCode, 403);
  });

  test('S20.2/3 failed, retrying, queued, sending and suppressed records are distinct and secrets never leave the API', async () => {
    const owner = await signIn(h, ownerEmail);
    const failedId = await email(
      'failed',
      1,
      '550 rejected; smtp://user:password@private:587; code 123456',
      undefined,
      'login_code'
    );
    const retryId = await email('queued', 1, 'connect ECONNREFUSED private:587');
    await email('queued', 0, null);
    await email('sending', 1, null);
    await email('sending', 2, '450 temporarily unavailable');
    await email('failed', 0, 'reminder suppressed');
    const response = await get(owner.cookie);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const data = response.json<OwnerStatus>();
    assert.deepEqual(data.mail.counts, {
      failed: 1,
      retrying: 2,
      queued: 1,
      sending: 2,
      sent: 1,
      suppressed: 1,
    });
    assert.equal(data.checkedAt, h.clock.now().toISOString());
    assert.equal(data.mail.failed[0].id, failedId);
    assert.equal(data.mail.failed[0].kind, 'login_code');
    assert.equal(data.mail.failed[0].state, 'failed');
    assert.equal(data.mail.failed[0].nextAttemptAt, null);
    assert.equal(data.mail.failed[0].failure.summary, 'Mail relay permanently rejected delivery.');
    const retry = data.mail.retrying.find((job) => job.id === retryId)!;
    assert.equal(retry.state, 'retrying');
    assert.equal(retry.nextAttemptAt, '2026-11-01T12:05:00.000Z');
    assert.equal(retry.attempts, 1);
    assert.ok(
      data.mail.retrying.some((job) => job.state === 'sending_retry' && job.nextAttemptAt === null)
    );
    for (const privateValue of [
      'private subject',
      'private text',
      'private html',
      'sealed-private',
      'password',
      'private:587',
      '123456',
      'idempotency',
      'provider_message',
      token,
    ]) {
      assert.ok(!response.body.includes(privateValue), `response leaked ${privateValue}`);
    }
  });

  test('S20.2 real worker outcomes: temporary failures retry, 5xx and exhausted retries stop, recovery is healthy', async () => {
    const owner = await signIn(h, ownerEmail);
    let responseCode = 450;
    const worker = createMailWorker({
      db: h.db,
      clock: h.clock,
      sealKey: deriveKey(h.config.appSecret, 'email-job-secrets'),
      transport: {
        async send() {
          if (responseCode)
            throw Object.assign(new Error(`${responseCode} synthetic rejection`), { responseCode });
        },
        close() {},
      },
    });
    async function enqueue() {
      return (
        await h.outbox.enqueueEmail(h.db, {
          kind: 'reminder',
          idempotencyKey: randomUUID(),
          to: 'synthetic@example.test',
          subject: 'Synthetic',
          text: 'Synthetic',
          html: '<p>Synthetic</p>',
        })
      ).jobId;
    }
    const retryId = await enqueue();
    await worker.runOnce();
    let data = (await get(owner.cookie)).json<OwnerStatus>();
    assert.equal(data.mail.counts.retrying, 1);
    assert.equal(data.mail.counts.failed, 0);
    assert.equal(data.mail.retrying[0].nextAttemptAt, '2026-11-01T12:01:00.000Z');
    responseCode = 550;
    const failedId = await enqueue();
    await worker.runOnce();
    data = (await get(owner.cookie)).json<OwnerStatus>();
    assert.equal(data.mail.failed[0].id, failedId);
    assert.equal(data.mail.failed[0].attempts, 1);
    await h.db.query('UPDATE email_jobs SET attempts = $2, next_attempt_at = $3 WHERE id = $1', [
      retryId,
      maxAttempts - 1,
      h.clock.now(),
    ]);
    responseCode = 450;
    await worker.runOnce();
    data = (await get(owner.cookie)).json<OwnerStatus>();
    assert.equal(data.mail.counts.failed, 2);
    assert.equal(data.mail.counts.retrying, 0);
    assert.doesNotMatch(
      data.mail.failed.find((job) => job.id === retryId)!.failure.action,
      /scheduled retry/
    );
    await h.db.query('DELETE FROM email_jobs WHERE id = ANY($1::uuid[])', [[failedId, retryId]]);
    responseCode = 0;
    await enqueue();
    await worker.runOnce();
    data = (await get(owner.cookie)).json<OwnerStatus>();
    assert.equal(data.mail.counts.failed, 0);
    assert.equal(data.mail.counts.retrying, 0);
    assert.deepEqual(data.mail.failed, []);
    assert.deepEqual(data.mail.retrying, []);
  });

  test('S20.4 connector state uses the real authenticated link without granting assistant access or exposing its hello', async () => {
    const owner = await signIn(h, ownerEmail);
    assert.equal((await get(owner.cookie)).json<OwnerStatus>().assistant.state, 'offline');
    // The status view does not grant the group owner assistant permission.
    const assistantStatus = await h.app.inject({
      method: 'GET',
      url: '/api/assistant/status',
      cookies: { bs_session: owner.cookie },
    });
    assert.equal(assistantStatus.json().state, 'not_permitted');
    const ws = new WebSocket(`${baseUrl}/connector`, {
      headers: { authorization: `Bearer ${token}` },
    });
    try {
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      ws.send(
        JSON.stringify({
          t: 'hello',
          runtimeVersion: 'private-runtime-version',
          provider: 'private-provider',
          sandbox: 'private-sandbox',
        })
      );
      let data: OwnerStatus | undefined;
      for (let i = 0; i < 100; i++) {
        data = (await get(owner.cookie)).json<OwnerStatus>();
        if (data.assistant.state === 'online') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(data!.assistant, { state: 'online' });
      assert.doesNotMatch(JSON.stringify(data), /private-runtime|private-provider|private-sandbox/);
    } finally {
      await new Promise<void>((resolve) => {
        ws.once('close', resolve);
        ws.close();
      });
    }
    for (let i = 0; i < 100; i++) {
      const data = (await get(owner.cookie)).json<OwnerStatus>();
      if (data.assistant.state === 'offline') {
        assert.equal(data.assistant.since, h.clock.now().toISOString());
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('connector did not become offline');
  });

  test('S20.4 missing assistant configuration is explicit, not healthy or offline', async () => {
    const owner = await signIn(h, ownerEmail);
    const previous = h.config.assistantOwnerEmail;
    h.config.assistantOwnerEmail = null;
    try {
      assert.deepEqual((await get(owner.cookie)).json<OwnerStatus>().assistant, {
        state: 'not_configured',
      });
    } finally {
      h.config.assistantOwnerEmail = previous;
    }
  });

  test('S20.5 lists are bounded, deterministically ordered, and totals do not hide older failures', async () => {
    const owner = await signIn(h, ownerEmail);
    const ids: string[] = [];
    for (let i = 0; i < 53; i++) ids.push(await email('failed', 1, null));
    const data = (await get(owner.cookie)).json<OwnerStatus>();
    assert.equal(data.mail.counts.failed, 53);
    assert.equal(data.mail.failed.length, 50);
    assert.deepEqual(
      data.mail.failed.map((job) => job.id),
      ids.sort().reverse().slice(0, 50)
    );
  });

  test('S20.5 unavailable status is not an empty healthy result and exposes no connection details', async () => {
    const owner = await signIn(h, ownerEmail);
    const originalConnect = h.db.connect;
    h.db.connect = ((...args: unknown[]) => {
      // Pool.query uses the callback overload; fail only the transaction's direct connection.
      if (args.length) return Reflect.apply(originalConnect, h.db, args);
      return Promise.reject(
        new AppError('unavailable', 503, 'private database host', {
          details: { cause: 'private database password' },
        })
      );
    }) as typeof h.db.connect;
    try {
      const response = await get(owner.cookie);
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error, 'unavailable');
      assert.doesNotMatch(response.body, /private database|counts|failed/);
    } finally {
      h.db.connect = originalConnect;
    }
  });
});

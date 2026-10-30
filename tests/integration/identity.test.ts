import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createOutbox } from '../../src/server/mail/outbox.ts';
import { createSmtpTransport } from '../../src/server/mail/transport.ts';
import { createMailWorker } from '../../src/server/mail/worker.ts';
import { migrate } from '../../src/server/platform/migrate.ts';
import { deriveKey } from '../../src/server/platform/secrets.ts';
import type { Harness } from '../support/harness.ts';
import {
  clearMailbox,
  cookieFrom,
  messagesTo,
  requestAndReceiveCode,
  signIn,
  startHarness,
  truncateAll,
  waitForCode,
} from '../support/harness.ts';

const member = 'member@example.test';
let h: Harness;

before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});
beforeEach(async () => {
  await truncateAll(h.db);
  await clearMailbox();
  h.clock.set('2026-11-01T12:00:00Z');
});

const verify = (email: string, code: string) => h.app.inject({ method: 'POST', url: '/api/auth/verify', payload: { email, code } });
const requestCode = (email: string, ip = '203.0.113.10') =>
  h.app.inject({ method: 'POST', url: '/api/auth/code', payload: { email }, remoteAddress: ip });
const wrongCode = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

describe('S1.1 requesting a code', () => {
  test('enqueues one login_code job, delivers it through the running worker within 10 s, and stores only a hash', async () => {
    const stop = new AbortController();
    const running = h.worker.run(stop.signal);
    try {
      const started = Date.now();
      const response = await requestCode(member);
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.sent, 'queued');
      assert.equal(body.codeExpiresAt, '2026-11-01T12:10:00.000Z');

      const jobs = await h.db.query(`SELECT kind, to_address FROM email_jobs`);
      assert.deepEqual(jobs.rows, [{ kind: 'login_code', to_address: member }]);

      const code = await waitForCode(member, 1, 10_000);
      assert.ok(Date.now() - started < 10_000);
      assert.match(code, /^\d{6}$/);

      // Neither table holds the raw code, and the sealed copy is gone once sent.
      const dump = await h.db.query(
        `SELECT (SELECT json_agg(c)::text FROM login_codes c) AS codes, (SELECT json_agg(j)::text FROM email_jobs j) AS jobs`,
      );
      assert.ok(!dump.rows[0].codes.includes(code), 'login_codes contains the raw code');
      assert.ok(!dump.rows[0].jobs.includes(code), 'email_jobs contains the raw code');
      const job = await h.db.query(`SELECT status, sealed_secrets FROM email_jobs`);
      assert.deepEqual(job.rows, [{ status: 'sent', sealed_secrets: null }]);

      const status = await h.app.inject({ method: 'GET', url: `/api/auth/code-status?email=${member}` });
      assert.deepEqual(status.json(), { delivery: 'sent' });
    } finally {
      stop.abort();
      await running;
    }
  });

  test('rejects a malformed address', async () => {
    const response = await requestCode('not-an-email');
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'invalid_email');
  });
});

describe('S1.2 verifying a code', () => {
  test('sets an HttpOnly, Secure, SameSite=Lax cookie, returns the profile, and works only once', async () => {
    const code = await requestAndReceiveCode(h, member);
    const response = await verify(member, code);
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.user.email, member);
    assert.equal(body.invitation, 'none');
    assert.equal(body.joinedGroupId, null);

    const setCookie = String(response.headers['set-cookie']);
    assert.match(setCookie, /^bs_session=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);

    const me = await h.app.inject({ method: 'GET', url: '/api/me', cookies: { bs_session: cookieFrom(response) } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().id, body.user.id);

    const again = await verify(member, code);
    assert.equal(again.statusCode, 401);
    assert.equal(again.json().error, 'code_expired');
  });
});

describe('S1.3 expiry and attempts', () => {
  test('a code verified 10 minutes and 1 second after issue is expired', async () => {
    const code = await requestAndReceiveCode(h, member);
    h.clock.advance(10 * 60_000 + 1000);
    const response = await verify(member, code);
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, 'code_expired');
  });

  test('a code verified just before expiry works', async () => {
    const code = await requestAndReceiveCode(h, member);
    h.clock.advance(10 * 60_000 - 1000);
    assert.equal((await verify(member, code)).statusCode, 200);
  });

  test('five wrong codes kill the code, so the right one is then expired', async () => {
    const code = await requestAndReceiveCode(h, member);
    for (let attempt = 1; attempt <= 4; attempt++) {
      const response = await verify(member, wrongCode(code));
      assert.equal(response.json().error, 'code_invalid', `attempt ${attempt}`);
      assert.equal(response.json().details.attemptsLeft, 5 - attempt);
    }
    assert.equal((await verify(member, wrongCode(code))).json().error, 'code_expired');
    const right = await verify(member, code);
    assert.equal(right.statusCode, 401);
    assert.equal(right.json().error, 'code_expired');
  });
});

describe('S1.4 superseding', () => {
  test('requesting a second code expires the first', async () => {
    const first = await requestAndReceiveCode(h, member);
    const second = await requestAndReceiveCode(h, member);
    if (first !== second) {
      assert.equal((await verify(member, first)).json().error, 'code_expired');
    }
    assert.equal((await verify(member, second)).statusCode, 200);
  });
});

describe('S1.5 rate limits', () => {
  test('a sixth request for one email within an hour is rate_limited with retryAfterSeconds', async () => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await requestCode(member)).statusCode, 200, `request ${i + 1}`);
      h.clock.advance(60_000);
    }
    const sixth = await requestCode(member);
    assert.equal(sixth.statusCode, 429);
    const body = sixth.json();
    assert.equal(body.error, 'rate_limited');
    assert.equal(body.retryable, true);
    // The oldest request was 5 minutes ago, so the window reopens in 55 minutes.
    assert.equal(body.details.retryAfterSeconds, 55 * 60);
    assert.equal(sixth.headers['retry-after'], String(55 * 60));

    h.clock.advance(55 * 60_000);
    assert.equal((await requestCode(member)).statusCode, 200);
  });

  test('more than 20 requests from one address within an hour are rate_limited', async () => {
    for (let i = 0; i < 20; i++) assert.equal((await requestCode(`m${i}@example.test`, '198.51.100.7')).statusCode, 200);
    const response = await requestCode('m20@example.test', '198.51.100.7');
    assert.equal(response.statusCode, 429);
    assert.equal(response.json().error, 'rate_limited');
    assert.equal((await requestCode('m20@example.test', '198.51.100.8')).statusCode, 200);
  });

  test('concurrent requests from one address for different emails cannot overshoot the limit', async () => {
    const responses = await Promise.all(Array.from({ length: 25 }, (_, i) => requestCode(`c${i}@example.test`, '198.51.100.9')));
    assert.equal(responses.filter((r) => r.statusCode === 200).length, 20);
    assert.equal(responses.filter((r) => r.statusCode === 429).length, 5);
  });
});

describe('S1.6 devices', () => {
  test('a second browser resolves to the same user, and logout revokes only its own session', async () => {
    const first = await signIn(h, member);
    const second = await signIn(h, 'Member@Example.test');
    assert.equal(second.userId, first.userId);
    assert.notEqual(second.cookie, first.cookie);

    const logout = await h.app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { bs_session: second.cookie } });
    assert.equal(logout.statusCode, 204);

    const revoked = await h.app.inject({ method: 'GET', url: '/api/me', cookies: { bs_session: second.cookie } });
    assert.equal(revoked.statusCode, 401);
    assert.equal(revoked.json().error, 'unauthenticated');
    const kept = await h.app.inject({ method: 'GET', url: '/api/me', cookies: { bs_session: first.cookie } });
    assert.equal(kept.statusCode, 200);
    assert.equal(kept.json().id, first.userId);
  });

  test('a session slides forward with use and lapses after 90 idle days', async () => {
    const { cookie } = await signIn(h, member);
    h.clock.advance(80 * 24 * 3600_000);
    const used = await h.app.inject({ method: 'GET', url: '/api/me', cookies: { bs_session: cookie } });
    assert.equal(used.statusCode, 200);
    assert.ok(used.cookies.some((c) => c.name === 'bs_session'), 'renewed cookie is re-sent');
    h.clock.advance(80 * 24 * 3600_000);
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/me', cookies: { bs_session: cookie } })).statusCode, 200);
    h.clock.advance(91 * 24 * 3600_000);
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/me', cookies: { bs_session: cookie } })).statusCode, 401);
  });
});

describe('S1.7 profile', () => {
  test('rejects an unknown zone and stores a real one', async () => {
    const { cookie } = await signIn(h, member);
    const patch = (payload: object) => h.app.inject({ method: 'PATCH', url: '/api/me', cookies: { bs_session: cookie }, payload });

    const bad = await patch({ timeZone: 'Mars/Base' });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, 'invalid_zone');

    const good = await patch({ timeZone: 'Europe/Sofia', displayName: '  Ana  ' });
    assert.equal(good.statusCode, 200);
    assert.equal(good.json().timeZone, 'Europe/Sofia');
    assert.equal(good.json().displayName, 'Ana');

    const me = await h.app.inject({ method: 'GET', url: '/api/me', cookies: { bs_session: cookie } });
    assert.equal(me.json().timeZone, 'Europe/Sofia');
    assert.equal(me.json().displayName, 'Ana');
  });

  test('refuses a bare offset and stores the canonical zone name (I-03)', async () => {
    const { cookie } = await signIn(h, member);
    const patch = (payload: object) => h.app.inject({ method: 'PATCH', url: '/api/me', cookies: { bs_session: cookie }, payload });

    for (const offset of ['+01:00', '-0800']) {
      const bad = await patch({ timeZone: offset });
      assert.equal(bad.statusCode, 400);
      assert.equal(bad.json().error, 'invalid_zone');
    }
    const lower = await patch({ timeZone: 'europe/sofia' });
    assert.equal(lower.json().timeZone, 'Europe/Sofia');
  });
});

describe('S1.8 authentication', () => {
  for (const [method, url] of [
    ['GET', '/api/me'],
    ['PATCH', '/api/me'],
    ['POST', '/api/auth/logout'],
    ['GET', '/api/groups'],
    ['GET', '/api/anything/else'],
    // Percent-encoded paths route to the same handlers and must be refused the same way.
    ['GET', '/%61pi/me'],
    ['PATCH', '/%61pi/me'],
    ['POST', '/%61pi/auth/logout'],
    ['GET', '/api/%6De'],
  ] as const) {
    test(`${method} ${url} without a cookie is unauthenticated`, async () => {
      const response = await h.app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error, 'unauthenticated');
    });
  }

  test('a forged cookie is unauthenticated', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/me', cookies: { bs_session: 'forged-token' } });
    assert.equal(response.statusCode, 401);
  });

  test('/__build-id is public', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/__build-id' });
    assert.deepEqual(response.json(), { buildId: 'test-build' });
  });
});

describe('mail retries', () => {
  test('a relay outage retries with backoff and the job is sent when the relay returns', async () => {
    await requestCode(member);
    // A worker pointed at a port nothing listens on.
    const deadRelay = createSmtpTransport('smtp://127.0.0.1:1', 'x@example.test');
    const broken = createMailWorker({ db: h.db, clock: h.clock, transport: deadRelay, sealKey: deriveKey(h.config.appSecret, 'email-job-secrets') });
    assert.equal(await broken.runOnce(), 1);
    const queued = await h.db.query(`SELECT status, attempts, next_attempt_at FROM email_jobs`);
    assert.equal(queued.rows[0].status, 'queued');
    assert.equal(queued.rows[0].attempts, 1);
    assert.equal(new Date(queued.rows[0].next_attempt_at).toISOString(), '2026-11-01T12:01:00.000Z');

    assert.equal(await h.worker.runOnce(), 0, 'not due yet');
    h.clock.advance(60_000);
    assert.equal(await h.worker.runOnce(), 1);
    assert.equal((await messagesTo(member)).length, 1);
    const sent = await h.db.query(`SELECT status, attempts FROM email_jobs`);
    assert.deepEqual(sent.rows, [{ status: 'sent', attempts: 2 }]);
  });

  test('a login code still undelivered after 10 minutes is failed, not sent', async () => {
    await requestCode(member);
    h.clock.advance(10 * 60_000);
    assert.equal(await h.worker.runOnce(), 1);
    const job = await h.db.query(`SELECT status, sealed_secrets FROM email_jobs`);
    assert.deepEqual(job.rows, [{ status: 'failed', sealed_secrets: null }]);
    assert.equal((await messagesTo(member)).length, 0);
    const status = await h.app.inject({ method: 'GET', url: `/api/auth/code-status?email=${member}` });
    assert.deepEqual(status.json(), { delivery: 'failed' });
  });
});

describe('mail outbox', () => {
  test('re-enqueueing with the same idempotency key returns the existing job (I-09)', async () => {
    const outbox = createOutbox({ clock: h.clock, sealKey: deriveKey(h.config.appSecret, 'email-job-secrets') });
    const job = { kind: 'reminder' as const, idempotencyKey: 'reminder:x', to: member, subject: 's', text: 't', html: 'h' };
    const first = await outbox.enqueueEmail(h.db, job);
    const second = await outbox.enqueueEmail(h.db, job);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.jobId, first.jobId);
    assert.equal((await h.db.query('SELECT count(*)::int AS n FROM email_jobs')).rows[0].n, 1);
  });
});

describe('migrations', () => {
  test('a second run against a migrated database applies nothing', async () => {
    assert.deepEqual(await migrate(h.db), []);
    const versions = await h.db.query('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(versions.rows.map((r) => r.version), ['0001_identity_mail']);
  });
});

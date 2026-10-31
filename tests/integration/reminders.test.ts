import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { OccurrenceView } from '../../src/shared/api.ts';
import type { Harness } from '../support/harness.ts';
import { clearMailbox, messagesTo, messageText, ownerEmail, requestAndReceiveCode, signIn, startHarness, truncateAll } from '../support/harness.ts';

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

type Method = 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE';
const inject = (method: Method, cookie: string, url: string, payload?: object) => h.app.inject({ method, url, cookies: { bs_session: cookie }, payload });

interface Member {
  cookie: string;
  userId: string;
}

// Olive owns the group from Chicago; Mark is a member in Sofia. The first meeting is Monday 2 November 2026, 12:15Z.
async function ownerAndMember(): Promise<{ owner: Member; member: Member; groupId: string }> {
  const owner = await signIn(h, ownerEmail);
  const groupId = (await inject('GET', owner.cookie, '/api/groups')).json()[0].id;
  const link = (await inject('POST', owner.cookie, `/api/groups/${groupId}/invitations`)).json().link as string;
  const member = await signIn(h, 'member@example.test', new URL(link).pathname.replace('/join/', ''));
  await inject('PATCH', owner.cookie, '/api/me', { displayName: 'Olive', timeZone: 'America/Chicago' });
  await inject('PATCH', member.cookie, '/api/me', { displayName: 'Mark', timeZone: 'Europe/Sofia' });
  return { owner, member, groupId };
}

async function firstMeeting(cookie: string, groupId: string): Promise<OccurrenceView> {
  const response = await inject('GET', cookie, `/api/groups/${groupId}/occurrences`);
  assert.equal(response.statusCode, 200, response.body);
  const first = response.json()[0] as OccurrenceView;
  assert.equal(first.startsAt, '2026-11-02T12:15:00.000Z');
  return first;
}

async function change(cookie: string, groupId: string, meeting: OccurrenceView, body: object): Promise<OccurrenceView> {
  const response = await inject('PATCH', cookie, `/api/groups/${groupId}/occurrences/${meeting.id}`, { expectedRevision: meeting.revision, ...body });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

interface ReminderJob {
  to_address: string;
  status: string;
  subject: string;
  last_error: string | null;
}

const reminderJobs = async () =>
  (await h.db.query<ReminderJob>(`SELECT to_address, status, subject, last_error FROM email_jobs WHERE kind = 'reminder' ORDER BY to_address, created_at`)).rows;

// Deliveries for meetings before `before`: every meeting in the eight weeks ahead has its own.
const deliveries = async (before = '2026-11-05T00:00:00Z') =>
  (
    await h.db.query<{ email: string; offset_minutes: number; status: string; send_after: Date; has_job: boolean }>(
      `SELECT u.email, d.offset_minutes, d.status, d.send_after, d.email_job_id IS NOT NULL AS has_job
         FROM reminder_deliveries d JOIN users u ON u.id = d.user_id JOIN occurrences o ON o.id = d.occurrence_id
        WHERE o.starts_at < $1 ORDER BY d.send_after, u.email, d.created_at`,
      [before],
    )
  ).rows;

const remindersTo = async (address: string) => {
  const found = [];
  for (const message of await messagesTo(address)) {
    const text = await messageText(message.ID);
    if (text.includes('Open study:')) found.push(text);
  }
  return found;
};

describe('S11 reminder emails', () => {
  test('S11.1 a tick 24 hours before queues one reminder per member, and further ticks queue nothing', async () => {
    await ownerAndMember();
    const early = await h.tick();
    assert.ok(early.materialized > 0, 'the tick fills in the meetings ahead');
    assert.equal(early.enqueued, 0, 'nothing is due yet');

    h.clock.set('2026-11-01T12:15:00Z');
    assert.equal((await h.tick()).enqueued, 2);
    assert.deepEqual(
      (await reminderJobs()).map((j) => [j.to_address, j.status]),
      [
        ['member@example.test', 'queued'],
        [ownerEmail, 'queued'],
      ],
    );
    assert.deepEqual(await h.tick(), { materialized: 0, enqueued: 0, suppressed: 0 });
    h.clock.set('2026-11-01T12:16:00Z');
    assert.equal((await h.tick()).enqueued, 0);
    assert.equal((await reminderJobs()).length, 2);

    // The hour-before reminder comes later.
    h.clock.set('2026-11-02T11:15:00Z');
    assert.equal((await h.tick()).enqueued, 2);
    assert.equal((await reminderJobs()).length, 4);
  });

  test('S11.2 the Sofia member reads the time in EET, the planned passage and an Open study link', async () => {
    const { member, groupId } = await ownerAndMember();
    await change(member.cookie, groupId, await firstMeeting(member.cookie, groupId), { plannedPassage: { bookId: 'ROM', chapter: 2, startVerse: 1, endVerse: 16 } });
    h.clock.set('2026-11-01T12:15:00Z');
    assert.equal((await h.tick()).enqueued, 2);
    await h.worker.runOnce();

    const [text] = await remindersTo('member@example.test');
    assert.ok(text, 'Mailpit holds the reminder');
    assert.match(text, /Hi Mark,/);
    assert.match(text, /meets Monday 2 November 2026, 14:15 EET \(Europe\/Sofia\)\./);
    assert.match(text, /Passage: Romans 2:1–16/);
    assert.match(text, /Open study: http:\/\/localhost:3000\/study/);
    assert.match(text, /You get this 1 day before each meeting\./);
    const [ownerText] = await remindersTo(ownerEmail);
    assert.match(ownerText, /Monday 2 November 2026, 06:15 CST \(America\/Chicago\)/);
  });

  test('S11.2 with no passage planned, the reminder says where the group stopped', async () => {
    const { member, groupId } = await ownerAndMember();
    // Confirming through the API needs the chapter imported; the row is what a confirmation writes.
    await h.db.query(
      `INSERT INTO group_progress (id, group_id, book_id, chapter, verse, confirmed_by, confirmed_at) VALUES (gen_random_uuid(), $1, 'ROM', 2, 11, $2, $3)`,
      [groupId, member.userId, h.clock.now()],
    );
    h.clock.set('2026-11-01T12:15:00Z');
    await h.tick();
    await h.worker.runOnce();
    const [text] = await remindersTo('member@example.test');
    assert.match(text, /Picking up after Romans 2:11/);
  });

  test('S11.3 offsets [120] give only the 2-hour reminder; reminders off give none; login codes still arrive', async () => {
    const { owner, member, groupId } = await ownerAndMember();
    const twoHours = await inject('PUT', member.cookie, `/api/groups/${groupId}/reminders`, { enabled: true, offsetsMinutes: [120] });
    assert.equal(twoHours.statusCode, 200, twoHours.body);
    const off = await inject('PUT', owner.cookie, `/api/groups/${groupId}/reminders`, { enabled: false, offsetsMinutes: [1440, 60] });
    assert.deepEqual(off.json(), { enabled: false, offsetsMinutes: [1440, 60] });

    for (const at of ['2026-11-01T12:15:00Z', '2026-11-02T10:15:00Z', '2026-11-02T11:15:00Z', '2026-11-02T12:10:00Z']) {
      h.clock.set(at);
      await h.tick();
    }
    assert.deepEqual(
      (await deliveries()).map((d) => [d.email, d.offset_minutes, d.has_job]),
      [['member@example.test', 120, true]],
    );

    await requestAndReceiveCode(h, ownerEmail);
    await requestAndReceiveCode(h, 'member@example.test');
  });

  test('S11.3 a preference change suppresses reminders no longer wanted and leaves the other member’s alone', async () => {
    const { member, groupId } = await ownerAndMember();
    await h.tick();
    assert.equal((await deliveries()).filter((d) => d.status === 'pending').length, 4, 'two offsets for two members');
    await inject('PUT', member.cookie, `/api/groups/${groupId}/reminders`, { enabled: false, offsetsMinutes: [] });
    assert.equal((await h.tick()).suppressed, 16, 'two for each of the eight meetings ahead');
    const left = (await deliveries()).filter((d) => d.status === 'pending');
    assert.deepEqual([...new Set(left.map((d) => d.email))], [ownerEmail]);
  });

  test('reminders turned off and on again before they are due are owed again', async () => {
    const { member, groupId } = await ownerAndMember();
    await h.tick();
    await inject('PUT', member.cookie, `/api/groups/${groupId}/reminders`, { enabled: false, offsetsMinutes: [1440, 60] });
    assert.equal((await h.tick()).suppressed, 16);
    await inject('PUT', member.cookie, `/api/groups/${groupId}/reminders`, { enabled: true, offsetsMinutes: [1440, 60] });
    await h.tick();
    assert.equal((await deliveries()).filter((d) => d.email === 'member@example.test' && d.status === 'pending').length, 2);

    h.clock.set('2026-11-01T12:15:00Z');
    assert.equal((await h.tick()).enqueued, 2);
    await h.worker.runOnce();
    assert.equal((await remindersTo('member@example.test')).length, 1);
  });

  test('a schedule change that deletes a meeting takes back its queued reminders; changing back does not send one twice', async () => {
    const { owner, groupId } = await ownerAndMember();
    const schedule = (weekday: number) => inject('PATCH', owner.cookie, `/api/groups/${groupId}/schedule`, { weekday, localTime: '06:15', timeZone: 'America/Chicago' });
    h.clock.set('2026-11-01T12:15:00Z');
    assert.equal((await h.tick()).enqueued, 2);

    assert.equal((await schedule(2)).statusCode, 200);
    assert.deepEqual(
      (await reminderJobs()).map((j) => [j.status, j.last_error]),
      [
        ['failed', 'reminder suppressed'],
        ['failed', 'reminder suppressed'],
      ],
      'taken back in the same transaction, before any tick',
    );
    assert.equal(await h.worker.runOnce(), 0);
    const orphaned = await h.db.query<{ status: string }>('SELECT status FROM reminder_deliveries WHERE occurrence_id IS NULL ORDER BY status');
    assert.deepEqual([...new Set(orphaned.rows.map((r) => r.status))], ['suppressed'], 'the rows stay as the record');

    // Back to Monday: the reminders never went, so they are owed for the new meeting.
    assert.equal((await schedule(1)).statusCode, 200);
    assert.equal((await h.tick()).enqueued, 2);
    assert.equal(await h.worker.runOnce(), 2);
    await h.tick();

    // Sent this time: away to Tuesday and back again sends nothing more.
    assert.equal((await schedule(2)).statusCode, 200);
    assert.equal((await schedule(1)).statusCode, 200);
    h.clock.set('2026-11-01T12:20:00Z');
    assert.equal((await h.tick()).enqueued, 0);
    assert.equal((await remindersTo('member@example.test')).length, 1);
    assert.equal((await remindersTo(ownerEmail)).length, 1);
  });

  test('a display name that looks like a placeholder is sent as written', async () => {
    const { member } = await ownerAndMember();
    await inject('PATCH', member.cookie, '/api/me', { displayName: 'Mark {{constructor}} {{code}}' });
    h.clock.set('2026-11-01T12:15:00Z');
    await h.tick();
    assert.equal(await h.worker.runOnce(), 2);
    const [text] = await remindersTo('member@example.test');
    assert.ok(text.includes('Mark {{constructor}} {{code}}'), text);
  });

  test('S11.4 moving the meeting after the reminder was queued suppresses it and schedules reminders for the new time', async () => {
    const { member, groupId } = await ownerAndMember();
    h.clock.set('2026-11-01T12:15:00Z');
    assert.equal((await h.tick()).enqueued, 2);

    const moved = await change(member.cookie, groupId, await firstMeeting(member.cookie, groupId), { localDate: '2026-11-03' });
    assert.equal(moved.startsAt, '2026-11-03T12:15:00.000Z');
    const result = await h.tick();
    assert.equal(result.suppressed, 4, 'the two queued day-before reminders and the two pending hour-before ones');
    assert.equal(result.enqueued, 0);
    assert.deepEqual(
      (await reminderJobs()).map((j) => [j.status, j.last_error]),
      [
        ['failed', 'reminder suppressed'],
        ['failed', 'reminder suppressed'],
      ],
    );
    assert.equal(await h.worker.runOnce(), 0, 'nothing left to send');
    const pending = (await deliveries()).filter((d) => d.status === 'pending');
    assert.deepEqual(
      pending.map((d) => d.send_after.toISOString()),
      ['2026-11-02T12:15:00.000Z', '2026-11-02T12:15:00.000Z', '2026-11-03T11:15:00.000Z', '2026-11-03T11:15:00.000Z'],
    );

    h.clock.set('2026-11-02T12:15:00Z');
    assert.equal((await h.tick()).enqueued, 2, 'the day-before reminders for the new time');

    const cancelled = await change(member.cookie, groupId, moved, { status: 'cancelled' });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal((await h.tick()).suppressed, 4);
    assert.equal((await deliveries()).filter((d) => d.status === 'pending').length, 0);
    assert.equal(await h.worker.runOnce(), 0);
    assert.deepEqual(await remindersTo('member@example.test'), []);
  });

  test('planning the passage after a reminder went out does not send it again', async () => {
    const { member, groupId } = await ownerAndMember();
    h.clock.set('2026-11-01T12:15:00Z');
    await h.tick();
    await h.worker.runOnce();
    await h.tick();
    await change(member.cookie, groupId, await firstMeeting(member.cookie, groupId), { plannedPassage: { bookId: 'ROM', chapter: 3 } });
    h.clock.set('2026-11-01T12:20:00Z');
    assert.equal((await h.tick()).enqueued, 0);
    assert.equal((await remindersTo('member@example.test')).length, 1);
  });

  test('a removed member’s pending reminders are suppressed', async () => {
    const { owner, member, groupId } = await ownerAndMember();
    await h.tick();
    const removed = await inject('DELETE', owner.cookie, `/api/groups/${groupId}/members/${member.userId}`);
    assert.equal(removed.statusCode, 204, removed.body);
    assert.equal((await h.tick()).suppressed, 16, 'two for each of the eight meetings ahead');
    h.clock.set('2026-11-01T12:15:00Z');
    await h.tick();
    assert.deepEqual(
      (await reminderJobs()).map((j) => j.to_address),
      [ownerEmail],
    );
  });

  test('S11.5 a tick 31 minutes after a reminder was due suppresses it', async () => {
    await ownerAndMember();
    await h.tick();
    h.clock.set('2026-11-01T12:46:00Z');
    const late = await h.tick();
    assert.equal(late.enqueued, 0);
    assert.equal(late.suppressed, 2);
    assert.deepEqual(
      (await deliveries()).map((d) => [d.offset_minutes, d.status]),
      [
        [1440, 'suppressed'],
        [1440, 'suppressed'],
        [60, 'pending'],
        [60, 'pending'],
      ],
    );
    assert.deepEqual(await reminderJobs(), []);
  });

  test('S11.5 a reminder 30 minutes late still goes out; a meeting first seen 31 minutes late gets none', async () => {
    await ownerAndMember();
    h.clock.set('2026-11-01T12:45:00Z');
    assert.equal((await h.tick()).enqueued, 2, 'deliveries made late but within 30 minutes are sent');

    await truncateAll(h.db);
    h.clock.set('2026-11-01T12:00:00Z');
    await ownerAndMember();
    h.clock.set('2026-11-01T12:46:00Z');
    const late = await h.tick();
    assert.equal(late.enqueued, 0);
    assert.equal(late.suppressed, 0);
    assert.deepEqual(
      (await deliveries()).map((d) => d.offset_minutes),
      [60, 60],
    );
  });

  test('S11.6 a worker killed between claim and send delivers each reminder at most once', async () => {
    await ownerAndMember();
    h.clock.set('2026-11-01T12:15:00Z');
    assert.equal((await h.tick()).enqueued, 2);

    // The worker claimed both and died before sending.
    const claimed = await h.db.query(
      `UPDATE email_jobs SET status = 'sending', claimed_at = $1, attempts = attempts + 1 WHERE kind = 'reminder' AND status = 'queued'`,
      [h.clock.now()],
    );
    assert.equal(claimed.rowCount, 2);
    assert.equal(await h.worker.runOnce(), 0, 'a fresh claim is left alone');
    assert.equal((await h.tick()).suppressed, 0, 'a claimed email is never taken back');

    h.clock.set('2026-11-01T12:26:00Z');
    assert.equal(await h.worker.runOnce(), 2, 'the stale claims are picked up');
    assert.equal(await h.worker.runOnce(), 0);
    await h.tick();
    assert.deepEqual(
      (await deliveries()).filter((d) => d.offset_minutes === 1440).map((d) => d.status),
      ['sent', 'sent'],
    );
    assert.equal((await remindersTo('member@example.test')).length, 1);
    assert.equal((await remindersTo(ownerEmail)).length, 1);
  });

  test('S11.7 reminders go only to the synthetic addresses the tests created', async () => {
    await ownerAndMember();
    for (const at of ['2026-11-01T12:15:00Z', '2026-11-02T11:15:00Z']) {
      h.clock.set(at);
      await h.tick();
    }
    const addresses = (await h.db.query<{ to_address: string }>('SELECT DISTINCT to_address FROM email_jobs')).rows.map((r) => r.to_address);
    assert.ok(addresses.length > 0);
    assert.ok(addresses.every((a) => a.endsWith('@example.test')), addresses.join(', '));
    assert.match(h.config.smtpUrl, /^smtp:\/\/localhost:/);
  });
});

describe('S11 reminder preferences', () => {
  test('the default is a day and an hour before; a change is the member’s own', async () => {
    const { owner, member, groupId } = await ownerAndMember();
    assert.deepEqual((await inject('GET', member.cookie, `/api/groups/${groupId}/reminders`)).json(), { enabled: true, offsetsMinutes: [1440, 60] });
    const saved = await inject('PUT', member.cookie, `/api/groups/${groupId}/reminders`, { enabled: true, offsetsMinutes: [15, 10080, 120] });
    assert.deepEqual(saved.json(), { enabled: true, offsetsMinutes: [10080, 120, 15] });
    assert.deepEqual((await inject('GET', member.cookie, `/api/groups/${groupId}/reminders`)).json(), { enabled: true, offsetsMinutes: [10080, 120, 15] });
    assert.deepEqual((await inject('GET', owner.cookie, `/api/groups/${groupId}/reminders`)).json(), { enabled: true, offsetsMinutes: [1440, 60] });
  });

  test('invalid preferences are refused', async () => {
    const { member, groupId } = await ownerAndMember();
    for (const body of [
      { offsetsMinutes: [60] },
      { enabled: 'yes', offsetsMinutes: [60] },
      { enabled: true },
      { enabled: true, offsetsMinutes: [4] },
      { enabled: true, offsetsMinutes: [10081] },
      { enabled: true, offsetsMinutes: [60.5] },
      { enabled: true, offsetsMinutes: ['60'] },
      { enabled: true, offsetsMinutes: [60, 60] },
      { enabled: true, offsetsMinutes: [5, 10, 15, 20, 25, 30] },
    ]) {
      const response = await inject('PUT', member.cookie, `/api/groups/${groupId}/reminders`, body);
      assert.equal(response.statusCode, 400, JSON.stringify(body));
      assert.equal(response.json().error, 'invalid_request');
    }
    assert.deepEqual((await inject('GET', member.cookie, `/api/groups/${groupId}/reminders`)).json(), { enabled: true, offsetsMinutes: [1440, 60] });
  });

  test('a non-member cannot read or change them', async () => {
    const { groupId } = await ownerAndMember();
    const stranger = await signIn(h, 'stranger@example.test');
    for (const response of [
      await inject('GET', stranger.cookie, `/api/groups/${groupId}/reminders`),
      await inject('PUT', stranger.cookie, `/api/groups/${groupId}/reminders`, { enabled: false, offsetsMinutes: [] }),
    ]) {
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error, 'not_member');
    }
    const anonymous = await h.app.inject({ method: 'GET', url: `/api/groups/${groupId}/reminders` });
    assert.equal(anonymous.statusCode, 401);
  });
});

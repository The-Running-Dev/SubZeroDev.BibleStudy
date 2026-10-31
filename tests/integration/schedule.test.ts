import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { GroupView, OccurrenceView } from '../../src/shared/api.ts';
import type { Harness } from '../support/harness.ts';
import { clearMailbox, ownerEmail, signIn, startHarness, truncateAll } from '../support/harness.ts';

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

type Method = 'GET' | 'POST' | 'PATCH';
const inject = (method: Method, cookie: string, url: string, payload?: object) => h.app.inject({ method, url, cookies: { bs_session: cookie }, payload });

interface Member {
  cookie: string;
  userId: string;
}

// Olive owns the group from Chicago; Mark is a member in Sofia.
async function ownerAndMember(): Promise<{ owner: Member; member: Member; groupId: string }> {
  const owner = await signIn(h, ownerEmail);
  const groupId = (await inject('GET', owner.cookie, '/api/groups')).json()[0].id;
  const link = (await inject('POST', owner.cookie, `/api/groups/${groupId}/invitations`)).json().link as string;
  const member = await signIn(h, 'member@example.test', new URL(link).pathname.replace('/join/', ''));
  await inject('PATCH', owner.cookie, '/api/me', { displayName: 'Olive', timeZone: 'America/Chicago' });
  await inject('PATCH', member.cookie, '/api/me', { displayName: 'Mark', timeZone: 'Europe/Sofia' });
  return { owner, member, groupId };
}

async function meetings(cookie: string, groupId: string, query = ''): Promise<OccurrenceView[]> {
  const response = await inject('GET', cookie, `/api/groups/${groupId}/occurrences${query}`);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

const on = (list: OccurrenceView[], localDate: string) => {
  const found = list.find((m) => m.anchor.localDate === localDate);
  assert.ok(found, `a meeting on ${localDate}`);
  return found;
};

async function change(cookie: string, groupId: string, meeting: OccurrenceView, body: object) {
  return inject('PATCH', cookie, `/api/groups/${groupId}/occurrences/${meeting.id}`, { expectedRevision: meeting.revision, ...body });
}

describe('S10 meeting times in each member’s zone', () => {
  test('S10.1 the 2 November 2026 meeting starts at 12:15Z: 06:15 in Chicago, 14:15 in Sofia', async () => {
    const { owner, member, groupId } = await ownerAndMember();
    const forOwner = await meetings(owner.cookie, groupId);
    assert.equal(forOwner.length, 8, 'eight weeks of Mondays');
    assert.deepEqual(
      forOwner.map((m) => m.anchor.localDate),
      ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07', '2026-12-14', '2026-12-21'],
    );
    const first = forOwner[0];
    assert.equal(first.startsAt, '2026-11-02T12:15:00.000Z');
    assert.deepEqual(first.anchor, { localDate: '2026-11-02', localTime: '06:15', timeZone: 'America/Chicago' });
    assert.deepEqual(first.viewer, { localDate: '2026-11-02', localTime: '06:15', timeZone: 'America/Chicago', abbreviation: 'CST' });

    const forMember = on(await meetings(member.cookie, groupId), '2026-11-02');
    assert.equal(forMember.id, first.id);
    assert.equal(forMember.startsAt, '2026-11-02T12:15:00.000Z');
    assert.equal(forMember.viewer.localTime, '14:15');
    assert.equal(forMember.viewer.timeZone, 'Europe/Sofia');
  });

  test('S10.2 across both clock changes: 26 October 2026 and 9 March 2026 are 06:15 in Chicago and 13:15 in Sofia', async () => {
    const { owner, member, groupId } = await ownerAndMember();
    h.clock.set('2026-10-20T12:00:00Z');
    const october = on(await meetings(owner.cookie, groupId), '2026-10-26');
    assert.equal(october.startsAt, '2026-10-26T11:15:00.000Z');
    assert.equal(october.viewer.localTime, '06:15');
    assert.equal(on(await meetings(member.cookie, groupId), '2026-10-26').viewer.localTime, '13:15');

    h.clock.set('2026-03-01T12:00:00Z');
    const march = on(await meetings(owner.cookie, groupId), '2026-03-09');
    assert.equal(march.startsAt, '2026-03-09T11:15:00.000Z');
    assert.equal(march.viewer.localTime, '06:15');
    assert.equal(march.viewer.abbreviation, 'CDT');
    assert.equal(on(await meetings(member.cookie, groupId), '2026-03-09').viewer.localTime, '13:15');
    // The Monday before Chicago's change is still an hour later in Sofia.
    assert.equal(on(await meetings(member.cookie, groupId), '2026-03-02').viewer.localTime, '14:15');
  });

  test('S10.3 a new schedule time regenerates the eight weeks ahead; moved and cancelled meetings keep their overrides', async () => {
    const { owner, member, groupId } = await ownerAndMember();
    const before = await meetings(member.cookie, groupId);
    const moved = await change(member.cookie, groupId, on(before, '2026-11-09'), { localDate: '2026-11-10', localTime: '07:30' });
    assert.equal(moved.statusCode, 200, moved.body);
    const cancelled = await change(member.cookie, groupId, on(before, '2026-11-16'), { status: 'cancelled' });
    assert.equal(cancelled.statusCode, 200, cancelled.body);

    const saved = await inject('PATCH', owner.cookie, `/api/groups/${groupId}/schedule`, { weekday: 1, localTime: '07:00', timeZone: 'America/Chicago' });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual((saved.json() as GroupView).schedule, { weekday: 1, localTime: '07:00', timeZone: 'America/Chicago' });

    const after = await meetings(owner.cookie, groupId);
    assert.equal(after.length, 8);
    for (const m of after.filter((x) => x.id !== moved.json().id)) {
      assert.equal(m.anchor.localTime, '07:00', m.anchor.localDate);
      assert.equal(m.viewer.localTime, '07:00');
      assert.ok(m.revision > on(before, m.anchor.localDate).revision, 'a regenerated meeting has a new revision');
    }
    assert.deepEqual(on(after, '2026-11-10').anchor, { localDate: '2026-11-10', localTime: '07:30', timeZone: 'America/Chicago' });
    assert.equal(on(after, '2026-11-10').revision, moved.json().revision, 'the moved meeting is untouched');
    assert.equal(on(after, '2026-11-16').status, 'cancelled');
    assert.equal(on(after, '2026-11-02').startsAt, '2026-11-02T13:00:00.000Z');

    // Moving the day: the Mondays nobody moved give way to Tuesdays, one meeting a day.
    const tuesdays = await inject('PATCH', owner.cookie, `/api/groups/${groupId}/schedule`, { weekday: 2, localTime: '07:00', timeZone: 'America/Chicago' });
    assert.equal(tuesdays.statusCode, 200, tuesdays.body);
    const dates = (await meetings(owner.cookie, groupId)).map((m) => m.anchor.localDate);
    assert.deepEqual(dates, ['2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24', '2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22']);
    assert.equal(on(await meetings(owner.cookie, groupId), '2026-11-10').anchor.localTime, '07:30');
  });

  test('S10.3 only the owner changes the schedule, and only to a known zone', async () => {
    const { owner, member, groupId } = await ownerAndMember();
    const notOwner = await inject('PATCH', member.cookie, `/api/groups/${groupId}/schedule`, { weekday: 1, localTime: '07:00', timeZone: 'America/Chicago' });
    assert.equal(notOwner.statusCode, 403);
    assert.equal(notOwner.json().error, 'not_owner');
    const badZone = await inject('PATCH', owner.cookie, `/api/groups/${groupId}/schedule`, { weekday: 1, localTime: '07:00', timeZone: 'Mars/Olympus' });
    assert.equal(badZone.statusCode, 400);
    assert.equal(badZone.json().error, 'invalid_zone');
    const offset = await inject('PATCH', owner.cookie, `/api/groups/${groupId}/schedule`, { weekday: 1, localTime: '07:00', timeZone: '+02:00' });
    assert.equal(offset.json().error, 'invalid_zone');
    const badTime = await inject('PATCH', owner.cookie, `/api/groups/${groupId}/schedule`, { weekday: 8, localTime: '07:00', timeZone: 'America/Chicago' });
    assert.equal(badTime.statusCode, 400);
  });

  test('S10.4 a move based on a stale revision returns stale_revision with the current meeting', async () => {
    const { owner, member, groupId } = await ownerAndMember();
    const seen = on(await meetings(owner.cookie, groupId), '2026-11-23');
    const first = await change(member.cookie, groupId, seen, { localTime: '08:00' });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().revision, seen.revision + 1);

    const second = await change(owner.cookie, groupId, seen, { localDate: '2026-11-24' });
    assert.equal(second.statusCode, 409, second.body);
    assert.equal(second.json().error, 'stale_revision');
    assert.equal(second.json().details.current.anchor.localTime, '08:00');
    assert.equal(second.json().details.current.viewer.timeZone, 'America/Chicago');
    assert.equal(on(await meetings(owner.cookie, groupId), '2026-11-23').anchor.localTime, '08:00', 'the stale move changed nothing');
  });

  test('S10.5 each member sees their profile zone, and it follows a profile change', async () => {
    const { member, groupId } = await ownerAndMember();
    assert.equal((await meetings(member.cookie, groupId))[0].viewer.localTime, '14:15');
    await inject('PATCH', member.cookie, '/api/me', { timeZone: 'Asia/Tokyo' });
    const tokyo = (await meetings(member.cookie, groupId))[0];
    assert.deepEqual(tokyo.viewer, { localDate: '2026-11-02', localTime: '21:15', timeZone: 'Asia/Tokyo', abbreviation: 'GMT+9' });
  });

  test('any member cancels, restores and plans the passage; one meeting a day; no move into the past', async () => {
    const { owner, member, groupId } = await ownerAndMember();
    const list = await meetings(member.cookie, groupId);
    const planned = await change(member.cookie, groupId, list[0], { plannedPassage: { bookId: 'ROM', chapter: 3, startVerse: 1, endVerse: 8 } });
    assert.equal(planned.statusCode, 200, planned.body);
    assert.deepEqual(planned.json().plannedPassage, { bookId: 'ROM', chapter: 3, startVerse: 1, endVerse: 8 });
    const cleared = await change(member.cookie, groupId, planned.json(), { plannedPassage: null });
    assert.equal(cleared.json().plannedPassage, null);
    const badPassage = await change(member.cookie, groupId, cleared.json(), { plannedPassage: { bookId: 'ROM', chapter: 17 } });
    assert.equal(badPassage.statusCode, 400);

    const clash = await change(member.cookie, groupId, list[1], { localDate: list[0].anchor.localDate });
    assert.equal(clash.statusCode, 409, clash.body);
    assert.equal(clash.json().error, 'invalid_request');
    const past = await change(member.cookie, groupId, list[1], { localDate: '2026-10-30' });
    assert.equal(past.statusCode, 400);

    const off = await change(owner.cookie, groupId, list[1], { status: 'cancelled' });
    assert.equal(off.json().status, 'cancelled');
    const onto = await change(member.cookie, groupId, list[2], { localDate: list[1].anchor.localDate });
    assert.equal(onto.statusCode, 200, 'a cancelled meeting does not hold its day');
    const restore = await change(member.cookie, groupId, off.json(), { status: 'scheduled' });
    assert.equal(restore.statusCode, 409, 'restoring onto a day taken since is refused');

    const outsider = await signIn(h, 'outsider@example.test');
    assert.equal((await inject('GET', outsider.cookie, `/api/groups/${groupId}/occurrences`)).statusCode, 403);
    assert.equal((await change(outsider.cookie, groupId, list[0], { status: 'cancelled' })).statusCode, 403);
    assert.equal((await change(member.cookie, groupId, list[0], {})).statusCode, 400, 'nothing to change');
    assert.equal((await inject('PATCH', member.cookie, `/api/groups/${groupId}/occurrences/${list[0].id}`, { status: 'cancelled' })).statusCode, 400, 'no revision');
  });

  test('a range lists the meetings starting within it', async () => {
    const { owner, groupId } = await ownerAndMember();
    const range = await meetings(owner.cookie, groupId, '?from=2026-11-05T00:00:00Z&to=2026-11-20T00:00:00Z');
    assert.deepEqual(
      range.map((m) => m.anchor.localDate),
      ['2026-11-09', '2026-11-16'],
    );
    assert.equal((await inject('GET', owner.cookie, `/api/groups/${groupId}/occurrences?from=soon`)).statusCode, 400);
  });
});

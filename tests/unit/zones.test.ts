import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { addDays, instantFor, isLocalDate, isoWeekday, localizeOccurrence, wallClock } from '../../src/shared/zones.ts';

describe('S10 wall-clock conversion in IANA zones', () => {
  test('S10.1 Monday 2 November 2026 06:15 in Chicago is 12:15Z and 14:15 in Sofia', () => {
    const startsAt = instantFor('2026-11-02', '06:15', 'America/Chicago');
    assert.equal(startsAt, '2026-11-02T12:15:00.000Z');
    assert.deepEqual(localizeOccurrence(startsAt, 'America/Chicago'), { localDate: '2026-11-02', localTime: '06:15', abbreviation: 'CST' });
    assert.equal(localizeOccurrence(startsAt, 'Europe/Sofia').localTime, '14:15');
  });

  test('S10.2 26 October and 9 March fall between the two countries’ changes: 13:15 in Sofia', () => {
    for (const date of ['2026-10-26', '2026-03-09']) {
      const startsAt = instantFor(date, '06:15', 'America/Chicago');
      assert.equal(startsAt, `${date}T11:15:00.000Z`);
      assert.equal(localizeOccurrence(startsAt, 'America/Chicago').abbreviation, 'CDT');
      assert.equal(localizeOccurrence(startsAt, 'Europe/Sofia').localTime, '13:15');
    }
  });

  test('a time skipped by clocks going forward is read with the offset before the change', () => {
    assert.equal(instantFor('2026-03-08', '02:30', 'America/Chicago'), '2026-03-08T08:30:00.000Z');
    assert.equal(wallClock(Date.parse('2026-03-08T08:30:00Z'), 'America/Chicago').localTime, '03:30');
    assert.equal(instantFor('2026-03-29', '03:30', 'Europe/Sofia'), '2026-03-29T01:30:00.000Z');
  });

  test('a time repeated by clocks going back is its first occurrence', () => {
    assert.equal(instantFor('2026-11-01', '01:30', 'America/Chicago'), '2026-11-01T06:30:00.000Z');
    assert.equal(instantFor('2026-10-25', '03:30', 'Europe/Sofia'), '2026-10-25T00:30:00.000Z');
  });

  test('round trips every quarter hour across a year in both zones', () => {
    for (const zone of ['America/Chicago', 'Europe/Sofia', 'Asia/Kolkata', 'UTC']) {
      for (let ms = Date.parse('2026-01-01T00:00:00Z'); ms < Date.parse('2027-01-01T00:00:00Z'); ms += 15 * 60 * 1000) {
        const { localDate, localTime } = wallClock(ms, zone);
        const back = Date.parse(instantFor(localDate, localTime, zone));
        assert.ok(back === ms || back === ms - 60 * 60 * 1000, `${zone} ${new Date(ms).toISOString()}`);
      }
    }
  });

  test('dates: validity, weekdays and day arithmetic across month and year ends', () => {
    assert.equal(isLocalDate('2026-02-29'), false);
    assert.equal(isLocalDate('2028-02-29'), true);
    assert.equal(isLocalDate('2026-1-05'), false);
    assert.equal(isoWeekday('2026-11-02'), 1);
    assert.equal(isoWeekday('2026-11-08'), 7);
    assert.equal(addDays('2026-12-28', 7), '2027-01-04');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  });
});

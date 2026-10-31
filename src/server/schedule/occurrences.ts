import type { GroupView, OccurrenceStatus, OccurrenceView, PassageRef } from '../../shared/api.ts';
import { bookById } from '../../shared/books.ts';
import { maxVerse } from '../../shared/reference.ts';
import { addDays, instantFor, isLocalDate, isoWeekday, localizeOccurrence, timePattern, wallClock } from '../../shared/zones.ts';
import { getGroup, requireMember, requireOwner } from '../groups/groups.ts';
import { canonicalTimeZone } from '../identity/validation.ts';
import type { Clock } from '../platform/clock.ts';
import type { Db, Queryable, Tx } from '../platform/db.ts';
import { withTransaction } from '../platform/db.ts';
import { AppError } from '../platform/errors.ts';
import { isUuid, uuidv7 } from '../platform/ids.ts';

// Meeting occurrences (S10). The group's weekly schedule is materialized eight weeks ahead; each row keeps the
// wall-clock date and time it was set in, and its instant is derived from them in that zone (I-06).

export interface ScheduleDeps {
  db: Db;
  clock: Clock;
}

export const windowDays = 56;
const dayMs = 24 * 60 * 60 * 1000;
const maxRangeMs = 366 * dayMs;
// Meetings are kept to dates this far ahead, which also keeps every date one Intl can convert.
const maxAheadDays = 3660;
const isoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const earliest = Date.UTC(2000, 0, 1);
const latest = Date.UTC(2200, 0, 1);

const invalid = (message: string) => new AppError('invalid_request', 400, message);
const notFound = () => new AppError('not_found', 404, 'No such meeting.');
const invalidZone = (zone: unknown) => new AppError('invalid_zone', 400, `${String(zone)} is not a known time zone.`);

interface OccurrenceRow {
  id: string;
  local_date: string;
  local_time: string;
  time_zone: string;
  starts_at: Date;
  status: OccurrenceStatus;
  moved: boolean;
  planned_book_id: string | null;
  planned_chapter: number | null;
  planned_start_verse: number | null;
  planned_end_verse: number | null;
  revision: number;
}

const columns = 'id, local_date, local_time, time_zone, starts_at, status, moved, planned_book_id, planned_chapter, planned_start_verse, planned_end_verse, revision';

function toView(row: OccurrenceRow, viewerZone: string): OccurrenceView {
  const startsAt = row.starts_at.toISOString();
  const plannedPassage: PassageRef | null =
    row.planned_book_id === null ? null : { bookId: row.planned_book_id, chapter: row.planned_chapter!, startVerse: row.planned_start_verse, endVerse: row.planned_end_verse };
  return {
    id: row.id,
    startsAt,
    status: row.status,
    revision: row.revision,
    plannedPassage,
    anchor: { localDate: row.local_date, localTime: row.local_time, timeZone: row.time_zone },
    viewer: { ...localizeOccurrence(startsAt, viewerZone), timeZone: viewerZone },
  };
}

// S10.5: every view is in the viewer's profile zone, whatever the browser's.
async function viewerZone(q: Queryable, userId: string): Promise<string> {
  const result = await q.query<{ time_zone: string }>('SELECT time_zone FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.time_zone ?? 'UTC';
}

interface Schedule {
  weekday: number;
  localTime: string;
  timeZone: string;
}

// Adds the schedule's slots from today through the window that are still ahead. A slot that already has a row, or a
// day another meeting was moved onto, is left as it is.
async function materialize(tx: Tx, clock: Clock, groupId: string, schedule: Schedule): Promise<void> {
  const now = clock.now().getTime();
  const today = wallClock(now, schedule.timeZone).localDate;
  for (let day = 0; day <= windowDays; day++) {
    const date = addDays(today, day);
    if (isoWeekday(date) !== schedule.weekday) continue;
    const startsAt = instantFor(date, schedule.localTime, schedule.timeZone);
    if (Date.parse(startsAt) <= now) continue;
    await tx.query(
      `INSERT INTO occurrences (id, group_id, slot_date, local_date, local_time, time_zone, starts_at, updated_at)
       VALUES ($1, $2, $3, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [uuidv7(now), groupId, date, schedule.localTime, schedule.timeZone, startsAt, new Date(now)],
    );
  }
}

async function lockedSchedule(tx: Tx, groupId: string, mode: 'SHARE' | 'UPDATE'): Promise<Schedule> {
  const result = await tx.query<{ schedule_weekday: number; schedule_local_time: string; schedule_time_zone: string }>(
    `SELECT schedule_weekday, schedule_local_time, schedule_time_zone FROM groups WHERE id = $1 FOR ${mode}`,
    [groupId],
  );
  const row = result.rows[0];
  return { weekday: row.schedule_weekday, localTime: row.schedule_local_time, timeZone: row.schedule_time_zone };
}

function instant(value: unknown, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const ms = typeof value === 'string' && isoInstant.test(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(ms) || ms < earliest || ms >= latest) throw invalid('from and to are ISO instants between 2000 and 2200.');
  return ms;
}

// The meetings starting in [from, to), cancelled ones included; by default the next eight weeks.
export async function listOccurrences(deps: ScheduleDeps, userId: string, groupId: unknown, range: { from?: unknown; to?: unknown } = {}): Promise<OccurrenceView[]> {
  await requireMember(deps.db, userId, groupId);
  const group = groupId as string;
  const now = deps.clock.now().getTime();
  const from = instant(range.from, now);
  const to = instant(range.to, now + windowDays * dayMs);
  if (to <= from || to - from > maxRangeMs) throw invalid('The range must end after it starts and span at most a year.');
  return withTransaction(deps.db, async (tx) => {
    await materialize(tx, deps.clock, group, await lockedSchedule(tx, group, 'SHARE'));
    const rows = await tx.query<OccurrenceRow>(
      `SELECT ${columns} FROM occurrences WHERE group_id = $1 AND starts_at >= $2 AND starts_at < $3 ORDER BY starts_at, id`,
      [group, new Date(from), new Date(to)],
    );
    const zone = await viewerZone(tx, userId);
    return rows.rows.map((row) => toView(row, zone));
  });
}

function plannedPassage(value: unknown): PassageRef | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object') throw invalid('A planned passage is a chapter or verses, or null.');
  const p = value as Record<string, unknown>;
  const book = typeof p.bookId === 'string' ? bookById(p.bookId) : undefined;
  const chapter = p.chapter;
  if (!book || !Number.isInteger(chapter) || (chapter as number) < 1 || (chapter as number) > book.chapters) throw invalid('That is not a chapter.');
  const verse = (v: unknown) => v === null || v === undefined || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= maxVerse);
  if (!verse(p.startVerse) || !verse(p.endVerse)) throw invalid('Verses must be whole numbers within a chapter.');
  const startVerse = (p.startVerse as number | null | undefined) ?? null;
  const endVerse = startVerse === null ? null : ((p.endVerse as number | null | undefined) ?? startVerse);
  if (startVerse === null && p.endVerse !== null && p.endVerse !== undefined) throw invalid('A range needs its first verse.');
  if (startVerse !== null && endVerse! < startVerse) throw invalid('A range cannot run backwards.');
  return { bookId: book.id, chapter: chapter as number, startVerse, endVerse };
}

// Any member moves, cancels, restores or plans the passage for one meeting, based on the revision they saw.
export async function updateOccurrence(deps: ScheduleDeps, userId: string, groupId: unknown, occurrenceId: unknown, request: unknown): Promise<OccurrenceView> {
  await requireMember(deps.db, userId, groupId);
  const group = groupId as string;
  if (!isUuid(occurrenceId)) throw notFound();
  const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
  if (!Number.isInteger(r.expectedRevision)) throw invalid('A change needs the revision of the meeting it was made on.');
  if (r.localDate !== undefined && !isLocalDate(r.localDate)) throw invalid('A date is YYYY-MM-DD.');
  if (r.localTime !== undefined && (typeof r.localTime !== 'string' || !timePattern.test(r.localTime))) throw invalid('A time is HH:MM.');
  if (r.status !== undefined && r.status !== 'scheduled' && r.status !== 'cancelled') throw invalid('A meeting is scheduled or cancelled.');
  const planned = r.plannedPassage === undefined ? undefined : plannedPassage(r.plannedPassage);
  if (r.localDate === undefined && r.localTime === undefined && r.status === undefined && planned === undefined) throw invalid('Nothing to change.');

  return withTransaction(deps.db, async (tx) => {
    const zone = await viewerZone(tx, userId);
    const found = await tx.query<OccurrenceRow>(`SELECT ${columns} FROM occurrences WHERE id = $1 AND group_id = $2 FOR UPDATE`, [occurrenceId, group]);
    const row = found.rows[0];
    if (!row) throw notFound();
    if (row.revision !== r.expectedRevision) {
      throw new AppError('stale_revision', 409, 'This meeting changed since you loaded it.', { details: { current: toView(row, zone) } });
    }
    const now = deps.clock.now();
    const localDate = (r.localDate as string | undefined) ?? row.local_date;
    const localTime = (r.localTime as string | undefined) ?? row.local_time;
    const moved = localDate !== row.local_date || localTime !== row.local_time;
    const today = wallClock(now.getTime(), row.time_zone).localDate;
    if (moved && localDate < addDays(today, -1)) throw invalid('A meeting can only move to a time still ahead.');
    if (moved && localDate > addDays(today, maxAheadDays)) throw invalid('A meeting can move at most ten years ahead.');
    const startsAt = moved ? instantFor(localDate, localTime, row.time_zone) : row.starts_at.toISOString();
    if (moved && Date.parse(startsAt) <= now.getTime()) throw invalid('A meeting can only move to a time still ahead.');
    const status = (r.status as OccurrenceStatus | undefined) ?? row.status;
    const plan = planned === undefined ? { bookId: row.planned_book_id, chapter: row.planned_chapter, startVerse: row.planned_start_verse, endVerse: row.planned_end_verse } : planned;
    try {
      const updated = await tx.query<OccurrenceRow>(
        `UPDATE occurrences SET local_date = $3, local_time = $4, starts_at = $5, status = $6, moved = moved OR $7, planned_book_id = $8, planned_chapter = $9,
           planned_start_verse = $10, planned_end_verse = $11, revision = revision + 1, updated_by = $12, updated_at = $13
         WHERE id = $1 AND group_id = $2 RETURNING ${columns}`,
        [row.id, group, localDate, localTime, startsAt, status, moved, plan?.bookId ?? null, plan?.chapter ?? null, plan?.startVerse ?? null, plan?.endVerse ?? null, userId, now],
      );
      return toView(updated.rows[0], zone);
    } catch (error) {
      const pg = error as { code?: string; constraint?: string };
      if (pg.code === '23505' && pg.constraint === 'occurrences_one_a_day') throw new AppError('invalid_request', 409, 'Another meeting is already scheduled that day.');
      throw error;
    }
  });
}

// S10.3: the owner changes the weekly schedule. Meetings ahead that nobody moved follow it: on the same weekday they
// take the new time and zone (a cancelled one stays cancelled); on another weekday they go, and the new weekday's
// slots are made. Moved, cancelled and planned meetings keep their date and time, and none is moved into the past.
export async function updateSchedule(deps: ScheduleDeps, userId: string, groupId: unknown, request: unknown): Promise<GroupView> {
  await requireOwner(deps.db, userId, groupId);
  const group = groupId as string;
  const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
  const weekday = r.weekday;
  if (!Number.isInteger(weekday) || (weekday as number) < 1 || (weekday as number) > 7) throw invalid('The weekday is 1 (Monday) to 7 (Sunday).');
  if (typeof r.localTime !== 'string' || !timePattern.test(r.localTime)) throw invalid('A time is HH:MM.');
  const timeZone = canonicalTimeZone(r.timeZone);
  if (!timeZone) throw invalidZone(r.timeZone);
  const schedule: Schedule = { weekday: weekday as number, localTime: r.localTime, timeZone };

  await withTransaction(deps.db, async (tx) => {
    await lockedSchedule(tx, group, 'UPDATE');
    await tx.query('UPDATE groups SET schedule_weekday = $2, schedule_local_time = $3, schedule_time_zone = $4 WHERE id = $1', [
      group,
      schedule.weekday,
      schedule.localTime,
      schedule.timeZone,
    ]);
    const now = deps.clock.now();
    const ahead = await tx.query<OccurrenceRow & { slot_date: string }>(
      `SELECT ${columns}, slot_date FROM occurrences WHERE group_id = $1 AND starts_at > $2 AND NOT moved ORDER BY starts_at FOR UPDATE`,
      [group, now],
    );
    for (const row of ahead.rows) {
      if (isoWeekday(row.slot_date) !== schedule.weekday) {
        if (row.status === 'scheduled' && row.planned_book_id === null) await tx.query('DELETE FROM occurrences WHERE id = $1', [row.id]);
        continue;
      }
      const startsAt = instantFor(row.slot_date, schedule.localTime, schedule.timeZone);
      if (Date.parse(startsAt) <= now.getTime()) continue;
      if (row.local_time === schedule.localTime && row.time_zone === schedule.timeZone && row.starts_at.toISOString() === startsAt) continue;
      await tx.query(
        `UPDATE occurrences SET local_time = $2, time_zone = $3, starts_at = $4, revision = revision + 1, updated_by = $5, updated_at = $6 WHERE id = $1`,
        [row.id, schedule.localTime, schedule.timeZone, startsAt, userId, now],
      );
    }
    await materialize(tx, deps.clock, group, schedule);
  });
  return getGroup(deps.db, userId, group);
}

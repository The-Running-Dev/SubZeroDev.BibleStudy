import type { PassageRef, ReminderPreference } from '../../shared/api.ts';
import { formatReference } from '../../shared/reference.ts';
import { wallClock, zoneAbbreviation } from '../../shared/zones.ts';
import { requireMember } from '../groups/groups.ts';
import type { Outbox } from '../mail/outbox.ts';
import { withdrawQueued } from '../mail/outbox.ts';
import type { Clock } from '../platform/clock.ts';
import type { Db, Queryable, Tx } from '../platform/db.ts';
import { withTransaction } from '../platform/db.ts';
import { AppError } from '../platform/errors.ts';
import { uuidv7 } from '../platform/ids.ts';
import { log } from '../platform/log.ts';
import { latestProgress } from '../progress/progress.ts';
import { materializeAhead } from '../schedule/occurrences.ts';

// Reminder emails (S11). Each tick works out which reminders are owed — one per scheduled meeting ahead, active member
// and offset in their preference — records each as a delivery for that meeting's revision, and queues the email once
// it is due. A delivery no longer owed (the meeting moved, was cancelled or replanned, the member left or changed their
// preference) is suppressed and its email taken back if the worker has not claimed it (I-07). Login codes never look at
// any of this (I-08).

export interface ReminderDeps {
  db: Db;
  clock: Clock;
  outbox: Outbox;
  publicUrl: string;
  // Wakes the mail worker after a tick queued something.
  onEmailQueued?: () => void;
}

export const defaultOffsets = [1440, 60];
export const minOffset = 5;
export const maxOffset = 10080;
export const maxOffsets = 5;
// A reminder this late is no longer a reminder.
export const lateMinutes = 30;
const tickMs = 60_000;

const invalid = (message: string) => new AppError('invalid_request', 400, message);

export async function getReminderPreference(db: Db, userId: string, groupId: unknown): Promise<ReminderPreference> {
  await requireMember(db, userId, groupId);
  const found = await db.query<{ enabled: boolean; offsets_minutes: number[] }>(
    'SELECT enabled, offsets_minutes FROM reminder_preferences WHERE user_id = $1 AND group_id = $2',
    [userId, groupId],
  );
  const row = found.rows[0];
  return row ? { enabled: row.enabled, offsetsMinutes: row.offsets_minutes } : { enabled: true, offsetsMinutes: [...defaultOffsets] };
}

export async function setReminderPreference(deps: { db: Db; clock: Clock }, userId: string, groupId: unknown, request: unknown): Promise<ReminderPreference> {
  await requireMember(deps.db, userId, groupId);
  const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
  if (typeof r.enabled !== 'boolean') throw invalid('enabled is true or false.');
  const offsets = r.offsetsMinutes;
  if (!Array.isArray(offsets) || offsets.length > maxOffsets) throw invalid(`offsetsMinutes is a list of at most ${maxOffsets} offsets.`);
  if (!offsets.every((o) => Number.isInteger(o) && o >= minOffset && o <= maxOffset)) throw invalid('Each offset is whole minutes, from 5 to 10080 (a week).');
  const sorted = [...new Set(offsets as number[])].sort((a, b) => b - a);
  if (sorted.length !== offsets.length) throw invalid('Each offset can appear once.');
  await deps.db.query(
    `INSERT INTO reminder_preferences (user_id, group_id, enabled, offsets_minutes, updated_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, group_id) DO UPDATE SET enabled = $3, offsets_minutes = $4, updated_at = $5`,
    [userId, groupId, r.enabled, sorted, deps.clock.now()],
  );
  return { enabled: r.enabled, offsetsMinutes: sorted };
}

// Every reminder owed now: (occurrence, revision, member, offset) for scheduled meetings still ahead. No preference row
// means the default offsets; a disabled preference means none.
const owed = `
  SELECT o.id AS occurrence_id, o.revision AS occurrence_revision, o.group_id, m.user_id, off.offset_minutes,
         o.starts_at - make_interval(mins => off.offset_minutes) AS send_after
    FROM occurrences o
    JOIN memberships m ON m.group_id = o.group_id AND m.removed_at IS NULL
    LEFT JOIN reminder_preferences p ON p.user_id = m.user_id AND p.group_id = o.group_id
    CROSS JOIN LATERAL unnest(CASE WHEN p.user_id IS NULL THEN $2::int[] WHEN p.enabled THEN p.offsets_minutes ELSE '{}'::int[] END) AS off (offset_minutes)
   WHERE o.status = 'scheduled' AND o.starts_at > $1`;

export interface TickResult {
  materialized: number;
  enqueued: number;
  suppressed: number;
}

interface DueRow {
  id: string;
  offset_minutes: number;
  email: string;
  display_name: string;
  time_zone: string;
  group_id: string;
  group_name: string;
  starts_at: Date;
  planned_book_id: string | null;
  planned_chapter: number | null;
  planned_start_verse: number | null;
  planned_end_verse: number | null;
}

// One tick, under an advisory lock so two processes never both run it. Safe to repeat: a second tick at the same
// instant finds nothing to do.
export async function reminderTick(deps: ReminderDeps): Promise<TickResult> {
  const now = deps.clock.now();
  const result = await withTransaction(deps.db, async (tx): Promise<TickResult> => {
    const locked = await tx.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked', ['reminder_tick']);
    if (!locked.rows[0].locked) return { materialized: 0, enqueued: 0, suppressed: 0 };

    let materialized = 0;
    for (const group of (await tx.query<{ id: string }>('SELECT id FROM groups ORDER BY id')).rows) materialized += await materializeAhead(tx, deps.clock, group.id);

    // An email the worker finished settles its delivery.
    await tx.query(
      `UPDATE reminder_deliveries d SET status = j.status, updated_at = $1 FROM email_jobs j
        WHERE d.email_job_id = j.id AND d.status = 'pending' AND j.status IN ('sent', 'failed')`,
      [now],
    );

    const suppressed = await suppressUnowed(tx, now);

    // New deliveries for what is owed and not too late, unless a live one exists for the same revision. A suppressed
    // one does not count, so a reminder turned off and on again is owed anew. A reminder already sent or being sent to
    // the member for the same group, offset and moment is not owed again: planning the passage bumps the revision but
    // moves nothing, and a schedule changed and changed back makes a new meeting at the same time.
    const missing = await tx.query<{ occurrence_id: string; occurrence_revision: number; group_id: string; user_id: string; offset_minutes: number; send_after: Date }>(
      `SELECT w.* FROM (${owed}) w
        WHERE w.send_after >= $1::timestamptz - make_interval(mins => $3)
          AND NOT EXISTS (SELECT 1 FROM reminder_deliveries d
                           WHERE d.user_id = w.user_id AND d.offset_minutes = w.offset_minutes
                             AND ((d.occurrence_id = w.occurrence_id AND d.occurrence_revision = w.occurrence_revision AND d.status <> 'suppressed')
                                  OR (d.group_id = w.group_id AND d.send_after = w.send_after
                                      AND (d.status = 'sent' OR (d.status = 'pending' AND d.email_job_id IS NOT NULL)))))`,
      [now, defaultOffsets, lateMinutes],
    );
    for (const row of missing.rows) {
      await tx.query(
        `INSERT INTO reminder_deliveries (id, occurrence_id, occurrence_revision, group_id, user_id, offset_minutes, send_after, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) ON CONFLICT DO NOTHING`,
        [uuidv7(now.getTime()), row.occurrence_id, row.occurrence_revision, row.group_id, row.user_id, row.offset_minutes, row.send_after, now],
      );
    }

    const enqueued = await enqueueDue(deps, tx, now);
    return { materialized, enqueued, suppressed };
  });
  if (result.enqueued) deps.onEmailQueued?.();
  return result;
}

// Pending deliveries that are no longer owed, or are more than 30 minutes late, and whose email has not been claimed.
async function suppressUnowed(tx: Tx, now: Date): Promise<number> {
  const stale = await tx.query<{ id: string; email_job_id: string | null }>(
    `SELECT d.id, d.email_job_id FROM reminder_deliveries d
      WHERE d.status = 'pending'
        AND (d.email_job_id IS NULL OR EXISTS (SELECT 1 FROM email_jobs j WHERE j.id = d.email_job_id AND j.status = 'queued'))
        AND (d.send_after < $1::timestamptz - make_interval(mins => $3)
             OR NOT EXISTS (SELECT 1 FROM (${owed}) w
                             WHERE w.occurrence_id = d.occurrence_id AND w.occurrence_revision = d.occurrence_revision
                               AND w.user_id = d.user_id AND w.offset_minutes = d.offset_minutes))
      FOR UPDATE OF d`,
    [now, defaultOffsets, lateMinutes],
  );
  return suppressDeliveries(tx, stale.rows, now);
}

// Suppresses pending deliveries, taking back each one's email while it is still queued. The worker may claim a queued
// email meanwhile; only a delivery whose email was really taken back is suppressed, and the rest settle when it finishes.
export async function suppressDeliveries(tx: Queryable, rows: { id: string; email_job_id: string | null }[], now: Date): Promise<number> {
  const withdrawn = new Set(await withdrawQueued(tx, rows.flatMap((row) => (row.email_job_id ? [row.email_job_id] : [])), 'reminder suppressed'));
  const ids = rows.filter((row) => row.email_job_id === null || withdrawn.has(row.email_job_id)).map((row) => row.id);
  if (!ids.length) return 0;
  await tx.query(`UPDATE reminder_deliveries SET status = 'suppressed', updated_at = $2 WHERE id = ANY($1::uuid[])`, [ids, now]);
  return ids.length;
}

async function enqueueDue(deps: ReminderDeps, tx: Tx, now: Date): Promise<number> {
  // The meeting row is share-locked and re-checked, so a move or cancel committed since suppressUnowed ran either
  // waits for this tick (and the next one takes the email back) or keeps the reminder from being queued.
  const due = await tx.query<DueRow>(
    `SELECT d.id, d.offset_minutes, u.email, u.display_name, u.time_zone, g.id AS group_id, g.name AS group_name, o.starts_at,
            o.planned_book_id, o.planned_chapter, o.planned_start_verse, o.planned_end_verse
       FROM reminder_deliveries d
       JOIN occurrences o ON o.id = d.occurrence_id
       JOIN groups g ON g.id = o.group_id
       JOIN users u ON u.id = d.user_id
      WHERE d.status = 'pending' AND d.email_job_id IS NULL AND d.send_after <= $1
        AND o.status = 'scheduled' AND o.revision = d.occurrence_revision AND o.starts_at > $1
        AND EXISTS (SELECT 1 FROM memberships m WHERE m.group_id = o.group_id AND m.user_id = d.user_id AND m.removed_at IS NULL)
      ORDER BY d.send_after, d.id
      FOR UPDATE OF d FOR SHARE OF o`,
    [now],
  );
  for (const row of due.rows) {
    const passage = await passageLine(tx, row);
    const email = reminderEmail({ ...row, startsAt: row.starts_at, passage, publicUrl: deps.publicUrl });
    const { jobId } = await deps.outbox.enqueueEmail(tx, { kind: 'reminder', idempotencyKey: `reminder:${row.id}`, to: row.email, ...email });
    await tx.query('UPDATE reminder_deliveries SET email_job_id = $2, updated_at = $3 WHERE id = $1', [row.id, jobId, now]);
  }
  return due.rows.length;
}

// The meeting's planned passage, or where the group stopped when none is planned.
async function passageLine(tx: Tx, row: DueRow): Promise<string | null> {
  if (row.planned_book_id !== null) {
    const ref: PassageRef = { bookId: row.planned_book_id, chapter: row.planned_chapter!, startVerse: row.planned_start_verse, endVerse: row.planned_end_verse };
    return `Passage: ${formatReference(ref)}`;
  }
  const progress = await latestProgress(tx, row.group_id);
  if (!progress) return null;
  const { bookId, chapter, verse } = progress.ref;
  return `Picking up after ${formatReference({ bookId, chapter, startVerse: verse, endVerse: verse })}`;
}

const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "Monday 2 November 2026, 14:15 EET (Europe/Sofia)": the recipient's own zone, with its name.
export function meetingTime(startsAt: Date, zone: string): string {
  const { localDate, localTime } = wallClock(startsAt.getTime(), zone);
  const [year, month, day] = localDate.split('-').map(Number);
  const weekday = weekdays[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday} ${day} ${months[month - 1]} ${year}, ${localTime} ${zoneAbbreviation(startsAt.getTime(), zone)} (${zone})`;
}

function offsetText(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? '1 day' : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function reminderEmail(input: {
  display_name: string;
  group_name: string;
  time_zone: string;
  offset_minutes: number;
  startsAt: Date;
  passage: string | null;
  publicUrl: string;
}): { subject: string; text: string; html: string } {
  const when = meetingTime(input.startsAt, input.time_zone);
  const link = `${input.publicUrl}/study`;
  const footer = `You get this ${offsetText(input.offset_minutes)} before each meeting. Change your reminders in the app, under Group.`;
  const lines = [`Hi ${input.display_name},`, '', `${input.group_name} meets ${when}.`, ...(input.passage ? [input.passage] : []), '', `Open study: ${link}`, '', footer];
  const html = [
    `<p>Hi ${escapeHtml(input.display_name)},</p>`,
    `<p>${escapeHtml(input.group_name)} meets <strong>${escapeHtml(when)}</strong>.${input.passage ? `<br>${escapeHtml(input.passage)}` : ''}</p>`,
    `<p><a href="${escapeHtml(link)}">Open study</a></p>`,
    `<p style="color:#666">${escapeHtml(footer)}</p>`,
  ].join('');
  return { subject: `${input.group_name}: ${when}`, text: lines.join('\n'), html };
}

// Runs a tick every minute until `signal` aborts. A failed tick is logged; the next one starts over.
export async function runReminders(deps: ReminderDeps, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const result = await reminderTick(deps);
      if (result.enqueued || result.suppressed) log('info', 'reminder tick', { ...result });
    } catch (error) {
      log('error', 'reminder tick failed', { error: (error as Error).message });
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, tickMs);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    });
  }
}

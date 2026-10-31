import type {
  Command,
  CommandOutcome,
  DriftReport,
  PassageRef,
  PausedReason,
  PlaybackState,
  RecordingView,
  StudySessionResponse,
  TranslationId,
  WrapUpView,
} from '../../shared/api.ts';
import { bookById } from '../../shared/books.ts';
import { derivePosition, rangeBounds, verseAtSeconds } from '../../shared/playback.ts';
import { listRecordings, resolveRecording } from '../content/narration.ts';
import { requireMember } from '../groups/groups.ts';
import { latestProgress } from '../progress/progress.ts';
import { sessionQuestions } from '../questions/questions.ts';
import type { Clock } from '../platform/clock.ts';
import type { Db, Queryable } from '../platform/db.ts';
import { withTransaction } from '../platform/db.ts';
import { AppError } from '../platform/errors.ts';
import { isUuid, uuidv7 } from '../platform/ids.ts';
import { log } from '../platform/log.ts';

// Study sessions (S5): one active session per group, its playback state, and the commands that change it.
// Every command is serialized on the session row and recorded by commandId, so a retry never applies twice (I-16).

export interface StudyDeps {
  db: Db;
  clock: Clock;
  mediaDir: string;
  onAudioQueued?: () => void;
}

const noActiveSession = () => new AppError('no_active_session', 404, 'This group has no active study session.');

interface SessionRow {
  id: string;
  group_id: string;
  status: 'active' | 'ended';
  revision: number;
  book_id: string;
  chapter: number;
  start_verse: number | null;
  end_verse: number | null;
  translation_id: TranslationId;
  narrator_id: string | null;
  recording_id: string | null;
  mode: 'narration' | 'manual';
  play_status: 'paused' | 'playing' | 'ended';
  position_seconds: number;
  anchor_server_time_ms: string;
  rate: string;
  manual_verse: number | null;
  changed_by: string | null;
  changed_by_name: string | null;
  paused_reason: PausedReason | null;
  reached_verse: number | null;
  started_at: Date;
}

const sessionColumns = `s.id, s.group_id, s.status, s.revision, s.book_id, s.chapter, s.start_verse, s.end_verse, s.translation_id,
  s.narrator_id, s.recording_id, s.mode, s.play_status, s.position_seconds, s.anchor_server_time_ms, s.rate, s.manual_verse,
  s.changed_by, u.display_name AS changed_by_name, s.paused_reason, s.reached_verse, s.started_at`;

async function loadSession(q: Queryable, sessionId: string, lock: boolean): Promise<SessionRow | null> {
  const result = await q.query<SessionRow>(
    `SELECT ${sessionColumns} FROM study_sessions s LEFT JOIN users u ON u.id = s.changed_by WHERE s.id = $1${lock ? ' FOR UPDATE OF s' : ''}`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

// The mutable part of a session, in the shape the commands change.
interface Draft {
  passage: PassageRef;
  translationId: TranslationId;
  narratorId: string | null;
  recording: RecordingView | null;
  mode: 'narration' | 'manual';
  status: 'paused' | 'playing' | 'ended';
  positionSeconds: number;
  anchorServerTimeMs: number;
  rate: number;
  manualVerse: number | null;
  pausedReason: PausedReason | null;
  // The furthest verse reached on this chapter, for the wrap-up suggestion (S9.1).
  reachedVerse: number | null;
}

function bounds(draft: Pick<Draft, 'recording' | 'passage'>) {
  return draft.recording ? rangeBounds(draft.recording.timing, draft.recording.durationSeconds, draft.passage) : { start: 0, end: 0 };
}

// The verse the study is on at `nowMs`: the marked one in manual mode, the narrated one when its timing is verified.
function verseNow(draft: Draft, nowMs: number): number | null {
  if (draft.mode === 'manual') return draft.manualVerse;
  if (!draft.recording) return null;
  const verse = verseAtSeconds(draft.recording.timing, derivePosition(draft, nowMs, bounds(draft).end));
  return verse === null ? null : Math.min(verse, draft.passage.endVerse ?? verse);
}

const furthest = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b));

// The session as it stands at `nowMs`. A playing session past its range end reads as paused there;
// that is not written back, so it does not change the revision.
async function effectiveDraft(q: Queryable, mediaDir: string, row: SessionRow, nowMs: number): Promise<Draft> {
  const passage: PassageRef = { bookId: row.book_id, chapter: row.chapter, startVerse: row.start_verse, endVerse: row.end_verse };
  // A session waiting on narration (no recording yet) takes it as soon as it is imported; one already
  // following a recording keeps it, and reads as having none if it disappears.
  const recording =
    row.mode === 'narration' && row.narrator_id ? await resolveRecording({ db: q, mediaDir }, row.translation_id, passage, row.narrator_id) : null;
  const draft: Draft = {
    passage,
    translationId: row.translation_id,
    narratorId: row.narrator_id,
    recording: recording && (row.recording_id === null || recording.id === row.recording_id) ? recording : null,
    mode: row.mode,
    status: row.play_status,
    positionSeconds: row.position_seconds,
    anchorServerTimeMs: Number(row.anchor_server_time_ms),
    rate: Number(row.rate),
    manualVerse: row.manual_verse,
    pausedReason: row.paused_reason,
    reachedVerse: row.reached_verse,
  };
  if (draft.status === 'playing') {
    // A recording that went missing cannot be followed; it reads as paused where it was.
    const end = draft.recording ? bounds(draft).end : draft.positionSeconds;
    const position = derivePosition(draft, nowMs, end);
    if (!draft.recording || position >= end) {
      Object.assign(draft, { status: 'paused', positionSeconds: position, anchorServerTimeMs: nowMs, pausedReason: 'range_end' });
    }
  }
  draft.reachedVerse = furthest(draft.reachedVerse, verseNow(draft, nowMs));
  return draft;
}

function toState(row: SessionRow, draft: Draft): PlaybackState {
  const state: PlaybackState = {
    sessionId: row.id,
    revision: row.revision,
    passage: draft.passage,
    translationId: draft.translationId,
    narratorId: draft.narratorId,
    recordingId: draft.recording?.id ?? null,
    recording: draft.recording,
    mode: draft.mode,
    status: row.status === 'ended' ? 'ended' : draft.status,
    positionSeconds: draft.positionSeconds,
    anchorServerTimeMs: draft.anchorServerTimeMs,
    rate: draft.rate,
    manualVerse: draft.manualVerse,
    changedBy: row.changed_by ? { userId: row.changed_by, displayName: row.changed_by_name ?? '' } : null,
  };
  if (draft.pausedReason && state.status === 'paused') state.pausedReason = draft.pausedReason;
  return state;
}

async function readState(q: Queryable, mediaDir: string, sessionId: string, nowMs: number): Promise<PlaybackState> {
  const row = await loadSession(q, sessionId, false);
  if (!row) throw noActiveSession();
  return toState(row, await effectiveDraft(q, mediaDir, row, nowMs));
}

async function writeDraft(q: Queryable, sessionId: string, draft: Draft, changedBy: string | null, now: Date): Promise<void> {
  await q.query(
    `UPDATE study_sessions SET revision = revision + 1, book_id = $2, chapter = $3, start_verse = $4, end_verse = $5, translation_id = $6,
       narrator_id = $7, recording_id = $8, mode = $9, play_status = $10, position_seconds = $11, anchor_server_time_ms = $12, rate = $13,
       manual_verse = $14, paused_reason = $15, changed_by = $16, changed_at = $17, reached_verse = $18,
       status = CASE WHEN $10 = 'ended' THEN 'ended' ELSE status END,
       ended_by = CASE WHEN $10 = 'ended' THEN $16 ELSE ended_by END,
       ended_at = CASE WHEN $10 = 'ended' THEN $17 ELSE ended_at END
     WHERE id = $1`,
    [
      sessionId,
      draft.passage.bookId,
      draft.passage.chapter,
      draft.passage.startVerse,
      draft.passage.endVerse,
      draft.translationId,
      draft.narratorId,
      draft.recording?.id ?? null,
      draft.mode,
      draft.status,
      draft.positionSeconds,
      draft.anchorServerTimeMs,
      draft.rate,
      draft.manualVerse,
      draft.status === 'paused' ? draft.pausedReason : null,
      changedBy,
      now,
      draft.reachedVerse,
    ],
  );
}

async function firstNarrator(q: Queryable, translationId: TranslationId): Promise<string | null> {
  const result = await q.query<{ id: string }>('SELECT id FROM narrators WHERE translation_id = $1 AND enabled ORDER BY id LIMIT 1', [translationId]);
  return result.rows[0]?.id ?? null;
}

// Queues the narration a session is waiting for. Failure is logged, not raised: the command already committed.
async function queueAudio(deps: StudyDeps, passage: PassageRef): Promise<void> {
  try {
    const listing = await listRecordings(deps, 'BSB', passage.bookId, passage.chapter);
    if (listing.queued) deps.onAudioQueued?.();
  } catch (error) {
    log('warn', 'could not queue session narration', { bookId: passage.bookId, chapter: passage.chapter, error: (error as Error).message });
  }
}

// ---- start, join, read ----

// Starts the group's session, or returns the active one. Concurrent starts converge on one row (I-15).
// A new session resumes at the group's stopping point (DOD-19), or opens the group's starting chapter before it has one.
export async function startOrJoinSession(deps: StudyDeps, userId: string, groupId: unknown): Promise<StudySessionResponse> {
  const { db, clock } = deps;
  await requireMember(db, userId, groupId);
  const id = groupId as string;
  let waiting: PassageRef | null = null;
  const sessionId = await withTransaction(db, async (tx) => {
    const active = await tx.query<{ id: string }>(`SELECT id FROM study_sessions WHERE group_id = $1 AND status = 'active'`, [id]);
    if (active.rowCount) return active.rows[0].id;
    const group = (
      await tx.query<{ shared_translation_id: TranslationId; narrator_id: string | null; rate: string; start_book_id: string; start_chapter: number }>(
        'SELECT shared_translation_id, narrator_id, rate, start_book_id, start_chapter FROM groups WHERE id = $1',
        [id],
      )
    ).rows[0];
    const progress = await latestProgress(tx, id);
    const passage: PassageRef = progress
      ? { bookId: progress.ref.bookId, chapter: progress.ref.chapter, startVerse: null, endVerse: null }
      : { bookId: group.start_book_id, chapter: group.start_chapter, startVerse: null, endVerse: null };
    const verse = progress?.ref.verse ?? 1;
    const narratorId = group.narrator_id ?? (await firstNarrator(tx, 'BSB'));
    const manual = group.shared_translation_id === 'CSB' || !narratorId;
    const recording = manual ? null : await resolveRecording({ db: tx, mediaDir: deps.mediaDir }, 'BSB', passage, narratorId);
    if (!manual && !recording) waiting = passage;
    // Narration starts at the verse when its timing is known; before that it can only start at the chapter's beginning.
    const position = recording?.timing.status === 'verified' ? (recording.timing.verseStarts[verse - 1] ?? 0) : 0;
    const now = clock.now();
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO study_sessions (id, group_id, status, started_by, started_at, revision, book_id, chapter, translation_id, narrator_id,
         recording_id, mode, play_status, position_seconds, anchor_server_time_ms, rate, manual_verse, changed_at, reached_verse)
       VALUES ($1, $2, 'active', $3, $4, 0, $5, $6, $7, $8, $9, $10, 'paused', $14, $11, $12, $13, $4, $15)
       ON CONFLICT (group_id) WHERE status = 'active' DO NOTHING
       RETURNING id`,
      [
        uuidv7(now.getTime()),
        id,
        userId,
        now,
        passage.bookId,
        passage.chapter,
        group.shared_translation_id,
        narratorId,
        recording?.id ?? null,
        manual ? 'manual' : 'narration',
        now.getTime(),
        group.rate,
        manual ? verse : null,
        position,
        progress ? verse : null,
      ],
    );
    if (inserted.rowCount) return inserted.rows[0].id;
    // Another member's start committed first.
    waiting = null;
    return (await tx.query<{ id: string }>(`SELECT id FROM study_sessions WHERE group_id = $1 AND status = 'active'`, [id])).rows[0].id;
  });
  if (waiting) await queueAudio(deps, waiting);
  return { sessionId, state: await readState(db, deps.mediaDir, sessionId, clock.now().getTime()) };
}

export async function activeSession(deps: StudyDeps, userId: string, groupId: unknown): Promise<StudySessionResponse> {
  await requireMember(deps.db, userId, groupId);
  const active = await deps.db.query<{ id: string }>(`SELECT id FROM study_sessions WHERE group_id = $1 AND status = 'active'`, [groupId]);
  if (!active.rowCount) throw noActiveSession();
  const sessionId = active.rows[0].id;
  return { sessionId, state: await readState(deps.db, deps.mediaDir, sessionId, deps.clock.now().getTime()) };
}

// The state a joining client starts from; checks membership of the session's group (I-04).
export async function sessionForMember(deps: StudyDeps, userId: string, sessionId: unknown): Promise<{ groupId: string; state: PlaybackState; startedAt: Date }> {
  if (!isUuid(sessionId)) throw noActiveSession();
  const row = await loadSession(deps.db, sessionId, false);
  if (!row) throw noActiveSession();
  await requireMember(deps.db, userId, row.group_id);
  if (row.status !== 'active') throw noActiveSession();
  const state = toState(row, await effectiveDraft(deps.db, deps.mediaDir, row, deps.clock.now().getTime()));
  return { groupId: row.group_id, state, startedAt: row.started_at };
}

// S9.1: what the session suggests as the stopping point, and the questions to settle. Works after the session ended,
// so a member can wrap up once everyone has left; it only reads, and the stopping point changes only on confirmation.
export async function wrapUp(deps: StudyDeps, userId: string, groupId: unknown, sessionId: unknown): Promise<WrapUpView> {
  await requireMember(deps.db, userId, groupId);
  if (!isUuid(sessionId)) throw noActiveSession();
  const row = await loadSession(deps.db, sessionId, false);
  if (!row || row.group_id !== groupId) throw noActiveSession();
  const draft = await effectiveDraft(deps.db, deps.mediaDir, row, deps.clock.now().getTime());
  const { bookId, chapter, startVerse } = draft.passage;
  return {
    suggested: { bookId, chapter, verse: draft.reachedVerse ?? startVerse ?? 1 },
    openQuestions: await sessionQuestions(deps.db, row.group_id, { bookId, chapter }, row.started_at),
  };
}

// ---- commands ----

const num = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const int = (value: unknown): value is number => Number.isInteger(value);

// Narrows a command from the wire; null when its shape is wrong.
export function parseCommand(value: unknown): Command | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  switch (c.kind) {
    case 'play':
    case 'pause':
    case 'end_session':
      return { kind: c.kind };
    case 'seek':
      return num(c.positionSeconds) ? { kind: 'seek', positionSeconds: c.positionSeconds } : null;
    case 'set_passage': {
      const p = c.passage as Record<string, unknown> | null;
      if (!p || typeof p !== 'object' || typeof p.bookId !== 'string' || !int(p.chapter)) return null;
      const verse = (v: unknown) => v === null || v === undefined || int(v);
      if (!verse(p.startVerse) || !verse(p.endVerse)) return null;
      return {
        kind: 'set_passage',
        passage: { bookId: p.bookId, chapter: p.chapter, startVerse: (p.startVerse as number | null) ?? null, endVerse: (p.endVerse as number | null) ?? null },
      };
    }
    case 'set_translation':
      return c.translationId === 'BSB' || c.translationId === 'CSB' ? { kind: 'set_translation', translationId: c.translationId } : null;
    case 'set_narrator':
      return typeof c.narratorId === 'string' ? { kind: 'set_narrator', narratorId: c.narratorId } : null;
    case 'set_rate':
      return num(c.rate) ? { kind: 'set_rate', rate: c.rate } : null;
    case 'set_manual_verse':
      return int(c.verse) ? { kind: 'set_manual_verse', verse: c.verse } : null;
    default:
      return null;
  }
}

export interface CommandResult {
  outcome: CommandOutcome;
  state: PlaybackState;
  reason?: string;
}

class Rejection extends Error {}
const reject = (reason: string): never => {
  throw new Rejection(reason);
};

async function verseCount(q: Queryable, passage: PassageRef): Promise<number> {
  const book = bookById(passage.bookId);
  if (!book || passage.chapter < 1 || passage.chapter > book.chapters) reject(`${passage.bookId} ${passage.chapter} is not a chapter.`);
  const result = await q.query<{ verse_count: number }>(
    `SELECT verse_count FROM chapters WHERE translation_id = 'BSB' AND book_id = $1 AND chapter = $2`,
    [book!.id, passage.chapter],
  );
  if (!result.rowCount) reject('That chapter has not been imported yet.');
  return result.rows[0].verse_count;
}

// Applies one command to `draft` in place. Returns true when the session now waits on narration being imported.
async function applyTo(q: Queryable, mediaDir: string, draft: Draft, command: Command, nowMs: number): Promise<boolean> {
  const position = derivePosition(draft, nowMs, bounds(draft).end);
  const resolve = (d: Draft) => (d.narratorId ? resolveRecording({ db: q, mediaDir }, d.translationId, d.passage, d.narratorId) : Promise.resolve(null));
  const pauseAt = (seconds: number) => Object.assign(draft, { status: 'paused', positionSeconds: seconds, anchorServerTimeMs: nowMs, pausedReason: 'member' });

  switch (command.kind) {
    case 'pause':
      if (draft.mode === 'narration') pauseAt(position);
      else draft.pausedReason = 'member';
      return false;

    case 'play': {
      if (draft.mode === 'manual') reject('There is no narration to play in manual mode.');
      if (!draft.recording) draft.recording = await resolve(draft);
      if (!draft.recording) reject('The narration for this chapter is being prepared.');
      const range = bounds(draft);
      const from = draft.positionSeconds >= range.end - 0.05 || draft.positionSeconds < range.start ? range.start : draft.positionSeconds;
      Object.assign(draft, { status: 'playing', positionSeconds: from, anchorServerTimeMs: nowMs, pausedReason: null });
      return false;
    }

    case 'seek': {
      if (draft.mode === 'manual' || !draft.recording) reject('There is no narration to seek in.');
      const range = bounds(draft);
      Object.assign(draft, { positionSeconds: Math.min(Math.max(command.positionSeconds, range.start), range.end), anchorServerTimeMs: nowMs });
      return false;
    }

    case 'set_passage': {
      const p = command.passage;
      const count = await verseCount(q, p);
      const startVerse = p.startVerse ?? (p.endVerse === null ? null : 1);
      const endVerse = p.endVerse ?? (startVerse === null ? null : startVerse);
      if (startVerse !== null && (startVerse < 1 || endVerse! < startVerse || endVerse! > count)) reject(`Verses must be within 1–${count}.`);
      draft.passage = { bookId: bookById(p.bookId)!.id, chapter: p.chapter, startVerse, endVerse };
      draft.manualVerse = draft.mode === 'manual' ? (startVerse ?? 1) : null;
      draft.recording = draft.mode === 'narration' ? await resolve(draft) : null;
      pauseAt(bounds(draft).start);
      return draft.mode === 'narration' && !draft.recording;
    }

    case 'set_translation': {
      if (command.translationId === 'CSB') {
        const verse = draft.mode === 'manual' ? draft.manualVerse : draft.recording ? verseAtSeconds(draft.recording.timing, position) : null;
        Object.assign(draft, { translationId: 'CSB', mode: 'manual', recording: null, manualVerse: verse ?? draft.passage.startVerse ?? 1 });
        pauseAt(0);
        return false;
      }
      const verse = draft.mode === 'manual' ? draft.manualVerse : null;
      draft.translationId = 'BSB';
      draft.narratorId ??= await firstNarrator(q, 'BSB');
      if (!draft.narratorId) reject('No BSB narrator is available.');
      draft.mode = 'narration';
      draft.manualVerse = null;
      draft.recording = await resolve(draft);
      const range = bounds(draft);
      const timing = draft.recording?.timing;
      const at = verse && timing?.status === 'verified' ? Math.min(Math.max(timing.verseStarts[verse - 1] ?? range.start, range.start), range.end) : range.start;
      pauseAt(at);
      return !draft.recording;
    }

    case 'set_narrator': {
      if (draft.translationId !== 'BSB') reject('CSB has no narration.');
      const narrator = await q.query('SELECT 1 FROM narrators WHERE id = $1 AND translation_id = $2 AND enabled', [command.narratorId, draft.translationId]);
      if (!narrator.rowCount) reject('That narrator is not available.');
      const was = draft.recording;
      draft.narratorId = command.narratorId;
      if (draft.mode === 'manual') return false;
      draft.recording = await resolve(draft);
      if (!draft.recording) {
        pauseAt(0);
        return true;
      }
      // The same verse in the new narrator's reading when both timings are known; otherwise the same second.
      const range = bounds(draft);
      const verse = was ? verseAtSeconds(was.timing, position) : null;
      const timing = draft.recording.timing;
      const mapped = verse && timing.status === 'verified' ? timing.verseStarts[verse - 1] : position;
      Object.assign(draft, { positionSeconds: Math.min(Math.max(mapped, range.start), range.end), anchorServerTimeMs: nowMs });
      return false;
    }

    case 'set_rate': {
      if (command.rate < 0.75 || command.rate > 1.5) reject('Rate must be between 0.75 and 1.5.');
      Object.assign(draft, { positionSeconds: position, anchorServerTimeMs: nowMs, rate: Math.round(command.rate * 100) / 100 });
      return false;
    }

    case 'set_manual_verse': {
      if (draft.mode !== 'manual') reject('The verse follows the narration; switch to manual mode first.');
      const count = await verseCount(q, draft.passage);
      if (command.verse < 1 || command.verse > count) reject(`Verses must be within 1–${count}.`);
      draft.manualVerse = command.verse;
      return false;
    }

    case 'end_session':
      Object.assign(draft, { status: 'ended', positionSeconds: position, anchorServerTimeMs: nowMs, pausedReason: null });
      return false;
  }
}

export async function applyCommand(
  deps: StudyDeps,
  userId: string,
  message: { sessionId: unknown; commandId: unknown; expectedRevision: unknown; command: Command },
): Promise<CommandResult> {
  const { db, clock, mediaDir } = deps;
  const { sessionId, commandId, expectedRevision, command } = message;
  if (!isUuid(sessionId)) throw noActiveSession();
  if (!isUuid(commandId) || !int(expectedRevision)) throw new AppError('invalid_request', 400, 'A command needs a commandId and an expectedRevision.');
  let waiting: PassageRef | null = null;
  const result = await withTransaction(db, async (tx): Promise<CommandResult> => {
    const row = await loadSession(tx, sessionId, true);
    if (!row) throw noActiveSession();
    await requireMember(tx, userId, row.group_id);
    const now = clock.now();
    const nowMs = now.getTime();

    const seen = await tx.query<{ session_id: string; outcome: CommandOutcome; reason: string | null }>(
      'SELECT session_id, outcome, reason FROM session_commands WHERE command_id = $1',
      [commandId],
    );
    if (seen.rowCount) {
      const first = seen.rows[0];
      const state = toState(row, await effectiveDraft(tx, mediaDir, row, nowMs));
      if (first.session_id !== row.id) return { outcome: 'rejected_invalid', state, reason: 'That commandId was already used.' };
      return { outcome: first.outcome, state, ...(first.reason ? { reason: first.reason } : {}) };
    }
    if (row.status !== 'active') throw noActiveSession();

    const draft = await effectiveDraft(tx, mediaDir, row, nowMs);
    const record = (outcome: CommandOutcome, reason: string | null, resulting: number) =>
      tx.query(
        `INSERT INTO session_commands (command_id, session_id, user_id, kind, expected_revision, outcome, reason, resulting_revision, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [commandId, row.id, userId, command.kind, expectedRevision, outcome, reason, resulting, now],
      );

    // Pause is the one command that always applies: anyone must be able to stop the room (I-16).
    if (command.kind !== 'pause' && expectedRevision !== row.revision) {
      await record('rejected_stale', null, row.revision);
      return { outcome: 'rejected_stale', state: toState(row, draft) };
    }
    try {
      if (await applyTo(tx, mediaDir, draft, command, nowMs)) waiting = draft.passage;
      // Moving to another chapter starts its furthest verse over; anything else can only take it further.
      const moved = draft.passage.bookId !== row.book_id || draft.passage.chapter !== row.chapter;
      draft.reachedVerse = moved ? verseNow(draft, nowMs) : furthest(draft.reachedVerse, verseNow(draft, nowMs));
    } catch (error) {
      if (!(error instanceof Rejection)) throw error;
      if (command.kind === 'play' && row.mode === 'narration' && !draft.recording) waiting = draft.passage;
      await record('rejected_invalid', error.message, row.revision);
      return { outcome: 'rejected_invalid', state: toState(row, await effectiveDraft(tx, mediaDir, row, nowMs)), reason: error.message };
    }
    await writeDraft(tx, row.id, draft, userId, now);
    await record('applied', null, row.revision + 1);
    const updated = (await loadSession(tx, row.id, false))!;
    return { outcome: 'applied', state: toState(updated, draft) };
  });
  if (waiting) await queueAudio(deps, waiting);
  return result;
}

// ---- server-side pauses ----

// DOD-11: on start, sessions that were playing when the process stopped are paused at the derived position.
export async function recoverSessions(deps: Omit<StudyDeps, 'onAudioQueued'>): Promise<number> {
  return withTransaction(deps.db, async (tx) => {
    const playing = await tx.query<{ id: string }>(`SELECT id FROM study_sessions WHERE status = 'active' AND play_status = 'playing' FOR UPDATE`);
    const now = deps.clock.now();
    for (const { id } of playing.rows) {
      const row = (await loadSession(tx, id, true))!;
      const draft = await effectiveDraft(tx, deps.mediaDir, row, now.getTime());
      if (draft.status === 'playing') {
        const position = derivePosition(draft, now.getTime(), bounds(draft).end);
        Object.assign(draft, { status: 'paused', positionSeconds: position, anchorServerTimeMs: now.getTime(), pausedReason: 'server_restart' });
      }
      await writeDraft(tx, id, draft, null, now);
      log('info', 'paused session after restart', { sessionId: id, positionSeconds: draft.positionSeconds, reason: draft.pausedReason });
    }
    return playing.rowCount ?? 0;
  });
}

// The room emptied: pause at the derived position. Returns the new state, or null when nothing changed.
// `occupied` is asked again under the row lock, so a member who rejoined during the grace keeps playing.
export async function pauseForEmptyRoom(deps: StudyDeps, sessionId: string, occupied: () => boolean = () => false): Promise<PlaybackState | null> {
  return withTransaction(deps.db, async (tx) => {
    const row = await loadSession(tx, sessionId, true);
    if (!row || row.status !== 'active' || row.play_status !== 'playing' || occupied()) return null;
    const now = deps.clock.now();
    const draft = await effectiveDraft(tx, deps.mediaDir, row, now.getTime());
    if (draft.status === 'playing') {
      const position = derivePosition(draft, now.getTime(), bounds(draft).end);
      Object.assign(draft, { status: 'paused', positionSeconds: position, anchorServerTimeMs: now.getTime(), pausedReason: 'room_empty' });
    }
    await writeDraft(tx, sessionId, draft, null, now);
    return toState((await loadSession(tx, sessionId, false))!, draft);
  });
}

// ---- drift ----

// Samples count only from clients that report themselves ready while the session plays.
export async function recordDrift(deps: StudyDeps, userId: string, sessionId: string, clientId: string, driftMs: number): Promise<void> {
  if (!num(driftMs) || Math.abs(driftMs) > 3_600_000) return;
  await deps.db.query(
    `INSERT INTO drift_samples (session_id, client_id, user_id, drift_ms, recorded_at)
     SELECT $1, $2, $3, $4, $5 WHERE EXISTS (SELECT 1 FROM study_sessions WHERE id = $1 AND status = 'active' AND play_status = 'playing')`,
    [sessionId, clientId, userId, driftMs, deps.clock.now()],
  );
}

export async function driftReport(deps: StudyDeps, userId: string, groupId: unknown, sessionId: unknown): Promise<DriftReport> {
  await requireMember(deps.db, userId, groupId);
  if (!isUuid(sessionId)) throw noActiveSession();
  const owned = await deps.db.query('SELECT 1 FROM study_sessions WHERE id = $1 AND group_id = $2', [sessionId, groupId]);
  if (!owned.rowCount) throw noActiveSession();
  const overall = await deps.db.query<{ samples: string; p50: number | null; p95: number | null; max: number | null }>(
    `SELECT count(*) AS samples,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(drift_ms)) AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY abs(drift_ms)) AS p95,
       max(abs(drift_ms)) AS max
     FROM drift_samples WHERE session_id = $1`,
    [sessionId],
  );
  const perClient = await deps.db.query<{ client_id: string; p95: number }>(
    `SELECT client_id, percentile_cont(0.95) WITHIN GROUP (ORDER BY abs(drift_ms)) AS p95
     FROM drift_samples WHERE session_id = $1 GROUP BY client_id ORDER BY client_id`,
    [sessionId],
  );
  const o = overall.rows[0];
  const round = (v: number | null) => Math.round((v ?? 0) * 10) / 10;
  return {
    samples: Number(o.samples),
    p50Ms: round(o.p50),
    p95Ms: round(o.p95),
    maxMs: round(o.max),
    perClient: perClient.rows.map((r) => ({ clientId: r.client_id, p95Ms: round(r.p95) })),
  };
}

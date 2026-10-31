import type { NoteAnchor, NoteView, PullResponse, PushResult, SoloPositionView, SyncOp } from '../../shared/api.ts';
import { bookById } from '../../shared/books.ts';
import { maxVerse } from '../../shared/reference.ts';
import type { Clock } from '../platform/clock.ts';
import type { Db, Queryable, Tx } from '../platform/db.ts';
import { withTransaction } from '../platform/db.ts';
import { AppError } from '../platform/errors.ts';
import { isUuid, uuidv7 } from '../platform/ids.ts';

// A member's own notes and solo reading position (S12). Every read and write is scoped to the caller's user id and
// nothing here takes a group (I-21). Devices push operations and pull what changed; an operation id applies at most
// once, and a stale edit with a different body becomes a NoteConflict instead of overwriting (I-22).

export interface PersonalDeps {
  db: Db;
  clock: Clock;
}

export const maxOpsPerPush = 200;
export const maxNoteBytes = 64 * 1024;
const maxDeviceId = 100;

const invalid = (message: string) => new AppError('invalid_request', 400, message);
const tooLarge = (message: string) => new AppError('payload_too_large', 413, message, { retryable: false });
const int = (value: unknown): value is number => Number.isInteger(value);

function parseAnchor(value: unknown): NoteAnchor {
  const a = value as Record<string, unknown> | null;
  if (!a || typeof a !== 'object') throw invalid('A note anchor is { translationId, bookId, chapter, startVerse, endVerse }.');
  if (a.translationId !== 'BSB' && a.translationId !== 'CSB') throw invalid('A note anchor translation is BSB or CSB.');
  const book = typeof a.bookId === 'string' ? bookById(a.bookId) : undefined;
  if (!book) throw invalid('A note anchor names a book of the Bible.');
  if (!int(a.chapter) || a.chapter < 1 || a.chapter > book.chapters) throw invalid(`${book.name} has ${book.chapters} chapters.`);
  const verse = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    if (!int(v) || v < 1 || v > maxVerse) throw invalid('Verses are whole numbers from 1.');
    return v;
  };
  const startVerse = verse(a.startVerse);
  const endVerse = startVerse === null ? null : (verse(a.endVerse) ?? startVerse);
  if (endVerse !== null && startVerse !== null && endVerse < startVerse) throw invalid('The passage ends before it starts.');
  return { translationId: a.translationId, bookId: book.id, chapter: a.chapter, startVerse, endVerse };
}

function parseBody(value: unknown): string {
  if (typeof value !== 'string') throw invalid('A note body is text.');
  // Postgres text cannot hold NUL.
  if (value.includes('\u0000')) throw invalid('The note contains a character that cannot be stored.');
  if (Buffer.byteLength(value, 'utf8') > maxNoteBytes) throw tooLarge('A note is at most 64 KB. Split it into smaller notes.');
  return value;
}

function parseOp(value: unknown): SyncOp {
  const o = value as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || !isUuid(o.opId)) throw invalid('Each operation has an opId (UUID).');
  const base = o.baseRevision;
  if (base !== null && base !== undefined && (!int(base) || base < 0)) throw invalid('baseRevision is a revision number or null.');
  const baseRevision = (base ?? null) as number | null;
  if (o.entity === 'solo_position') {
    if (o.op !== 'set') throw invalid('A solo position operation is set.');
    const p = o.position as Record<string, unknown> | null;
    if (!p || typeof p !== 'object' || p.verse === null || p.verse === undefined) throw invalid('A solo position is { translationId, bookId, chapter, verse }.');
    const at = parseAnchor({ translationId: p.translationId, bookId: p.bookId, chapter: p.chapter, startVerse: p.verse, endVerse: p.verse });
    const position = { translationId: at.translationId, bookId: at.bookId, chapter: at.chapter, verse: at.startVerse as number };
    return { opId: o.opId, entity: 'solo_position', op: 'set', baseRevision, position };
  }
  if (o.entity !== 'note') throw invalid('An operation entity is note or solo_position.');
  if (!isUuid(o.entityId)) throw invalid('A note operation names the note id (UUID).');
  if (typeof o.deviceId !== 'string' || !o.deviceId || o.deviceId.length > maxDeviceId || o.deviceId.includes('\u0000')) {
    throw invalid('A note operation names the device.');
  }
  if (o.op === 'upsert') {
    return { opId: o.opId, entity: 'note', entityId: o.entityId, op: 'upsert', baseRevision, anchor: parseAnchor(o.anchor), body: parseBody(o.body), deviceId: o.deviceId };
  }
  if (o.op === 'delete') {
    if (baseRevision === null) throw invalid('A delete names the revision it removes.');
    return { opId: o.opId, entity: 'note', entityId: o.entityId, op: 'delete', baseRevision, deviceId: o.deviceId };
  }
  throw invalid('A note operation is upsert or delete.');
}

export function parsePush(body: unknown): SyncOp[] {
  const ops = (body as { ops?: unknown } | null)?.ops;
  if (!Array.isArray(ops)) throw invalid('Send { ops: [...] }.');
  if (ops.length > maxOpsPerPush) throw tooLarge(`Push at most ${maxOpsPerPush} operations at a time.`);
  return ops.map(parseOp);
}

interface NoteRow {
  id: string;
  user_id: string;
  translation_id: 'BSB' | 'CSB';
  book_id: string;
  chapter: number;
  start_verse: number | null;
  end_verse: number | null;
  body: string;
  revision: number;
  updated_at: Date;
  deleted_at: Date | null;
}

const noteColumns = 'id, user_id, translation_id, book_id, chapter, start_verse, end_verse, body, revision, updated_at, deleted_at';

function toNoteView(row: NoteRow): NoteView {
  return {
    id: row.id,
    anchor: { translationId: row.translation_id, bookId: row.book_id, chapter: row.chapter, startVerse: row.start_verse, endVerse: row.end_verse },
    body: row.body,
    revision: row.revision,
    updatedAt: row.updated_at.toISOString(),
    deleted: row.deleted_at !== null,
  };
}

type Outcome = PushResult['outcome'];

async function record(tx: Tx, userId: string, op: SyncOp, outcome: Outcome, revision: number, conflictId: string | null, now: Date): Promise<PushResult> {
  await tx.query(
    `INSERT INTO sync_operations (op_id, user_id, entity, entity_id, base_revision, outcome, resulting_revision, conflict_id, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [op.opId, userId, op.entity, op.entity === 'note' ? op.entityId : null, op.baseRevision, outcome, revision, conflictId, now],
  );
  return { opId: op.opId, outcome, revision, ...(conflictId ? { conflictId } : {}) };
}

async function applyNote(tx: Tx, userId: string, op: Extract<SyncOp, { entity: 'note' }>, now: Date): Promise<PushResult> {
  const found = await tx.query<NoteRow>(`SELECT ${noteColumns} FROM notes WHERE id = $1 FOR UPDATE`, [op.entityId]);
  const note = found.rows[0];
  if (note && note.user_id !== userId) throw invalid('That note id is taken. Create the note with a new id.');

  if (op.op === 'delete') {
    // Nothing to remove, or removed already: the delete has had its effect.
    if (!note) return record(tx, userId, op, 'already_applied', 0, null, now);
    if (note.deleted_at) return record(tx, userId, op, 'already_applied', note.revision, null, now);
    // The note changed since this device saw it: the newer text stays, and the device pulls it.
    if (op.baseRevision !== note.revision) return record(tx, userId, op, 'conflict', note.revision, null, now);
    await tx.query(
      `UPDATE notes SET body = '', deleted_at = $2, updated_at = $2, revision = revision + 1, device_id = $3, change_seq = nextval('personal_changes') WHERE id = $1`,
      [note.id, now, op.deviceId],
    );
    return record(tx, userId, op, 'applied', note.revision + 1, null, now);
  }

  const a = op.anchor;
  if (!note) {
    // A base revision for a note the server never had still creates it: the device's text is never dropped.
    await tx.query(
      `INSERT INTO notes (id, user_id, translation_id, book_id, chapter, start_verse, end_verse, body, revision, updated_at, device_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10)`,
      [op.entityId, userId, a.translationId, a.bookId, a.chapter, a.startVerse, a.endVerse, op.body, now, op.deviceId],
    );
    return record(tx, userId, op, 'applied', 1, null, now);
  }
  if (op.baseRevision !== note.revision) {
    // Another device got there first. The same text is no conflict; different text keeps both sides (I-22).
    if (!note.deleted_at && note.body === op.body) return record(tx, userId, op, 'already_applied', note.revision, null, now);
    const conflictId = uuidv7(now.getTime());
    await tx.query(
      `INSERT INTO note_conflicts (id, user_id, note_id, base_revision, server_revision, server_body, incoming_body, incoming_device_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [conflictId, userId, note.id, op.baseRevision, note.revision, note.body, op.body, op.deviceId, now],
    );
    return record(tx, userId, op, 'conflict', note.revision, conflictId, now);
  }
  await tx.query(
    `UPDATE notes SET translation_id = $2, book_id = $3, chapter = $4, start_verse = $5, end_verse = $6, body = $7, deleted_at = NULL, updated_at = $8,
            revision = revision + 1, device_id = $9, change_seq = nextval('personal_changes')
      WHERE id = $1`,
    [note.id, a.translationId, a.bookId, a.chapter, a.startVerse, a.endVerse, op.body, now, op.deviceId],
  );
  return record(tx, userId, op, 'applied', note.revision + 1, null, now);
}

async function applySolo(tx: Tx, userId: string, op: Extract<SyncOp, { entity: 'solo_position' }>, now: Date): Promise<PushResult> {
  // The newest position wins: reading on one device and then another moves it either way.
  const p = op.position;
  const saved = await tx.query<{ revision: number }>(
    `INSERT INTO solo_positions (user_id, translation_id, book_id, chapter, verse, revision, updated_at) VALUES ($1, $2, $3, $4, $5, 1, $6)
     ON CONFLICT (user_id) DO UPDATE SET translation_id = $2, book_id = $3, chapter = $4, verse = $5, revision = solo_positions.revision + 1,
            updated_at = $6, change_seq = nextval('personal_changes')
     RETURNING revision`,
    [userId, p.translationId, p.bookId, p.chapter, p.verse, now],
  );
  return record(tx, userId, op, 'applied', saved.rows[0].revision, null, now);
}

export async function pushOps(deps: PersonalDeps, userId: string, body: unknown): Promise<{ results: PushResult[] }> {
  const ops = parsePush(body);
  return withTransaction(deps.db, async (tx) => {
    // One push per user at a time, so change numbers rise in commit order and a pull cursor never skips a write.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`personal:${userId}`]);
    const now = deps.clock.now();
    const results: PushResult[] = [];
    for (const op of ops) {
      const seen = await tx.query<{ user_id: string; outcome: Outcome; resulting_revision: number; conflict_id: string | null }>(
        'SELECT user_id, outcome, resulting_revision, conflict_id FROM sync_operations WHERE op_id = $1',
        [op.opId],
      );
      const first = seen.rows[0];
      if (first) {
        if (first.user_id !== userId) throw invalid('That opId was already used. Send the operation with a new opId.');
        // I-22: a retried operation reports what the first attempt did, and changes nothing: a conflict stays a conflict.
        const outcome = first.outcome === 'conflict' ? 'conflict' : 'already_applied';
        results.push({ opId: op.opId, outcome, revision: first.resulting_revision, ...(first.conflict_id ? { conflictId: first.conflict_id } : {}) });
        continue;
      }
      results.push(op.entity === 'note' ? await applyNote(tx, userId, op, now) : await applySolo(tx, userId, op, now));
    }
    return { results };
  });
}

function parseCursor(value: unknown): bigint | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{1,18}$/.test(value)) throw invalid('cursor is the value the previous pull returned.');
  return BigInt(value);
}

export async function soloPositionOf(q: Queryable, userId: string): Promise<SoloPositionView | null> {
  const result = await q.query<{ translation_id: 'BSB' | 'CSB'; book_id: string; chapter: number; verse: number; revision: number }>(
    'SELECT translation_id, book_id, chapter, verse, revision FROM solo_positions WHERE user_id = $1',
    [userId],
  );
  const row = result.rows[0];
  return row ? { translationId: row.translation_id, bookId: row.book_id, chapter: row.chapter, verse: row.verse, revision: row.revision } : null;
}

// What changed after `cursor`: notes written since (deleted ones too, so devices drop them), the solo position, and
// every open conflict. Without a cursor, every note the user still has.
export async function pull(deps: PersonalDeps, userId: string, cursor: unknown): Promise<PullResponse> {
  const after = parseCursor(cursor);
  return withTransaction(deps.db, async (tx) => {
    // One snapshot for the rows and the cursor: a write that commits during the pull lands after the cursor, not lost.
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const notes = await tx.query<NoteRow>(
      after === null
        ? `SELECT ${noteColumns} FROM notes WHERE user_id = $1 AND deleted_at IS NULL ORDER BY change_seq`
        : `SELECT ${noteColumns} FROM notes WHERE user_id = $1 AND change_seq > $2 ORDER BY change_seq`,
      after === null ? [userId] : [userId, after.toString()],
    );
    const conflicts = await tx.query<{ id: string; note_id: string; server_body: string; incoming_body: string }>(
      'SELECT id, note_id, server_body, incoming_body FROM note_conflicts WHERE user_id = $1 AND resolved_at IS NULL ORDER BY created_at, id',
      [userId],
    );
    const latest = await tx.query<{ seq: string | null }>(
      `SELECT GREATEST((SELECT max(change_seq) FROM notes WHERE user_id = $1), (SELECT change_seq FROM solo_positions WHERE user_id = $1))::text AS seq`,
      [userId],
    );
    const seq = BigInt(latest.rows[0].seq ?? '0');
    return {
      notes: notes.rows.map(toNoteView),
      soloPosition: await soloPositionOf(tx, userId),
      conflicts: conflicts.rows.map((c) => ({ id: c.id, noteId: c.note_id, serverBody: c.server_body, incomingBody: c.incoming_body })),
      cursor: (after !== null && after > seq ? after : seq).toString(),
    };
  });
}

// The caller's own undeleted notes, in the order asked, for a question's context. Any other id is rejected, never skipped.
export async function ownNotes(q: Queryable, userId: string, ids: string[]): Promise<NoteView[]> {
  if (!ids.length) return [];
  const result = await q.query<NoteRow>(`SELECT ${noteColumns} FROM notes WHERE id = ANY($1::uuid[]) AND user_id = $2 AND deleted_at IS NULL`, [ids, userId]);
  if (result.rowCount !== ids.length) throw invalid('Attach only your own notes, and not deleted ones.');
  const byId = new Map(result.rows.map((r) => [r.id, toNoteView(r)]));
  return ids.map((id) => byId.get(id) as NoteView);
}

export type ConflictChoice = 'kept_server' | 'kept_incoming' | 'kept_both';
const choices: readonly ConflictChoice[] = ['kept_server', 'kept_incoming', 'kept_both'];

// The member picks which side of a NoteConflict stays (S15). Kept server leaves the note as it is; kept incoming
// writes the other device's text over it; kept both adds that text as a new note on the same passage. Returns the
// notes the choice left, live ones only. Someone else's conflict, or an unknown one, is not found (I-21).
export async function resolveConflict(deps: PersonalDeps, userId: string, conflictId: unknown, choice: unknown): Promise<NoteView[]> {
  if (!choices.includes(choice as ConflictChoice)) throw invalid('choice is kept_server, kept_incoming or kept_both.');
  const notFound = new AppError('not_found', 404, 'No such conflict.');
  if (!isUuid(conflictId)) throw notFound;
  return withTransaction(deps.db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`personal:${userId}`]);
    const found = await tx.query<{ note_id: string; server_revision: number; incoming_body: string; incoming_device_id: string; resolved_at: Date | null }>(
      'SELECT note_id, server_revision, incoming_body, incoming_device_id, resolved_at FROM note_conflicts WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [conflictId, userId],
    );
    const conflict = found.rows[0];
    if (!conflict) throw notFound;
    if (conflict.resolved_at) throw new AppError('conflict_resolved', 409, 'This conflict was already resolved. Reload your notes.', { retryable: false });
    const now = deps.clock.now();
    const note = (await tx.query<NoteRow>(`SELECT ${noteColumns} FROM notes WHERE id = $1 FOR UPDATE`, [conflict.note_id])).rows[0];
    // The note changed again after the conflict: writing over it would lose text nobody chose against, so both stay.
    const picked: ConflictChoice = choice === 'kept_incoming' && note.revision !== conflict.server_revision ? 'kept_both' : (choice as ConflictChoice);
    const kept: NoteRow[] = [];
    if (picked === 'kept_incoming') {
      const updated = await tx.query<NoteRow>(
        `UPDATE notes SET body = $2, deleted_at = NULL, updated_at = $3, revision = revision + 1, device_id = $4, change_seq = nextval('personal_changes')
          WHERE id = $1 RETURNING ${noteColumns}`,
        [note.id, conflict.incoming_body, now, conflict.incoming_device_id],
      );
      kept.push(updated.rows[0]);
    } else {
      kept.push(note);
    }
    if (picked === 'kept_both') {
      const copy = await tx.query<NoteRow>(
        `INSERT INTO notes (id, user_id, translation_id, book_id, chapter, start_verse, end_verse, body, revision, updated_at, device_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10) RETURNING ${noteColumns}`,
        [uuidv7(now.getTime()), userId, note.translation_id, note.book_id, note.chapter, note.start_verse, note.end_verse, conflict.incoming_body, now, conflict.incoming_device_id],
      );
      kept.push(copy.rows[0]);
    }
    await tx.query('UPDATE note_conflicts SET resolved_at = $2, resolution = $3 WHERE id = $1', [conflictId, now, picked]);
    return kept.filter((n) => n.deleted_at === null).map(toNoteView);
  });
}

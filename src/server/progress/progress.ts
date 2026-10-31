import type { GroupProgressView, StoppingPoint } from '../../shared/api.ts';
import { bookById } from '../../shared/books.ts';
import { requireMember } from '../groups/groups.ts';
import type { Clock } from '../platform/clock.ts';
import type { Db, Queryable } from '../platform/db.ts';
import { withTransaction } from '../platform/db.ts';
import { AppError } from '../platform/errors.ts';
import { isUuid, uuidv7 } from '../platform/ids.ts';

// The group's stopping point (S9). Append-only: the newest row is where Resume study opens. It changes only when a
// member confirms one, naming the row they last saw (I-19); playback, browsing, questions and solo reading never write it.

export interface ProgressDeps {
  db: Db;
  clock: Clock;
}

const invalid = (message: string) => new AppError('invalid_request', 400, message);

interface ProgressRow {
  id: string;
  book_id: string;
  chapter: number;
  verse: number;
  confirmed_by_name: string;
  confirmed_at: Date;
}

function toView(row: ProgressRow): GroupProgressView {
  return {
    id: row.id,
    ref: { bookId: row.book_id, chapter: row.chapter, verse: row.verse },
    confirmedBy: row.confirmed_by_name,
    confirmedAt: row.confirmed_at.toISOString(),
  };
}

// The newest confirmation: rows form one chain, each based on the one before, so it is the one nobody built on.
export async function latestProgress(q: Queryable, groupId: string): Promise<GroupProgressView | null> {
  const result = await q.query<ProgressRow>(
    `SELECT p.id, p.book_id, p.chapter, p.verse, u.display_name AS confirmed_by_name, p.confirmed_at
       FROM group_progress p JOIN users u ON u.id = p.confirmed_by
      WHERE p.group_id = $1 AND NOT EXISTS (SELECT 1 FROM group_progress n WHERE n.based_on_id = p.id)`,
    [groupId],
  );
  return result.rows[0] ? toView(result.rows[0]) : null;
}

export async function currentStoppingPoint(deps: ProgressDeps, userId: string, groupId: unknown): Promise<GroupProgressView | null> {
  await requireMember(deps.db, userId, groupId);
  return latestProgress(deps.db, groupId as string);
}

const int = (value: unknown): value is number => Number.isInteger(value);

// A verse of an imported BSB chapter, the same bound the study passage uses.
async function stoppingPoint(q: Queryable, value: unknown): Promise<StoppingPoint> {
  if (!value || typeof value !== 'object') throw invalid('A stopping point needs a book, chapter and verse.');
  const r = value as Record<string, unknown>;
  const book = typeof r.bookId === 'string' ? bookById(r.bookId) : undefined;
  if (!book || !int(r.chapter) || r.chapter < 1 || r.chapter > book.chapters) throw invalid('That is not a chapter.');
  if (!int(r.verse) || r.verse < 1) throw invalid('A stopping point needs a verse.');
  const count = await q.query<{ verse_count: number }>(`SELECT verse_count FROM chapters WHERE translation_id = 'BSB' AND book_id = $1 AND chapter = $2`, [
    book.id,
    r.chapter,
  ]);
  if (!count.rowCount) throw invalid('That chapter has not been imported yet.');
  if (r.verse > count.rows[0].verse_count) throw invalid(`Verses must be within 1–${count.rows[0].verse_count}.`);
  return { bookId: book.id, chapter: r.chapter, verse: r.verse };
}

// S9.2: a confirmation based on anything but the newest row is stale, and the error carries the newest so the client
// can show it. The group row lock serializes confirmations; the (group, based_on) constraint backs it up.
export async function confirmStoppingPoint(deps: ProgressDeps, userId: string, groupId: unknown, request: unknown): Promise<{ id: string }> {
  await requireMember(deps.db, userId, groupId);
  const id = groupId as string;
  const body = (request ?? {}) as Record<string, unknown>;
  const basedOnId = body.basedOnId ?? null;
  if (basedOnId !== null && !isUuid(basedOnId)) throw invalid('basedOnId must be the id of the stopping point last seen, or null.');
  if (body.sessionId !== undefined && body.sessionId !== null && !isUuid(body.sessionId)) throw invalid('Unknown session.');
  const sessionId = (body.sessionId as string | null | undefined) ?? null;
  return withTransaction(deps.db, async (tx) => {
    await tx.query('SELECT 1 FROM groups WHERE id = $1 FOR UPDATE', [id]);
    const ref = await stoppingPoint(tx, body.ref);
    if (sessionId) {
      const owned = await tx.query('SELECT 1 FROM study_sessions WHERE id = $1 AND group_id = $2', [sessionId, id]);
      if (!owned.rowCount) throw invalid('Unknown session.');
    }
    const latest = await latestProgress(tx, id);
    if ((latest?.id ?? null) !== basedOnId) {
      throw new AppError('stale_progress', 409, 'Someone confirmed a stopping point first.', { details: { current: latest } });
    }
    const now = deps.clock.now();
    const progressId = uuidv7(now.getTime());
    await tx.query(
      `INSERT INTO group_progress (id, group_id, book_id, chapter, verse, confirmed_by, confirmed_at, session_id, based_on_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [progressId, id, ref.bookId, ref.chapter, ref.verse, userId, now, sessionId, basedOnId],
    );
    return { id: progressId };
  });
}

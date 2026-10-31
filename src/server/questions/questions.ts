import type { Disposition, PassageRef, PostQuestionRequest, QuestionStatus, QuestionView, ReplyView, TranslationId } from '../../shared/api.ts';
import { dispositions, questionStatuses } from '../../shared/api.ts';
import { bookById } from '../../shared/books.ts';
import { requireMember } from '../groups/groups.ts';
import type { Clock } from '../platform/clock.ts';
import type { Db, Queryable } from '../platform/db.ts';
import { withTransaction } from '../platform/db.ts';
import { AppError } from '../platform/errors.ts';
import { isUuid, uuidv7 } from '../platform/ids.ts';

// Questions and replies on a passage (S8). They belong to the group and the passage, not to a session, and never
// touch the group's stopping point (I-19). Only the author edits or deletes a post (I-20). A deleted post keeps its row
// without a body, so a late retry of the post that created it finds it rather than posting it again; a deleted reply
// and a removed question with no replies left are not listed.

export interface QuestionDeps {
  db: Db;
  clock: Clock;
}

export const maxBodyLength = 4000;

export type PostTarget = { questionId: string } | { replyId: string };

const notFound = () => new AppError('not_found', 404, 'That question or reply no longer exists.');
const invalid = (message: string) => new AppError('invalid_request', 400, message);
const notAuthor = () => new AppError('not_author', 403, 'Only its author can change this post.');

interface QuestionRow {
  id: string;
  translation_id: TranslationId;
  book_id: string;
  chapter: number;
  start_verse: number | null;
  end_verse: number | null;
  author_id: string;
  author_name: string;
  body: string | null;
  edited_at: Date | null;
  created_at: Date;
  status: QuestionStatus;
  revision: number;
  version: number;
}

interface ReplyRow {
  id: string;
  question_id: string;
  author_id: string;
  author_name: string;
  body: string | null;
  edited_at: Date | null;
  created_at: Date;
  revision: number;
}

const questionColumns = `q.id, q.translation_id, q.book_id, q.chapter, q.start_verse, q.end_verse, q.author_id, u.display_name AS author_name,
  q.body, q.edited_at, q.created_at, q.status, q.revision, q.version`;
const replyColumns = `r.id, r.question_id, r.author_id, u.display_name AS author_name, r.body, r.edited_at, r.created_at, r.revision`;

function toReply(row: ReplyRow): ReplyView {
  return {
    id: row.id,
    author: { userId: row.author_id, displayName: row.author_name },
    body: row.body,
    removed: row.body === null,
    editedAt: row.edited_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    revision: row.revision,
  };
}

function toQuestion(row: QuestionRow, replies: ReplyView[]): QuestionView {
  const kind = row.start_verse === null ? 'chapter' : row.start_verse === row.end_verse ? 'verse' : 'range';
  return {
    id: row.id,
    anchor: { translationId: row.translation_id, bookId: row.book_id, chapter: row.chapter, startVerse: row.start_verse, endVerse: row.end_verse },
    kind,
    author: { userId: row.author_id, displayName: row.author_name },
    body: row.body,
    removed: row.body === null,
    editedAt: row.edited_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    status: row.status,
    replies,
    revision: row.revision,
    version: row.version,
  };
}

// Questions with their remaining replies, in passage order: chapter questions first, then by first verse, then oldest first.
async function withReplies(q: Queryable, rows: QuestionRow[]): Promise<QuestionView[]> {
  if (!rows.length) return [];
  const replies = await q.query<ReplyRow>(
    `SELECT ${replyColumns} FROM replies r JOIN users u ON u.id = r.author_id WHERE r.question_id = ANY($1::uuid[]) AND r.body IS NOT NULL ORDER BY r.created_at, r.id`,
    [rows.map((r) => r.id)],
  );
  const byQuestion = new Map<string, ReplyView[]>();
  for (const reply of replies.rows) {
    const list = byQuestion.get(reply.question_id) ?? [];
    list.push(toReply(reply));
    byQuestion.set(reply.question_id, list);
  }
  return rows.map((row) => toQuestion(row, byQuestion.get(row.id) ?? []));
}

async function loadQuestion(q: Queryable, groupId: string, questionId: string, lock: '' | ' FOR UPDATE OF q' | ' FOR SHARE OF q' = ''): Promise<QuestionRow | null> {
  const result = await q.query<QuestionRow>(
    `SELECT ${questionColumns} FROM questions q JOIN users u ON u.id = q.author_id WHERE q.id = $1 AND q.group_id = $2${lock}`,
    [questionId, groupId],
  );
  return result.rows[0] ?? null;
}

export async function questionView(q: Queryable, groupId: string, questionId: string): Promise<QuestionView | null> {
  const row = await loadQuestion(q, groupId, questionId);
  return row ? (await withReplies(q, [row]))[0] : null;
}

function body(value: unknown): string {
  if (typeof value !== 'string') throw invalid('A post needs a body.');
  const trimmed = value.trim();
  if (!trimmed) throw new AppError('empty_body', 400, 'Write something before posting.');
  if (trimmed.includes('\u0000')) throw invalid('A post cannot contain a null character.');
  if (trimmed.length > maxBodyLength) throw invalid(`A post can be at most ${maxBodyLength} characters.`);
  return trimmed;
}

const int = (value: unknown): value is number => Number.isInteger(value);

// A verse, range or chapter of an imported chapter. A start verse alone is that one verse.
async function anchor(q: Queryable, value: unknown): Promise<PassageRef & { translationId: TranslationId }> {
  if (!value || typeof value !== 'object') throw invalid('A question needs a passage.');
  const a = value as Record<string, unknown>;
  if (a.translationId !== 'BSB' && a.translationId !== 'CSB') throw invalid('Unknown translation.');
  const book = typeof a.bookId === 'string' ? bookById(a.bookId) : undefined;
  if (!book || !int(a.chapter) || a.chapter < 1 || a.chapter > book.chapters) throw invalid('That is not a chapter.');
  const optional = (v: unknown) => v === null || v === undefined || int(v);
  if (!optional(a.startVerse) || !optional(a.endVerse)) throw invalid('Verses must be whole numbers.');
  const startVerse = (a.startVerse as number | null | undefined) ?? null;
  const endVerse = startVerse === null ? null : ((a.endVerse as number | null | undefined) ?? startVerse);
  if (startVerse === null && a.endVerse !== null && a.endVerse !== undefined) throw invalid('A range needs its first verse.');
  // Verse numbers are bounded by the imported BSB chapter, as for the study passage.
  const count = await q.query<{ verse_count: number }>(`SELECT verse_count FROM chapters WHERE translation_id = 'BSB' AND book_id = $1 AND chapter = $2`, [
    book.id,
    a.chapter,
  ]);
  if (!count.rowCount) throw invalid('That chapter has not been imported yet.');
  const verses = count.rows[0].verse_count;
  if (startVerse !== null && (startVerse < 1 || endVerse! < startVerse || endVerse! > verses)) throw invalid(`Verses must be within 1–${verses}.`);
  return { translationId: a.translationId, bookId: book.id, chapter: a.chapter, startVerse, endVerse };
}

export interface QuestionFilter {
  bookId?: string;
  chapter?: number;
  status?: QuestionStatus[];
}

// Parses `?book&chapter&status` (status comma-separated). No book of the Bible has more than 150 chapters.
export function parseFilter(query: Record<string, unknown>): QuestionFilter {
  const filter: QuestionFilter = {};
  if (query.book !== undefined) {
    const book = typeof query.book === 'string' ? bookById(query.book) : undefined;
    if (!book) throw invalid('Unknown book.');
    filter.bookId = book.id;
  }
  if (query.chapter !== undefined) {
    const chapter = Number(query.chapter);
    const most = filter.bookId ? bookById(filter.bookId)!.chapters : 150;
    if (!Number.isInteger(chapter) || chapter < 1 || chapter > most) throw invalid('Unknown chapter.');
    filter.chapter = chapter;
  }
  if (query.status !== undefined) {
    const statuses = String(query.status).split(',').filter(Boolean);
    if (!statuses.length || !statuses.every((s): s is QuestionStatus => (questionStatuses as readonly string[]).includes(s))) throw invalid('Unknown status.');
    filter.status = statuses;
  }
  return filter;
}

export async function listQuestions(deps: QuestionDeps, userId: string, groupId: unknown, filter: QuestionFilter): Promise<QuestionView[]> {
  await requireMember(deps.db, userId, groupId);
  return questionsFor(deps.db, groupId as string, filter);
}

export async function questionsFor(q: Queryable, groupId: string, filter: QuestionFilter): Promise<QuestionView[]> {
  const result = await q.query<QuestionRow>(
    `SELECT ${questionColumns} FROM questions q JOIN users u ON u.id = q.author_id
      WHERE q.group_id = $1 AND ($2::text IS NULL OR q.book_id = $2) AND ($3::int IS NULL OR q.chapter = $3) AND ($4::text[] IS NULL OR q.status = ANY($4))
        -- A removed question with no replies left has nothing to show.
        AND (q.body IS NOT NULL OR EXISTS (SELECT 1 FROM replies r WHERE r.question_id = q.id AND r.body IS NOT NULL))
      ORDER BY q.book_id, q.chapter, q.start_verse NULLS FIRST, q.end_verse NULLS FIRST, q.created_at, q.id`,
    [groupId, filter.bookId ?? null, filter.chapter ?? null, filter.status ?? null],
  );
  return withReplies(q, result.rows);
}

// The questions a study keeps in view (S9.4): the unsettled ones on its chapter, those posted since it started (wherever
// the passage has moved since), and every carried one, so a carried question comes back in the next study.
export async function sessionQuestions(q: Queryable, groupId: string, at: { bookId: string; chapter: number }, since: Date): Promise<QuestionView[]> {
  const result = await q.query<QuestionRow>(
    `SELECT ${questionColumns} FROM questions q JOIN users u ON u.id = q.author_id
      WHERE q.group_id = $1 AND q.status IN ('open', 'carried')
        AND ((q.book_id = $2 AND q.chapter = $3) OR q.status = 'carried' OR q.created_at >= $4)
        AND (q.body IS NOT NULL OR EXISTS (SELECT 1 FROM replies r WHERE r.question_id = q.id AND r.body IS NOT NULL))
      ORDER BY q.book_id, q.chapter, q.start_verse NULLS FIRST, q.end_verse NULLS FIRST, q.created_at, q.id`,
    [groupId, at.bookId, at.chapter, since],
  );
  return withReplies(q, result.rows);
}

// S9.4: any member settles a question, during a study or after it. Each decision is kept in question_dispositions;
// the question's status is the latest one, and its version rises so every client takes the change.
export async function setDisposition(deps: QuestionDeps, userId: string, groupId: unknown, questionId: unknown, request: unknown): Promise<QuestionView> {
  await requireMember(deps.db, userId, groupId);
  const r = (request ?? {}) as Record<string, unknown>;
  if (!(dispositions as readonly unknown[]).includes(r.status)) throw invalid('Status must be closed, carried, resolved or no_longer_relevant.');
  const status = r.status as Disposition;
  if (r.sessionId !== undefined && r.sessionId !== null && !isUuid(r.sessionId)) throw invalid('Unknown session.');
  const sessionId = (r.sessionId as string | null | undefined) ?? null;
  if (!isUuid(questionId)) throw notFound();
  const group = groupId as string;
  return withTransaction(deps.db, async (tx) => {
    const question = await loadQuestion(tx, group, questionId, ' FOR UPDATE OF q');
    if (!question) throw notFound();
    if (sessionId) {
      const owned = await tx.query('SELECT 1 FROM study_sessions WHERE id = $1 AND group_id = $2', [sessionId, group]);
      if (!owned.rowCount) throw invalid('Unknown session.');
    }
    const now = deps.clock.now();
    await tx.query(
      `INSERT INTO question_dispositions (id, question_id, session_id, status, decided_by, decided_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [uuidv7(now.getTime()), questionId, sessionId, status, userId, now],
    );
    await tx.query('UPDATE questions SET status = $2, version = version + 1 WHERE id = $1', [questionId, status]);
    return (await questionView(tx, group, questionId))!;
  });
}

// A retry with the same clientOpId returns the question the first attempt created (S8.2).
export async function postQuestion(deps: QuestionDeps, userId: string, groupId: unknown, request: unknown): Promise<QuestionView> {
  await requireMember(deps.db, userId, groupId);
  const r = (request ?? {}) as Partial<PostQuestionRequest>;
  if (!isUuid(r.clientOpId)) throw invalid('A question needs a clientOpId.');
  const text = body(r.body);
  const at = await anchor(deps.db, r.anchor);
  return withTransaction(deps.db, async (tx) => {
    const now = deps.clock.now();
    await tx.query(
      `INSERT INTO questions (id, group_id, author_id, client_op_id, translation_id, book_id, chapter, start_verse, end_verse, body, created_at, status, revision)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'open', 0)
       ON CONFLICT (author_id, client_op_id) DO NOTHING`,
      [uuidv7(now.getTime()), groupId, userId, r.clientOpId, at.translationId, at.bookId, at.chapter, at.startVerse, at.endVerse, text, now],
    );
    const existing = await tx.query<{ id: string }>('SELECT id FROM questions WHERE author_id = $1 AND client_op_id = $2 AND group_id = $3', [
      userId,
      r.clientOpId,
      groupId,
    ]);
    // The same clientOpId used for another group's question.
    if (!existing.rowCount) throw invalid('That clientOpId was already used.');
    // A retry of a question since deleted returns it deleted.
    return (await questionView(tx, groupId as string, existing.rows[0].id))!;
  });
}

const hasReplies = async (q: Queryable, questionId: string) =>
  !!(await q.query('SELECT 1 FROM replies WHERE question_id = $1 AND body IS NOT NULL LIMIT 1', [questionId])).rowCount;

export async function postReply(deps: QuestionDeps, userId: string, groupId: unknown, questionId: unknown, request: unknown): Promise<{ reply: ReplyView; question: QuestionView }> {
  await requireMember(deps.db, userId, groupId);
  if (!isUuid(questionId)) throw notFound();
  const r = (request ?? {}) as { clientOpId?: unknown; body?: unknown };
  if (!isUuid(r.clientOpId)) throw invalid('A reply needs a clientOpId.');
  const text = body(r.body);
  return withTransaction(deps.db, async (tx) => {
    // Locks the question, so a delete sees every reply committed before it and the version rises one change at a time.
    const row = await loadQuestion(tx, groupId as string, questionId, ' FOR UPDATE OF q');
    if (!row || (row.body === null && !(await hasReplies(tx, row.id)))) throw notFound();
    const now = deps.clock.now();
    const inserted = await tx.query(
      `INSERT INTO replies (id, question_id, author_id, client_op_id, body, created_at, revision) VALUES ($1, $2, $3, $4, $5, $6, 0)
       ON CONFLICT (author_id, client_op_id) DO NOTHING RETURNING id`,
      [uuidv7(now.getTime()), row.id, userId, r.clientOpId, text, now],
    );
    if (inserted.rowCount) await tx.query('UPDATE questions SET version = version + 1 WHERE id = $1', [row.id]);
    // A retry returns what the first attempt posted, deleted or not.
    const found = await tx.query<ReplyRow>(
      `SELECT ${replyColumns} FROM replies r JOIN users u ON u.id = r.author_id WHERE r.author_id = $1 AND r.client_op_id = $2 AND r.question_id = $3`,
      [userId, r.clientOpId, row.id],
    );
    if (!found.rowCount) throw invalid('That clientOpId was already used.');
    return { reply: toReply(found.rows[0]), question: (await questionView(tx, groupId as string, row.id))! };
  });
}

// The question a reply belongs to, checked against the group, with the reply row locked.
async function lockedReply(q: Queryable, groupId: string, replyId: string): Promise<(ReplyRow & { question_id: string }) | null> {
  const result = await q.query<ReplyRow>(
    `SELECT ${replyColumns} FROM replies r JOIN users u ON u.id = r.author_id JOIN questions q ON q.id = r.question_id
      WHERE r.id = $1 AND q.group_id = $2 FOR UPDATE OF r`,
    [replyId, groupId],
  );
  return result.rows[0] ?? null;
}

function staleRevision(current: QuestionView | ReplyView): AppError {
  return new AppError('stale_revision', 409, 'This post changed since you loaded it.', { details: { current } });
}

// I-20: only the author edits, and every edit sets editedAt. A stale edit is refused with the current post.
export async function editPost(
  deps: QuestionDeps,
  userId: string,
  groupId: unknown,
  target: PostTarget,
  request: unknown,
): Promise<{ post: QuestionView | ReplyView; question: QuestionView }> {
  await requireMember(deps.db, userId, groupId);
  const r = (request ?? {}) as { expectedRevision?: unknown; body?: unknown };
  if (!int(r.expectedRevision)) throw invalid('An edit needs the expectedRevision it was made against.');
  const text = body(r.body);
  const group = groupId as string;
  return withTransaction(deps.db, async (tx) => {
    const now = deps.clock.now();
    if ('questionId' in target) {
      if (!isUuid(target.questionId)) throw notFound();
      const row = await loadQuestion(tx, group, target.questionId, ' FOR UPDATE OF q');
      if (!row || row.body === null) throw notFound();
      if (row.author_id !== userId) throw notAuthor();
      if (row.revision !== r.expectedRevision) throw staleRevision((await withReplies(tx, [row]))[0]);
      await tx.query('UPDATE questions SET body = $2, edited_at = $3, revision = revision + 1, version = version + 1 WHERE id = $1', [row.id, text, now]);
      const question = (await questionView(tx, group, row.id))!;
      return { post: question, question };
    }
    if (!isUuid(target.replyId)) throw notFound();
    const row = await lockedReply(tx, group, target.replyId);
    if (!row || row.body === null) throw notFound();
    if (row.author_id !== userId) throw notAuthor();
    if (row.revision !== r.expectedRevision) throw staleRevision(toReply(row));
    await tx.query('UPDATE replies SET body = $2, edited_at = $3, revision = revision + 1 WHERE id = $1', [row.id, text, now]);
    await tx.query('UPDATE questions SET version = version + 1 WHERE id = $1', [row.question_id]);
    const question = (await questionView(tx, group, row.question_id))!;
    return { post: question.replies.find((reply) => reply.id === row.id)!, question };
  });
}

// A question with replies keeps them under a removed placeholder (I-20); a question with none, or a reply, is deleted.
// Returns the question as it now stands, so the room can update it; a deleted question comes back removed with no replies.
export async function deletePost(
  deps: QuestionDeps,
  userId: string,
  groupId: unknown,
  target: PostTarget,
): Promise<{ outcome: 'deleted' | 'body_removed'; question: QuestionView }> {
  await requireMember(deps.db, userId, groupId);
  const group = groupId as string;
  return withTransaction(deps.db, async (tx) => {
    const now = deps.clock.now();
    if ('questionId' in target) {
      if (!isUuid(target.questionId)) throw notFound();
      const row = await loadQuestion(tx, group, target.questionId, ' FOR UPDATE OF q');
      if (!row || row.body === null) throw notFound();
      if (row.author_id !== userId) throw notAuthor();
      const outcome = (await hasReplies(tx, row.id)) ? 'body_removed' : 'deleted';
      await tx.query('UPDATE questions SET body = NULL, body_removed_at = $2, revision = revision + 1, version = version + 1 WHERE id = $1', [row.id, now]);
      return { outcome, question: (await questionView(tx, group, row.id))! };
    }
    if (!isUuid(target.replyId)) throw notFound();
    const row = await lockedReply(tx, group, target.replyId);
    if (!row || row.body === null) throw notFound();
    if (row.author_id !== userId) throw notAuthor();
    await tx.query('UPDATE replies SET body = NULL, body_removed_at = $2, revision = revision + 1 WHERE id = $1', [row.id, now]);
    await tx.query('UPDATE questions SET version = version + 1 WHERE id = $1', [row.question_id]);
    return { outcome: 'deleted', question: (await questionView(tx, group, row.question_id))! };
  });
}

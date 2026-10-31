import type { NoteAnchor } from '../../shared/api.ts';
import type { Db } from '../platform/db.ts';
import { withTransaction } from '../platform/db.ts';
import { soloPositionOf } from './personal.ts';

// A member's own data as one file (S16, DOD-27): profile, live notes, solo position, the questions and replies they
// wrote, and their assistant conversations. Every query is scoped to the caller; nothing another member wrote is
// included, not even the questions their replies answer. Runtime ids stay on the server (I-25).

const anchor = (r: { translation_id: string; book_id: string; chapter: number; start_verse: number | null; end_verse: number | null }): NoteAnchor =>
  ({ translationId: r.translation_id, bookId: r.book_id, chapter: r.chapter, startVerse: r.start_verse, endVerse: r.end_verse }) as NoteAnchor;

export async function exportPersonal(db: Db, userId: string, now: Date): Promise<Record<string, unknown>> {
  return withTransaction(db, async (tx) => {
    // One snapshot, so the file is consistent with itself.
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const profile = (
      await tx.query<{ id: string; email: string; display_name: string; time_zone: string; display_translation_id: string | null; created_at: Date }>(
        'SELECT id, email, display_name, time_zone, display_translation_id, created_at FROM users WHERE id = $1',
        [userId],
      )
    ).rows[0];
    const notes = await tx.query(
      `SELECT id, translation_id, book_id, chapter, start_verse, end_verse, body, updated_at FROM notes
       WHERE user_id = $1 AND deleted_at IS NULL ORDER BY translation_id, book_id, chapter, start_verse NULLS FIRST, updated_at`,
      [userId],
    );
    const questions = await tx.query(
      `SELECT id, group_id, translation_id, book_id, chapter, start_verse, end_verse, body, created_at, edited_at, body_removed_at FROM questions
       WHERE author_id = $1 ORDER BY created_at, id`,
      [userId],
    );
    const replies = await tx.query(
      'SELECT id, question_id, body, created_at, edited_at, body_removed_at FROM replies WHERE author_id = $1 ORDER BY created_at, id',
      [userId],
    );
    const conversations = await tx.query<{ id: string; created_at: Date }>(
      'SELECT id, created_at FROM assistant_conversations WHERE user_id = $1 ORDER BY created_at, id',
      [userId],
    );
    const turns = await tx.query<{ id: string; conversation_id: string; prompt: string; status: string; created_at: Date }>(
      `SELECT t.id, t.conversation_id, t.prompt, t.status, t.created_at FROM assistant_turns t
       JOIN assistant_conversations c ON c.id = t.conversation_id WHERE c.user_id = $1 ORDER BY t.created_at, t.id`,
      [userId],
    );
    const entries = await tx.query<{ turn_id: string; kind: string; text: string; received_at: Date }>(
      `SELECT e.turn_id, e.kind, e.text, e.received_at FROM transcript_entries e
       JOIN assistant_conversations c ON c.id = e.conversation_id WHERE c.user_id = $1 ORDER BY e.position`,
      [userId],
    );
    return {
      exportedAt: now.toISOString(),
      profile: profile && {
        id: profile.id,
        email: profile.email,
        displayName: profile.display_name,
        timeZone: profile.time_zone,
        displayTranslationId: profile.display_translation_id,
        createdAt: profile.created_at.toISOString(),
      },
      notes: notes.rows.map((r) => ({ id: r.id, anchor: anchor(r), body: r.body, updatedAt: (r.updated_at as Date).toISOString() })),
      soloPosition: await soloPositionOf(tx, userId),
      questions: questions.rows.map((r) => ({
        id: r.id,
        groupId: r.group_id,
        anchor: anchor(r),
        body: r.body,
        createdAt: (r.created_at as Date).toISOString(),
        editedAt: r.edited_at ? (r.edited_at as Date).toISOString() : null,
        removedAt: r.body_removed_at ? (r.body_removed_at as Date).toISOString() : null,
      })),
      replies: replies.rows.map((r) => ({
        id: r.id,
        questionId: r.question_id,
        body: r.body,
        createdAt: (r.created_at as Date).toISOString(),
        editedAt: r.edited_at ? (r.edited_at as Date).toISOString() : null,
        removedAt: r.body_removed_at ? (r.body_removed_at as Date).toISOString() : null,
      })),
      conversations: conversations.rows.map((c) => ({
        id: c.id,
        createdAt: c.created_at.toISOString(),
        turns: turns.rows
          .filter((t) => t.conversation_id === c.id)
          .map((t) => ({
            prompt: t.prompt,
            status: t.status,
            createdAt: t.created_at.toISOString(),
            transcript: entries.rows.filter((e) => e.turn_id === t.id).map((e) => ({ kind: e.kind, text: e.text, receivedAt: e.received_at.toISOString() })),
          })),
      })),
    };
  });
}

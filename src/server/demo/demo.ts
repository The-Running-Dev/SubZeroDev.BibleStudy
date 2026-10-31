// The demo seed (S18.4): synthetic members at example.test, a group, notes, questions and replies, so the app
// can be shown without inviting anyone. It sends nothing: no invitation leaves the database, every demo member's
// reminders are off, and no email job is queued. Romans must already be imported.
import { randomUUID } from 'node:crypto';
import { acceptInvitationById, bootstrapOwner, createInvitation } from '../groups/groups.ts';
import { pushOps } from '../personal/personal.ts';
import { postQuestion, postReply } from '../questions/questions.ts';
import type { Clock } from '../platform/clock.ts';
import type { Db } from '../platform/db.ts';
import { withTransaction } from '../platform/db.ts';
import { uuidv7 } from '../platform/ids.ts';

export const demoDomain = 'example.test';
const members = [
  { email: `anna@${demoDomain}`, name: 'Anna' },
  { email: `mark@${demoDomain}`, name: 'Mark' },
  { email: `ruth@${demoDomain}`, name: 'Ruth' },
];

export interface DemoSummary {
  status: 'seeded' | 'already_seeded';
  groupId: string;
  owner: string;
  members: string[];
}

async function ensureUser(db: Db, clock: Clock, email: string, name: string): Promise<string> {
  const now = clock.now();
  const row = await db.query<{ id: string }>(
    `INSERT INTO users (id, email, display_name, time_zone, created_at) VALUES ($1, $2, $3, 'America/Chicago', $4)
     ON CONFLICT ((lower(email))) DO UPDATE SET email = users.email RETURNING id`,
    [uuidv7(now.getTime()), email, name, now],
  );
  return row.rows[0].id;
}

export async function seedDemo(deps: { db: Db; clock: Clock; ownerEmail: string | null }): Promise<DemoSummary> {
  const ownerEmail = deps.ownerEmail?.toLowerCase() ?? '';
  // Only a synthetic owner: a seed under a real owner's address would post in their name.
  if (!ownerEmail.endsWith(`@${demoDomain}`)) throw new Error(`OWNER_EMAIL must be an @${demoDomain} address for the demo seed`);
  const { db, clock } = deps;
  const ownerId = await ensureUser(db, clock, ownerEmail, 'Owner');
  await withTransaction(db, (tx) => bootstrapOwner(tx, clock, { id: ownerId, email: ownerEmail }, ownerEmail));
  const group = await db.query<{ id: string; owner_id: string }>('SELECT id, owner_id FROM groups ORDER BY created_at LIMIT 1');
  if (!group.rowCount || group.rows[0].owner_id !== ownerId) throw new Error('the group belongs to someone else; seed an empty database');
  const groupId = group.rows[0].id;
  const summary = { groupId, owner: ownerEmail, members: members.map((m) => m.email) };
  if ((await db.query('SELECT 1 FROM questions WHERE group_id = $1 LIMIT 1', [groupId])).rowCount) return { status: 'already_seeded', ...summary };

  const ids: string[] = [];
  for (const member of members) {
    const userId = await ensureUser(db, clock, member.email, member.name);
    ids.push(userId);
    // The invitation is accepted here, so its link is never shown or sent.
    const invitation = await createInvitation(db, clock, 'http://localhost', ownerId, groupId);
    await withTransaction(db, (tx) => acceptInvitationById(tx, clock, userId, invitation.id));
  }
  for (const userId of [ownerId, ...ids]) {
    await db.query(
      `INSERT INTO reminder_preferences (user_id, group_id, enabled, offsets_minutes, updated_at) VALUES ($1, $2, false, '{}', $3)
       ON CONFLICT (user_id, group_id) DO UPDATE SET enabled = false`,
      [userId, groupId, clock.now()],
    );
  }

  const [anna, mark, ruth] = ids;
  const rest = { db, clock };
  const anchor = (chapter: number, startVerse: number, endVerse = startVerse) => ({ translationId: 'BSB', bookId: 'ROM', chapter, startVerse, endVerse });
  const ask = (userId: string, at: ReturnType<typeof anchor>, body: string) => postQuestion(rest, userId, groupId, { clientOpId: randomUUID(), anchor: at, body });
  const answer = (userId: string, questionId: string, body: string) => postReply(rest, userId, groupId, questionId, { clientOpId: randomUUID(), body });

  const q1 = await ask(anna, anchor(1, 16, 17), 'What does Paul mean by "the righteousness of God is revealed"?');
  await answer(mark, q1.id, 'I read it as God’s way of putting people right with himself, received by faith.');
  await answer(ownerId, q1.id, 'Let’s start Monday with this one.');
  const q2 = await ask(ruth, anchor(1, 20), 'How is God’s nature "clearly seen" in creation?');
  await answer(anna, q2.id, 'Psalm 19 says something similar.');
  await ask(mark, anchor(2, 1), 'Is Paul turning from the Gentiles to his Jewish readers here?');

  const note = (chapter: number, verse: number, body: string) => ({
    opId: randomUUID(),
    entity: 'note',
    entityId: randomUUID(),
    op: 'upsert',
    baseRevision: null,
    anchor: anchor(chapter, verse),
    body,
    deviceId: 'demo-seed',
  });
  await pushOps(rest, ownerId, { ops: [note(1, 16, 'Not ashamed: the theme of the whole letter.'), note(1, 17, 'Habakkuk 2:4.')] });
  await pushOps(rest, anna, { ops: [note(1, 16, 'Power of God for salvation.')] });
  return { status: 'seeded', ...summary };
}

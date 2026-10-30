import type { GroupSummary, GroupView, InvitationView, MemberRole, TranslationId } from '../../shared/api.ts';
import type { Clock } from '../platform/clock.ts';
import type { Queryable, Tx } from '../platform/db.ts';
import { AppError } from '../platform/errors.ts';
import { isUuid, uuidv7 } from '../platform/ids.ts';
import { randomToken, sha256Hex } from '../platform/secrets.ts';

export const invitationLifetimeMs = 14 * 24 * 60 * 60 * 1000;
export const defaultGroup = { name: 'Bible Study', weekday: 1, localTime: '06:15', timeZone: 'America/Chicago', startBookId: 'ROM', startChapter: 1 };

// Why an invitation created no membership. `unknown` covers a token that matches no invitation.
export type InvitationState = 'unknown' | 'revoked' | 'expired' | 'accepted';

const notMember = () => new AppError('not_member', 403, 'You are not a member of this group.');
const notOwner = () => new AppError('not_owner', 403, "Only the group's owner can do this.");

// I-04: every group-scoped read or write starts here. A removed member fails it.
export async function requireMember(db: Queryable, userId: string, groupId: unknown): Promise<{ role: MemberRole }> {
  if (!isUuid(groupId)) throw notMember();
  const found = await db.query<{ role: MemberRole }>(
    'SELECT role FROM memberships WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL',
    [groupId, userId],
  );
  if (!found.rowCount) throw notMember();
  return { role: found.rows[0].role };
}

export async function requireOwner(db: Queryable, userId: string, groupId: unknown): Promise<void> {
  if ((await requireMember(db, userId, groupId)).role !== 'owner') throw notOwner();
}

// The first sign-in by OWNER_EMAIL creates the one group, with that user as owner. Later sign-ins change nothing.
export async function bootstrapOwner(tx: Tx, clock: Clock, user: { id: string; email: string }, ownerEmail: string | null): Promise<string | null> {
  if (!ownerEmail || user.email.toLowerCase() !== ownerEmail) return null;
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['group_bootstrap']);
  if ((await tx.query('SELECT 1 FROM groups LIMIT 1')).rowCount) return null;
  const now = clock.now();
  const groupId = uuidv7(now.getTime());
  await tx.query(
    `INSERT INTO groups (id, name, owner_id, schedule_weekday, schedule_local_time, schedule_time_zone, start_book_id, start_chapter, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [groupId, defaultGroup.name, user.id, defaultGroup.weekday, defaultGroup.localTime, defaultGroup.timeZone, defaultGroup.startBookId, defaultGroup.startChapter, now],
  );
  await tx.query(`INSERT INTO memberships (group_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3)`, [groupId, user.id, now]);
  return groupId;
}

export async function listGroups(db: Queryable, userId: string): Promise<GroupSummary[]> {
  const found = await db.query<{ id: string; name: string; role: MemberRole }>(
    `SELECT g.id, g.name, m.role FROM memberships m JOIN groups g ON g.id = m.group_id
     WHERE m.user_id = $1 AND m.removed_at IS NULL ORDER BY g.created_at`,
    [userId],
  );
  return found.rows;
}

interface GroupRow {
  id: string;
  name: string;
  shared_translation_id: TranslationId;
  narrator_id: string | null;
  rate: string;
  schedule_weekday: number;
  schedule_local_time: string;
  schedule_time_zone: string;
}

export async function getGroup(db: Queryable, userId: string, groupId: unknown): Promise<GroupView> {
  const { role } = await requireMember(db, userId, groupId);
  const group = await db.query<GroupRow>(
    `SELECT id, name, shared_translation_id, narrator_id, rate, schedule_weekday, schedule_local_time, schedule_time_zone FROM groups WHERE id = $1`,
    [groupId],
  );
  const members = await db.query<{ user_id: string; display_name: string; role: MemberRole }>(
    `SELECT m.user_id, u.display_name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = $1 AND m.removed_at IS NULL ORDER BY m.role = 'owner' DESC, lower(u.display_name), m.joined_at`,
    [groupId],
  );
  const row = group.rows[0];
  return {
    id: row.id,
    name: row.name,
    role,
    members: members.rows.map((m) => ({ userId: m.user_id, displayName: m.display_name, role: m.role })),
    sharedTranslationId: row.shared_translation_id,
    narratorId: row.narrator_id,
    rate: Number(row.rate),
    schedule: { weekday: row.schedule_weekday, localTime: row.schedule_local_time, timeZone: row.schedule_time_zone },
  };
}

// The raw token exists only in the returned link; the database keeps its hash.
export async function createInvitation(
  db: Queryable,
  clock: Clock,
  publicUrl: string,
  userId: string,
  groupId: unknown,
): Promise<{ id: string; link: string; expiresAt: string }> {
  await requireOwner(db, userId, groupId);
  const now = clock.now();
  const id = uuidv7(now.getTime());
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + invitationLifetimeMs);
  await db.query(
    `INSERT INTO invitations (id, group_id, token_hash, created_by, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, groupId, sha256Hex(token), userId, now, expiresAt],
  );
  return { id, link: `${publicUrl}/join/${token}`, expiresAt: expiresAt.toISOString() };
}

export async function listInvitations(db: Queryable, clock: Clock, userId: string, groupId: unknown): Promise<InvitationView[]> {
  await requireOwner(db, userId, groupId);
  const now = clock.now();
  const found = await db.query<{ id: string; created_at: Date; expires_at: Date; revoked_at: Date | null; accepted_at: Date | null }>(
    'SELECT id, created_at, expires_at, revoked_at, accepted_at FROM invitations WHERE group_id = $1 ORDER BY created_at DESC',
    [groupId],
  );
  return found.rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    state: row.accepted_at ? 'accepted' : row.revoked_at ? 'revoked' : now >= row.expires_at ? 'expired' : 'open',
  }));
}

// Revoking an accepted or already revoked link changes nothing.
export async function revokeInvitation(db: Queryable, clock: Clock, userId: string, groupId: unknown, invitationId: unknown): Promise<void> {
  await requireOwner(db, userId, groupId);
  const found = isUuid(invitationId)
    ? await db.query(
        `UPDATE invitations SET revoked_at = COALESCE(revoked_at, CASE WHEN accepted_at IS NULL THEN $3::timestamptz END)
         WHERE id = $1 AND group_id = $2`,
        [invitationId, groupId, clock.now()],
      )
    : { rowCount: 0 };
  if (!found.rowCount) throw new AppError('not_found', 404, 'No such invitation.');
}

// Removal keeps the row with `removed_at`; the member needs a new invitation to come back.
// Returns the removed user's id as stored, which may differ in case from the path's.
export async function removeMember(db: Queryable, clock: Clock, userId: string, groupId: unknown, memberId: unknown): Promise<string> {
  await requireOwner(db, userId, groupId);
  if (typeof memberId === 'string' && memberId.toLowerCase() === userId) throw new AppError('invalid_request', 400, 'The owner cannot be removed.');
  const removed = isUuid(memberId)
    ? await db.query<{ user_id: string }>(
        `UPDATE memberships SET removed_at = $3 WHERE group_id = $1 AND user_id = $2 AND role = 'member' AND removed_at IS NULL RETURNING user_id`,
        [groupId, memberId, clock.now()],
      )
    : { rowCount: 0, rows: [] };
  if (!removed.rowCount) throw new AppError('not_found', 404, 'No such member.');
  return removed.rows[0].user_id;
}

export async function invitationIdForToken(db: Queryable, token: unknown): Promise<string | null> {
  if (typeof token !== 'string' || token.length === 0 || token.length > 128) return null;
  const found = await db.query<{ id: string }>('SELECT id FROM invitations WHERE token_hash = $1', [sha256Hex(token)]);
  return found.rows[0]?.id ?? null;
}

export async function acceptInvitation(tx: Tx, clock: Clock, userId: string, token: unknown): Promise<{ groupId: string } | { invalid: InvitationState }> {
  const invitationId = await invitationIdForToken(tx, token);
  return invitationId ? acceptInvitationById(tx, clock, userId, invitationId) : { invalid: 'unknown' };
}

// I-05: one invitation, at most one membership. The row lock makes two simultaneous acceptances queue.
export async function acceptInvitationById(tx: Tx, clock: Clock, userId: string, invitationId: string): Promise<{ groupId: string } | { invalid: InvitationState }> {
  const found = await tx.query<{ group_id: string; expires_at: Date; revoked_at: Date | null; accepted_by: string | null }>(
    'SELECT group_id, expires_at, revoked_at, accepted_by FROM invitations WHERE id = $1 FOR UPDATE',
    [invitationId],
  );
  if (!found.rowCount) return { invalid: 'unknown' };
  const invitation = found.rows[0];
  const active = await tx.query('SELECT 1 FROM memberships WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL', [invitation.group_id, userId]);
  // A current member opening a link (the owner testing it, or the same invitee twice) leaves it for its invitee.
  if (active.rowCount) return { groupId: invitation.group_id };
  if (invitation.accepted_by) return { invalid: 'accepted' };
  if (invitation.revoked_at) return { invalid: 'revoked' };
  const now = clock.now();
  if (now >= invitation.expires_at) return { invalid: 'expired' };

  await tx.query(
    `INSERT INTO memberships (group_id, user_id, role, joined_at) VALUES ($1, $2, 'member', $3)
     ON CONFLICT (group_id, user_id) DO UPDATE SET role = 'member', joined_at = $3, removed_at = NULL`,
    [invitation.group_id, userId, now],
  );
  await tx.query('UPDATE invitations SET accepted_by = $2, accepted_at = $3 WHERE id = $1', [invitationId, userId, now]);
  return { groupId: invitation.group_id };
}

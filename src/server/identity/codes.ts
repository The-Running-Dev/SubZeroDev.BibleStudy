import { randomInt } from 'node:crypto';
import type { CodeDelivery, Profile } from '../../shared/api.ts';
import { acceptInvitation, acceptInvitationById, bootstrapOwner, invitationIdForToken } from '../groups/groups.ts';
import type { Outbox } from '../mail/outbox.ts';
import type { Clock } from '../platform/clock.ts';
import type { Db } from '../platform/db.ts';
import { withTransaction } from '../platform/db.ts';
import { AppError } from '../platform/errors.ts';
import { uuidv7 } from '../platform/ids.ts';
import { equalHex, hmacHex } from '../platform/secrets.ts';
import type { UserRow } from './profile.ts';
import { toProfile } from './profile.ts';
import { createSession } from './sessions.ts';
import { normalizeEmail } from './validation.ts';

export const codeLifetimeMs = 10 * 60 * 1000;
export const maxFailedAttempts = 5;
export const maxCodesPerEmailPerHour = 5;
export const maxCodesPerIpPerHour = 20;
const hourMs = 60 * 60 * 1000;
// Older codes are only consulted to tell a stale code (code_expired) from a wrong one (code_invalid).
const recentCodesConsidered = 20;

export interface IdentityDeps {
  db: Db;
  clock: Clock;
  outbox: Outbox;
  codePepper: Buffer;
  publicUrl: string;
  // The address whose first sign-in creates the group (OWNER_EMAIL), lower-cased.
  ownerEmail: string | null;
}

export function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

// Bound to the code's id, so equal codes issued twice never share a hash.
export function hashCode(pepper: Buffer, codeId: string, code: string): string {
  return hmacHex(pepper, `${codeId}:${code}`);
}

function loginEmail(publicUrl: string): { subject: string; text: string; html: string } {
  return {
    subject: 'Your Bible Study sign-in code',
    text: `Your sign-in code is {{code}}.\n\nIt works once, for 10 minutes. If you did not ask for it, ignore this email.\n\n${publicUrl}\n`,
    html: `<p>Your sign-in code is <strong style="font-size:1.4em;letter-spacing:0.15em">{{code}}</strong>.</p><p>It works once, for 10 minutes. If you did not ask for it, ignore this email.</p><p><a href="${publicUrl}">${publicUrl}</a></p>`,
  };
}

function rateLimited(oldest: Date, now: Date): AppError {
  const retryAfterSeconds = Math.max(1, Math.ceil((oldest.getTime() + hourMs - now.getTime()) / 1000));
  return new AppError('rate_limited', 429, 'Too many code requests. Try again later.', { retryable: true, details: { retryAfterSeconds } });
}

export async function requestLoginCode(
  deps: IdentityDeps,
  input: { email: unknown; ip: string; invitationToken?: unknown },
): Promise<{ sent: 'queued'; codeExpiresAt: string }> {
  const email = normalizeEmail(input.email);
  // Kept with the code, so the invitation still applies when the code is typed on another device.
  // Its validity is checked only at verification, so a request never reveals whether a link is live.
  const invitationId = await invitationIdForToken(deps.db, input.invitationToken);
  const now = deps.clock.now();
  const since = new Date(now.getTime() - hourMs);

  return withTransaction(deps.db, async (tx) => {
    // Serialise requests per address and per client so neither hourly count can be raced.
    // Always email first, then IP, so two requests never wait on each other in opposite orders.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`login_code:${email}`]);
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`login_code_ip:${input.ip}`]);

    const byEmail = await tx.query<{ count: string; oldest: Date | null }>(
      'SELECT count(*) AS count, min(created_at) AS oldest FROM login_codes WHERE lower(email) = $1 AND created_at > $2',
      [email, since],
    );
    if (Number(byEmail.rows[0].count) >= maxCodesPerEmailPerHour) throw rateLimited(byEmail.rows[0].oldest!, now);

    const byIp = await tx.query<{ count: string; oldest: Date | null }>(
      'SELECT count(*) AS count, min(created_at) AS oldest FROM login_codes WHERE request_ip = $1 AND created_at > $2',
      [input.ip, since],
    );
    if (Number(byIp.rows[0].count) >= maxCodesPerIpPerHour) throw rateLimited(byIp.rows[0].oldest!, now);

    // A new code supersedes any open one.
    await tx.query('UPDATE login_codes SET consumed_at = $2 WHERE lower(email) = $1 AND consumed_at IS NULL', [email, now]);

    const codeId = uuidv7(now.getTime());
    const code = generateCode();
    const expiresAt = new Date(now.getTime() + codeLifetimeMs);
    const { jobId } = await deps.outbox.enqueueEmail(tx, {
      kind: 'login_code',
      idempotencyKey: `login_code:${codeId}`,
      to: email,
      ...loginEmail(deps.publicUrl),
      secrets: { code },
    });
    await tx.query(
      `INSERT INTO login_codes (id, email, code_hash, request_ip, created_at, expires_at, email_job_id, invitation_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [codeId, email, hashCode(deps.codePepper, codeId, code), input.ip, now, expiresAt, jobId, invitationId],
    );
    return { sent: 'queued' as const, codeExpiresAt: expiresAt.toISOString() };
  });
}

interface CodeRow {
  id: string;
  code_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
  failed_attempts: number;
  invitation_id: string | null;
}

type InvitationOutcome = { joinedGroupId: string | null; invitation: 'accepted' | 'invalid' | 'none' };
type Verified = { user: Profile; token: string; sessionId: string; expiresAt: Date } & InvitationOutcome;

type VerifyOutcome =
  | ({ kind: 'ok' } & Verified)
  | { kind: 'error'; error: AppError };

export async function verifyLoginCode(
  deps: IdentityDeps,
  input: { email: unknown; code: unknown; invitationToken?: unknown },
): Promise<Verified> {
  const email = normalizeEmail(input.email);
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  const now = deps.clock.now();
  const expired = new AppError('code_expired', 401, 'This code has expired. Request a new one.');

  // Failed attempts are committed even though the request fails, so the outcome is returned, not thrown.
  const outcome = await withTransaction<VerifyOutcome>(deps.db, async (tx) => {
    const codes = await tx.query<CodeRow>(
      `SELECT id, code_hash, expires_at, consumed_at, failed_attempts, invitation_id FROM login_codes
       WHERE lower(email) = $1 ORDER BY created_at DESC LIMIT $2 FOR UPDATE`,
      [email, recentCodesConsidered],
    );
    const open = codes.rows.find((row) => row.consumed_at === null) ?? null;
    const usable = open !== null && now < open.expires_at && open.failed_attempts < maxFailedAttempts;
    const matches = (row: CodeRow) => /^\d{6}$/.test(code) && equalHex(row.code_hash, hashCode(deps.codePepper, row.id, code));

    if (open && usable && matches(open)) {
      await tx.query('UPDATE login_codes SET consumed_at = $2 WHERE id = $1', [open.id, now]);
      const user = await tx.query<UserRow>(
        `INSERT INTO users (id, email, display_name, time_zone, created_at) VALUES ($1, $2, $3, 'UTC', $4)
         ON CONFLICT ((lower(email))) DO UPDATE SET email = users.email
         RETURNING id, email, display_name, time_zone, display_translation_id`,
        [uuidv7(now.getTime()), email, email.split('@')[0].slice(0, 60), now],
      );
      const profile = toProfile(user.rows[0]);
      await bootstrapOwner(tx, deps.clock, profile, deps.ownerEmail);
      // The token the app carried through sign-in wins; the one recorded with the code covers another device.
      // An invalid invitation still signs the user in, without a membership.
      let joined: InvitationOutcome = { joinedGroupId: null, invitation: 'none' };
      if (input.invitationToken !== undefined || open.invitation_id) {
        const accepted =
          input.invitationToken !== undefined
            ? await acceptInvitation(tx, deps.clock, profile.id, input.invitationToken)
            : await acceptInvitationById(tx, deps.clock, profile.id, open.invitation_id!);
        joined = 'groupId' in accepted ? { joinedGroupId: accepted.groupId, invitation: 'accepted' } : { joinedGroupId: null, invitation: 'invalid' };
      }
      const session = await createSession(tx, deps.clock, profile.id);
      return { kind: 'ok', user: profile, ...session, ...joined };
    }

    // The right code at the wrong time: consumed, superseded, expired or out of attempts.
    if (codes.rows.some(matches) || !usable) return { kind: 'error', error: expired };

    const attempts = open!.failed_attempts + 1;
    await tx.query('UPDATE login_codes SET failed_attempts = $2 WHERE id = $1', [open!.id, attempts]);
    if (attempts >= maxFailedAttempts) return { kind: 'error', error: expired };
    return {
      kind: 'error',
      error: new AppError('code_invalid', 401, 'That code is not right.', { details: { attemptsLeft: maxFailedAttempts - attempts } }),
    };
  });

  if (outcome.kind === 'error') throw outcome.error;
  const { user, token, sessionId, expiresAt, joinedGroupId, invitation } = outcome;
  return { user, token, sessionId, expiresAt, joinedGroupId, invitation };
}

export async function loginCodeStatus(deps: IdentityDeps, emailInput: unknown): Promise<{ delivery: CodeDelivery }> {
  const email = normalizeEmail(emailInput);
  const result = await deps.db.query<{ status: CodeDelivery }>(
    `SELECT j.status FROM login_codes c JOIN email_jobs j ON j.id = c.email_job_id
     WHERE lower(c.email) = $1 ORDER BY c.created_at DESC LIMIT 1`,
    [email],
  );
  return { delivery: result.rowCount ? result.rows[0].status : 'none' };
}

import type { Clock } from '../platform/clock.ts';
import type { Queryable } from '../platform/db.ts';
import { uuidv7 } from '../platform/ids.ts';
import { randomToken, sha256Hex } from '../platform/secrets.ts';

export const sessionLifetimeMs = 90 * 24 * 60 * 60 * 1000;
// Sliding renewal writes at most once a day per session.
const renewAfterMs = 24 * 60 * 60 * 1000;

export interface Authenticated {
  userId: string;
  sessionId: string;
  // Set when the expiry slid forward, so web can refresh the cookie.
  renewedUntil: Date | null;
}

export async function createSession(db: Queryable, clock: Clock, userId: string): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const now = clock.now();
  const token = randomToken(32);
  const sessionId = uuidv7(now.getTime());
  const expiresAt = new Date(now.getTime() + sessionLifetimeMs);
  await db.query(
    `INSERT INTO auth_sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at) VALUES ($1, $2, $3, $4, $4, $5)`,
    [sessionId, userId, sha256Hex(token), now, expiresAt],
  );
  return { token, sessionId, expiresAt };
}

export async function authenticate(db: Queryable, clock: Clock, cookieToken: string | undefined): Promise<Authenticated | null> {
  if (!cookieToken || cookieToken.length > 128) return null;
  const now = clock.now();
  const found = await db.query<{ id: string; user_id: string; last_seen_at: Date }>(
    `SELECT id, user_id, last_seen_at FROM auth_sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
    [sha256Hex(cookieToken), now],
  );
  if (!found.rowCount) return null;
  const session = found.rows[0];
  let renewedUntil: Date | null = null;
  if (now.getTime() - session.last_seen_at.getTime() >= renewAfterMs) {
    renewedUntil = new Date(now.getTime() + sessionLifetimeMs);
    await db.query('UPDATE auth_sessions SET last_seen_at = $2, expires_at = $3 WHERE id = $1', [session.id, now, renewedUntil]);
  }
  return { userId: session.user_id, sessionId: session.id, renewedUntil };
}

export async function revokeSession(db: Queryable, clock: Clock, sessionId: string): Promise<void> {
  await db.query('UPDATE auth_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [sessionId, clock.now()]);
}

// Whether a session found at connect time still holds, for long-lived channels that authenticated once.
export async function sessionIsValid(db: Queryable, clock: Clock, sessionId: string): Promise<boolean> {
  const found = await db.query('SELECT 1 FROM auth_sessions WHERE id = $1 AND revoked_at IS NULL AND expires_at > $2', [sessionId, clock.now()]);
  return Boolean(found.rowCount);
}

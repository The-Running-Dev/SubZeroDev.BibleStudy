import type { OperationalEmail, OwnerStatus } from '../../shared/api.ts';
import type { Db } from '../platform/db.ts';
import { withTransaction } from '../platform/db.ts';

// SMTP errors can echo AUTH commands, URLs, message bodies and credentials. Never return raw text,
// even to the owner. A fixed vocabulary preserves useful guidance without trying to redact secrets.
export function safeMailFailure(error: string | null): OperationalEmail['failure'] {
  if (error === 'login code expired before delivery') {
    return {
      summary: 'Sign-in code expired before delivery.',
      action: 'Check the mail relay, then request a new sign-in code.',
    };
  }
  if (error && /EAUTH|Invalid login|authentication failed/i.test(error)) {
    return {
      summary: 'Mail relay authentication failed.',
      action: 'Check the relay credentials on the server.',
    };
  }
  if (
    error &&
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|timeout|timed out/i.test(error)
  ) {
    return {
      summary: 'Mail relay connection failed.',
      action: 'Check relay availability and network access from the server.',
    };
  }
  if (error && /(?:^|[ :])5\d\d[ -]/.test(error)) {
    return {
      summary: 'Mail relay permanently rejected delivery.',
      action: 'Check the recipient and relay policy. Request a new code if needed.',
    };
  }
  if (error && /(?:^|[ :])4\d\d[ -]/.test(error)) {
    return {
      summary: 'Mail relay temporarily rejected delivery.',
      action: 'Check relay limits if this persists.',
    };
  }
  return {
    summary: 'Delivery attempt failed; details withheld.',
    action: 'Inspect server logs using the job ID. Check the relay before requesting a new code.',
  };
}

interface StatusRow {
  id: string;
  kind: OperationalEmail['kind'];
  to_address: string;
  status: 'failed' | 'queued' | 'sending';
  attempts: number;
  created_at: Date;
  next_attempt_at: Date;
  last_error: string | null;
}

export const statusListLimit = 50;

// Read only, in one snapshot. No bodies, sealed secrets, idempotency keys or provider IDs are selected.
export async function mailStatus(db: Db): Promise<OwnerStatus['mail']> {
  return withTransaction(db, async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const counts = await tx.query<{
      failed: number;
      retrying: number;
      queued: number;
      sending: number;
      sent: number;
      suppressed: number;
    }>(
      `SELECT
         count(*) FILTER (WHERE status = 'failed' AND last_error IS DISTINCT FROM 'reminder suppressed')::int AS failed,
         count(*) FILTER (WHERE (status = 'queued' AND attempts > 0) OR (status = 'sending' AND attempts > 1))::int AS retrying,
         count(*) FILTER (WHERE status = 'queued' AND attempts = 0)::int AS queued,
         count(*) FILTER (WHERE status = 'sending')::int AS sending,
         count(*) FILTER (WHERE status = 'sent')::int AS sent,
         count(*) FILTER (WHERE status = 'failed' AND last_error = 'reminder suppressed')::int AS suppressed
       FROM email_jobs`
    );
    async function list(failed: boolean): Promise<OperationalEmail[]> {
      const result = await tx.query<StatusRow>(
        `SELECT id, kind, to_address, status, attempts, created_at, next_attempt_at, last_error FROM email_jobs
         WHERE ${failed ? "status = 'failed' AND last_error IS DISTINCT FROM 'reminder suppressed'" : "(status = 'queued' AND attempts > 0) OR (status = 'sending' AND attempts > 1)"}
         ORDER BY created_at DESC, id DESC LIMIT $1`,
        [statusListLimit]
      );
      return result.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        to: row.to_address,
        state:
          row.status === 'failed'
            ? 'failed'
            : row.status === 'sending'
              ? 'sending_retry'
              : 'retrying',
        attempts: row.attempts,
        createdAt: row.created_at.toISOString(),
        nextAttemptAt: row.status === 'queued' ? row.next_attempt_at.toISOString() : null,
        failure: safeMailFailure(row.last_error),
      }));
    }
    return {
      counts: counts.rows[0],
      failed: await list(true),
      retrying: await list(false),
      limit: statusListLimit,
    };
  });
}

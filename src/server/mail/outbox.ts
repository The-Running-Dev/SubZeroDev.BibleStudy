import type { Clock } from '../platform/clock.ts';
import type { Queryable } from '../platform/db.ts';
import { uuidv7 } from '../platform/ids.ts';
import { seal } from '../platform/secrets.ts';

export type EmailKind = 'login_code' | 'reminder';

export interface EmailJobInput {
  kind: EmailKind;
  idempotencyKey: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  // Substituted into {{name}} placeholders only at send time, so the stored bodies never carry them.
  secrets?: Record<string, string>;
}

export interface Outbox {
  enqueueEmail(tx: Queryable, job: EmailJobInput): Promise<{ jobId: string; created: boolean }>;
}

export function createOutbox(deps: { clock: Clock; sealKey: Buffer }): Outbox {
  return {
    async enqueueEmail(tx, job) {
      const now = deps.clock.now();
      const id = uuidv7(now.getTime());
      const sealed = job.secrets ? seal(deps.sealKey, JSON.stringify(job.secrets)) : null;
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO email_jobs (id, kind, idempotency_key, to_address, subject, text_body, html_body, sealed_secrets, next_attempt_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [id, job.kind, job.idempotencyKey, job.to, job.subject, job.text, job.html, sealed, now],
      );
      if (inserted.rowCount) return { jobId: inserted.rows[0].id, created: true };
      const existing = await tx.query<{ id: string }>('SELECT id FROM email_jobs WHERE idempotency_key = $1', [job.idempotencyKey]);
      return { jobId: existing.rows[0].id, created: false };
    },
  };
}

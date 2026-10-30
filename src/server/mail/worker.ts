import type { Clock } from '../platform/clock.ts';
import type { Db } from '../platform/db.ts';
import { log } from '../platform/log.ts';
import { unseal } from '../platform/secrets.ts';
import type { MailTransport } from './transport.ts';
import { isPermanentFailure } from './transport.ts';

export const retryDelaysMinutes = [1, 5, 15, 60];
export const maxAttempts = retryDelaysMinutes.length + 1;
const staleSendingMinutes = 10;
const loginCodeLifetimeMinutes = 10;
const pollMs = 1000;

interface ClaimedJob {
  id: string;
  kind: string;
  to_address: string;
  subject: string;
  text_body: string;
  html_body: string;
  sealed_secrets: string | null;
  attempts: number;
  created_at: Date;
}

export interface MailWorker {
  runOnce(): Promise<number>;
  run(signal: AbortSignal): Promise<void>;
  notify(): void;
}

// Minutes to wait before the next try after `attempts` tries, or null when the job has used them all.
export function nextDelayMinutes(attempts: number): number | null {
  return attempts >= 1 && attempts < maxAttempts ? retryDelaysMinutes[attempts - 1] : null;
}

export function fillPlaceholders(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match);
}

export function createMailWorker(deps: { db: Db; clock: Clock; transport: MailTransport; sealKey: Buffer }): MailWorker {
  let wake: (() => void) | null = null;

  async function claim(now: Date): Promise<ClaimedJob[]> {
    const result = await deps.db.query<ClaimedJob>(
      `UPDATE email_jobs SET status = 'sending', claimed_at = $1, attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM email_jobs
         WHERE (status = 'queued' AND next_attempt_at <= $1)
            OR (status = 'sending' AND claimed_at <= $1::timestamptz - make_interval(mins => $2))
         ORDER BY next_attempt_at
         LIMIT 10
         FOR UPDATE SKIP LOCKED)
       RETURNING id, kind, to_address, subject, text_body, html_body, sealed_secrets, attempts, created_at`,
      [now, staleSendingMinutes],
    );
    return result.rows;
  }

  async function finish(id: string, status: 'sent' | 'failed', now: Date, error: string | null): Promise<void> {
    await deps.db.query(
      `UPDATE email_jobs
       SET status = $2, sent_at = CASE WHEN $2 = 'sent' THEN $3::timestamptz END, last_error = $4, sealed_secrets = NULL, claimed_at = NULL
       WHERE id = $1`,
      [id, status, now, error],
    );
  }

  async function deliver(job: ClaimedJob, now: Date): Promise<void> {
    // A login code nobody can use any more is not worth sending.
    if (job.kind === 'login_code' && now.getTime() - job.created_at.getTime() >= loginCodeLifetimeMinutes * 60_000) {
      await finish(job.id, 'failed', now, 'login code expired before delivery');
      return;
    }
    try {
      const values = job.sealed_secrets ? (JSON.parse(unseal(deps.sealKey, job.sealed_secrets)) as Record<string, string>) : {};
      await deps.transport.send({
        to: job.to_address,
        subject: job.subject,
        text: fillPlaceholders(job.text_body, values),
        html: fillPlaceholders(job.html_body, values),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const delay = isPermanentFailure(error) ? null : nextDelayMinutes(job.attempts);
      if (delay === null) {
        await finish(job.id, 'failed', deps.clock.now(), message);
        log('warn', 'email failed', { jobId: job.id, kind: job.kind, attempts: job.attempts, error: message });
      } else {
        await deps.db.query(
          `UPDATE email_jobs
           SET status = 'queued', claimed_at = NULL, last_error = $2, next_attempt_at = $3::timestamptz + make_interval(mins => $4)
           WHERE id = $1`,
          [job.id, message, deps.clock.now(), delay],
        );
        log('warn', 'email retry scheduled', { jobId: job.id, kind: job.kind, attempts: job.attempts, delayMinutes: delay, error: message });
      }
      return;
    }
    // Recording the send is outside the send's try: a database error here must not be mistaken for a
    // failed send and mail the same message again. The job stays claimed and is picked up as stale.
    await finish(job.id, 'sent', deps.clock.now(), null);
    log('info', 'email sent', { jobId: job.id, kind: job.kind });
  }

  async function runOnce(): Promise<number> {
    const now = deps.clock.now();
    const jobs = await claim(now);
    for (const job of jobs) {
      // One job's bookkeeping failure must not strand the rest of the batch in 'sending'.
      try {
        await deliver(job, now);
      } catch (error) {
        log('error', 'email job bookkeeping failed', { jobId: job.id, kind: job.kind, error: (error as Error).message });
      }
    }
    return jobs.length;
  }

  return {
    runOnce,
    notify() {
      wake?.();
    },
    async run(signal) {
      while (!signal.aborted) {
        try {
          // Drain everything due before sleeping.
          while (!signal.aborted && (await runOnce()) > 0);
        } catch (error) {
          log('error', 'mail worker pass failed', { error: (error as Error).message });
        }
        if (signal.aborted) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, pollMs);
          function done() {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            wake = null;
            resolve();
          }
          wake = done;
          signal.addEventListener('abort', done, { once: true });
        });
      }
    },
  };
}

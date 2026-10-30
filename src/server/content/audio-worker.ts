import type { Clock } from '../platform/clock.ts';
import type { Db } from '../platform/db.ts';
import { log } from '../platform/log.ts';
import type { ContentSource } from './aolab.ts';
import { NarratorError, importAudio } from './narration.ts';

// Fetches recordings requested on first use (listRecordings queues them). One job per chapter and narrator;
// a stored recording deletes its job, a failure is retried on the same schedule as email, then marked failed.

export const audioRetryDelaysMinutes = [1, 5, 15, 60];
const staleClaimMinutes = 10;
const pollMs = 1000;

interface ClaimedJob {
  translation_id: 'BSB';
  book_id: string;
  chapter: number;
  narrator_id: string;
  attempts: number;
}

export interface AudioWorker {
  runOnce(): Promise<number>;
  run(signal: AbortSignal): Promise<void>;
  notify(): void;
}

export function createAudioWorker(deps: { db: Db; clock: Clock; source: ContentSource; mediaDir: string }): AudioWorker {
  let wake: (() => void) | null = null;

  async function claim(now: Date): Promise<ClaimedJob[]> {
    const result = await deps.db.query<ClaimedJob>(
      `UPDATE audio_jobs SET claimed_at = $1, attempts = attempts + 1, updated_at = $1
       WHERE (translation_id, book_id, chapter, narrator_id) IN (
         SELECT translation_id, book_id, chapter, narrator_id FROM audio_jobs
         WHERE status = 'preparing' AND next_attempt_at <= $1
           AND (claimed_at IS NULL OR claimed_at <= $1::timestamptz - make_interval(mins => $2))
         ORDER BY next_attempt_at
         LIMIT 4
         FOR UPDATE SKIP LOCKED)
       RETURNING translation_id, book_id, chapter, narrator_id, attempts`,
      [now, staleClaimMinutes],
    );
    return result.rows;
  }

  const key = (job: ClaimedJob) => [job.translation_id, job.book_id, job.chapter, job.narrator_id];

  async function fail(job: ClaimedJob, reason: string, permanent: boolean): Promise<void> {
    const delay = permanent ? undefined : audioRetryDelaysMinutes[job.attempts - 1];
    const now = deps.clock.now();
    if (delay === undefined) {
      await deps.db.query(
        `UPDATE audio_jobs SET status = 'failed', reason = $5, claimed_at = NULL, updated_at = $6
         WHERE translation_id = $1 AND book_id = $2 AND chapter = $3 AND narrator_id = $4`,
        [...key(job), reason, now],
      );
      log('warn', 'audio job failed', { bookId: job.book_id, chapter: job.chapter, narratorId: job.narrator_id, attempts: job.attempts, reason });
      return;
    }
    // Still preparing: the reader keeps polling while the retry is pending.
    await deps.db.query(
      `UPDATE audio_jobs SET reason = $5, claimed_at = NULL, updated_at = $6, next_attempt_at = $6::timestamptz + make_interval(mins => $7)
       WHERE translation_id = $1 AND book_id = $2 AND chapter = $3 AND narrator_id = $4`,
      [...key(job), reason, now, delay],
    );
    log('warn', 'audio job retry scheduled', { bookId: job.book_id, chapter: job.chapter, narratorId: job.narrator_id, delayMinutes: delay, reason });
  }

  async function process(job: ClaimedJob): Promise<void> {
    let summary;
    try {
      summary = await importAudio(deps, { translationId: job.translation_id, bookId: job.book_id, chapters: [job.chapter], narrators: [job.narrator_id] });
    } catch (error) {
      // importAudio refuses a narrator that was disabled after the job was queued; anything else
      // (the database, the media volume) may recover, so it follows the retry schedule.
      await fail(job, (error as Error).message, error instanceof NarratorError);
      return;
    }
    const item = summary.items[0];
    if (item && item.status !== 'failed') {
      await deps.db.query('DELETE FROM audio_jobs WHERE translation_id = $1 AND book_id = $2 AND chapter = $3 AND narrator_id = $4', key(job));
      log('info', 'audio job stored', { bookId: job.book_id, chapter: job.chapter, narratorId: job.narrator_id, mediaSha256: item.mediaSha256 });
      return;
    }
    await fail(job, item?.reason ?? 'import produced no recording', item?.permanent ?? false);
  }

  async function runOnce(): Promise<number> {
    const jobs = await claim(deps.clock.now());
    await Promise.all(
      jobs.map(async (job) => {
        try {
          await process(job);
        } catch (error) {
          log('error', 'audio job bookkeeping failed', { bookId: job.book_id, chapter: job.chapter, narratorId: job.narrator_id, error: (error as Error).message });
        }
      }),
    );
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
          while (!signal.aborted && (await runOnce()) > 0);
        } catch (error) {
          log('error', 'audio worker pass failed', { error: (error as Error).message });
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

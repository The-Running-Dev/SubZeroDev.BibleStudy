import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from './db.ts';
import { withTransaction } from './db.ts';
import { log } from './log.ts';

export const migrationsDir = join(import.meta.dirname, '..', '..', '..', 'migrations');

// Forward-only: each NNNN_name.sql runs once, in its own transaction, and is recorded in schema_migrations.
export async function migrate(db: Db, dir: string = migrationsDir): Promise<string[]> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const files = (await readdir(dir)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  const applied: string[] = [];

  for (const file of files) {
    const version = file.slice(0, -'.sql'.length);
    const sql = await readFile(join(dir, file), 'utf8');
    const ran = await withTransaction(db, async (tx) => {
      // Serialise concurrent starters; the second one sees the row and skips.
      await tx.query('SELECT pg_advisory_xact_lock(4207131)');
      const done = await tx.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
      if (done.rowCount) return false;
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      return true;
    });
    if (ran) {
      applied.push(version);
      log('info', 'migration applied', { version });
    }
  }
  return applied;
}

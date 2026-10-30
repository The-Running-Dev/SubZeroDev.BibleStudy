import { createPool } from './db.ts';
import { backup, listBackups, nextRunAt, postgresTools, prune, readManifest, restore, tableCounts } from './backup.ts';
import { log } from './log.ts';

// node src/server/platform/backup-cli.ts <command>
//   backup              one run now, then prune
//   schedule            a run every day at BACKUP_AT (UTC, default 03:30); the stack's backup service
//   list                the runs on disk
//   restore <name|latest> [--force]   into an empty stack (stop the app first)
//   counts              row counts of the live database, to compare with a manifest

const [command = '', ...rest] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const mediaDir = process.env.MEDIA_DIR?.trim() || 'data/media';
const backupDir = process.env.BACKUP_DIR?.trim() || 'data/backups';
const keep = Number(process.env.BACKUP_KEEP ?? 14);
const at = process.env.BACKUP_AT?.trim() || '03:30';
if (!Number.isInteger(keep) || keep < 1) {
  console.error('BACKUP_KEEP must be a whole number of runs, at least 1');
  process.exit(1);
}

const db = createPool(url);
const deps = { db, ...postgresTools(url), mediaDir, backupDir, buildId: process.env.BUILD_ID?.trim() || 'dev', now: () => new Date() };

async function runOnce(): Promise<void> {
  const manifest = await backup(deps);
  const pruned = await prune(backupDir, keep);
  log('info', 'backup written', { stamp: manifest.stamp, media: manifest.media.length, dumpBytes: manifest.database.bytes, counts: manifest.counts, pruned: pruned.removedRuns });
  console.log(JSON.stringify({ stamp: manifest.stamp, counts: manifest.counts, media: manifest.media.length }));
}

try {
  switch (command) {
    case 'backup':
      await runOnce();
      break;
    case 'schedule': {
      nextRunAt(new Date(), at);
      const stop = new AbortController();
      process.once('SIGTERM', () => stop.abort());
      process.once('SIGINT', () => stop.abort());
      while (!stop.signal.aborted) {
        const next = nextRunAt(new Date(), at);
        log('info', 'next backup', { at: next.toISOString() });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, next.getTime() - Date.now());
          stop.signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
        });
        if (stop.signal.aborted) break;
        // A failed run is logged and retried at the next slot; the service keeps running.
        await runOnce().catch((error: Error) => log('error', 'backup failed', { error: error.message }));
      }
      break;
    }
    case 'list':
      for (const stamp of await listBackups(backupDir)) {
        const manifest = await readManifest(backupDir, stamp);
        console.log(`${stamp}  build ${manifest.buildId}  media ${manifest.media.length}  ${JSON.stringify(manifest.counts)}`);
      }
      break;
    case 'restore': {
      const name = rest.find((a) => !a.startsWith('--'));
      const runs = await listBackups(backupDir);
      const stamp = name === 'latest' ? runs.at(-1) : name;
      if (!stamp) throw new Error(name === 'latest' ? `no backups in ${backupDir}` : 'restore needs a backup name or "latest"');
      const manifest = await restore(deps, stamp, { force: rest.includes('--force') });
      const counts = await tableCounts(db);
      log('info', 'backup restored', { stamp, media: manifest.media.length, counts });
      console.log(JSON.stringify({ stamp, expected: manifest.counts, restored: counts }));
      break;
    }
    case 'counts':
      console.log(JSON.stringify(await tableCounts(db)));
      break;
    default:
      console.error('usage: backup-cli.ts backup | schedule | list | restore <name|latest> [--force] | counts');
      process.exitCode = 1;
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}

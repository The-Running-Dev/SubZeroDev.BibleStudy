import { createPool } from './db.ts';
import { backup, listBackups, nextRunAt, postgresTools, prune, readManifest, restore, tableCounts, withBackupLock } from './backup.ts';
import { log } from './log.ts';

// node src/server/platform/backup-cli.ts <command>
//   backup              one run now, then prune
//   schedule            a run every day at BACKUP_AT (UTC, default 03:30), and one at start when the newest
//                       is a day old or missing; the stack's backup service
//   health              exits 0 when the newest run is younger than BACKUP_HEALTH_HOURS (default 26)
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
const healthHours = Number(process.env.BACKUP_HEALTH_HOURS ?? 26);
if (!Number.isInteger(keep) || keep < 1) {
  console.error('BACKUP_KEEP must be a whole number of runs, at least 1');
  process.exit(1);
}
// The dump holds sign-in and session tables: only the backup's own user may read what it writes.
process.umask(0o077);

const db = createPool(url);
const deps = { db, ...postgresTools(url), mediaDir, backupDir, buildId: process.env.BUILD_ID?.trim() || 'dev', now: () => new Date() };

async function runOnce(): Promise<void> {
  const { manifest, pruned } = await withBackupLock(backupDir, async () => ({ manifest: await backup(deps), pruned: await prune(backupDir, keep) }));
  log('info', 'backup written', { stamp: manifest.stamp, media: manifest.media.length, dumpBytes: manifest.database.bytes, counts: manifest.counts, pruned: pruned.removedRuns });
  console.log(JSON.stringify({ stamp: manifest.stamp, counts: manifest.counts, media: manifest.media.length, dumpBytes: manifest.database.bytes }));
}

// How long ago the newest finished run was written, or Infinity when there is none.
async function newestAgeMs(): Promise<number> {
  const newest = (await listBackups(backupDir)).at(-1);
  if (!newest) return Infinity;
  const manifest = await readManifest(backupDir, newest).catch(() => null);
  return manifest ? Date.now() - Date.parse(manifest.createdAt) : Infinity;
}

// A failed run is logged and retried at the next slot; the service keeps running, and its health check turns
// unhealthy once the newest run is too old.
const attempt = () => runOnce().catch((error: Error) => log('error', 'backup failed', { error: error.message }));

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
      // A fresh stack, or one down over the last slot, backs up now rather than waiting up to a day; an
      // unwritable BACKUP_DIR shows up at start instead of at 03:30.
      if ((await newestAgeMs()) >= 24 * 60 * 60 * 1000) await attempt();
      while (!stop.signal.aborted) {
        const next = nextRunAt(new Date(), at);
        log('info', 'next backup', { at: next.toISOString() });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, next.getTime() - Date.now());
          stop.signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
        });
        if (stop.signal.aborted) break;
        await attempt();
      }
      break;
    }
    case 'health': {
      const age = await newestAgeMs();
      if (age >= healthHours * 60 * 60 * 1000) {
        console.error(Number.isFinite(age) ? `newest backup is ${Math.round(age / 3_600_000)} h old` : `no backups in ${backupDir}`);
        process.exitCode = 1;
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
      // The app reads the restored recordings, so they keep the usual permissions.
      process.umask(0o022);
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
      console.error('usage: backup-cli.ts backup | schedule | health | list | restore <name|latest> [--force] | counts');
      process.exitCode = 1;
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}

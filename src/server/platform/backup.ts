import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Db } from './db.ts';

// Nightly backups: a pg_dump and a media manifest per run, in a dated folder under the backup directory.
// Media files are named by their SHA-256 and never change, so they are copied once into a shared store
// (<backupDir>/media) that every run's manifest points into.
//
//   <backupDir>/2026-10-31T033000Z/db.dump
//   <backupDir>/2026-10-31T033000Z/manifest.json
//   <backupDir>/media/<sha256>.mp3

export interface MediaEntry {
  name: string;
  sha256: string;
  bytes: number;
}

export interface BackupManifest {
  version: 1;
  stamp: string;
  createdAt: string;
  buildId: string;
  database: { file: 'db.dump'; sha256: string; bytes: number };
  media: MediaEntry[];
  // Rows at dump time, for checking a restore.
  counts: Record<string, number>;
}

export interface BackupDeps {
  db: Db;
  // Writes a dump of the database to the given file, and restores one.
  dump: (file: string) => Promise<void>;
  restore: (file: string) => Promise<void>;
  mediaDir: string;
  backupDir: string;
  buildId: string;
  now: () => Date;
}

export const countedTables = ['users', 'groups', 'memberships', 'chapters', 'recordings', 'study_sessions', 'assistant_turns'] as const;

const mediaName = /^[0-9a-f]{64}\.[a-z0-9]+$/;
const stampPattern = /^\d{4}-\d{2}-\d{2}T\d{6}Z$/;
const mediaStore = 'media';

export function stampFor(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/^(\d{4})(\d{2})(\d{2})/, '$1-$2-$3').replace(/\.\d{3}Z$/, 'Z');
}

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function tableCounts(db: Pick<Db, 'query'>): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of countedTables) {
    const result = await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
    counts[table] = Number(result.rows[0]?.n ?? 0);
  }
  return counts;
}

// Copies a file under a temporary name and renames it, so a crash never leaves a partial file under the real name.
async function copyAtomic(from: string, to: string): Promise<void> {
  const temp = `${to}.${randomUUID()}.tmp`;
  try {
    await copyFile(from, temp);
    await rename(temp, to);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function backup(deps: BackupDeps): Promise<BackupManifest> {
  const stamp = stampFor(deps.now());
  const finalDir = join(deps.backupDir, stamp);
  const workDir = `${finalDir}.partial`;
  const storeDir = join(deps.backupDir, mediaStore);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await mkdir(storeDir, { recursive: true });

  try {
    // Counted before the dump; a row added in between is in the dump but not the count, which a restore check allows for.
    const counts = await tableCounts(deps.db);
    const dumpFile = join(workDir, 'db.dump');
    await deps.dump(dumpFile);

    const media: MediaEntry[] = [];
    const names = (await readdir(deps.mediaDir).catch(() => [] as string[])).filter((n) => mediaName.test(n)).sort();
    for (const name of names) {
      const source = join(deps.mediaDir, name);
      const sha256 = await fileSha256(source);
      // A file whose bytes do not match its name is damaged: the run fails rather than back it up.
      if (!name.startsWith(sha256)) throw new Error(`media file ${name} does not match its checksum`);
      const { size } = await stat(source);
      const stored = join(storeDir, name);
      const existing = await stat(stored).catch(() => null);
      if (existing?.size !== size) await copyAtomic(source, stored);
      media.push({ name, sha256, bytes: size });
    }

    const manifest: BackupManifest = {
      version: 1,
      stamp,
      createdAt: deps.now().toISOString(),
      buildId: deps.buildId,
      database: { file: 'db.dump', sha256: await fileSha256(dumpFile), bytes: (await stat(dumpFile)).size },
      media,
      counts,
    };
    await writeFile(join(workDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(workDir, finalDir);
    return manifest;
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

export async function listBackups(backupDir: string): Promise<string[]> {
  const entries = await readdir(backupDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && stampPattern.test(e.name))
    .map((e) => e.name)
    .sort();
}

export async function readManifest(backupDir: string, stamp: string): Promise<BackupManifest> {
  if (!stampPattern.test(stamp)) throw new Error(`not a backup name: ${stamp}`);
  return JSON.parse(await readFile(join(backupDir, stamp, 'manifest.json'), 'utf8')) as BackupManifest;
}

// Keeps the newest `keep` runs and drops media no kept manifest lists.
export async function prune(backupDir: string, keep: number): Promise<{ removedRuns: string[]; removedMedia: string[] }> {
  const runs = await listBackups(backupDir);
  const removedRuns = runs.slice(0, Math.max(0, runs.length - keep));
  for (const run of removedRuns) await rm(join(backupDir, run), { recursive: true, force: true });

  const referenced = new Set<string>();
  for (const run of runs.slice(removedRuns.length)) for (const entry of (await readManifest(backupDir, run)).media) referenced.add(entry.name);
  const removedMedia: string[] = [];
  const storeDir = join(backupDir, mediaStore);
  for (const name of await readdir(storeDir).catch(() => [] as string[])) {
    if (referenced.has(name)) continue;
    await rm(join(storeDir, name), { force: true });
    removedMedia.push(name);
  }
  return { removedRuns, removedMedia };
}

// Restores a run into a database with no users, unless forced, and puts its media back.
export async function restore(deps: Omit<BackupDeps, 'dump' | 'now' | 'buildId'>, stamp: string, options: { force?: boolean } = {}): Promise<BackupManifest> {
  const manifest = await readManifest(deps.backupDir, stamp);
  const dumpFile = join(deps.backupDir, stamp, manifest.database.file);
  if ((await fileSha256(dumpFile)) !== manifest.database.sha256) throw new Error(`${stamp}: the database dump does not match its manifest`);
  const storeDir = join(deps.backupDir, mediaStore);
  for (const entry of manifest.media) {
    if ((await fileSha256(join(storeDir, entry.name))) !== entry.sha256) throw new Error(`${stamp}: stored media ${entry.name} does not match its manifest`);
  }

  if (!options.force) {
    const users = await deps.db.query<{ n: string | null }>(`SELECT CASE WHEN to_regclass('public.users') IS NULL THEN NULL ELSE (SELECT count(*) FROM users) END AS n`).catch(() => null);
    const n = Number(users?.rows[0]?.n ?? 0);
    if (n > 0) throw new Error(`the database already has ${n} user(s); restore only into an empty stack, or pass --force to replace it`);
  }

  await deps.restore(dumpFile);
  await mkdir(deps.mediaDir, { recursive: true });
  for (const entry of manifest.media) {
    const target = join(deps.mediaDir, entry.name);
    const existing = await stat(target).catch(() => null);
    if (existing?.size !== entry.bytes) await copyAtomic(join(storeDir, entry.name), target);
  }
  return manifest;
}

// pg_dump and pg_restore, given the connection through the environment so the password is not on the command line.
export function postgresTools(databaseUrl: string): Pick<BackupDeps, 'dump' | 'restore'> {
  const url = new URL(databaseUrl);
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')),
  };
  const run = promisify(execFile);
  return {
    dump: async (file) => {
      await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--file=${file}`], { env });
    },
    restore: async (file) => {
      await run('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error', `--dbname=${env.PGDATABASE}`, file], { env });
    },
  };
}

// The next time of day (UTC, "HH:MM") strictly after `now`.
export function nextRunAt(now: Date, at: string): Date {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at);
  if (!match) throw new Error(`BACKUP_AT must be HH:MM (UTC), not ${at}`);
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Number(match[1]), Number(match[2])));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

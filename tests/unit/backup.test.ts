import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { Db } from '../../src/server/platform/db.ts';
import { backup, listBackups, nextRunAt, prune, readManifest, restore, stampFor, withBackupLock, type BackupDeps } from '../../src/server/platform/backup.ts';

const sha = (data: string) => createHash('sha256').update(data).digest('hex');
const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

// A database that answers every count query, including the restore's user check, with `users`.
function fakeDb(users: number): Db {
  return {
    query: async () => ({ rows: [{ n: String(users) }] }),
  } as unknown as Db;
}

async function setup(users = 2): Promise<{ deps: BackupDeps; restored: string[]; clock: { at: Date } }> {
  const root = await mkdtemp(join(tmpdir(), 'bs-backup-'));
  roots.push(root);
  const mediaDir = join(root, 'media');
  await mkdir(mediaDir);
  const restored: string[] = [];
  const clock = { at: new Date('2026-10-31T03:30:00.000Z') };
  const deps: BackupDeps = {
    db: fakeDb(users),
    dump: async (file) => writeFile(file, `dump at ${clock.at.toISOString()}`),
    restore: async (file) => {
      restored.push(await readFile(file, 'utf8'));
    },
    mediaDir,
    backupDir: join(root, 'backups'),
    buildId: 'test-build',
    now: () => clock.at,
  };
  return { deps, restored, clock };
}

async function addMedia(deps: BackupDeps, content: string): Promise<string> {
  const name = `${sha(content)}.mp3`;
  await writeFile(join(deps.mediaDir, name), content);
  return name;
}

describe('stampFor and nextRunAt', () => {
  test('a stamp is a sortable UTC name without separators that trouble file systems', () => {
    assert.equal(stampFor(new Date('2026-10-31T03:30:05.123Z')), '2026-10-31T033005Z');
  });

  test('the next run is today when the time is still ahead, tomorrow when it has passed or is now', () => {
    assert.equal(nextRunAt(new Date('2026-10-31T01:00:00Z'), '03:30').toISOString(), '2026-10-31T03:30:00.000Z');
    assert.equal(nextRunAt(new Date('2026-10-31T03:30:00Z'), '03:30').toISOString(), '2026-11-01T03:30:00.000Z');
    assert.equal(nextRunAt(new Date('2026-12-31T23:59:00Z'), '00:00').toISOString(), '2027-01-01T00:00:00.000Z');
  });

  test('a malformed time is refused', () => {
    assert.throws(() => nextRunAt(new Date(), '3:30'), /HH:MM/);
    assert.throws(() => nextRunAt(new Date(), '24:00'), /HH:MM/);
  });
});

describe('backup', () => {
  test('writes the dump, a manifest with checksums and counts, and the media into the shared store', async () => {
    const { deps } = await setup();
    const name = await addMedia(deps, 'audio one');
    const manifest = await backup(deps);

    assert.equal(manifest.stamp, '2026-10-31T033000Z');
    assert.equal(manifest.buildId, 'test-build');
    assert.equal(manifest.database.sha256, sha('dump at 2026-10-31T03:30:00.000Z'));
    assert.deepEqual(manifest.media, [{ name, sha256: sha('audio one'), bytes: 'audio one'.length }]);
    assert.equal(manifest.counts.users, 2);
    assert.deepEqual(await readManifest(deps.backupDir, manifest.stamp), manifest);
    assert.equal(await readFile(join(deps.backupDir, 'media', name), 'utf8'), 'audio one');
    assert.deepEqual(await listBackups(deps.backupDir), ['2026-10-31T033000Z']);
  });

  test('a media file whose bytes do not match its name fails the run and leaves no run behind', async () => {
    const { deps } = await setup();
    await writeFile(join(deps.mediaDir, `${sha('original')}.mp3`), 'corrupted');
    await assert.rejects(backup(deps), /does not match its checksum/);
    assert.deepEqual(await listBackups(deps.backupDir), []);
    assert.deepEqual((await readdir(deps.backupDir)).filter((n) => n !== 'media'), []);
  });

  test('a failed dump leaves no run behind', async () => {
    const { deps } = await setup();
    await assert.rejects(backup({ ...deps, dump: async () => Promise.reject(new Error('pg_dump: connection refused')) }), /connection refused/);
    assert.deepEqual(await listBackups(deps.backupDir), []);
  });
});

describe('prune', () => {
  test('keeps the newest runs and drops media only the removed runs listed', async () => {
    const { deps, clock } = await setup();
    const first = await addMedia(deps, 'first');
    await backup(deps);
    await rm(join(deps.mediaDir, first));
    const second = await addMedia(deps, 'second');
    clock.at = new Date('2026-11-01T03:30:00Z');
    await backup(deps);
    clock.at = new Date('2026-11-02T03:30:00Z');
    await backup(deps);

    const result = await prune(deps.backupDir, 2);
    assert.deepEqual(result.removedRuns, ['2026-10-31T033000Z']);
    assert.deepEqual(result.removedMedia, [first]);
    assert.deepEqual(await listBackups(deps.backupDir), ['2026-11-01T033000Z', '2026-11-02T033000Z']);
    assert.deepEqual(await readdir(join(deps.backupDir, 'media')), [second]);
  });

  test('drops the folders of runs that never finished', async () => {
    const { deps } = await setup();
    await backup(deps);
    await mkdir(join(deps.backupDir, '2026-10-30T033000Z.partial'));
    await prune(deps.backupDir, 5);
    assert.deepEqual((await readdir(deps.backupDir)).sort(), ['2026-10-31T033000Z', 'media']);
  });

  test('leaves the media store alone when a kept run cannot be read', async () => {
    const { deps, clock } = await setup();
    const name = await addMedia(deps, 'audio');
    await backup(deps);
    clock.at = new Date('2026-11-01T03:30:00Z');
    const second = await backup(deps);
    await writeFile(join(deps.backupDir, second.stamp, 'manifest.json'), '{ truncated');
    await writeFile(join(deps.backupDir, 'media', `${sha('orphan')}.mp3`), 'orphan');
    const result = await prune(deps.backupDir, 5);
    assert.deepEqual(result.removedMedia, []);
    assert.deepEqual((await readdir(join(deps.backupDir, 'media'))).sort(), [name, `${sha('orphan')}.mp3`].sort());
  });
});

describe('withBackupLock', () => {
  test('a second run while one holds the lock is refused, and the lock is released after', async () => {
    const { deps } = await setup();
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const held = withBackupLock(deps.backupDir, () => new Promise<void>((resolve) => ((release = resolve), started())));
    await running;
    await assert.rejects(withBackupLock(deps.backupDir, async () => 'second'), /another backup is running/);
    release();
    await held;
    assert.equal(await withBackupLock(deps.backupDir, async () => 'third'), 'third');
    assert.deepEqual(await readdir(deps.backupDir), []);
  });

  test('a lock left by a killed run is taken over once it is old', async () => {
    const { deps } = await setup();
    await mkdir(deps.backupDir, { recursive: true });
    const lock = join(deps.backupDir, '.lock');
    await writeFile(lock, '1 2026-10-30T00:00:00Z\n');
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
    await utimes(lock, old, old);
    assert.equal(await withBackupLock(deps.backupDir, async () => 'ran'), 'ran');
  });
});

describe('restore', () => {
  test('restores the dump and puts the media back into an empty stack', async () => {
    const { deps } = await setup();
    const name = await addMedia(deps, 'audio');
    const manifest = await backup(deps);

    const target = await setup(0);
    const fresh = { ...target.deps, backupDir: deps.backupDir };
    await restore(fresh, manifest.stamp);
    assert.deepEqual(target.restored, ['dump at 2026-10-31T03:30:00.000Z']);
    assert.equal(await readFile(join(fresh.mediaDir, name), 'utf8'), 'audio');
  });

  test('refuses a database that already has users unless forced', async () => {
    const { deps, restored } = await setup(3);
    const manifest = await backup(deps);
    await assert.rejects(restore(deps, manifest.stamp), /already has 3 user/);
    assert.deepEqual(restored, []);
    await restore(deps, manifest.stamp, { force: true });
    assert.equal(restored.length, 1);
  });

  test('refuses a run whose dump or stored media no longer match the manifest', async () => {
    const { deps } = await setup(0);
    const name = await addMedia(deps, 'audio');
    const manifest = await backup(deps);
    await writeFile(join(deps.backupDir, 'media', name), 'bitrot');
    await assert.rejects(restore(deps, manifest.stamp), /stored media .* does not match/);
    await writeFile(join(deps.backupDir, manifest.stamp, 'db.dump'), 'truncated');
    await assert.rejects(restore(deps, manifest.stamp), /database dump does not match/);
  });

  test('a name that is not a backup is refused before any file is read', async () => {
    const { deps } = await setup(0);
    await assert.rejects(restore(deps, '../../etc'), /not a backup name/);
  });

  test('a manifest naming files a backup never writes is refused', async () => {
    const { deps } = await setup(0);
    const manifest = await backup(deps);
    const path = join(deps.backupDir, manifest.stamp, 'manifest.json');
    await writeFile(path, JSON.stringify({ ...manifest, media: [{ name: '../../escape.mp3', sha256: 'x', bytes: 1 }] }));
    await assert.rejects(readManifest(deps.backupDir, manifest.stamp), /names files a backup never writes/);
    await writeFile(path, JSON.stringify({ ...manifest, database: { ...manifest.database, file: '../db.dump' } }));
    await assert.rejects(restore(deps, manifest.stamp), /names files a backup never writes/);
  });
});

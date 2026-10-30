// The stack drill: builds the image, runs compose.yaml with .env.example's values (secrets replaced),
// and checks what the deploy depends on (S7.2-S7.4):
//   1. the app serves /__build-id with the build it was given;
//   2. database rows and media survive `down` and `up`;
//   3. a backup restored into an empty stack reproduces users, groups and chapters, and the media;
//   4. a failing migration exits the container non-zero before the listener opens.
// Synthetic data only. Needs Docker with Compose v2.
//
//   node scripts/drill-stack.ts [--image <tag>] [--build-id <id>] [--keep]
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: { image: { type: 'string' }, 'build-id': { type: 'string' }, keep: { type: 'boolean' } } });
const root = join(import.meta.dirname, '..');
const run = randomBytes(3).toString('hex');
const projectA = `bsdrill-${run}-a`;
const projectB = `bsdrill-${run}-b`;
const proxyNetwork = `bsdrill-${run}-proxy`;
const work = mkdtempSync(join(tmpdir(), 'bsdrill-'));
const backupDir = join(work, 'backups');
const migrationsDir = join(work, 'migrations');
const envFile = join(work, 'stack.env');
const results: { check: string; ok: boolean; detail: string }[] = [];

function docker(argv: string[], options: { input?: string | Buffer; allowFail?: boolean; quiet?: boolean } = {}): { status: number; out: string } {
  const result = spawnSync('docker', argv, { cwd: root, input: options.input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const status = result.status ?? 1;
  if (status !== 0 && !options.allowFail) throw new Error(`docker ${argv.join(' ')} exited ${status}\n${out}`);
  if (!options.quiet && status !== 0) process.stderr.write(out);
  return { status, out };
}

const compose = (project: string, argv: string[], options: Parameters<typeof docker>[1] = {}) =>
  docker(['compose', '-p', project, '--env-file', envFile, '-f', join(root, 'compose.yaml'), ...argv], options);

function record(check: string, ok: boolean, detail: string): void {
  results.push({ check, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${check}${detail ? ` — ${detail}` : ''}`);
}

// .env.example, with every secret replaced and the stack pointed at the drill's image and network.
function writeEnv(image: string): void {
  const lines = readFileSync(join(root, '.env.example'), 'utf8').split('\n');
  const secret = () => randomBytes(32).toString('base64url');
  const overrides: Record<string, string> = {
    APP_SECRET: secret(),
    DB_PASSWORD: secret(),
    CONNECTOR_TOKEN: secret(),
    BIBLESTUDY_IMAGE: image,
    BIBLESTUDY_PULL_POLICY: 'never',
    PROXY_NETWORK: proxyNetwork,
    BACKUP_DIR: backupDir,
  };
  const out = lines.filter((line) => !/^\s*#/.test(line) && line.includes('=')).filter((line) => !(line.split('=')[0]! in overrides));
  for (const [key, value] of Object.entries(overrides)) out.push(`${key}=${value}`);
  writeFileSync(envFile, `${out.join('\n')}\n`);
}

const psql = (project: string, sql: string) => compose(project, ['exec', '-T', 'db', 'psql', '-U', 'biblestudy', '-d', 'biblestudy', '-v', 'ON_ERROR_STOP=1', '-At'], { input: sql }).out.trim();

// What a restore must reproduce: row counts, every chapter's stored and recomputed checksum, and the media files' hashes.
function snapshot(project: string): string {
  const counts = psql(
    project,
    `SELECT string_agg(t || '=' || n, ' ' ORDER BY t) FROM (
       SELECT 'users' t, count(*) n FROM users UNION ALL SELECT 'groups', count(*) FROM groups
       UNION ALL SELECT 'memberships', count(*) FROM memberships UNION ALL SELECT 'chapters', count(*) FROM chapters
       UNION ALL SELECT 'recordings', count(*) FROM recordings) c;`,
  );
  const chapters = psql(
    project,
    `SELECT string_agg(translation_id || ' ' || book_id || ' ' || chapter || ' ' || content_sha256 || ' ' || encode(sha256(convert_to(content, 'UTF8')), 'hex'), E'\\n' ORDER BY translation_id, book_id, chapter) FROM chapters;`,
  );
  const media = compose(project, ['exec', '-T', 'app', 'sh', '-c', 'cd /app/data/media && sha256sum *.mp3 | sort']).out.trim();
  return `${counts}\n${chapters}\n${media}`;
}

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

function seed(project: string): void {
  const audio = randomBytes(4096);
  const audioSha = sha(audio);
  compose(project, ['exec', '-T', 'app', 'sh', '-c', `cat > /app/data/media/${audioSha}.mp3`], { input: audio });
  const owner = randomUUID();
  const member = randomUUID();
  const group = randomUUID();
  const chapter = (n: number) => JSON.stringify({ verses: [{ n: 1, text: `Drill chapter ${n}, verse 1.` }, { n: 2, text: `Drill chapter ${n}, verse 2.` }] });
  const rows = [1, 2].map((n) => `('BSB', 'ROM', ${n}, 2, '${chapter(n)}', '${sha(chapter(n))}', 'drill', now())`).join(', ');
  psql(
    project,
    `INSERT INTO users (id, email, display_name, time_zone, created_at) VALUES
       ('${owner}', 'drill-owner@example.test', 'Drill Owner', 'America/Chicago', now()),
       ('${member}', 'drill-member@example.test', 'Drill Member', 'Europe/Sofia', now());
     INSERT INTO groups (id, name, owner_id, schedule_weekday, schedule_local_time, schedule_time_zone, start_book_id, start_chapter, created_at)
       VALUES ('${group}', 'Drill group', '${owner}', 1, '06:15', 'America/Chicago', 'ROM', 1, now());
     INSERT INTO memberships (group_id, user_id, role, joined_at) VALUES ('${group}', '${owner}', 'owner', now()), ('${group}', '${member}', 'member', now());
     INSERT INTO chapters (translation_id, book_id, chapter, verse_count, content, content_sha256, source_ref, fetched_at) VALUES ${rows};
     INSERT INTO recordings (id, translation_id, book_id, chapter, narrator_id, media_sha256, bytes, duration_seconds, mime_type, source_url, imported_at, timing_status, timing_reason)
       VALUES ('${randomUUID()}', 'BSB', 'ROM', 1, 'souer', '${audioSha}', ${audio.length}, 10.5, 'audio/mpeg', 'drill', now(), 'absent', 'drill fixture');`,
  );
}

let image = args.image ?? '';
try {
  if (!image) {
    const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim() || 'local';
    const buildId = args['build-id'] ?? `drill-${commit}`;
    image = `biblestudy:drill-${run}`;
    console.log(`building ${image} (BUILD_ID=${buildId})`);
    docker(['build', '--build-arg', `BUILD_ID=${buildId}`, '-t', image, '.']);
  }
  const expectedBuild = JSON.parse(docker(['image', 'inspect', image, '--format', '{{json .Config.Env}}']).out)
    .find((e: string) => e.startsWith('BUILD_ID='))
    ?.slice('BUILD_ID='.length);

  writeEnv(image);
  // The backup service runs as uid 1000; a fresh temp folder may belong to another user.
  rmSync(backupDir, { recursive: true, force: true });
  mkdirSync(backupDir, { recursive: true });
  if (process.platform !== 'win32') chmodSync(backupDir, 0o777);
  docker(['network', 'create', proxyNetwork], { quiet: true });

  // 1. Up with the example values; the image's health check is a GET of /__build-id.
  compose(projectA, ['up', '-d', '--wait', '--wait-timeout', '180']);
  const buildId = compose(projectA, ['exec', '-T', 'app', 'node', '-e', "fetch('http://127.0.0.1:3000/__build-id').then(r=>r.text()).then(t=>console.log(t))"]).out.trim();
  record('S7.2 /__build-id on the app port', buildId === JSON.stringify({ buildId: expectedBuild }), buildId);

  // 2. Rows and media survive down/up.
  seed(projectA);
  const before = snapshot(projectA);
  compose(projectA, ['down']);
  compose(projectA, ['up', '-d', '--wait', '--wait-timeout', '180']);
  const after = snapshot(projectA);
  record('S7.2 data and media survive down && up', before === after, before.split('\n')[0] ?? '');

  // 3. Back up, then restore into a second, empty stack.
  const backupOut = compose(projectA, ['run', '--rm', '-T', 'backup', 'node', 'src/server/platform/backup-cli.ts', 'backup']).out;
  const stamp = /"stamp":"([^"]+)"/.exec(backupOut)?.[1] ?? '';
  const manifest = JSON.parse(readFileSync(join(backupDir, stamp, 'manifest.json'), 'utf8')) as { media: unknown[]; database: { bytes: number } };
  record('S7.3 backup writes a pg_dump and a media manifest', manifest.database.bytes > 0 && manifest.media.length === 1, `${stamp}, dump ${manifest.database.bytes} bytes, ${manifest.media.length} media file(s)`);
  compose(projectA, ['down']);

  compose(projectB, ['up', '-d', '--wait', '--wait-timeout', '180', 'db']);
  const restoreOut = compose(projectB, ['run', '--rm', '-T', '--no-deps', 'backup', 'node', 'src/server/platform/backup-cli.ts', 'restore', 'latest']).out;
  compose(projectB, ['up', '-d', '--wait', '--wait-timeout', '180']);
  const restored = snapshot(projectB);
  record('S7.3 restore into an empty stack reproduces rows, chapter checksums and media', restored === before, /\{"stamp".*\}/.exec(restoreOut)?.[0] ?? '');

  // A restore over a stack that has users is refused.
  const again = compose(projectB, ['run', '--rm', '-T', '--no-deps', 'backup', 'node', 'src/server/platform/backup-cli.ts', 'restore', 'latest'], { allowFail: true, quiet: true });
  record('S7.3 restore refuses a stack that already has users', again.status !== 0 && /already has/.test(again.out), '');

  // 4. A failing migration, mounted over the image's own: the container exits non-zero and never listens.
  rmSync(migrationsDir, { recursive: true, force: true });
  mkdirSync(migrationsDir, { recursive: true });
  for (const name of readdirSync(join(root, 'migrations'))) copyFileSync(join(root, 'migrations', name), join(migrationsDir, name));
  writeFileSync(join(migrationsDir, '9999_drill_broken.sql'), 'CREATE TABLE drill_partial (id int);\nSELECT * FROM no_such_table;\n');
  const failed = compose(projectB, ['run', '--rm', '-T', '--no-deps', '-v', `${migrationsDir}:/app/migrations:ro`, 'app'], { allowFail: true, quiet: true });
  const leftover = psql(projectB, "SELECT count(*) FROM schema_migrations WHERE version = '9999_drill_broken'; SELECT to_regclass('drill_partial') IS NULL;");
  record(
    'S7.4 a failing migration exits non-zero before listening',
    failed.status !== 0 && failed.out.includes('migration failed') && !failed.out.includes('"msg":"listening"') && leftover === '0\nt',
    `exit ${failed.status}, nothing applied`,
  );
} catch (error) {
  record('drill ran to the end', false, (error as Error).message);
} finally {
  if (!args.keep) {
    for (const project of [projectA, projectB]) compose(project, ['down', '-v', '--remove-orphans'], { allowFail: true, quiet: true });
    docker(['network', 'rm', proxyNetwork], { allowFail: true, quiet: true });
    // The backup runs wrote as the image's user, which on Linux may not be the user running the drill.
    if (image) docker(['run', '--rm', '--entrypoint', 'sh', '-v', `${backupDir}:/b`, image, '-c', 'rm -rf /b/* /b/.[!.]*'], { allowFail: true, quiet: true });
    if (!args.image) docker(['image', 'rm', image], { allowFail: true, quiet: true });
    try {
      rmSync(work, { recursive: true, force: true });
    } catch (error) {
      console.warn(`left ${work}: ${(error as Error).message}`);
    }
  }
}

const failedChecks = results.filter((r) => !r.ok);
console.log(`\n${results.length - failedChecks.length}/${results.length} checks passed (${new Date().toISOString()})`);
process.exit(failedChecks.length ? 1 : 0);

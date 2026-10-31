// The stack drill: builds the image, runs compose.yaml with stack.env.example's values (secrets replaced),
// and checks what the deploy depends on (S7.2-S7.4):
//   1. the app serves /__build-id with the build it was given, and every service is healthy;
//   2. database rows and media survive `down` and `up`;
//   3. a backup restored into an empty stack reproduces users, groups and chapters, and the media; a forced
//      restore over a stack migrated past the backup replaces it;
//   4. a failing migration exits the container non-zero before the listener opens; a deploy whose migration
//      fails stops with nothing applied, and redeploying the previous image brings the app back.
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

function docker(
  argv: string[],
  options: { input?: string | Buffer; allowFail?: boolean; quiet?: boolean; env?: Record<string, string> } = {},
): { status: number; out: string } {
  const env = options.env ? { ...process.env, ...options.env } : undefined;
  const result = spawnSync('docker', argv, { cwd: root, input: options.input, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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

// stack.env.example, with every secret replaced and the stack pointed at the drill's image and network.
function writeEnv(image: string): void {
  const lines = readFileSync(join(root, 'stack.env.example'), 'utf8').split('\n');
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

// The last line of a CLI's output that is its JSON result rather than a log entry.
function result<T>(out: string): T {
  const parsed = out
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((o) => o && typeof o === 'object' && !('msg' in o));
  if (!parsed.length) throw new Error(`no JSON result in:\n${out}`);
  return parsed.at(-1) as T;
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
  const media = compose(project, ['exec', '-T', 'biblestudy', 'sh', '-c', 'cd /app/data/media && sha256sum *.mp3 | sort']).out.trim();
  return `${counts}\n${chapters}\n${media}`;
}

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

function seed(project: string): void {
  const audio = randomBytes(4096);
  const audioSha = sha(audio);
  compose(project, ['exec', '-T', 'biblestudy', 'sh', '-c', `cat > /app/data/media/${audioSha}.mp3`], { input: audio });
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
let brokenImage = '';
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

  // 1. Up with the example values; the image's health check is a GET of /__health, which queries the database.
  compose(projectA, ['up', '-d', '--wait', '--wait-timeout', '180']);
  const buildId = compose(projectA, ['exec', '-T', 'biblestudy', 'node', '-e', "fetch('http://127.0.0.1:3000/__build-id').then(r=>r.text()).then(t=>console.log(t))"]).out.trim();
  record('S7.2 /__build-id on the app port', buildId === JSON.stringify({ buildId: expectedBuild }), buildId);
  // The backup service is healthy only once a backup exists, so this also covers its run at start.
  const unhealthy = compose(projectA, ['ps', '--format', '{{.Service}} {{.Health}}']).out.trim().split('\n').filter((l) => !/ healthy$/.test(l));
  record('S7.3 every long-running service is healthy, the backup taken at start included', unhealthy.length === 0, unhealthy.join('; '));

  // 2. Rows and media survive down/up.
  seed(projectA);
  const before = snapshot(projectA);
  compose(projectA, ['down']);
  compose(projectA, ['up', '-d', '--wait', '--wait-timeout', '180']);
  const after = snapshot(projectA);
  record('S7.2 data and media survive down && up', before === after, before.split('\n')[0] ?? '');

  // 3. Back up, then restore into a second, empty stack.
  // Run inside the service, as an operator would; the run is only readable by the backup's own user.
  const written = result<{ stamp: string; media: number; dumpBytes: number }>(
    compose(projectA, ['exec', '-T', 'backup', 'node', 'src/server/platform/backup-cli.ts', 'backup']).out,
  );
  record('S7.3 backup writes a pg_dump and a media manifest', written.dumpBytes > 0 && written.media === 1, `${written.stamp}, dump ${written.dumpBytes} bytes, ${written.media} media file(s)`);
  compose(projectA, ['down']);

  compose(projectB, ['up', '-d', '--wait', '--wait-timeout', '180', 'db']);
  const restoreOut = compose(projectB, ['run', '--rm', '-T', '--no-deps', 'backup', 'node', 'src/server/platform/backup-cli.ts', 'restore', 'latest']).out;
  compose(projectB, ['up', '-d', '--wait', '--wait-timeout', '180']);
  const restored = snapshot(projectB);
  record('S7.3 restore into an empty stack reproduces rows, chapter checksums and media', restored === before, /\{"stamp".*\}/.exec(restoreOut)?.[0] ?? '');

  // A restore over a stack that has users is refused.
  const again = compose(projectB, ['run', '--rm', '-T', '--no-deps', 'backup', 'node', 'src/server/platform/backup-cli.ts', 'restore', 'latest'], { allowFail: true, quiet: true });
  record('S7.3 restore refuses a stack that already has users', again.status !== 0 && /already has/.test(again.out), '');

  // A forced restore over a database a later migration has changed: a table the backup does not hold, with
  // a foreign key into one it does. The restore replaces the whole schema, so it neither fails on the
  // reference nor leaves the table behind.
  psql(projectB, `CREATE TABLE drill_newer (user_id uuid REFERENCES users(id)); INSERT INTO drill_newer SELECT id FROM users;`);
  compose(projectB, ['stop', 'biblestudy']);
  const forced = compose(projectB, ['exec', '-T', 'backup', 'node', 'src/server/platform/backup-cli.ts', 'restore', 'latest', '--force'], { allowFail: true });
  compose(projectB, ['up', '-d', '--wait', '--wait-timeout', '180']);
  const newerGone = psql(projectB, "SELECT to_regclass('drill_newer') IS NULL;");
  record(
    'S7.3 a forced restore replaces a database migrated past the backup',
    forced.status === 0 && newerGone === 't' && snapshot(projectB) === before,
    forced.status === 0 ? 'drill_newer dropped, rows and media match' : forced.out.trim().split('\n').at(-1) ?? '',
  );

  // 4. A failing migration, mounted over the image's own: the container exits non-zero and never listens.
  rmSync(migrationsDir, { recursive: true, force: true });
  mkdirSync(migrationsDir, { recursive: true });
  for (const name of readdirSync(join(root, 'migrations'))) copyFileSync(join(root, 'migrations', name), join(migrationsDir, name));
  writeFileSync(join(migrationsDir, '9999_drill_broken.sql'), 'CREATE TABLE drill_partial (id int);\nSELECT * FROM no_such_table;\n');
  const failed = compose(projectB, ['run', '--rm', '-T', '--no-deps', '-v', `${migrationsDir}:/app/migrations:ro`, 'biblestudy'], { allowFail: true, quiet: true });
  const leftover = psql(projectB, "SELECT count(*) FROM schema_migrations WHERE version = '9999_drill_broken'; SELECT to_regclass('drill_partial') IS NULL;");
  record(
    'S7.4 a failing migration exits non-zero before listening',
    failed.status !== 0 && failed.out.includes('migration failed') && !failed.out.includes('"msg":"listening"') && leftover === '0\nt',
    `exit ${failed.status}, nothing applied`,
  );

  // The same broken migration in a new image, deployed the way Portainer does: `up -d` with the new tag.
  writeFileSync(join(migrationsDir, 'Dockerfile'), `FROM ${image}\nCOPY 9999_drill_broken.sql /app/migrations/\n`);
  brokenImage = `${image}-broken`;
  docker(['build', '-q', '-t', brokenImage, migrationsDir], { quiet: true });
  // Compose stops the running app before it waits on migrate, so the site is down until the rollback: the
  // check is that nothing of the migration landed and the previous image comes straight back.
  const deploy = compose(projectB, ['up', '-d', '--wait', '--wait-timeout', '120'], { allowFail: true, quiet: true, env: { BIBLESTUDY_IMAGE: brokenImage } });
  const applied = psql(projectB, "SELECT count(*) FROM schema_migrations WHERE version = '9999_drill_broken'; SELECT to_regclass('drill_partial') IS NULL;");
  const rollback = compose(projectB, ['up', '-d', '--wait', '--wait-timeout', '180'], { allowFail: true, quiet: true });
  const serves = compose(projectB, ['exec', '-T', 'biblestudy', 'node', '-e', "fetch('http://127.0.0.1:3000/__build-id').then(r=>r.text()).then(t=>console.log(t))"], { allowFail: true, quiet: true }).out.trim();
  record(
    'S7.4 a deploy whose migration fails applies nothing, and the previous image redeploys',
    deploy.status !== 0 && applied === '0\nt' && rollback.status === 0 && serves === JSON.stringify({ buildId: expectedBuild }) && snapshot(projectB) === before,
    `failed up exit ${deploy.status}, rollback up exit ${rollback.status}, ${serves}`,
  );
} catch (error) {
  record('drill ran to the end', false, (error as Error).message);
} finally {
  if (!args.keep) {
    for (const project of [projectA, projectB]) compose(project, ['down', '-v', '--remove-orphans'], { allowFail: true, quiet: true });
    docker(['network', 'rm', proxyNetwork], { allowFail: true, quiet: true });
    // The backup runs wrote as the image's user, which on Linux may not be the user running the drill.
    if (image) docker(['run', '--rm', '--entrypoint', 'sh', '-v', `${backupDir}:/b`, image, '-c', 'rm -rf /b/* /b/.[!.]*'], { allowFail: true, quiet: true });
    if (brokenImage) docker(['image', 'rm', brokenImage], { allowFail: true, quiet: true });
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

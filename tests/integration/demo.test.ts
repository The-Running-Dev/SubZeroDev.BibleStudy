// S18.4: the demo seed creates synthetic members only, sends nothing and runs twice without doubling anything.
// Romans imported live from AO Lab.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createAoLabSource } from '../../src/server/content/aolab.ts';
import { runImport } from '../../src/server/content/import.ts';
import { demoDomain, seedDemo } from '../../src/server/demo/demo.ts';
import type { Harness } from '../support/harness.ts';
import { clearMailbox, messagesTo, ownerEmail, startHarness } from '../support/harness.ts';

const aoLabUrl = process.env.AOLAB_BASE_URL ?? 'https://bible.helloao.org';
let h: Harness;

before(async () => {
  h = await startHarness();
  await clearMailbox();
  const source = createAoLabSource({ baseUrl: aoLabUrl });
  assert.equal((await runImport({ db: h.db, clock: h.clock, source }, { translationId: 'BSB', books: ['ROM'] })).status, 'succeeded');
});
after(async () => {
  await h?.close();
});

const count = async (sql: string) => Number((await h.db.query<{ n: string }>(`SELECT count(*) AS n FROM ${sql}`)).rows[0].n);

test('S18.4 the demo seed uses synthetic accounts, queues no email and turns every reminder off', async () => {
  await assert.rejects(seedDemo({ db: h.db, clock: h.clock, ownerEmail: 'someone@gmail.com' }), /must be an @example\.test address/);
  const first = await seedDemo({ db: h.db, clock: h.clock, ownerEmail });
  assert.equal(first.status, 'seeded');
  const emails = (await h.db.query<{ email: string }>('SELECT email FROM users ORDER BY email')).rows.map((row) => row.email);
  assert.equal(emails.length, 4);
  for (const email of emails) assert.ok(email.endsWith(`@${demoDomain}`), `${email} is not synthetic`);
  assert.equal(await count(`memberships WHERE group_id = '${first.groupId}' AND removed_at IS NULL`), 4);
  assert.equal(await count('invitations WHERE accepted_by IS NULL'), 0);
  assert.equal(await count('questions'), 3);
  assert.equal(await count('replies'), 3);
  assert.equal(await count('notes WHERE deleted_at IS NULL'), 3);
  assert.equal(await count('reminder_preferences WHERE enabled'), 0);
  assert.equal(await count('reminder_preferences'), 4);

  // The reminder loop finds nobody owed, and nothing reached the outbox or the mailbox.
  h.clock.set(new Date('2026-11-02T11:00:00Z'));
  await h.tick();
  await h.worker.runOnce();
  assert.equal(await count('email_jobs'), 0);
  for (const email of emails) assert.equal((await messagesTo(email)).length, 0);

  const second = await seedDemo({ db: h.db, clock: h.clock, ownerEmail });
  assert.equal(second.status, 'already_seeded');
  assert.equal(await count('questions'), 3);
  assert.equal(await count('users'), 4);
});

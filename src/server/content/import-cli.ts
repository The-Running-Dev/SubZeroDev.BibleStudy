// import-content --translation BSB [--books ROM,1CO]
// Run inside the app container (or locally with DATABASE_URL set). Prints the manifest summary.
import { parseArgs } from 'node:util';
import { systemClock } from '../platform/clock.ts';
import { createPool } from '../platform/db.ts';
import { createAoLabSource } from './aolab.ts';
import { runImport } from './import.ts';

const { values } = parseArgs({
  options: { translation: { type: 'string' }, books: { type: 'string' } },
});
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
if (values.translation !== 'BSB') {
  console.error('--translation BSB is the only importable translation. CSB is fetched from API.Bible on demand.');
  process.exit(1);
}

const pool = createPool(url);
try {
  const source = createAoLabSource({ baseUrl: process.env.AOLAB_BASE_URL ?? 'https://bible.helloao.org' });
  const books = values.books?.split(',').map((b) => b.trim()).filter(Boolean);
  if (books && books.length === 0) throw new Error('--books lists no books; omit it to import every book');
  const summary = await runImport({ db: pool, clock: systemClock, source }, { translationId: 'BSB', books });
  const failed = summary.items.filter((item) => item.status === 'failed');
  console.log(JSON.stringify({ manifestId: summary.manifestId, status: summary.status, sourceSha256: summary.sourceSha256, counts: summary.counts }));
  for (const item of failed) console.error(`failed ${item.bookId} ${item.chapter}: ${'reason' in item ? item.reason : ''}`);
  process.exitCode = summary.status === 'succeeded' ? 0 : 2;
} finally {
  await pool.end();
}

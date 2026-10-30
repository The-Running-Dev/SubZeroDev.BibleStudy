// import-content --translation BSB [--books ROM,1CO] [--audio ROM:1-16] [--narrators souer,hays]
// Run inside the app container (or locally with DATABASE_URL set). Prints the manifest summary.
// --audio alone imports recordings only (their chapters' text must already be imported);
// with --books, or with neither flag, the text is imported first.
import { parseArgs } from 'node:util';
import { contentSettings } from '../platform/config.ts';
import { systemClock } from '../platform/clock.ts';
import { createPool } from '../platform/db.ts';
import { createAoLabSource } from './aolab.ts';
import { runImport } from './import.ts';
import { importAudio, narratorsFor, parseAudioScope } from './narration.ts';

const { values } = parseArgs({
  options: { translation: { type: 'string' }, books: { type: 'string' }, audio: { type: 'string' }, narrators: { type: 'string' } },
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
const list = (raw: string | undefined) => raw?.split(',').map((item) => item.trim()).filter(Boolean);

let audioScopes: ReturnType<typeof parseAudioScope>[] = [];
try {
  audioScopes = (list(values.audio) ?? []).map(parseAudioScope);
  if (values.audio !== undefined && audioScopes.length === 0) throw new Error('--audio lists no chapters, e.g. --audio ROM:1-16');
  if (values.narrators !== undefined && values.audio === undefined) throw new Error('--narrators needs --audio');
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const { mediaDir, aolabBaseUrl } = contentSettings();
const pool = createPool(url);
try {
  const source = createAoLabSource({ baseUrl: aolabBaseUrl });
  let ok = true;
  if (values.books !== undefined || values.audio === undefined) {
    const books = list(values.books);
    if (books && books.length === 0) throw new Error('--books lists no books; omit it to import every book');
    const summary = await runImport({ db: pool, clock: systemClock, source }, { translationId: 'BSB', books });
    console.log(JSON.stringify({ kind: 'text', manifestId: summary.manifestId, status: summary.status, sourceSha256: summary.sourceSha256, counts: summary.counts }));
    for (const item of summary.items) if (item.status === 'failed') console.error(`failed ${item.bookId} ${item.chapter}: ${'reason' in item ? item.reason : ''}`);
    ok = summary.status === 'succeeded';
  }
  const narrators = audioScopes.length ? await narratorsFor(pool, 'BSB', list(values.narrators)) : [];
  for (const scope of audioScopes) {
    const summary = await importAudio({ db: pool, clock: systemClock, source, mediaDir }, { translationId: 'BSB', ...scope, narrators });
    console.log(JSON.stringify({ kind: 'audio', bookId: scope.bookId, manifestId: summary.manifestId, status: summary.status, counts: summary.counts }));
    for (const item of summary.items) {
      if (item.status === 'failed') console.error(`failed ${item.bookId} ${item.chapter} ${item.narratorId}: ${item.reason}`);
      else if (item.timingStatus !== 'verified') console.error(`no verse following for ${item.bookId} ${item.chapter} ${item.narratorId}: ${item.timingReason}`);
    }
    ok &&= summary.status === 'succeeded';
  }
  process.exitCode = ok ? 0 : 2;
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { verseAt } from '../../src/client/timing.ts';
import { mp3DurationSeconds, readFrameHeader } from '../../src/server/content/mp3.ts';
import { parseAudioScope, validateTiming } from '../../src/server/content/narration.ts';
import { parseRange } from '../../src/server/web/content-routes.ts';
import { frameSeconds, synthMp3 } from '../support/mp3.ts';

describe('mp3 duration', () => {
  test('reads an MPEG-1 Layer III header', () => {
    assert.deepEqual(readFrameHeader(synthMp3(1), 0), { bytes: 417, samples: 1152, sampleRate: 44100 });
    assert.equal(readFrameHeader(Buffer.from([0xff, 0xfb, 0xf0, 0x00]), 0), null, 'bitrate index 15 is invalid');
  });

  test('sums the frames, skipping an ID3v2 tag and a Xing frame', () => {
    const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);
    close(mp3DurationSeconds(synthMp3(400)), 400 * frameSeconds);
    close(mp3DurationSeconds(synthMp3(400, { id3: true, xing: true })), 400 * frameSeconds);
  });

  test('a file with no frames is refused', () => {
    assert.throws(() => mp3DurationSeconds(Buffer.from('not audio at all')), /no MPEG audio frames/);
  });
});

describe('S3.2 verse timing validation', () => {
  const starts = Array.from({ length: 32 }, (_, i) => i * 5);
  test('one strictly increasing start per verse, inside the recording, is verified', () => {
    assert.deepEqual(validateTiming(starts, 32, 200), { status: 'verified', starts });
  });
  test('31 entries for 32 verses is rejected', () => {
    const check = validateTiming(starts.slice(0, 31), 32, 200);
    assert.equal(check.status, 'rejected');
    assert.equal('reason' in check && check.reason, 'verse count 31 ≠ 32');
  });
  test('a start that does not increase is rejected', () => {
    const bad = [...starts];
    bad[4] = bad[3];
    const check = validateTiming(bad, 32, 200);
    assert.equal(check.status, 'rejected');
    assert.equal('reason' in check && check.reason, 'verse 5 starts at 15 s, not after verse 4 at 15 s');
  });
  test('a start past the end, a negative start or non-numbers are rejected; no timing is absent', () => {
    assert.match((validateTiming(starts, 32, 150) as { reason: string }).reason, /verse 32 starts at 155 s, after the recording ends at 150.000 s/);
    assert.match((validateTiming([-1, ...starts.slice(1)], 32, 200) as { reason: string }).reason, /verse 1 starts before the recording/);
    assert.equal(validateTiming(['0', 1], 2, 10).status, 'rejected');
    assert.deepEqual(validateTiming(undefined, 32, 200), { status: 'absent', reason: 'the source publishes no verse timing for this recording', starts: null });
  });
});

describe('verseAt', () => {
  const starts = [0.5, 4, 9.25];
  test('is the last verse started at or before the position', () => {
    assert.equal(verseAt(starts, 0), null);
    assert.equal(verseAt(starts, 0.5), 1);
    assert.equal(verseAt(starts, 3.99), 1);
    assert.equal(verseAt(starts, 4), 2);
    assert.equal(verseAt(starts, 100), 3);
  });
});

describe('Range header', () => {
  test('resolves single byte ranges against the size', () => {
    assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
    assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
    assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
    assert.deepEqual(parseRange('bytes=990-5000', 1000), { start: 990, end: 999 });
    assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
  });
  test('serves the whole file for no range, several ranges or another unit', () => {
    for (const header of [undefined, '', 'bytes=0-1,5-9', 'items=0-1', 'bytes=-']) assert.equal(parseRange(header, 1000), null, String(header));
  });
  test('a range past the end is unsatisfiable', () => {
    for (const header of ['bytes=1000-', 'bytes=5-4', 'bytes=-0']) assert.equal(parseRange(header, 1000), 'unsatisfiable', header);
  });
});

describe('--audio scope', () => {
  test('BOOK, BOOK:N and BOOK:N-M', () => {
    assert.deepEqual(parseAudioScope('ROM:1-16'), { bookId: 'ROM', chapters: Array.from({ length: 16 }, (_, i) => i + 1) });
    assert.deepEqual(parseAudioScope('rom:3'), { bookId: 'ROM', chapters: [3] });
    assert.equal(parseAudioScope('JUD').chapters.length, 1);
    assert.equal(parseAudioScope('1CO').chapters.length, 16);
  });
  test('an unknown book or chapters outside the book are refused', () => {
    assert.throws(() => parseAudioScope('XYZ:1'), /is not BOOK, BOOK:N or BOOK:N-M/);
    assert.throws(() => parseAudioScope('ROM:1-17'), /Romans has chapters 1-16/);
    assert.throws(() => parseAudioScope('ROM:5-3'), /Romans has chapters 1-16/);
  });
});

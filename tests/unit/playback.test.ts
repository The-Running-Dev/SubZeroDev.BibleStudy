import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RecordingTiming } from '../../src/shared/api.ts';
import { correctionFor, derivePosition, rangeBounds, verseAtSeconds } from '../../src/shared/playback.ts';
import { parseCommand } from '../../src/server/study/sessions.ts';

const verified: RecordingTiming = { status: 'verified', verseStarts: [0, 10, 25, 40] };
const absent: RecordingTiming = { status: 'absent', reason: 'no timing file' };
const passage = (startVerse: number | null, endVerse: number | null) => ({ bookId: 'JHN' as const, chapter: 3, startVerse, endVerse });

describe('rangeBounds', () => {
  test('a whole chapter runs from 0 to the duration', () => {
    assert.deepEqual(rangeBounds(verified, 60, passage(null, null)), { start: 0, end: 60 });
  });

  test('a verse range runs from its first verse start to the next verse after its last', () => {
    assert.deepEqual(rangeBounds(verified, 60, passage(2, 3)), { start: 10, end: 40 });
    assert.deepEqual(rangeBounds(verified, 60, passage(4, 4)), { start: 40, end: 60 }, 'the last verse ends with the recording');
  });

  test('without verified timing a range is the whole chapter', () => {
    assert.deepEqual(rangeBounds(absent, 60, passage(2, 3)), { start: 0, end: 60 });
  });

  test('bounds stay inside the recording', () => {
    assert.deepEqual(rangeBounds({ status: 'verified', verseStarts: [0, 10, 70] }, 60, passage(3, 3)), { start: 60, end: 60 });
  });
});

describe('derivePosition', () => {
  const playing = { status: 'playing' as const, positionSeconds: 10, anchorServerTimeMs: 1_000, rate: 1.5 };

  test('a playing session advances at its rate from the anchor', () => {
    assert.equal(derivePosition(playing, 5_000, 100), 16);
  });

  test('a playing session stops at the end of its range', () => {
    assert.equal(derivePosition(playing, 600_000, 30), 30);
  });

  test('a paused session stays where it is', () => {
    assert.equal(derivePosition({ ...playing, status: 'paused' }, 600_000, 30), 10);
  });
});

describe('verseAtSeconds', () => {
  test('returns the verse whose start is the last at or before the position', () => {
    assert.equal(verseAtSeconds(verified, 0), 1);
    assert.equal(verseAtSeconds(verified, 9.99), 1);
    assert.equal(verseAtSeconds(verified, 10), 2);
    assert.equal(verseAtSeconds(verified, 59), 4);
  });

  test('is null without verified timing', () => {
    assert.equal(verseAtSeconds(absent, 12), null);
  });
});

describe('correctionFor', () => {
  test('inside the 40 ms deadband nothing changes', () => {
    assert.deepEqual(correctionFor(39, 1, 12), { kind: 'none' });
    assert.deepEqual(correctionFor(-39, 1, 12), { kind: 'none' });
  });

  test('up to 1 s a client ahead slows by 5 %, one behind speeds up by 5 %', () => {
    assert.deepEqual(correctionFor(200, 1, 12), { kind: 'nudge', playbackRate: 0.95 });
    const faster = correctionFor(-200, 1.5, 12);
    assert.ok(faster.kind === 'nudge' && Math.abs(faster.playbackRate - 1.575) < 1e-9);
    assert.deepEqual(correctionFor(1000, 1, 12), { kind: 'nudge', playbackRate: 0.95 });
  });

  test('beyond 1 s the client seeks to the target', () => {
    assert.deepEqual(correctionFor(1001, 1, 12), { kind: 'seek', positionSeconds: 12 });
    assert.deepEqual(correctionFor(-5000, 1, 12), { kind: 'seek', positionSeconds: 12 });
  });
});

describe('parseCommand', () => {
  test('accepts every command kind in its contract shape', () => {
    const commands = [
      { kind: 'play' },
      { kind: 'pause' },
      { kind: 'end_session' },
      { kind: 'seek', positionSeconds: 12.5 },
      { kind: 'set_passage', passage: passage(2, 5) },
      { kind: 'set_passage', passage: passage(null, null) },
      { kind: 'set_translation', translationId: 'CSB' },
      { kind: 'set_narrator', narratorId: 'aolab-default' },
      { kind: 'set_rate', rate: 1.25 },
      { kind: 'set_manual_verse', verse: 3 },
    ];
    for (const command of commands) assert.deepEqual(parseCommand(command), command);
  });

  test('drops fields the contract does not carry', () => {
    assert.deepEqual(parseCommand({ kind: 'play', positionSeconds: 4 }), { kind: 'play' });
    assert.deepEqual(parseCommand({ kind: 'set_passage', passage: { bookId: 'JHN', chapter: 3 } }), { kind: 'set_passage', passage: passage(null, null) });
  });

  test('rejects malformed commands', () => {
    for (const bad of [
      null,
      'play',
      {},
      { kind: 'rewind' },
      { kind: 'seek', positionSeconds: Number.NaN },
      { kind: 'seek', positionSeconds: '12' },
      { kind: 'set_passage', passage: { bookId: 'JHN', chapter: 3.5 } },
      { kind: 'set_passage', passage: { bookId: 'JHN', chapter: 3, startVerse: 'one' } },
      { kind: 'set_translation', translationId: 'KJV' },
      { kind: 'set_narrator', narratorId: 7 },
      { kind: 'set_rate', rate: Number.POSITIVE_INFINITY },
      { kind: 'set_manual_verse', verse: 1.5 },
    ]) {
      assert.equal(parseCommand(bad), null, JSON.stringify(bad));
    }
  });
});

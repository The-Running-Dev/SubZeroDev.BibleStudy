import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { dispatchText } from '../../src/server/assistant/assistant.ts';
import { maxNoteBytes, maxOpsPerPush, parsePush } from '../../src/server/personal/personal.ts';
import { AppError } from '../../src/server/platform/errors.ts';

const anchor = { translationId: 'BSB', bookId: 'ROM', chapter: 4, startVerse: 3, endVerse: 3 };
const upsert = (body: unknown = 'A note.') => ({ opId: randomUUID(), entity: 'note', entityId: randomUUID(), op: 'upsert', baseRevision: null, anchor, body, deviceId: 'd' });

function refused(body: unknown, status = 400): void {
  assert.throws(
    () => parsePush(body),
    (e: unknown) => e instanceof AppError && e.status === status,
  );
}

describe('S12 push parsing', () => {
  test('notes and solo positions parse; a missing baseRevision is null', () => {
    const op = upsert();
    const position = { opId: randomUUID(), entity: 'solo_position', op: 'set', position: { translationId: 'CSB', bookId: 'ROM', chapter: 4, verse: 25 } };
    assert.deepEqual(parsePush({ ops: [op, position] }), [op, { ...position, baseRevision: null }]);
    assert.deepEqual(parsePush({ ops: [] }), []);
  });

  test('a whole-chapter note has null verses; a range keeps both ends', () => {
    const chapter = { ...upsert(), anchor: { ...anchor, startVerse: null, endVerse: null } };
    const range = { ...upsert(), anchor: { ...anchor, startVerse: 1, endVerse: 8 } };
    assert.deepEqual(parsePush({ ops: [chapter, range] }), [chapter, range]);
  });

  test('anything malformed refuses the whole push', () => {
    for (const body of [
      null,
      {},
      { ops: 'x' },
      { ops: [{ ...upsert(), opId: 'x' }] },
      { ops: [{ ...upsert(), entityId: 'x' }] },
      { ops: [{ ...upsert(), baseRevision: -1 }] },
      { ops: [{ ...upsert(), baseRevision: 1.5 }] },
      { ops: [{ ...upsert(), op: 'patch' }] },
      { ops: [{ ...upsert(), deviceId: 'd'.repeat(101) }] },
      { ops: [{ ...upsert(), deviceId: 'a\u0000b' }] },
      { ops: [{ ...upsert(), anchor: { ...anchor, translationId: 'KJV' } }] },
      { ops: [{ ...upsert(), anchor: { ...anchor, chapter: 0 } }] },
      { ops: [{ ...upsert(), anchor: { ...anchor, startVerse: 0 } }] },
      { ops: [{ ...upsert(), anchor: { ...anchor, startVerse: 5, endVerse: 4 } }] },
      { ops: [upsert(42)] },
      { ops: [upsert('a\u0000b')] },
      { ops: [{ opId: randomUUID(), entity: 'solo_position', op: 'set', position: { translationId: 'BSB', bookId: 'ROM', chapter: 4, verse: null } }] },
      { ops: [upsert(), { opId: randomUUID(), entity: 'bookmark' }] },
    ]) {
      refused(body);
    }
  });

  test('more operations than allowed, or a note over 64 KB, is too large (413)', () => {
    refused({ ops: Array.from({ length: maxOpsPerPush + 1 }, () => upsert()) }, 413);
    refused({ ops: [upsert('é'.repeat(maxNoteBytes / 2 + 1))] }, 413);
    assert.equal(parsePush({ ops: [upsert('x'.repeat(maxNoteBytes))] }).length, 1);
  });
});

describe('S12.5 notes in the assistant prompt', () => {
  test('chosen notes follow the passage and precede the question; none adds nothing', () => {
    const verses = [{ number: 3, text: 'Abraham believed God.' }];
    const without = dispatchText('Why?', 'Romans 4:3', 'BSB', verses);
    assert.doesNotMatch(without, /own notes/);
    const withNotes = dispatchText('Why?', 'Romans 4:3', 'BSB', verses, [{ id: randomUUID(), reference: 'Romans 4:3', body: 'Credited, not earned.' }]);
    assert.match(withNotes, /3 Abraham believed God\.\n\nThe reader's own notes:\n- Romans 4:3: Credited, not earned\.\n\nQuestion: Why\?/);
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { applyQuestion, mergeQuestions, pacedBy, parseVerses, reveal } from '../../src/client/questions.ts';
import type { QuestionView } from '../../src/shared/api.ts';

function question(id: string, startVerse: number | null, overrides: Partial<QuestionView> = {}): QuestionView {
  return {
    id,
    anchor: { translationId: 'BSB', bookId: 'ROM', chapter: 2, startVerse, endVerse: startVerse },
    kind: startVerse === null ? 'chapter' : 'verse',
    author: { userId: 'u1', displayName: 'Olive' },
    body: `Question ${id}`,
    removed: false,
    editedAt: null,
    createdAt: '2026-11-01T12:00:00.000Z',
    status: 'open',
    replies: [],
    revision: 1,
    version: 1,
    ...overrides,
  };
}

const romans2 = { bookId: 'ROM', chapter: 2 };

describe('reveal (S8.3)', () => {
  const questions = [question('chapter', null), question('v4', 4), question('v9', 9)];

  test('a chapter question shows from the start; a verse question once the reading reaches it', () => {
    let shown = reveal(questions, null, new Set());
    assert.deepEqual([...shown], ['chapter']);
    shown = reveal(questions, 3, shown);
    assert.deepEqual([...shown], ['chapter']);
    shown = reveal(questions, 4, shown);
    assert.deepEqual([...shown].sort(), ['chapter', 'v4']);
  });

  test('seeking back over a shown verse keeps it once, and returns the same set', () => {
    const shown = reveal(questions, 4, new Set());
    const back = reveal(questions, 2, shown);
    assert.equal(back, shown);
    assert.equal(reveal(questions, 4, back), shown);
  });

  test('seeking past several verses reveals all of them', () => {
    assert.deepEqual([...reveal(questions, 12, new Set())].sort(), ['chapter', 'v4', 'v9']);
  });
});

describe('applyQuestion', () => {
  test('adds a new question in passage order and replaces a newer revision', () => {
    let list = applyQuestion([question('v9', 9)], question('v4', 4), romans2);
    assert.deepEqual(
      list.map((q) => q.id),
      ['v4', 'v9'],
    );
    list = applyQuestion(list, question('v4', 4, { body: 'Edited', revision: 2, version: 2 }), romans2);
    assert.equal(list[0].body, 'Edited');
    assert.equal(list.length, 2);
  });

  test('an older version than the one shown is ignored, even when only a reply changed it', () => {
    const list = [question('v4', 4, { body: 'New', version: 3 })];
    assert.equal(applyQuestion(list, question('v4', 4, { body: 'Old', version: 2 }), romans2), list);
  });

  test('a fetched list keeps a newer copy that arrived first', () => {
    const newer = question('v4', 4, { body: 'Newer', version: 3 });
    const merged = mergeQuestions([newer, question('gone', 9)], [question('v4', 4, { body: 'Fetched', version: 2 }), question('v9', 9)], romans2);
    assert.deepEqual(
      merged.map((q) => [q.id, q.body]),
      [
        ['v4', 'Newer'],
        ['v9', 'Question v9'],
      ],
    );
  });

  test('a question gone, settled or on another chapter is dropped', () => {
    const list = [question('v4', 4)];
    assert.deepEqual(applyQuestion(list, question('v4', 4, { removed: true, body: null, revision: 2 }), romans2), []);
    assert.deepEqual(applyQuestion(list, question('v4', 4, { status: 'resolved', revision: 2 }), romans2), []);
    assert.deepEqual(applyQuestion([], question('other', 4), { bookId: 'ROM', chapter: 3 }), []);
  });

  test('a removed question that still has replies stays, as a placeholder', () => {
    const reply = { id: 'r1', author: { userId: 'u2', displayName: 'Mark' }, body: 'Here', removed: false, editedAt: null, createdAt: '2026-11-01T12:01:00.000Z', revision: 1 };
    const list = applyQuestion([question('v4', 4)], question('v4', 4, { removed: true, body: null, replies: [reply], revision: 2 }), romans2);
    assert.equal(list.length, 1);
    assert.equal(list[0].removed, true);
  });
});

describe('pacedBy', () => {
  const recording = (status: 'verified' | 'absent') =>
    ({ timing: status === 'verified' ? { status, verseStarts: [0, 5] } : { status, reason: 'none' } }) as never;
  test('reading together and verified timing pace; narration without verse timing does not', () => {
    assert.equal(pacedBy({ mode: 'manual', recording: null, status: 'paused' }), true);
    assert.equal(pacedBy({ mode: 'narration', recording: recording('verified'), status: 'paused' }), true);
    assert.equal(pacedBy({ mode: 'narration', recording: recording('absent'), status: 'playing' }), false);
    assert.equal(pacedBy({ mode: 'narration', recording: null, status: 'paused' }), true, 'still preparing');
  });
});

describe('parseVerses', () => {
  test('a verse, a range with either dash, or blank for the chapter', () => {
    assert.deepEqual(parseVerses('4'), { startVerse: 4, endVerse: 4 });
    assert.deepEqual(parseVerses(' 4-6 '), { startVerse: 4, endVerse: 6 });
    assert.deepEqual(parseVerses('4–6'), { startVerse: 4, endVerse: 6 });
    assert.deepEqual(parseVerses(''), { startVerse: null, endVerse: null });
  });

  test('anything else is null', () => {
    for (const text of ['0', '6-4', 'four', '4,6', '-3']) assert.equal(parseVerses(text), null, text);
  });
});

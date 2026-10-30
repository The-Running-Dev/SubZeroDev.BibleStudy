import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AoChapter } from '../../src/server/content/aolab.ts';
import { contentHash, normalizeChapter, serializeContent, verseText } from '../../src/server/content/normalize.ts';
import { adjacentChapter, books } from '../../src/shared/books.ts';
import { formatReference, parseReference } from '../../src/shared/reference.ts';

describe('S2.3 parseReference', () => {
  const cases: [string, ReturnType<typeof parseReference>][] = [
    ['Romans 3:12', { bookId: 'ROM', chapter: 3, startVerse: 12, endVerse: 12 }],
    ['rom 3', { bookId: 'ROM', chapter: 3, startVerse: null, endVerse: null }],
    ['Romans 3:12-15', { bookId: 'ROM', chapter: 3, startVerse: 12, endVerse: 15 }],
    ['Romans 17', null],
    ['1 Cor 13:4', { bookId: '1CO', chapter: 13, startVerse: 4, endVerse: 4 }],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)}`, () => assert.deepEqual(parseReference(input), expected));
  }

  test('accepts spacing, en dashes, periods and unambiguous prefixes', () => {
    assert.deepEqual(parseReference('  Rom.  3 : 12 – 15 '), { bookId: 'ROM', chapter: 3, startVerse: 12, endVerse: 15 });
    assert.deepEqual(parseReference('1cor 13'), { bookId: '1CO', chapter: 13, startVerse: null, endVerse: null });
    assert.deepEqual(parseReference('psalm 23'), { bookId: 'PSA', chapter: 23, startVerse: null, endVerse: null });
    assert.deepEqual(parseReference('Philem 1'), { bookId: 'PHM', chapter: 1, startVerse: null, endVerse: null });
  });

  test('rejects unknown books, ambiguous prefixes, chapter 0 and backward ranges', () => {
    for (const input of ['', 'Romans', 'Hezekiah 1', 'J 1', 'Romans 0', 'Romans 3:15-12', 'Romans 3:0']) {
      assert.equal(parseReference(input), null, input);
    }
  });

  test('every book resolves from its id and its name', () => {
    for (const book of books) {
      assert.equal(parseReference(`${book.id} 1`)?.bookId, book.id, book.id);
      assert.equal(parseReference(`${book.name} ${book.chapters}`)?.bookId, book.id, book.name);
      assert.equal(parseReference(`${book.name} ${book.chapters + 1}`), null, `${book.name} past its last chapter`);
    }
  });

  test('formatReference round-trips', () => {
    assert.equal(formatReference({ bookId: 'ROM', chapter: 3, startVerse: null, endVerse: null }), 'Romans 3');
    assert.equal(formatReference({ bookId: 'ROM', chapter: 3, startVerse: 12, endVerse: 12 }), 'Romans 3:12');
    assert.equal(formatReference({ bookId: '1CO', chapter: 13, startVerse: 4, endVerse: 7 }), '1 Corinthians 13:4–7');
  });
});

describe('books and adjacentChapter', () => {
  test('the canon has 66 books and 1,189 chapters', () => {
    assert.equal(books.length, 66);
    assert.equal(books.reduce((sum, b) => sum + b.chapters, 0), 1189);
  });

  test('moves within a book, across books, and stops at the ends', () => {
    assert.deepEqual(adjacentChapter({ bookId: 'ROM', chapter: 1 }, 1), { bookId: 'ROM', chapter: 2 });
    assert.deepEqual(adjacentChapter({ bookId: 'ROM', chapter: 16 }, 1), { bookId: '1CO', chapter: 1 });
    assert.deepEqual(adjacentChapter({ bookId: '1CO', chapter: 1 }, -1), { bookId: 'ROM', chapter: 16 });
    assert.equal(adjacentChapter({ bookId: 'GEN', chapter: 1 }, -1), null);
    assert.equal(adjacentChapter({ bookId: 'REV', chapter: 22 }, 1), null);
  });
});

function chapter(content: AoChapter['chapter']['content'], footnotes: AoChapter['chapter']['footnotes'] = []): AoChapter {
  return {
    translation: { id: 'BSB', name: 'Berean Standard Bible', sha256: 'x', numberOfBooks: 66, totalNumberOfChapters: 1189 },
    book: { id: 'PSA', name: 'Psalms', order: 19, numberOfChapters: 150, sha256: 'y' },
    numberOfVerses: content.filter((c) => c.type === 'verse').length,
    thisChapterLink: '/api/BSB/PSA/3.json',
    chapter: { number: 3, content, footnotes },
  };
}

describe('normalizing AO Lab chapters', () => {
  test('prose segments run together; footnote markers carry no text', () => {
    assert.equal(verseText(['Paul, a servant', { noteId: 1 }, ' of  Christ Jesus,', 'called to be an apostle']), 'Paul, a servant of Christ Jesus, called to be an apostle');
  });

  test('poetry keeps one line per poem segment, and text after a poem line starts a new line', () => {
    assert.equal(
      verseText([{ text: 'Many say of me,', poem: 1 }, { text: '“God will not deliver him.”', poem: 2 }, 'Selah', { noteId: 5 }]),
      'Many say of me,\n“God will not deliver him.”\nSelah',
    );
  });

  test('headings and Hebrew subtitles attach to the following verse; chapter-level footnotes are dropped', () => {
    const content = normalizeChapter(
      chapter(
        [
          { type: 'heading', content: ['Deliver Me, O LORD!'] },
          { type: 'hebrew_subtitle', content: ['A Psalm of David, when he fled from his son Absalom.'] },
          { type: 'line_break' },
          { type: 'verse', number: 1, content: [{ text: 'O LORD, how my foes have increased!', poem: 1 }] },
          { type: 'verse', number: 2, content: ['Selah', { noteId: 5 }] },
        ],
        [
          { noteId: 5, text: ' Selah  is probably a musical term. ', reference: { chapter: 3, verse: 2 } },
          { noteId: 6, text: 'A note on the chapter.', reference: { chapter: 3 } },
        ],
      ),
    );
    assert.deepEqual(content, {
      verses: [
        { number: 1, text: 'O LORD, how my foes have increased!' },
        { number: 2, text: 'Selah' },
      ],
      headings: [
        { beforeVerse: 1, text: 'Deliver Me, O LORD!' },
        { beforeVerse: 1, text: 'A Psalm of David, when he fled from his son Absalom.' },
      ],
      footnotes: [{ verse: 2, text: 'Selah is probably a musical term.' }],
    });
  });

  test('serialization is canonical, so the hash depends only on the content', () => {
    const a = serializeContent({ verses: [{ number: 1, text: 'a' }], headings: [], footnotes: [] });
    const b = serializeContent({ footnotes: [], headings: [], verses: [{ text: 'a', number: 1 }] } as never);
    assert.equal(a, b);
    assert.equal(a, '{"verses":[{"number":1,"text":"a"}],"headings":[],"footnotes":[]}');
    assert.match(contentHash(a), /^[0-9a-f]{64}$/);
  });
});

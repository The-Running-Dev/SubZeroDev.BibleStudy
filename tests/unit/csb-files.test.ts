import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createCsbFileSource, parseCsbBook } from '../../src/server/content/csb-files.ts';

// Synthetic markup in the shape of the owner's CSB files. No CSB text is kept in this repository.
const xml = `<?xml version="1.0" encoding="utf-8"?>
<book id="bk.45">
<bookname>Fixture Book</bookname>
<chapter id="romans.1" display="1">
<head1>First Fixture Heading</head1>
<p type="noind"><verse reference="romans.1.1" display-number="1"><sup class="verse-ref" id="romans.1.1">1</sup>Verse one names the <span class="smallcaps">Lord</span>&#8201;&#8212;&#8201;and <smallcaps>God</smallcaps><sup class="cross-ref"><a href="#" data-content="Gn 1:1">a</a></sup> plainly.</verse>
<verse reference="romans.1.2" display-number="2"><sup class="verse-ref">2</sup>Verse two begins here</verse></p>
<head2>Second Fixture Heading<sup class="cross-ref"><a data-content="Ps 1:1">b</a></sup></head2>
<p><verse reference="romans.1.2" display-number="2">and ends after the heading.<sup class="translate-note"><a data-content="Or &#8216;fixture&#8217;&#8203;">c</a></sup></verse></p>
<poetryblock><verse reference="romans.1.3" display-number="3"><poem><sup class="verse-ref">3</sup>A first line,</poem>
<poem>a second line.<poemright><em>Selah</em></poemright></poem></verse></poetryblock>
<p><verse reference="romans.1.4" display-number="4"><sup class="verse-ref">4</sup>It measured 22 <sup>1</sup>/<sub>2</sub> fixtures.<note level="1"><notereference>d</notereference>A synthetic note.</note></verse></p>
</chapter>
<chapter id="romans.2" display="2">
<psalm>Fixture 2</psalm>
<p><verse id="romans.2.1" display="1"><sup class="verse-ref">1</sup>Chapter two, verse one.</verse>
<verse refernce="romans.2.2" display-number="2"><sup class="verse-ref">2</sup>Verse two, misspelt.</verse></p>
<listtable>
<row><cell><verse reference="romans.2.3" display-number="3"/><sup class="verse-ref" id="romans.2.3">3</sup>the first row</cell><cell type="right">one</cell></row>
<row><cell>the second row</cell><cell type="right">one</cell></row>
<row><cell><verse reference="romans.2.4" display-number="4"/><sup class="verse-ref" id="romans.2.4">4</sup>the last row</cell><cell type="right">one</cell></row>
</listtable>
<p>Text after the table is no verse's.</p>
</chapter>
<chapter id="romans.3" display="3">
<p><verse reference="romans.3.1" display-number="1"><sup class="verse-ref" id="romans.3.1">1</sup>One, then two arrives early. <sup class="verse-ref" id="romans.3.2">2</sup>Two is inside one.</verse>
<verse reference="romans.3.3" display-number="3"><sup class="verse-ref" id="romans.3.3">3</sup>Three quotes <otquote>an old line</otquote>, then
, pauses . . . and ends
 > here.</verse>
<verse reference="romans.3.3" display-number="3"><sup class="verse-ref" id="romans.3.4">4</sup>Four carries a stale reference</verse></p>
<p><verse reference="romans.3.3" display-number="3">and continues with it.</verse>
<verse reference="romans.3.5" display-number="5"><sup class="verse-ref" id="romans.3.5">5</sup>Five is itself.</verse></p>
</chapter>
</book>`;

describe('CSB files', () => {
  test('a book parses into verses, headings and footnotes', () => {
    const book = parseCsbBook(xml);
    assert.equal(book.order, 45);
    assert.equal(book.name, 'Fixture Book');
    assert.deepEqual(
      book.chapters.map((c) => c.chapter),
      [1, 2, 3],
    );
    assert.deepEqual(book.chapters[0].content, {
      verses: [
        { number: 1, text: 'Verse one names the LORD—and GOD plainly.' },
        { number: 2, text: 'Verse two begins here and ends after the heading.' },
        { number: 3, text: 'A first line,\na second line.\nSelah' },
        { number: 4, text: 'It measured 22 1/2 fixtures.' },
      ],
      headings: [
        { beforeVerse: 1, text: 'First Fixture Heading' },
        { beforeVerse: 3, text: 'Second Fixture Heading' },
      ],
      footnotes: [
        { verse: 2, text: 'Or ‘fixture’' },
        { verse: 4, text: 'A synthetic note.' },
      ],
    });
  });

  test('a misspelt reference is read, a table verse runs from its marker, and the chapter label is not text', () => {
    const [, two] = parseCsbBook(xml).chapters;
    assert.deepEqual(two.content, {
      verses: [
        { number: 1, text: 'Chapter two, verse one.' },
        { number: 2, text: 'Verse two, misspelt.' },
        { number: 3, text: 'the first row one\nthe second row one' },
        { number: 4, text: 'the last row one' },
      ],
      headings: [],
      footnotes: [],
    });
  });

  test("a verse's number marker outranks its element's reference, and stray spacing is tidied", () => {
    const three = parseCsbBook(xml).chapters[2];
    assert.deepEqual(three.content.verses, [
      { number: 1, text: 'One, then two arrives early.' },
      { number: 2, text: 'Two is inside one.' },
      { number: 3, text: 'Three quotes an old line, then, pauses . . . and ends here.' },
      { number: 4, text: 'Four carries a stale reference and continues with it.' },
      { number: 5, text: 'Five is itself.' },
    ]);
  });

  test('malformed markup is refused', () => {
    assert.throws(() => parseCsbBook('<book id="bk.1"><chapter id="x.1" display="1"><p></chapter></book>'), /closes <p>/);
    assert.throws(() => parseCsbBook('<book id="bk.1"><chapter id="x.1" display="1">'), /never closed/);
    assert.throws(() => parseCsbBook('<book><chapter id="x.1" display="1"></chapter></book>'), /bk\.NN/);
  });

  test('a folder of NN-Book.xml files is a text source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'csb-'));
    try {
      await writeFile(join(dir, '45-Rom.xml'), xml);
      const source = createCsbFileSource(dir);
      const catalog = await source.catalog();
      assert.deepEqual(
        catalog.books.map((b) => [b.id, b.order, b.numberOfChapters]),
        [['ROM', 45, 16]],
      );
      const chapter = await source.chapter('ROM', 2);
      assert.equal(chapter.sourceRef, 'csb-file:45-Rom.xml#romans.2');
      await assert.rejects(source.chapter('ROM', 4), /has no chapter 4/);

      await writeFile(join(dir, '46-1Cor.xml'), xml);
      const mislabeled = createCsbFileSource(dir);
      await mislabeled.catalog();
      await assert.rejects(mislabeled.chapter('1CO', 1), /says it is book 45, not 46/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createEsvFileSource, parseEsvChapter } from '../../src/server/content/esv-files.ts';
import { esvChapter, writeEsvFixture } from '../support/esv-fixture.ts';

test('ESV preserves verse gaps, poetry, headings and both kinds of annotation', () => {
  assert.deepEqual(parseEsvChapter(esvChapter(), 57, 1), {
    verses: [{ number: 1, text: 'First fixture line.\nSecond fixture line.' }, { number: 3, text: 'Final fixture verse.' }],
    headings: [{ beforeVerse: 1, text: 'Fixture heading' }],
    footnotes: [
      { verse: 1, text: 'Alternative reading' }, { verse: 1, text: 'Cross-reference: Fixture 2:1' }, { verse: 1, text: 'Heading note' },
    ],
  });
});

test('ESV refuses mismatched identities, counts, broken verse order, empty text and invalid annotations', () => {
  const mutations = [
    (d: ReturnType<typeof esvChapter>) => { d.SchemaVersion = 2; },
    (d: ReturnType<typeof esvChapter>) => { d.Translation = 'CSB'; },
    (d: ReturnType<typeof esvChapter>) => { d.BookNumber = 56; },
    (d: ReturnType<typeof esvChapter>) => { d.Chapter = 2; },
    (d: ReturnType<typeof esvChapter>) => { d.VerseCount = 3; },
    (d: ReturnType<typeof esvChapter>) => { d.Verses[1].Number = 1; },
    (d: ReturnType<typeof esvChapter>) => { d.Verses[0].Text = '\u0000'; },
    (d: ReturnType<typeof esvChapter>) => { d.Headings[0].BeforeVerse = 2; },
    (d: ReturnType<typeof esvChapter>) => { d.Verses[0].Footnotes[0].Text = ''; },
  ];
  for (const mutate of mutations) {
    const data = esvChapter();
    mutate(data);
    assert.throws(() => parseEsvChapter(data, 57, 1));
  }
});

test('ESV file source records stable hashes, detects changes and names corrupt files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'esv-source-'));
  try {
    const file = await writeEsvFixture(dir);
    const source = createEsvFileSource(dir);
    const catalog = await source.catalog();
    assert.deepEqual(catalog.books.map((b) => [b.id, b.name, b.numberOfChapters]), [['PHM', 'Philemon', 1]]);
    assert.equal((await source.chapter('PHM', 1)).sourceRef, 'esv-file:57-Philemon/001.json');
    assert.deepEqual(await source.catalog(), catalog);
    const changed = esvChapter();
    changed.Verses[0].Text = 'Changed fixture text.';
    await writeFile(file, JSON.stringify(changed));
    assert.notEqual((await source.catalog()).sha256, catalog.sha256);
    await writeFile(file, '{broken');
    await assert.rejects(source.chapter('PHM', 1), /57-Philemon\/001.json/);
    await mkdir(join(dir, '57-Duplicate'));
    await assert.rejects(source.catalog(), /duplicate|expected exactly/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ESV refuses empty sources and incomplete books before importing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'esv-incomplete-'));
  try {
    await assert.rejects(createEsvFileSource(dir).catalog(), /no NN-Book/);
    await mkdir(join(dir, '40-Matthew'));
    await writeFile(join(dir, '40-Matthew', '001.json'), JSON.stringify(esvChapter()));
    await assert.rejects(createEsvFileSource(dir).catalog(), /expected exactly 28/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

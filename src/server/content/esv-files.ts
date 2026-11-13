import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChapterContent } from '../../shared/api.ts';
import { books as canon } from '../../shared/books.ts';
import type { TextBook, TextSource } from './import.ts';

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
  return value as Record<string, unknown>;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error('expected an array');
  return value;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.includes('\u0000')) throw new Error('expected nonempty text without NUL');
  return value;
};
const positive = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('expected a positive integer');
  return value;
};

// Download-CSBBible and Download-ESVBible keep different formats. This adapter consumes only the ESV
// downloader's JSON; it neither fetches ESV.org nor needs the accompanying raw HTML files at runtime.
export function parseEsvChapter(value: unknown, bookNumber: number, chapterNumber: number): ChapterContent {
  const data = object(value);
  if (data.SchemaVersion !== 1 || data.Translation !== 'ESV') throw new Error('expected ESV chapter schema version 1');
  if (data.BookNumber !== bookNumber || data.Chapter !== chapterNumber) throw new Error(`chapter metadata does not match book ${bookNumber}, chapter ${chapterNumber}`);
  const footnotes: ChapterContent['footnotes'] = [];
  const notes = (owner: Record<string, unknown>, verse: number) => {
    for (const note of array(owner.Footnotes)) footnotes.push({ verse, text: text(object(note).Text) });
    for (const ref of array(owner.CrossReferences)) footnotes.push({ verse, text: `Cross-reference: ${text(object(ref).Text)}` });
  };
  let previous = 0;
  const verses = array(data.Verses).map((value) => {
    const verse = object(value);
    const number = positive(verse.Number);
    if (number <= previous) throw new Error('verse numbers must be unique and increasing');
    // ESV intentionally omits some traditional verse numbers. Keep those gaps and the original text.
    previous = number;
    notes(verse, number);
    return { number, text: text(verse.Text) };
  });
  if (!verses.length || data.VerseCount !== verses.length) throw new Error('VerseCount does not match the nonempty verses array');
  const headings = array(data.Headings).map((value) => {
    const heading = object(value);
    const beforeVerse = positive(heading.BeforeVerse);
    if (!verses.some((v) => v.number === beforeVerse)) throw new Error(`heading refers to missing verse ${beforeVerse}`);
    notes(heading, beforeVerse);
    return { beforeVerse, text: text(heading.Text) };
  });
  return { verses, headings, footnotes };
}

export function createEsvFileSource(dir: string): TextSource {
  const files = new Map<string, { path: string; name: string; bookNumber: number; chapter: number }>();
  return {
    translationId: 'ESV',
    kind: 'files',
    async catalog() {
      files.clear();
      const listed: TextBook[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const match = /^(\d{2})-.+$/.exec(entry.name);
        if (!entry.isDirectory() || !match) continue;
        const order = Number(match[1]);
        const book = canon[order - 1];
        if (!book) throw new Error(`${entry.name}: invalid canon book number`);
        if (listed.some((b) => b.id === book.id)) throw new Error(`${entry.name}: duplicate book ${book.id}`);
        const folder = join(dir, entry.name);
        const names = (await readdir(folder)).filter((name) => name.endsWith('.json')).sort();
        const expected = Array.from({ length: book.chapters }, (_, i) => `${String(i + 1).padStart(3, '0')}.json`);
        if (names.join(',') !== expected.join(',')) throw new Error(`${entry.name}: expected exactly ${book.chapters} numbered chapter JSON files`);
        const hashes: string[] = [];
        for (const [index, name] of names.entries()) {
          const path = join(folder, name);
          const chapter = index + 1;
          hashes.push(`${name}:${sha256(await readFile(path))}`);
          files.set(`${book.id}.${chapter}`, { path, name: `${entry.name}/${name}`, bookNumber: order, chapter });
        }
        listed.push({ id: book.id, name: book.name, order, numberOfChapters: book.chapters, sha256: sha256(hashes.join('\n')) });
      }
      if (!listed.length) throw new Error(`${dir}: no NN-Book chapter folders found`);
      listed.sort((a, b) => a.order - b.order);
      return { sha256: sha256(listed.map((b) => `${b.id}:${b.sha256}`).join('\n')), books: listed };
    },
    async chapter(bookId, chapter) {
      const file = files.get(`${bookId}.${chapter}`);
      if (!file) throw new Error(`${bookId} ${chapter}: no chapter file (call catalog first)`);
      try {
        return {
          content: parseEsvChapter(JSON.parse(await readFile(file.path, 'utf8')), file.bookNumber, file.chapter),
          sourceRef: `esv-file:${file.name}`,
        };
      } catch (error) {
        throw new Error(`${file.name}: ${(error as Error).message}`, { cause: error });
      }
    },
  };
}

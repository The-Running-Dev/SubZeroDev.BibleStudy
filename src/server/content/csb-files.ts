// CSB text from the owner's own XML files, one per book (01-Gen.xml … 66-Rev.xml), imported once and kept.
// The files never enter the repository or the image: the owner copies them to the host and imports them from there.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChapterContent } from '../../shared/api.ts';
import { books as canon } from '../../shared/books.ts';
import type { TextBook, TextSource } from './import.ts';

interface Tag {
  name: string;
  attrs: Record<string, string>;
}

type Token = { kind: 'open'; tag: Tag; selfClosing: boolean } | { kind: 'close'; name: string } | { kind: 'text'; text: string };

const tokenPattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([A-Za-z][\w:.-]*)\s*>|<([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|[^<]+|</g;
const attrPattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    if (entity[0] === '#') return String.fromCodePoint(entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity]!;
  });
}

function* tokens(xml: string): Generator<Token> {
  for (const match of xml.matchAll(tokenPattern)) {
    const [raw, closeName, openName, attrText, selfClosing] = match;
    if (raw.startsWith('<!--') || raw.startsWith('<?') || raw.startsWith('<!')) continue;
    if (closeName) yield { kind: 'close', name: closeName };
    else if (openName) {
      const attrs: Record<string, string> = {};
      for (const a of attrText.matchAll(attrPattern)) attrs[a[1]] = decode(a[2] ?? a[3]);
      yield { kind: 'open', tag: { name: openName, attrs }, selfClosing: selfClosing === '/' };
    } else if (raw === '<') throw new Error(`malformed markup at offset ${match.index}`);
    else yield { kind: 'text', text: decode(raw) };
  }
}

// Headings attach to the verse that follows them. `psalm` is the chapter's own label ("Psalm 3").
const headingTags = new Set(['head1', 'head2', 'head3', 'supertitle', 'speaker', 'heb']);
const skippedTags = new Set(['bookname', 'psalm', 'notereference']);
// Each of these starts a line of its own. Inline elements join their text to what is around it; the boundary of
// any other element inside a verse is a space.
const lineTags = new Set(['poem', 'poemright', 'item', 'row']);
const inlineTags = new Set(['span', 'em', 'i', 'smallcaps', 'sub', 'sup', 'a', 'note', 'notereference', 'redletter-start', 'redletter-end', 'hr', 'otquote']);
const boundary = (name: string) => (lineTags.has(name) ? '\n' : inlineTags.has(name) ? '' : ' ');
// Superscripts holding a translator's note; cross references and quotation sources are left out.
const noteClass = /\b(translate-note|alt-reading-note|alt-reading|clarifying-note|help-note)\b/;

// The files' line breaks put a space before some punctuation, and leave a stray '>' in a few verses. An ellipsis
// (". . .") keeps its spaces.
function tidy(text: string): string {
  return text
    .replace(/\s>(?=\s|$)/g, ' ')
    .replace(/(?<!\.)[^\S\n]+([,;:!?]|\.(?!\s?\.))/g, '$1')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

// Thin and zero-width spaces only set off dashes and quotation marks in print.
const typographic = /[\u2009\u200A\u200B\u2060\uFEFF]/g;

export interface ParsedChapter {
  chapter: number;
  content: ChapterContent;
  chapterId: string;
}

export interface ParsedBook {
  order: number;
  name: string;
  chapters: ParsedChapter[];
}

// Verse text is everything inside a <verse> but its superscripts and notes; a verse split across paragraphs
// is one verse. Small capitals (LORD) are written as capitals, as the BSB text has them.
export function parseCsbBook(xml: string): ParsedBook {
  let order = 0;
  let name = '';
  const chapters: ParsedChapter[] = [];
  let chapter: { number: number; id: string; texts: Map<number, string>; headings: ChapterContent['headings']; footnotes: ChapterContent['footnotes'] } | null = null;
  let verse: number | null = null;
  // A <verse> element whose reference was copied from an earlier verse: its number marker names the real one, and
  // the elements continuing it carry the same stale reference.
  let stale = null as { reference: number; verse: number } | null;
  // In a table a verse is an empty <verse/> marking where it starts; it runs to the next verse or the table's end.
  let milestoneDepth: number | null = null;
  let pending: string[] = [];
  let heading: string | null = null;
  let note: string | null = null;
  let bookName: string | null = null;
  // Depths of the open elements whose text is not verse text, and of small capitals.
  const stack: { name: string; skip: boolean; caps: boolean; noteSup: boolean }[] = [];
  const skipping = () => stack.some((s) => s.skip);
  const caps = () => stack.some((s) => s.caps);

  const append = (piece: string) => {
    if (verse === null || !chapter) return;
    const before = chapter.texts.get(verse);
    chapter.texts.set(verse, before === undefined ? piece : before + piece);
  };
  // Headings attach to a verse when it first appears; a verse that appears again continues.
  const enterVerse = (number: number) => {
    if (!chapter) return;
    verse = number;
    if (chapter.texts.has(number)) return append(' ');
    for (const text of pending) chapter.headings.push({ beforeVerse: number, text });
    pending = [];
    chapter.texts.set(number, '');
  };
  const finishChapter = () => {
    if (!chapter) return;
    const verses = [...chapter.texts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([number, text]) => ({ number, text: tidy(text) }))
      .filter((v) => v.text.length > 0);
    chapters.push({ chapter: chapter.number, chapterId: chapter.id, content: { verses, headings: chapter.headings, footnotes: chapter.footnotes } });
    chapter = null;
  };

  for (const token of tokens(xml)) {
    if (token.kind === 'text') {
      if (bookName !== null) bookName += token.text;
      if (skipping()) continue;
      const text = (caps() ? token.text.toUpperCase() : token.text).replace(typographic, '').replace(/\s+/g, ' ');
      if (note !== null) note += text;
      else if (heading !== null) heading += text;
      else append(text);
      continue;
    }
    if (token.kind === 'close') {
      const open = stack.pop();
      if (!open || open.name !== token.name) throw new Error(`</${token.name}> closes ${open ? `<${open.name}>` : 'nothing'}`);
      if (open.name === 'bookname') {
        name = tidy(bookName ?? '');
        bookName = null;
      } else if (headingTags.has(open.name) && heading !== null) {
        const text = tidy(heading);
        if (text) pending.push(text);
        heading = null;
      } else if (open.name === 'note' && note !== null) {
        if (verse !== null && chapter && tidy(note)) chapter.footnotes.push({ verse, text: tidy(note) });
        note = null;
      } else if (open.name === 'verse') verse = null;
      if (milestoneDepth !== null && stack.length <= milestoneDepth) {
        verse = null;
        milestoneDepth = null;
      }
      else if (open.name === 'chapter') finishChapter();
      append(boundary(open.name));
      continue;
    }

    const { tag, selfClosing } = token;
    const parentNoteSup = stack.at(-1)?.noteSup ?? false;
    if (tag.name === 'book') {
      const match = /^bk\.(\d+)$/.exec(tag.attrs.id ?? '');
      if (!match) throw new Error('the <book> element has no bk.NN id');
      order = Number(match[1]);
    } else if (tag.name === 'chapter') {
      finishChapter();
      const number = Number(tag.attrs.display);
      if (!Number.isInteger(number) || number < 1) throw new Error(`chapter ${tag.attrs.id ?? '?'} has no display number`);
      chapter = { number, id: tag.attrs.id ?? String(number), texts: new Map(), headings: [], footnotes: [] };
      pending = [];
    } else if (tag.name === 'verse') {
      // A few verses in the files name their reference in an id, or in a misspelt attribute.
      const reference = tag.attrs.reference ?? tag.attrs.id ?? Object.entries(tag.attrs).find(([key]) => /^ref/.test(key))?.[1] ?? '';
      const match = /\.(\d+)$/.exec(reference);
      if (!match || !chapter) throw new Error(`verse ${reference || '?'} is outside a chapter or unnumbered`);
      const number = Number(match[1]);
      if (stale && stale.reference !== number) stale = null;
      enterVerse(stale ? stale.verse : number);
      const table = stack.findLastIndex((s) => s.name === 'listtable');
      milestoneDepth = selfClosing ? (table >= 0 ? table : stack.length - 1) : null;
    } else if (tag.name === 'sup' && /\bverse-ref\b/.test(tag.attrs.class ?? '') && verse !== null) {
      const marker = /\.(\d+)$/.exec(tag.attrs.id ?? '');
      if (marker && Number(marker[1]) !== verse) {
        stale = { reference: stale?.reference ?? verse, verse: Number(marker[1]) };
        enterVerse(stale.verse);
      }
    } else if (tag.name === 'bookname') bookName = '';
    else if (headingTags.has(tag.name)) heading = '';
    else if (tag.name === 'note') note = '';
    else if (parentNoteSup && tag.name === 'a' && tag.attrs['data-content'] && verse !== null && chapter) {
      const text = tidy(tag.attrs['data-content'].replace(typographic, ''));
      if (text) chapter.footnotes.push({ verse, text });
    }
    if (selfClosing) continue;
    // A superscript without a class is a fraction's numerator (22 <sup>1</sup>/<sub>2</sub>), set off by a thin space.
    const numerator = tag.name === 'sup' && !tag.attrs.class;
    append(numerator ? ' ' : boundary(tag.name));
    stack.push({
      name: tag.name,
      skip: (tag.name === 'sup' && !numerator) || skippedTags.has(tag.name),
      caps: tag.name === 'smallcaps' || (tag.name === 'span' && /\bsmallcaps\b/.test(tag.attrs.class ?? '')),
      noteSup: tag.name === 'sup' && noteClass.test(tag.attrs.class ?? ''),
    });
  }
  if (stack.length) throw new Error(`<${stack.at(-1)!.name}> is never closed`);
  if (!order) throw new Error('no <book> element');
  return { order, name, chapters };
}

export interface CsbFile {
  path: string;
  name: string;
}

// Files are matched to books by their NN- prefix, the canon order the shared catalog uses.
export async function listCsbFiles(dir: string): Promise<Map<string, CsbFile>> {
  const found = new Map<string, CsbFile>();
  for (const entry of await readdir(dir)) {
    const match = /^(\d{2})-.*\.xml$/i.exec(entry);
    if (!match) continue;
    const book = canon[Number(match[1]) - 1];
    if (!book) throw new Error(`${entry}: no book ${match[1]} in the 66-book canon`);
    if (found.has(book.id)) throw new Error(`${entry} and ${found.get(book.id)!.name} are both book ${match[1]}`);
    found.set(book.id, { path: join(dir, entry), name: entry });
  }
  if (found.size === 0) throw new Error(`${dir} holds no NN-Book.xml files`);
  return found;
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

// A TextSource over a folder of CSB books. Each file is read and parsed once, when its first chapter is asked for.
export function createCsbFileSource(dir: string): TextSource {
  let files: Map<string, CsbFile> | null = null;
  const parsed = new Map<string, Promise<{ book: ParsedBook; file: CsbFile }>>();

  const load = async (bookId: string) => {
    const file = files?.get(bookId);
    if (!file) throw new Error(`${bookId}: no file`);
    const book = parseCsbBook(await readFile(file.path, 'utf8'));
    const expected = canon.findIndex((b) => b.id === bookId) + 1;
    if (book.order !== expected) throw new Error(`${file.name} says it is book ${book.order}, not ${expected}`);
    return { book, file };
  };

  return {
    translationId: 'CSB',
    kind: 'files',
    async catalog() {
      files = await listCsbFiles(dir);
      const listed: TextBook[] = [];
      for (const [id, file] of files) {
        const info = canon.find((b) => b.id === id)!;
        listed.push({ id, name: info.name, order: canon.indexOf(info) + 1, numberOfChapters: info.chapters, sha256: sha256(await readFile(file.path)) });
      }
      listed.sort((a, b) => a.order - b.order);
      return { sha256: sha256(listed.map((b) => `${b.id}:${b.sha256}`).join('\n')), books: listed };
    },
    async chapter(bookId, number) {
      if (!parsed.has(bookId)) parsed.set(bookId, load(bookId));
      const { book, file } = await parsed.get(bookId)!;
      const found = book.chapters.find((c) => c.chapter === number);
      if (!found) throw new Error(`${file.name} has no chapter ${number}`);
      if (found.content.verses.length === 0) throw new Error(`${file.name} chapter ${number} has no verses`);
      return { content: found.content, sourceRef: `csb-file:${file.name}#${found.chapterId}` };
    },
  };
}

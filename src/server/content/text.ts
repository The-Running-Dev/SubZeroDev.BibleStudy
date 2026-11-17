import type { ChapterContent } from '../../shared/api.ts';
import { books as canon } from '../../shared/books.ts';

// A chapter as an import source reads it: what the verses, headings and notes tables store. The served copy
// (ChapterContent) is derived from it, so both always say the same thing.
export interface ChapterText {
  verses: { number: number; text: string }[];
  headings: { beforeVerse: number; level: number | null; text: string }[];
  notes: { verse: number; kind: 'footnote' | 'crossref'; text: string; passage: string | null }[];
}

// The served chapter shows cross references among its notes, as "Cross-reference: …".
export function servedContent(text: ChapterText): ChapterContent {
  return {
    verses: text.verses.map((v) => ({ number: v.number, text: v.text })),
    headings: text.headings.map((h) => ({ beforeVerse: h.beforeVerse, text: h.text })),
    footnotes: text.notes.map((n) => ({ verse: n.verse, text: n.kind === 'crossref' ? `Cross-reference: ${n.text}` : n.text })),
  };
}

// A source with no heading levels or cross references (BSB from AO Lab).
export function plainText(content: ChapterContent): ChapterText {
  return {
    verses: content.verses,
    headings: content.headings.map((h) => ({ beforeVerse: h.beforeVerse, level: null, text: h.text })),
    notes: content.footnotes.map((f) => ({ verse: f.verse, kind: 'footnote', text: f.text, passage: null })),
  };
}

// Book, chapter and verse as one number, BBCCCVVV: Romans 3:23 is 45003023.
export function verseRef(bookId: string, chapter: number, verse: number): number {
  const number = canon.findIndex((b) => b.id === bookId) + 1;
  if (number < 1) throw new Error(`${bookId} is not a canon book`);
  return number * 1_000_000 + chapter * 1_000 + verse;
}

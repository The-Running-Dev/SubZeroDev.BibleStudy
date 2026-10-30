import type { PassageRef } from './api.ts';
import { books } from './books.ts';

function normalize(text: string): string {
  return text.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

const exact = new Map<string, string>();
for (const book of books) {
  for (const key of [book.id, book.name, ...book.aliases]) {
    exact.set(normalize(key), book.id);
    exact.set(normalize(key).replace(/ /g, ''), book.id);
  }
}

function resolveBook(text: string): string | null {
  const key = normalize(text);
  const hit = exact.get(key) ?? exact.get(key.replace(/ /g, ''));
  if (hit) return hit;
  // An unambiguous prefix of a full name, e.g. "roma" or "1 corin".
  if (key.length < 3) return null;
  const matches = books.filter((book) => normalize(book.name).startsWith(key));
  return matches.length === 1 ? matches[0].id : null;
}

const pattern = /^(.*?[a-z].*?)\s*(\d+)(?:\s*:\s*(\d+)(?:\s*[-–]\s*(\d+))?)?$/;

// No chapter has more verses than Psalm 119.
export const maxVerse = 176;

// Parses "Romans 3:12", "rom 3", "Romans 3:12-15" or "1 Cor 13:4". In a one-chapter book a lone number
// past 1 is a verse: "Jude 5" is Jude 1:5. Null when the book is unknown, the chapter is outside the
// book, a verse is past any chapter's end, or a range runs backwards.
export function parseReference(input: string): PassageRef | null {
  const match = pattern.exec(normalize(input));
  if (!match) return null;
  const bookId = resolveBook(match[1]);
  if (!bookId) return null;
  const book = books.find((b) => b.id === bookId)!;
  let [chapterText, startText] = [match[2], match[3]];
  const endText = match[4];
  if (book.chapters === 1 && startText === undefined && Number(chapterText) > 1) [chapterText, startText] = ['1', chapterText];
  const chapter = Number(chapterText);
  if (chapter < 1 || chapter > book.chapters) return null;
  if (startText === undefined) return { bookId, chapter, startVerse: null, endVerse: null };
  const startVerse = Number(startText);
  const endVerse = endText === undefined ? startVerse : Number(endText);
  if (startVerse < 1 || endVerse < startVerse || endVerse > maxVerse) return null;
  return { bookId, chapter, startVerse, endVerse };
}

export function formatReference(ref: PassageRef): string {
  const name = books.find((b) => b.id === ref.bookId)?.name ?? ref.bookId;
  if (ref.startVerse === null) return `${name} ${ref.chapter}`;
  if (ref.endVerse === null || ref.endVerse === ref.startVerse) return `${name} ${ref.chapter}:${ref.startVerse}`;
  return `${name} ${ref.chapter}:${ref.startVerse}–${ref.endVerse}`;
}

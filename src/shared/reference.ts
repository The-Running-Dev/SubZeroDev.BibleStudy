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

// Parses "Romans 3:12", "rom 3", "Romans 3:12-15" or "1 Cor 13:4". Null when the book is unknown,
// the chapter is outside the book, or a range runs backwards.
export function parseReference(input: string): PassageRef | null {
  const match = pattern.exec(normalize(input));
  if (!match) return null;
  const bookId = resolveBook(match[1]);
  if (!bookId) return null;
  const chapter = Number(match[2]);
  const book = books.find((b) => b.id === bookId)!;
  if (chapter < 1 || chapter > book.chapters) return null;
  if (match[3] === undefined) return { bookId, chapter, startVerse: null, endVerse: null };
  const startVerse = Number(match[3]);
  const endVerse = match[4] === undefined ? startVerse : Number(match[4]);
  if (startVerse < 1 || endVerse < startVerse) return null;
  return { bookId, chapter, startVerse, endVerse };
}

export function formatReference(ref: PassageRef): string {
  const name = books.find((b) => b.id === ref.bookId)?.name ?? ref.bookId;
  if (ref.startVerse === null) return `${name} ${ref.chapter}`;
  if (ref.endVerse === null || ref.endVerse === ref.startVerse) return `${name} ${ref.chapter}:${ref.startVerse}`;
  return `${name} ${ref.chapter}:${ref.startVerse}–${ref.endVerse}`;
}

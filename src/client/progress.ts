import type { GroupProgressView, StoppingPoint } from '../shared/api.ts';
import { formatReference, parseReference } from '../shared/reference.ts';

export const formatStop = (ref: StoppingPoint) =>
  formatReference({
    bookId: ref.bookId,
    chapter: ref.chapter,
    startVerse: ref.verse,
    endVerse: null,
  });

// "Romans 2:11"; a range stops at its last verse. Null without a verse: a stopping point is a verse, not a chapter.
export function parseStop(text: string): StoppingPoint | null {
  const ref = parseReference(text);
  if (!ref || ref.startVerse === null) return null;
  return { bookId: ref.bookId, chapter: ref.chapter, verse: ref.endVerse ?? ref.startVerse };
}

// S9.2: what a member sees when another confirmed a stopping point first.
export const staleNote = (current: GroupProgressView) =>
  `${current.confirmedBy} confirmed ${formatStop(current.ref)} first. Confirm again to replace it.`;

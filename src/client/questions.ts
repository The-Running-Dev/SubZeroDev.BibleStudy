import type { PlaybackState, QuestionStatus, QuestionView } from '../shared/api.ts';

// The statuses a study shows: what the group has not settled yet.
export const unsettled: QuestionStatus[] = ['open', 'carried'];

// A removed question with no replies has nothing left to show.
export const isGone = (question: QuestionView) => question.removed && question.replies.length === 0;

// Passage order, as the server lists them: chapter questions first, then by first verse, then oldest first.
function order(a: QuestionView, b: QuestionView): number {
  return (
    (a.anchor.startVerse ?? 0) - (b.anchor.startVerse ?? 0) ||
    (a.anchor.endVerse ?? 0) - (b.anchor.endVerse ?? 0) ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

// Applies one changed question to the list a study shows for its chapter: replaced, added, or dropped when it is
// gone, settled or on another chapter. An older copy than the one shown is ignored.
export function applyQuestion(list: QuestionView[], question: QuestionView, chapter: { bookId: string; chapter: number }): QuestionView[] {
  const existing = list.find((q) => q.id === question.id);
  if (existing && existing.version > question.version) return list;
  const rest = list.filter((q) => q.id !== question.id);
  const belongs = question.anchor.bookId === chapter.bookId && question.anchor.chapter === chapter.chapter && unsettled.includes(question.status) && !isGone(question);
  return belongs ? [...rest, question].sort(order) : rest;
}

// A fetched list, keeping any question this client already holds a newer copy of: a broadcast can overtake the fetch.
export function mergeQuestions(local: QuestionView[], fetched: QuestionView[], chapter: { bookId: string; chapter: number }): QuestionView[] {
  return local.reduce((list, q) => (fetched.some((f) => f.id === q.id && f.version < q.version) ? applyQuestion(list, q, chapter) : list), fetched);
}

// Whether the study's questions wait for their verse: reading together, or narration with verse timing. Narration still
// being prepared waits too, so its questions are not all shown just before its timing arrives.
export function pacedBy(state: Pick<PlaybackState, 'mode' | 'recording' | 'status'>): boolean {
  if (state.mode === 'manual') return true;
  if (!state.recording) return state.status !== 'ended';
  return state.recording.timing.status === 'verified';
}

// S8.3: a chapter question is shown from the start; a verse or range question once the reading reaches its first
// verse. A question once shown stays shown, so seeking back over its verse does not show it again. Returns `shown`
// itself when nothing new is revealed.
export function reveal(questions: QuestionView[], verse: number | null, shown: ReadonlySet<string>): ReadonlySet<string> {
  const reached = questions.filter((q) => !shown.has(q.id) && (q.anchor.startVerse === null || (verse !== null && q.anchor.startVerse <= verse)));
  return reached.length ? new Set([...shown, ...reached.map((q) => q.id)]) : shown;
}

// "4", "4-6" or "4–6"; blank is the whole chapter. Null when it is not one of those.
export function parseVerses(text: string): { startVerse: number | null; endVerse: number | null } | null {
  const trimmed = text.trim();
  if (!trimmed) return { startVerse: null, endVerse: null };
  const match = /^(\d+)\s*(?:[-–]\s*(\d+))?$/.exec(trimmed);
  if (!match) return null;
  const startVerse = Number(match[1]);
  const endVerse = match[2] ? Number(match[2]) : startVerse;
  return startVerse >= 1 && endVerse >= startVerse ? { startVerse, endVerse } : null;
}

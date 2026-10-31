import type { PlaybackState, QuestionStatus, QuestionView } from '../shared/api.ts';

// The statuses a study shows: what the group has not settled yet.
export const unsettled: QuestionStatus[] = ['open', 'carried'];

// A removed question with no replies has nothing left to show.
export const isGone = (question: QuestionView) => question.removed && question.replies.length === 0;

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Passage order, as the server lists them: by chapter, chapter questions first, then by first verse, then oldest first.
function order(a: QuestionView, b: QuestionView): number {
  return (
    byText(a.anchor.bookId, b.anchor.bookId) ||
    a.anchor.chapter - b.anchor.chapter ||
    (a.anchor.startVerse ?? 0) - (b.anchor.startVerse ?? 0) ||
    (a.anchor.endVerse ?? 0) - (b.anchor.endVerse ?? 0) ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

const onChapter = (question: QuestionView, chapter: { bookId: string; chapter: number }) =>
  question.anchor.bookId === chapter.bookId && question.anchor.chapter === chapter.chapter;

// Applies one changed question to the list a study shows: replaced, added, or dropped when it is gone or settled. The
// study keeps its chapter's questions, every carried one, and those it already shows from earlier in the session (S9.4);
// a new question on another chapter waits for the next list. An older copy than the one shown is ignored.
export function applyQuestion(list: QuestionView[], question: QuestionView, chapter: { bookId: string; chapter: number }): QuestionView[] {
  const existing = list.find((q) => q.id === question.id);
  if (existing && existing.version > question.version) return list;
  const rest = list.filter((q) => q.id !== question.id);
  const kept = onChapter(question, chapter) || question.status === 'carried' || existing !== undefined;
  const belongs = kept && unsettled.includes(question.status) && !isGone(question);
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
// verse. One on another chapter than `chapter` (carried, or from earlier in the session) is shown from the start too.
// A question once shown stays shown, so seeking back over its verse does not show it again. Returns `shown` itself
// when nothing new is revealed.
export function reveal(
  questions: QuestionView[],
  verse: number | null,
  shown: ReadonlySet<string>,
  chapter?: { bookId: string; chapter: number },
): ReadonlySet<string> {
  const due = (q: QuestionView) => q.anchor.startVerse === null || (chapter !== undefined && !onChapter(q, chapter)) || (verse !== null && q.anchor.startVerse <= verse);
  const reached = questions.filter((q) => !shown.has(q.id) && due(q));
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

import { books } from '../shared/books.ts';
import type { TranslationId } from '../shared/api.ts';
import { downloadChapter, listDownloads } from './offline.ts';
import type { ChapterRef } from './offline.ts';

const chapters = books.flatMap((book) =>
  Array.from({ length: book.chapters }, (_, index) => ({ bookId: book.id, chapter: index + 1 }))
);
export const bibleChapterCount = chapters.length;
const key = (ref: Pick<ChapterRef, 'bookId' | 'chapter'>) => `${ref.bookId}/${ref.chapter}`;
const canonical = new Set(chapters.map(key));

async function savedChapters(userId: string, translationId: TranslationId): Promise<Set<string>> {
  const saved = await listDownloads(userId, translationId);
  return new Set(saved.filter((chapter) => !chapter.expired && canonical.has(key(chapter))).map(key));
}

export async function savedBibleChapterCount(userId: string, translationId: TranslationId): Promise<number> {
  return (await savedChapters(userId, translationId)).size;
}

export interface BibleDownloadProgress {
  saved: number;
  current: ChapterRef | null;
}

export type BibleDownloadResult = { state: 'complete' | 'paused'; saved: number } | { state: 'failed'; saved: number; reason: string };

// Each chapter is verified and committed separately. Restarting rechecks storage and skips valid copies.
export async function downloadBible(
  userId: string,
  translationId: TranslationId,
  signal: AbortSignal,
  onProgress: (progress: BibleDownloadProgress) => void
): Promise<BibleDownloadResult> {
  let saved = 0;
  const run = async (): Promise<BibleDownloadResult> => {
    try {
      const existing = await savedChapters(userId, translationId);
      saved = existing.size;
      onProgress({ saved, current: null });
      for (const position of chapters) {
        const chapter: ChapterRef = { translationId, ...position };
        if (signal.aborted) return { state: 'paused', saved };
        if (existing.has(key(chapter))) continue;
        onProgress({ saved, current: chapter });
        const result = await downloadChapter(userId, chapter, false, signal);
        if (result.state !== 'ready') {
          if (signal.aborted) return { state: 'paused', saved };
          return { state: 'failed', saved, reason: result.state === 'failed' ? result.reason : 'The chapter was not saved.' };
        }
        saved++;
        onProgress({ saved, current: null });
      }
      // Another window or storage pressure may have removed a chapter during the download.
      saved = await savedBibleChapterCount(userId, translationId);
      if (saved !== bibleChapterCount) return { state: 'failed', saved, reason: 'Some saved chapters are no longer available. Resume to download them again.' };
      return { state: 'complete', saved };
    } catch (error) {
      if (signal.aborted) return { state: 'paused', saved };
      return { state: 'failed', saved, reason: error instanceof Error ? error.message : 'The download failed.' };
    }
  };
  if (!navigator.locks) return run();
  return navigator.locks.request(`download ${translationId} Bible ${userId}`, { ifAvailable: true }, (lock) =>
    lock ? run() : Promise.resolve<BibleDownloadResult>({ state: 'failed', saved, reason: `The ${translationId} Bible is already downloading in another window.` })
  );
}

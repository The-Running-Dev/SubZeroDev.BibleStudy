import { books } from '../shared/books.ts';
import { downloadChapter, listDownloads } from './offline.ts';
import type { ChapterRef } from './offline.ts';

const chapters: ChapterRef[] = books.flatMap((book) =>
  Array.from({ length: book.chapters }, (_, index) => ({ translationId: 'ESV', bookId: book.id, chapter: index + 1 }))
);
export const esvChapterCount = chapters.length;
const key = (ref: ChapterRef) => `${ref.bookId}/${ref.chapter}`;
const canonical = new Set(chapters.map(key));

async function savedChapters(userId: string): Promise<Set<string>> {
  const saved = await listDownloads(userId, 'ESV');
  return new Set(saved.filter((chapter) => !chapter.expired && canonical.has(key(chapter))).map(key));
}

export async function savedEsvChapterCount(userId: string): Promise<number> {
  return (await savedChapters(userId)).size;
}

export interface EsvDownloadProgress {
  saved: number;
  current: ChapterRef | null;
}

export type EsvDownloadResult = { state: 'complete' | 'paused'; saved: number } | { state: 'failed'; saved: number; reason: string };

// Each chapter is verified and committed separately. Restarting rechecks storage and skips valid copies.
export async function downloadEsvBible(
  userId: string,
  signal: AbortSignal,
  onProgress: (progress: EsvDownloadProgress) => void
): Promise<EsvDownloadResult> {
  let saved = 0;
  const run = async (): Promise<EsvDownloadResult> => {
    try {
      const existing = await savedChapters(userId);
      saved = existing.size;
      onProgress({ saved, current: null });
      for (const chapter of chapters) {
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
      saved = await savedEsvChapterCount(userId);
      if (saved !== esvChapterCount) return { state: 'failed', saved, reason: 'Some saved chapters are no longer available. Resume to download them again.' };
      return { state: 'complete', saved };
    } catch (error) {
      if (signal.aborted) return { state: 'paused', saved };
      return { state: 'failed', saved, reason: error instanceof Error ? error.message : 'The download failed.' };
    }
  };
  if (!navigator.locks) return run();
  return navigator.locks.request(`download ESV Bible ${userId}`, { ifAvailable: true }, (lock) =>
    lock ? run() : Promise.resolve<EsvDownloadResult>({ state: 'failed', saved, reason: 'The ESV Bible is already downloading in another window.' })
  );
}

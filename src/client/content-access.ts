// Offline copies of imported CSB must carry the account scope issued by the server.
// Unscoped copies made by older builds are discarded; API.Bible expiry is unchanged.
import type { ChapterView, DownloadManifest, TranslationId } from '../shared/api.ts';

export function offlineContentPermitted(
  userId: string,
  translationId: TranslationId,
  content: Pick<ChapterView | DownloadManifest, 'expiresAt' | 'restrictedToUserId'>,
): boolean {
  if (translationId !== 'CSB' || content.expiresAt !== null) return true;
  return content.restrictedToUserId === userId;
}

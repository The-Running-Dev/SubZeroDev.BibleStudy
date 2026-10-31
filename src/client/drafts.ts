import type { Uuid } from '../shared/api.ts';
import { openDb, request } from './offline.ts';

// A question being written, kept on the device until it is posted (S15.5). One draft per member, group and chapter.
// The draft carries the client op id its post will use: a new one with every edit, so tapping Post again after a lost
// answer never posts twice, and an edited question is never taken for the one already sent.
// Drafts are never sent on their own: posting needs a connection and a tap.

export interface Draft {
  userId: Uuid;
  id: string;
  groupId: Uuid;
  verses: string;
  body: string;
  clientOpId: Uuid;
}

export const draftId = (groupId: Uuid, at: { bookId: string; chapter: number }) => `question:${groupId}:${at.bookId}:${at.chapter}`;

// Settles once the transaction is stored, or failed (a full disk among the reasons).
async function inStore(mode: IDBTransactionMode, work: (drafts: IDBObjectStore) => IDBRequest): Promise<unknown> {
  const tx = (await openDb()).transaction('drafts', mode);
  const result = request(work(tx.objectStore('drafts')));
  // The transaction's failure is the one reported.
  result.catch(() => undefined);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
  return result;
}

export async function loadDraft(userId: Uuid, id: string): Promise<Draft | undefined> {
  return (await inStore('readonly', (drafts) => drafts.get([userId, id]))) as Draft | undefined;
}

export async function saveDraft(draft: Draft): Promise<void> {
  await inStore('readwrite', (drafts) => drafts.put(draft));
}

export async function removeDraft(userId: Uuid, id: string): Promise<void> {
  await inStore('readwrite', (drafts) => drafts.delete([userId, id]));
}

// What this device keeps for reading with no connection (S14): chapters in IndexedDB, narration audio in Cache Storage.
// Everything is keyed by the signed-in user, so one browser shared by two members keeps their downloads apart.
// A download is ready only once every asset's bytes match the hash the server named (I-27); anything else is removed.
import type { BookId, ChapterView, DownloadManifest, IsoInstant, RecordingView, RecordingsResponse, TranslationId, TranslationView, Uuid } from '../shared/api.ts';

export type DownloadState =
  | { state: 'absent' }
  | { state: 'downloading'; doneBytes: number; totalBytes: number }
  | { state: 'ready'; expiresAt: IsoInstant | null; withNarration: boolean }
  | { state: 'failed'; reason: string }
  | { state: 'expired' };

export interface ChapterRef {
  translationId: TranslationId;
  bookId: BookId;
  chapter: number;
}

interface DownloadRecord extends ChapterRef {
  userId: Uuid;
  id: string;
  withNarration: boolean;
  chapterBody: string;
  translation: TranslationView | null;
  recording: RecordingView | null;
  audio: { url: string; sha256: string; bytes: number } | null;
  expiresAt: IsoInstant | null;
  totalBytes: number;
  savedAt: IsoInstant;
}

export interface OfflineChapter {
  chapter: ChapterView;
  translation: TranslationView | null;
  recording: RecordingView | null;
  audioUrl: string | null;
}

const dbName = 'biblestudy';
const mediaCache = 'media-v1';
// Later slices add their own stores here; an upgrade only ever adds.
const stores = ['downloads', 'notes', 'pendingOps', 'drafts', 'soloPosition', 'meta'];

let opening: Promise<IDBDatabase> | null = null;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      for (const name of stores) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: ['userId', 'id'] });
    };
    req.onsuccess = () => {
      const db = req.result;
      // A newer tab upgrading the schema closes this one's connection rather than blocking it.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      opening = null;
      reject(req.error ?? new Error('IndexedDB unavailable'));
    };
  });
  return opening;
}

async function store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await openDb()).transaction(name, mode).objectStore(name);
}

const idOf = (ref: ChapterRef) => `${ref.translationId}/${ref.bookId}/${ref.chapter}`;

async function getRecord(userId: Uuid, ref: ChapterRef): Promise<DownloadRecord | undefined> {
  return request((await store('downloads', 'readonly')).get([userId, idOf(ref)]) as IDBRequest<DownloadRecord | undefined>);
}

async function allRecords(userId: Uuid): Promise<DownloadRecord[]> {
  const range = IDBKeyRange.bound([userId, ''], [userId, '￿']);
  return request((await store('downloads', 'readonly')).getAll(range) as IDBRequest<DownloadRecord[]>);
}

async function everyRecord(): Promise<DownloadRecord[]> {
  return request((await store('downloads', 'readonly')).getAll() as IDBRequest<DownloadRecord[]>);
}

async function hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `The server answered ${response.status}.`);
  }
  return (await response.json()) as T;
}

// Reads a body chunk by chunk so the progress bar moves with the bytes actually received.
async function readBody(url: string, signal: AbortSignal, onBytes: (n: number) => void): Promise<ArrayBuffer> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal });
  if (!response.ok || !response.body) throw new Error(`The server answered ${response.status}.`);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
    onBytes(value.byteLength);
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.byteLength;
  }
  return joined.buffer;
}

async function audioReferenced(url: string, except: { userId: Uuid; id: string } | null): Promise<boolean> {
  return (await everyRecord()).some((r) => r.audio?.url === url && !(except && r.userId === except.userId && r.id === except.id));
}

async function releaseAudio(url: string, except: { userId: Uuid; id: string } | null): Promise<void> {
  if (await audioReferenced(url, except)) return;
  await (await caches.open(mediaCache)).delete(url);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function storageAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && typeof caches !== 'undefined' && typeof crypto?.subtle !== 'undefined';
}

export async function downloadManifest(ref: ChapterRef, withNarration: boolean, signal?: AbortSignal): Promise<DownloadManifest> {
  const url = `/api/content/${ref.translationId}/${ref.bookId}/${ref.chapter}/download-manifest${withNarration ? '?narration=true' : ''}`;
  return getJson<DownloadManifest>(url, signal ?? new AbortController().signal);
}

export async function downloadChapter(
  userId: Uuid,
  ref: ChapterRef,
  withNarration: boolean,
  signal: AbortSignal,
  onProgress?: (state: DownloadState) => void,
): Promise<DownloadState> {
  if (!storageAvailable()) return { state: 'failed', reason: 'This browser cannot keep chapters for offline reading.' };
  const id = idOf(ref);
  const run = async (): Promise<DownloadState> => {
    let addedAudio: string | null = null;
    try {
      void navigator.storage?.persist?.().catch(() => false);
      const manifest = await downloadManifest(ref, withNarration, signal);
      const listing = withNarration ? await getJson<RecordingsResponse>(`/api/content/${ref.translationId}/${ref.bookId}/${ref.chapter}/recordings`, signal) : null;
      const translations = await getJson<TranslationView[]>('/api/content/translations', signal);
      const audioAsset = manifest.assets.find((a) => a.kind === 'audio') ?? null;
      const recording = audioAsset ? (listing?.recordings.find((r) => r.mediaUrl === audioAsset.url) ?? null) : null;
      if (audioAsset && !recording) throw new Error('The narration changed while downloading; try again.');

      let doneBytes = 0;
      const tick = (n: number) => {
        doneBytes += n;
        onProgress?.({ state: 'downloading', doneBytes: Math.min(doneBytes, manifest.totalBytes), totalBytes: manifest.totalBytes });
      };
      onProgress?.({ state: 'downloading', doneBytes: 0, totalBytes: manifest.totalBytes });

      let chapterBody = '';
      const cache = await caches.open(mediaCache);
      for (const asset of manifest.assets) {
        if (asset.kind === 'audio' && (await cache.match(asset.url))) {
          tick(asset.bytes);
          continue;
        }
        const bytes = await readBody(asset.url, signal, tick);
        if (bytes.byteLength !== asset.bytes || (await hex(bytes)) !== asset.sha256) throw new Error('A downloaded file did not match what the server sent; try again.');
        if (asset.kind === 'chapter') chapterBody = new TextDecoder().decode(bytes);
        else {
          await cache.put(asset.url, new Response(bytes, { headers: { 'content-type': 'audio/mpeg', 'content-length': String(bytes.byteLength) } }));
          addedAudio = asset.url;
        }
      }
      signal.throwIfAborted();

      const record: DownloadRecord = {
        userId,
        id,
        ...ref,
        withNarration: audioAsset !== null,
        chapterBody,
        translation: translations.find((t) => t.id === ref.translationId) ?? null,
        recording,
        audio: audioAsset ? { url: audioAsset.url, sha256: audioAsset.sha256, bytes: audioAsset.bytes } : null,
        expiresAt: manifest.expiresAt,
        totalBytes: manifest.totalBytes,
        savedAt: new Date().toISOString(),
      };
      const previous = await getRecord(userId, ref);
      await request((await store('downloads', 'readwrite')).put(record));
      // Downloading text only over an earlier download with narration drops the audio it no longer needs.
      if (previous?.audio && previous.audio.url !== record.audio?.url) await releaseAudio(previous.audio.url, null);
      return { state: 'ready', expiresAt: record.expiresAt, withNarration: record.withNarration };
    } catch (error) {
      if (addedAudio) await releaseAudio(addedAudio, null).catch(() => undefined);
      const reason = signal.aborted ? 'Download cancelled.' : error instanceof TypeError ? 'The connection dropped during the download.' : error instanceof Error ? error.message : 'The download failed.';
      return { state: 'failed', reason };
    }
  };
  // One download per chapter at a time, across this browser's windows.
  if (!navigator.locks) return run();
  return navigator.locks.request(`download ${userId} ${id}`, { ifAvailable: true }, (lock) =>
    lock ? run() : Promise.resolve<DownloadState>({ state: 'failed', reason: 'This chapter is already downloading in another window.' }),
  );
}

export async function removeDownload(userId: Uuid, ref: ChapterRef): Promise<void> {
  const record = await getRecord(userId, ref);
  if (!record) return;
  await request((await store('downloads', 'readwrite')).delete([userId, record.id]));
  if (record.audio) await releaseAudio(record.audio.url, null);
}

async function evicted(record: DownloadRecord): Promise<boolean> {
  return record.audio !== null && !(await (await caches.open(mediaCache)).match(record.audio.url));
}

const isExpired = (record: DownloadRecord) => record.expiresAt !== null && Date.parse(record.expiresAt) <= Date.now();

export async function downloadState(userId: Uuid, ref: ChapterRef): Promise<DownloadState> {
  if (!storageAvailable()) return { state: 'absent' };
  const record = await getRecord(userId, ref);
  if (!record) return { state: 'absent' };
  if (isExpired(record)) return { state: 'expired' };
  // The browser may clear cached audio under storage pressure; a half-kept download is not offered.
  if (await evicted(record)) {
    await request((await store('downloads', 'readwrite')).delete([userId, record.id]));
    return { state: 'absent' };
  }
  return { state: 'ready', expiresAt: record.expiresAt, withNarration: record.withNarration };
}

export interface DownloadSummary extends ChapterRef {
  withNarration: boolean;
  totalBytes: number;
  expired: boolean;
}

export async function listDownloads(userId: Uuid): Promise<DownloadSummary[]> {
  if (!storageAvailable()) return [];
  const kept: DownloadSummary[] = [];
  for (const record of await allRecords(userId)) {
    if (await evicted(record)) continue;
    const { translationId, bookId, chapter, withNarration, totalBytes } = record;
    kept.push({ translationId, bookId, chapter, withNarration, totalBytes, expired: isExpired(record) });
  }
  return kept;
}

export async function offlineChapter(userId: Uuid, ref: ChapterRef): Promise<OfflineChapter | 'expired' | null> {
  if (!storageAvailable()) return null;
  const record = await getRecord(userId, ref);
  if (!record) return null;
  if (isExpired(record)) return 'expired';
  let audioUrl: string | null = null;
  if (record.audio) {
    const cached = await (await caches.open(mediaCache)).match(record.audio.url);
    if (cached) audioUrl = URL.createObjectURL(await cached.blob());
  }
  return { chapter: JSON.parse(record.chapterBody) as ChapterView, translation: record.translation, recording: audioUrl ? record.recording : null, audioUrl };
}

// The last profile the server confirmed, so a start with no connection can still open the member's downloads.
const profileKey = 'bible-study.profile';

export function rememberProfile<T extends { id: Uuid }>(profile: T): void {
  try {
    localStorage.setItem(profileKey, JSON.stringify(profile));
  } catch {
    // Storage blocked: an offline start shows the sign-in screen instead.
  }
}

export function rememberedProfile<T>(): T | null {
  try {
    const raw = localStorage.getItem(profileKey);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function forgetProfile(): void {
  try {
    localStorage.removeItem(profileKey);
  } catch {
    // Nothing kept.
  }
}

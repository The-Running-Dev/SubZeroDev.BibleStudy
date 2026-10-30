// Client for the AO Lab Free Use Bible API (bible.helloao.org). Only the importer talks to it;
// members only ever read our own copy (D-2026-10-30: clients never fetch AO Lab directly).

export interface AoTranslation {
  id: string;
  name: string;
  sha256: string;
  numberOfBooks: number;
  totalNumberOfChapters: number;
}

export interface AoBook {
  id: string;
  name: string;
  order: number;
  numberOfChapters: number;
  sha256: string;
}

export type AoSegment = string | { text: string; poem?: number; wordsOfJesus?: boolean } | { noteId: number } | { lineBreak: true } | { heading: string };

export type AoContentItem =
  | { type: 'heading' | 'hebrew_subtitle'; content: (string | AoSegment)[] }
  | { type: 'line_break' }
  | { type: 'verse'; number: number; content: AoSegment[] };

export interface AoChapter {
  translation: AoTranslation;
  book: AoBook;
  numberOfVerses: number;
  thisChapterLink: string;
  // Absolute audio URLs and site-relative timing paths, keyed by narrator.
  thisChapterAudioLinks?: Record<string, string>;
  thisChapterAudioTimings?: Record<string, string>;
  chapter: {
    number: number;
    content: AoContentItem[];
    footnotes: { noteId: number; text: string; reference: { chapter: number; verse?: number } }[];
  };
}

// Verse start times in seconds, in verse order.
export interface AoTiming {
  reader: string;
  verses: number[];
}

export interface AoAudio {
  bytes: Buffer;
  mimeType: string;
}

export interface ContentSource {
  books(translationId: string): Promise<{ translation: AoTranslation; books: AoBook[] }>;
  chapter(translationId: string, bookId: string, chapter: number): Promise<AoChapter>;
  timing(path: string): Promise<AoTiming>;
  audio(url: string): Promise<AoAudio>;
}

export class SourceError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

export interface SourceOptions {
  baseUrl: string;
  // Hosts audio may be fetched from besides the base URL's own.
  audioHosts?: string[];
  maxAudioBytes?: number;
  timeoutMs?: number;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const defaultAudioHosts = ['audio.bible.helloao.org'];

const maxRedirects = 3;

// A 4xx other than a timeout or a rate limit will not change on retry. A null status is a network fault.
export function isPermanent(status: number | null): boolean {
  return status !== null && status < 500 && status !== 408 && status !== 429;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createAoLabSource(options: SourceOptions): ContentSource {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? defaultSleep;
  const audioHosts = new Set([new URL(baseUrl).host, ...(options.audioHosts ?? defaultAudioHosts)]);
  const maxAudioBytes = options.maxAudioBytes ?? 100 * 1024 * 1024;

  // Retries network errors, 5xx, 408 and 429; any other 4xx or a refused response fails at once.
  async function withRetry<T>(label: string, work: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await work();
      } catch (error) {
        lastError = error;
        if (error instanceof SourceError && isPermanent(error.status)) throw error;
        if (attempt < attempts) await sleep(1000 * 2 ** (attempt - 1));
      }
    }
    throw lastError instanceof SourceError ? lastError : new SourceError(`${label}: ${String((lastError as Error)?.message ?? lastError)}`, null);
  }

  const base = new URL(baseUrl);
  // JSON comes only from the base URL's origin; audio only from an allowed host, over https.
  const checkJsonUrl = (url: URL) => {
    if (url.origin !== base.origin) throw new SourceError(`${url.href}: not on ${base.origin}`, 400);
  };
  const checkAudioUrl = (url: URL) => {
    if (url.protocol !== 'https:' && url.origin !== base.origin) throw new SourceError(`${url.href}: audio must be fetched over https`, 400);
    if (!audioHosts.has(url.host)) throw new SourceError(`${url.href}: ${url.host} is not an audio source`, 400);
  };

  // Redirects are followed by hand so every hop passes the same host check as the first URL.
  async function get(url: string, label: string, timeoutMs: number, check: (url: URL) => void): Promise<Response> {
    const signal = AbortSignal.timeout(timeoutMs);
    let current = new URL(url);
    for (let hop = 0; ; hop++) {
      check(current);
      const response = await fetch(current, { signal, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new SourceError(`${label}: HTTP ${response.status} without a location`, 502);
        if (hop >= maxRedirects) throw new SourceError(`${label}: more than ${maxRedirects} redirects`, 400);
        current = new URL(location, current);
        continue;
      }
      if (response.status === 404) throw new SourceError(`${label}: not found`, 404);
      if (!response.ok) throw new SourceError(`${label}: HTTP ${response.status}`, response.status);
      return response;
    }
  }

  const getJson = <T>(path: string): Promise<T> =>
    withRetry(path, async () => (await (await get(`${baseUrl}${path}`, path, options.timeoutMs ?? 30_000, checkJsonUrl)).json()) as T);

  return {
    books: (translationId) => getJson(`/api/${translationId}/books.json`),
    chapter: (translationId, bookId, chapter) => getJson(`/api/${translationId}/${bookId}/${chapter}.json`),
    timing: (path) => {
      if (!path.startsWith('/api/')) throw new SourceError(`${path}: not a timing path`, 400);
      return getJson(path);
    },
    audio: (url) => {
      checkAudioUrl(new URL(url));
      return withRetry(url, async () => {
        const response = await get(url, url, options.timeoutMs ?? 120_000, checkAudioUrl);
        const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (mimeType !== 'audio/mpeg') throw new SourceError(`${url}: expected audio/mpeg, got ${mimeType || 'no content type'}`, 415);
        const declared = Number(response.headers.get('content-length') ?? NaN);
        if (declared > maxAudioBytes) throw new SourceError(`${url}: ${declared} bytes is over the ${maxAudioBytes} byte limit`, 413);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > maxAudioBytes) throw new SourceError(`${url}: over the ${maxAudioBytes} byte limit`, 413);
        // A short read is a network fault, so it is retried.
        if (Number.isFinite(declared) && bytes.length !== declared) throw new SourceError(`${url}: received ${bytes.length} of ${declared} bytes`, null);
        return { bytes, mimeType };
      });
    },
  };
}

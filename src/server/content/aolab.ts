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
  chapter: {
    number: number;
    content: AoContentItem[];
    footnotes: { noteId: number; text: string; reference: { chapter: number; verse?: number } }[];
  };
}

export interface ContentSource {
  books(translationId: string): Promise<{ translation: AoTranslation; books: AoBook[] }>;
  chapter(translationId: string, bookId: string, chapter: number): Promise<AoChapter>;
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
  timeoutMs?: number;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createAoLabSource(options: SourceOptions): ContentSource {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? defaultSleep;

  async function getJson<T>(path: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) });
        if (response.status === 404) throw new SourceError(`${path}: not found`, 404);
        if (!response.ok) throw new SourceError(`${path}: HTTP ${response.status}`, response.status);
        return (await response.json()) as T;
      } catch (error) {
        lastError = error;
        if (error instanceof SourceError && error.status === 404) throw error;
        if (attempt < attempts) await sleep(1000 * 2 ** (attempt - 1));
      }
    }
    throw lastError instanceof SourceError ? lastError : new SourceError(`${path}: ${String((lastError as Error)?.message ?? lastError)}`, null);
  }

  return {
    books: (translationId) => getJson(`/api/${translationId}/books.json`),
    chapter: (translationId, bookId, chapter) => getJson(`/api/${translationId}/${bookId}/${chapter}.json`),
  };
}

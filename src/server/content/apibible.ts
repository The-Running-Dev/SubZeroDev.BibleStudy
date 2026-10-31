// Client for API.Bible, the only licensed source of CSB text (I-11). The key never leaves the server; members read
// our cached copy, which expires 14 days after it was fetched. Only the Fair Use report goes from the browser to
// API.Bible (fums.api.bible), as its terms require.
import type { Availability, ChapterContent } from '../../shared/api.ts';
import type { Clock } from '../platform/clock.ts';

export const csbCacheMs = 14 * 24 * 60 * 60 * 1000;
// How long a probe's answer stands before listTranslations asks API.Bible again; failures are retried sooner.
const statusOkMs = 60 * 60 * 1000;
const statusFailedMs = 60 * 1000;

export interface ApiBibleSettings {
  key: string;
  bibleId: string;
  baseUrl: string;
}

export type ApiBibleFailure = 'rejected' | 'not_found' | 'limited' | 'unreachable' | 'malformed';

export class ApiBibleError extends Error {
  readonly kind: ApiBibleFailure;

  constructor(kind: ApiBibleFailure, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface FetchedChapter {
  content: ChapterContent;
  verseCount: number;
  copyright: string | null;
  fumsToken: string | null;
  sourceRef: string;
}

export interface ApiBible {
  status(): Promise<Availability>;
  chapter(bookId: string, chapter: number): Promise<FetchedChapter>;
}

// API.Bible answers 401 without a key and 403 for one it does not know (recorded 2026-10-31); both mean the same here.
export function failureReason(error: ApiBibleError): string {
  switch (error.kind) {
    case 'rejected':
      return 'API.Bible rejected the key';
    case 'not_found':
      return 'API.Bible does not offer this Bible to this key. Check APIBIBLE_CSB_BIBLE_ID and that CSB access is approved.';
    case 'limited':
      return "API.Bible's request limit was reached; try again later";
    default:
      return 'API.Bible could not be reached; try again later';
  }
}

// ---- JSON content (content-type=json) ----

export interface ApiNode {
  type: 'tag' | 'text';
  name?: string;
  text?: string;
  attrs?: { style?: string; number?: string; verseId?: string; [key: string]: unknown };
  items?: ApiNode[];
}

const headingStyle = /^(s\d?|ms\d?|qa|sp|d)$/;
// Cross references, chapter labels and the like carry no text a reader needs.
const skippedStyle = /^(r|mr|sr|cl|cp|cd)$/;
const poemStyle = /^(q\d?|qc|qr|qm\d?|qd)$/;

function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

function plainText(node: ApiNode): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.name === 'verse' || node.name === 'note') return '';
  return (node.items ?? []).map(plainText).join('');
}

// Verse text is every text node tagged with the verse's id; a paragraph break inside a verse is a space in prose and
// a new line in poetry. Headings attach to the verse that follows them. Notes are not requested.
export function normalizeApiChapter(nodes: ApiNode[], bookId: string, chapter: number): ChapterContent {
  const texts = new Map<number, string>();
  const headings: ChapterContent['headings'] = [];
  let pending: string[] = [];
  const idPattern = new RegExp(`^${bookId}\\.${chapter}\\.(\\d+)$`);

  const visit = (node: ApiNode, breakBefore: string): string => {
    if (node.type === 'text') {
      const match = idPattern.exec(node.attrs?.verseId ?? '');
      if (!match || !node.text) return breakBefore;
      const number = Number(match[1]);
      const before = texts.get(number);
      if (before === undefined) {
        for (const text of pending) headings.push({ beforeVerse: number, text });
        pending = [];
      }
      texts.set(number, before === undefined ? node.text : before + breakBefore + node.text);
      return '';
    }
    if (node.name === 'verse' || node.name === 'note') return breakBefore;
    let carry = breakBefore;
    for (const item of node.items ?? []) carry = visit(item, carry);
    return carry;
  };

  let previousPoem = false;
  for (const node of nodes) {
    const style = node.attrs?.style ?? '';
    if (node.type === 'tag' && node.name === 'para' && headingStyle.test(style)) {
      const text = tidy(plainText(node));
      if (text) pending.push(text);
      continue;
    }
    if (node.type === 'tag' && node.name === 'para' && skippedStyle.test(style)) continue;
    const poem = poemStyle.test(style);
    visit(node, poem || previousPoem ? '\n' : ' ');
    previousPoem = poem;
  }

  const verses = [...texts.entries()].sort((a, b) => a[0] - b[0]).map(([number, text]) => ({ number, text: tidy(text) }));
  return { verses: verses.filter((v) => v.text.length > 0), headings, footnotes: [] };
}

// ---- HTTP ----

interface ChapterResponse {
  data?: { id?: string; content?: unknown; verseCount?: number; copyright?: string };
  meta?: { fumsToken?: string };
}

export function createApiBible(settings: ApiBibleSettings, clock: Clock, options: { timeoutMs?: number } = {}): ApiBible {
  const base = settings.baseUrl.replace(/\/+$/, '');
  let known: { availability: Availability; until: number } | null = null;
  // Concurrent readers of one chapter share a single request.
  const inFlight = new Map<string, Promise<FetchedChapter>>();

  async function get(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        headers: { 'api-key': settings.key, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      });
    } catch (error) {
      throw new ApiBibleError('unreachable', `API.Bible ${path}: ${(error as Error).message}`);
    }
    if (response.status === 401 || response.status === 403) throw new ApiBibleError('rejected', `API.Bible ${path}: HTTP ${response.status}`);
    if (response.status === 404) throw new ApiBibleError('not_found', `API.Bible ${path}: not found`);
    if (response.status === 429) throw new ApiBibleError('limited', `API.Bible ${path}: HTTP 429`);
    if (!response.ok) throw new ApiBibleError('unreachable', `API.Bible ${path}: HTTP ${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new ApiBibleError('malformed', `API.Bible ${path}: the body is not JSON`);
    }
  }

  function remember(availability: Availability, forMs: number): Availability {
    known = { availability, until: clock.now().getTime() + forMs };
    return availability;
  }

  // A rejected key or a missing Bible found by a chapter request also answers the next status question.
  function noteFailure(error: unknown): void {
    if (error instanceof ApiBibleError && (error.kind === 'rejected' || error.kind === 'not_found')) {
      remember({ state: 'unavailable', reason: failureReason(error) }, statusFailedMs);
    }
  }

  async function fetchChapter(bookId: string, chapter: number): Promise<FetchedChapter> {
    const id = `${bookId}.${chapter}`;
    const query = 'content-type=json&include-notes=false&include-titles=true&include-chapter-numbers=false&include-verse-numbers=true&include-verse-spans=false&fums-version=3';
    const body = (await get(`/bibles/${encodeURIComponent(settings.bibleId)}/chapters/${id}?${query}`)) as ChapterResponse;
    if (!body?.data || !Array.isArray(body.data.content)) throw new ApiBibleError('malformed', `API.Bible ${id}: no JSON content`);
    const content = normalizeApiChapter(body.data.content as ApiNode[], bookId, chapter);
    if (content.verses.length === 0) throw new ApiBibleError('malformed', `API.Bible ${id}: no verses`);
    const last = content.verses[content.verses.length - 1].number;
    const verseCount = Number.isInteger(body.data.verseCount) && (body.data.verseCount as number) >= last ? (body.data.verseCount as number) : last;
    const copyright = typeof body.data.copyright === 'string' && body.data.copyright.trim() ? body.data.copyright.trim() : null;
    const fumsToken = typeof body.meta?.fumsToken === 'string' && body.meta.fumsToken ? body.meta.fumsToken : null;
    return { content, verseCount, copyright, fumsToken, sourceRef: `apibible:${settings.bibleId}/${id}` };
  }

  return {
    async status() {
      if (known && clock.now().getTime() < known.until) return known.availability;
      try {
        await get(`/bibles/${encodeURIComponent(settings.bibleId)}`);
        return remember({ state: 'available' }, statusOkMs);
      } catch (error) {
        if (!(error instanceof ApiBibleError)) throw error;
        return remember({ state: 'unavailable', reason: failureReason(error) }, statusFailedMs);
      }
    },

    chapter(bookId, chapter) {
      const key = `${bookId}.${chapter}`;
      const running = inFlight.get(key);
      if (running) return running;
      const request = fetchChapter(bookId, chapter)
        .then((fetched) => {
          if (known?.availability.state !== 'available') remember({ state: 'available' }, statusOkMs);
          return fetched;
        })
        .catch((error: unknown) => {
          noteFailure(error);
          throw error;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, request);
      return request;
    },
  };
}

import type { ChapterContent } from '../../shared/api.ts';
import { sha256Hex } from '../platform/secrets.ts';
import type { AoChapter, AoSegment } from './aolab.ts';

// The stored form of a chapter is ChapterContent; its canonical JSON string is what `content_sha256` hashes (I-10).

function segmentText(segment: AoSegment | string): { text: string; poem: boolean } | null {
  if (typeof segment === 'string') return { text: segment, poem: false };
  if ('text' in segment) return { text: segment.text, poem: segment.poem !== undefined };
  if ('lineBreak' in segment) return { text: '\n', poem: false };
  return null; // footnote markers and inline headings carry no verse text
}

function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

// AO Lab splits text at footnote markers without edge whitespace: "the Omega," [note] "” says".
// A piece that opens with closing punctuation attaches to what precedes it, even across poem lines
// (Matthew 1:23 ends `“God with us”` [note] `).`). Otherwise a space goes between prose pieces unless
// the last one ended with opening punctuation.
const closes = /^[”’)\].,;:!?—]/;
const opens = /[“‘([—]$/;

// Joins a verse's segments. Lines of poetry keep their own line; prose runs together.
export function verseText(segments: AoSegment[]): string {
  let text = '';
  let previousPoem = false;
  for (const raw of segments) {
    const segment = segmentText(raw);
    if (!segment) continue;
    if (text.length > 0 && !closes.test(segment.text)) {
      if (segment.poem || previousPoem) text += '\n';
      else if (!opens.test(text)) text += ' ';
    }
    text += segment.text;
    previousPoem = segment.poem;
  }
  return tidy(text);
}

export function normalizeChapter(source: AoChapter): ChapterContent {
  const verses: ChapterContent['verses'] = [];
  const headings: ChapterContent['headings'] = [];
  let pending: string[] = [];

  for (const item of source.chapter.content) {
    if (item.type === 'heading' || item.type === 'hebrew_subtitle') {
      const text = tidy(item.content.map((part) => (typeof part === 'string' ? part : (segmentText(part)?.text ?? ''))).join(' '));
      if (text) pending.push(text);
    } else if (item.type === 'verse') {
      for (const text of pending) headings.push({ beforeVerse: item.number, text });
      pending = [];
      verses.push({ number: item.number, text: verseText(item.content) });
    }
  }

  const footnotes = source.chapter.footnotes
    .filter((note) => note.reference.verse !== undefined)
    .map((note) => ({ verse: note.reference.verse as number, text: tidy(note.text) }));

  return { verses, headings, footnotes };
}

export function serializeContent(content: ChapterContent): string {
  return JSON.stringify({
    verses: content.verses.map((v) => ({ number: v.number, text: v.text })),
    headings: content.headings.map((h) => ({ beforeVerse: h.beforeVerse, text: h.text })),
    footnotes: content.footnotes.map((f) => ({ verse: f.verse, text: f.text })),
  });
}

export function contentHash(serialized: string): string {
  return sha256Hex(serialized);
}

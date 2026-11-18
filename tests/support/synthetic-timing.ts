import type { AoChapter, ContentSource } from '../../src/server/content/aolab.ts';

// AO Lab stopped publishing verse timing (every chapter's thisChapterAudioTimings is {} since 2026-11-17), so the
// live narration tests keep the real chapters and recordings from AO Lab and take verse timing from here instead:
// one start every `spacing` seconds, which fits inside every Romans recording.
const syntheticPrefix = '/synthetic-timing/';

export function withSyntheticTiming(source: ContentSource, spacing = 1.5): ContentSource {
  const verseCounts = new Map<string, number>();
  return {
    ...source,
    async chapter(translationId, bookId, chapter): Promise<AoChapter> {
      const raw = await source.chapter(translationId, bookId, chapter);
      const key = `${translationId}/${bookId}/${chapter}`;
      verseCounts.set(key, raw.numberOfVerses);
      const narrators = Object.keys(raw.thisChapterAudioLinks ?? {});
      return { ...raw, thisChapterAudioTimings: Object.fromEntries(narrators.map((n) => [n, `${syntheticPrefix}${key}/${n}`])) };
    },
    async timing(path) {
      if (!path.startsWith(syntheticPrefix)) return source.timing(path);
      const parts = path.slice(syntheticPrefix.length).split('/');
      const count = verseCounts.get(parts.slice(0, 3).join('/'));
      if (count === undefined) throw new Error(`${path}: chapter not fetched first`);
      return { reader: parts[3], verses: Array.from({ length: count }, (_, i) => i * spacing) };
    },
  };
}

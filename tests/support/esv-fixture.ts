import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Synthetic text only. The downloaded ESV files stay outside git and the application image.
export const esvChapter = () => ({
  SchemaVersion: 1, Translation: 'ESV', BookNumber: 57, Chapter: 1, VerseCount: 2,
  Headings: [{ BeforeVerse: 1, Text: 'Fixture heading', Footnotes: [{ Text: 'Heading note' }], CrossReferences: [] }],
  Verses: [
    { Number: 1, Text: 'First fixture line.\nSecond fixture line.', Footnotes: [{ Text: 'Alternative reading' }], CrossReferences: [{ Text: 'Fixture 2:1' }] },
    { Number: 3, Text: 'Final fixture verse.', Footnotes: [], CrossReferences: [] },
  ],
});

export async function writeEsvFixture(dir: string): Promise<string> {
  const folder = join(dir, '57-Philemon');
  await mkdir(folder, { recursive: true });
  const file = join(folder, '001.json');
  await writeFile(file, JSON.stringify(esvChapter()));
  return file;
}

// The 66-book Protestant canon in order, keyed by USFM code. Chapter counts bound reference parsing
// and navigation before any content has loaded.
export interface BookInfo {
  id: string;
  name: string;
  chapters: number;
  aliases: string[];
}

export const books: readonly BookInfo[] = [
  { id: 'GEN', name: 'Genesis', chapters: 50, aliases: ['gen', 'ge', 'gn'] },
  { id: 'EXO', name: 'Exodus', chapters: 40, aliases: ['exod', 'exo', 'ex'] },
  { id: 'LEV', name: 'Leviticus', chapters: 27, aliases: ['lev', 'le', 'lv'] },
  { id: 'NUM', name: 'Numbers', chapters: 36, aliases: ['num', 'nu', 'nm'] },
  { id: 'DEU', name: 'Deuteronomy', chapters: 34, aliases: ['deut', 'deu', 'dt'] },
  { id: 'JOS', name: 'Joshua', chapters: 24, aliases: ['josh', 'jos'] },
  { id: 'JDG', name: 'Judges', chapters: 21, aliases: ['judg', 'jdg', 'jg'] },
  { id: 'RUT', name: 'Ruth', chapters: 4, aliases: ['ruth', 'rut', 'ru'] },
  { id: '1SA', name: '1 Samuel', chapters: 31, aliases: ['1 sam', '1sam', '1 sa', '1sa'] },
  { id: '2SA', name: '2 Samuel', chapters: 24, aliases: ['2 sam', '2sam', '2 sa', '2sa'] },
  { id: '1KI', name: '1 Kings', chapters: 22, aliases: ['1 kgs', '1kgs', '1 ki', '1ki'] },
  { id: '2KI', name: '2 Kings', chapters: 25, aliases: ['2 kgs', '2kgs', '2 ki', '2ki'] },
  { id: '1CH', name: '1 Chronicles', chapters: 29, aliases: ['1 chron', '1chron', '1 chr', '1chr', '1 ch', '1ch'] },
  { id: '2CH', name: '2 Chronicles', chapters: 36, aliases: ['2 chron', '2chron', '2 chr', '2chr', '2 ch', '2ch'] },
  { id: 'EZR', name: 'Ezra', chapters: 10, aliases: ['ezra', 'ezr'] },
  { id: 'NEH', name: 'Nehemiah', chapters: 13, aliases: ['neh', 'ne'] },
  { id: 'EST', name: 'Esther', chapters: 10, aliases: ['esth', 'est', 'es'] },
  { id: 'JOB', name: 'Job', chapters: 42, aliases: ['job', 'jb'] },
  { id: 'PSA', name: 'Psalms', chapters: 150, aliases: ['psalm', 'psa', 'ps', 'pss'] },
  { id: 'PRO', name: 'Proverbs', chapters: 31, aliases: ['prov', 'pro', 'prv', 'pr'] },
  { id: 'ECC', name: 'Ecclesiastes', chapters: 12, aliases: ['eccl', 'ecc', 'ec', 'qoh'] },
  { id: 'SNG', name: 'Song of Songs', chapters: 8, aliases: ['song of solomon', 'song', 'sng', 'sos', 'canticles'] },
  { id: 'ISA', name: 'Isaiah', chapters: 66, aliases: ['isa', 'is'] },
  { id: 'JER', name: 'Jeremiah', chapters: 52, aliases: ['jer', 'je', 'jr'] },
  { id: 'LAM', name: 'Lamentations', chapters: 5, aliases: ['lam', 'la'] },
  { id: 'EZK', name: 'Ezekiel', chapters: 48, aliases: ['ezek', 'eze', 'ezk'] },
  { id: 'DAN', name: 'Daniel', chapters: 12, aliases: ['dan', 'da', 'dn'] },
  { id: 'HOS', name: 'Hosea', chapters: 14, aliases: ['hos', 'ho'] },
  { id: 'JOL', name: 'Joel', chapters: 3, aliases: ['joel', 'jol', 'jl'] },
  { id: 'AMO', name: 'Amos', chapters: 9, aliases: ['amos', 'amo', 'am'] },
  { id: 'OBA', name: 'Obadiah', chapters: 1, aliases: ['obad', 'oba', 'ob'] },
  { id: 'JON', name: 'Jonah', chapters: 4, aliases: ['jonah', 'jon'] },
  { id: 'MIC', name: 'Micah', chapters: 7, aliases: ['mic', 'mi'] },
  { id: 'NAM', name: 'Nahum', chapters: 3, aliases: ['nah', 'nam', 'na'] },
  { id: 'HAB', name: 'Habakkuk', chapters: 3, aliases: ['hab', 'hb'] },
  { id: 'ZEP', name: 'Zephaniah', chapters: 3, aliases: ['zeph', 'zep', 'zp'] },
  { id: 'HAG', name: 'Haggai', chapters: 2, aliases: ['hag', 'hg'] },
  { id: 'ZEC', name: 'Zechariah', chapters: 14, aliases: ['zech', 'zec', 'zc'] },
  { id: 'MAL', name: 'Malachi', chapters: 4, aliases: ['mal', 'ml'] },
  { id: 'MAT', name: 'Matthew', chapters: 28, aliases: ['matt', 'mat', 'mt'] },
  { id: 'MRK', name: 'Mark', chapters: 16, aliases: ['mark', 'mrk', 'mk', 'mr'] },
  { id: 'LUK', name: 'Luke', chapters: 24, aliases: ['luke', 'luk', 'lk'] },
  { id: 'JHN', name: 'John', chapters: 21, aliases: ['john', 'jhn', 'jn'] },
  { id: 'ACT', name: 'Acts', chapters: 28, aliases: ['acts', 'act', 'ac'] },
  { id: 'ROM', name: 'Romans', chapters: 16, aliases: ['rom', 'ro', 'rm'] },
  { id: '1CO', name: '1 Corinthians', chapters: 16, aliases: ['1 cor', '1cor', '1 co', '1co'] },
  { id: '2CO', name: '2 Corinthians', chapters: 13, aliases: ['2 cor', '2cor', '2 co', '2co'] },
  { id: 'GAL', name: 'Galatians', chapters: 6, aliases: ['gal', 'ga'] },
  { id: 'EPH', name: 'Ephesians', chapters: 6, aliases: ['eph', 'ephes'] },
  { id: 'PHP', name: 'Philippians', chapters: 4, aliases: ['phil', 'php', 'pp'] },
  { id: 'COL', name: 'Colossians', chapters: 4, aliases: ['col'] },
  { id: '1TH', name: '1 Thessalonians', chapters: 5, aliases: ['1 thess', '1thess', '1 th', '1th'] },
  { id: '2TH', name: '2 Thessalonians', chapters: 3, aliases: ['2 thess', '2thess', '2 th', '2th'] },
  { id: '1TI', name: '1 Timothy', chapters: 6, aliases: ['1 tim', '1tim', '1 ti', '1ti'] },
  { id: '2TI', name: '2 Timothy', chapters: 4, aliases: ['2 tim', '2tim', '2 ti', '2ti'] },
  { id: 'TIT', name: 'Titus', chapters: 3, aliases: ['titus', 'tit'] },
  { id: 'PHM', name: 'Philemon', chapters: 1, aliases: ['philem', 'phm', 'pm'] },
  { id: 'HEB', name: 'Hebrews', chapters: 13, aliases: ['heb'] },
  { id: 'JAS', name: 'James', chapters: 5, aliases: ['jas', 'jm'] },
  { id: '1PE', name: '1 Peter', chapters: 5, aliases: ['1 pet', '1pet', '1 pe', '1pe', '1 pt', '1pt'] },
  { id: '2PE', name: '2 Peter', chapters: 3, aliases: ['2 pet', '2pet', '2 pe', '2pe', '2 pt', '2pt'] },
  { id: '1JN', name: '1 John', chapters: 5, aliases: ['1 jn', '1jn', '1 jhn', '1jhn', '1 jo', '1jo'] },
  { id: '2JN', name: '2 John', chapters: 1, aliases: ['2 jn', '2jn', '2 jhn', '2jhn', '2 jo', '2jo'] },
  { id: '3JN', name: '3 John', chapters: 1, aliases: ['3 jn', '3jn', '3 jhn', '3jhn', '3 jo', '3jo'] },
  { id: 'JUD', name: 'Jude', chapters: 1, aliases: ['jude', 'jud', 'jd'] },
  { id: 'REV', name: 'Revelation', chapters: 22, aliases: ['rev', 're', 'rv', 'revelations', 'apocalypse'] },
];

const byId = new Map(books.map((book) => [book.id, book]));

export function bookById(id: string): BookInfo | undefined {
  return byId.get(id);
}

export interface ChapterLocation {
  bookId: string;
  chapter: number;
}

// Previous and next chapter across book boundaries; null at Genesis 1 and Revelation 22.
export function adjacentChapter(at: ChapterLocation, step: -1 | 1): ChapterLocation | null {
  const index = books.findIndex((book) => book.id === at.bookId);
  if (index < 0) return null;
  const chapter = at.chapter + step;
  if (chapter >= 1 && chapter <= books[index].chapters) return { bookId: at.bookId, chapter };
  const next = books[index + step];
  if (!next) return null;
  return { bookId: next.id, chapter: step === 1 ? 1 : next.chapters };
}

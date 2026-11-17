-- Verse-level text (ADR-0008). API.Bible is gone: every translation is imported once and never expires. The
-- chapters table stays as the served copy of each chapter (I-10); verses, headings and verse_notes hold the same text
-- one row at a time, written in the same transaction as their chapter.

DELETE FROM chapters WHERE expires_at IS NOT NULL;
ALTER TABLE chapters DROP COLUMN expires_at, DROP COLUMN fums_token;

ALTER TABLE translations DROP CONSTRAINT translations_source_kind_check;
UPDATE translations SET source_kind = 'files', license_summary = 'Owner-supplied CSB files for personal use.' WHERE id = 'CSB';
ALTER TABLE translations ADD CONSTRAINT translations_source_kind_check CHECK (source_kind IN ('aolab', 'files'));

-- The 66-book canon every translation shares; book_number orders it and builds verse refs.
CREATE TABLE canon (
  book_id text PRIMARY KEY,
  book_number int NOT NULL UNIQUE CHECK (book_number BETWEEN 1 AND 66),
  name text NOT NULL,
  testament text NOT NULL CHECK (testament IN ('OT', 'NT')),
  chapters int NOT NULL CHECK (chapters > 0)
);

INSERT INTO canon (book_id, book_number, name, testament, chapters) VALUES
  ('GEN', 1, 'Genesis', 'OT', 50),
  ('EXO', 2, 'Exodus', 'OT', 40),
  ('LEV', 3, 'Leviticus', 'OT', 27),
  ('NUM', 4, 'Numbers', 'OT', 36),
  ('DEU', 5, 'Deuteronomy', 'OT', 34),
  ('JOS', 6, 'Joshua', 'OT', 24),
  ('JDG', 7, 'Judges', 'OT', 21),
  ('RUT', 8, 'Ruth', 'OT', 4),
  ('1SA', 9, '1 Samuel', 'OT', 31),
  ('2SA', 10, '2 Samuel', 'OT', 24),
  ('1KI', 11, '1 Kings', 'OT', 22),
  ('2KI', 12, '2 Kings', 'OT', 25),
  ('1CH', 13, '1 Chronicles', 'OT', 29),
  ('2CH', 14, '2 Chronicles', 'OT', 36),
  ('EZR', 15, 'Ezra', 'OT', 10),
  ('NEH', 16, 'Nehemiah', 'OT', 13),
  ('EST', 17, 'Esther', 'OT', 10),
  ('JOB', 18, 'Job', 'OT', 42),
  ('PSA', 19, 'Psalms', 'OT', 150),
  ('PRO', 20, 'Proverbs', 'OT', 31),
  ('ECC', 21, 'Ecclesiastes', 'OT', 12),
  ('SNG', 22, 'Song of Songs', 'OT', 8),
  ('ISA', 23, 'Isaiah', 'OT', 66),
  ('JER', 24, 'Jeremiah', 'OT', 52),
  ('LAM', 25, 'Lamentations', 'OT', 5),
  ('EZK', 26, 'Ezekiel', 'OT', 48),
  ('DAN', 27, 'Daniel', 'OT', 12),
  ('HOS', 28, 'Hosea', 'OT', 14),
  ('JOL', 29, 'Joel', 'OT', 3),
  ('AMO', 30, 'Amos', 'OT', 9),
  ('OBA', 31, 'Obadiah', 'OT', 1),
  ('JON', 32, 'Jonah', 'OT', 4),
  ('MIC', 33, 'Micah', 'OT', 7),
  ('NAM', 34, 'Nahum', 'OT', 3),
  ('HAB', 35, 'Habakkuk', 'OT', 3),
  ('ZEP', 36, 'Zephaniah', 'OT', 3),
  ('HAG', 37, 'Haggai', 'OT', 2),
  ('ZEC', 38, 'Zechariah', 'OT', 14),
  ('MAL', 39, 'Malachi', 'OT', 4),
  ('MAT', 40, 'Matthew', 'NT', 28),
  ('MRK', 41, 'Mark', 'NT', 16),
  ('LUK', 42, 'Luke', 'NT', 24),
  ('JHN', 43, 'John', 'NT', 21),
  ('ACT', 44, 'Acts', 'NT', 28),
  ('ROM', 45, 'Romans', 'NT', 16),
  ('1CO', 46, '1 Corinthians', 'NT', 16),
  ('2CO', 47, '2 Corinthians', 'NT', 13),
  ('GAL', 48, 'Galatians', 'NT', 6),
  ('EPH', 49, 'Ephesians', 'NT', 6),
  ('PHP', 50, 'Philippians', 'NT', 4),
  ('COL', 51, 'Colossians', 'NT', 4),
  ('1TH', 52, '1 Thessalonians', 'NT', 5),
  ('2TH', 53, '2 Thessalonians', 'NT', 3),
  ('1TI', 54, '1 Timothy', 'NT', 6),
  ('2TI', 55, '2 Timothy', 'NT', 4),
  ('TIT', 56, 'Titus', 'NT', 3),
  ('PHM', 57, 'Philemon', 'NT', 1),
  ('HEB', 58, 'Hebrews', 'NT', 13),
  ('JAS', 59, 'James', 'NT', 5),
  ('1PE', 60, '1 Peter', 'NT', 5),
  ('2PE', 61, '2 Peter', 'NT', 3),
  ('1JN', 62, '1 John', 'NT', 5),
  ('2JN', 63, '2 John', 'NT', 1),
  ('3JN', 64, '3 John', 'NT', 1),
  ('JUD', 65, 'Jude', 'NT', 1),
  ('REV', 66, 'Revelation', 'NT', 22)
;

-- ref is book, chapter and verse as one number, BBCCCVVV (Romans 3:23 = 45003023), so any passage, even one
-- across chapters, is one range.
CREATE TABLE verses (
  translation_id text NOT NULL,
  ref int NOT NULL,
  book_id text NOT NULL REFERENCES canon (book_id),
  chapter int NOT NULL,
  verse int NOT NULL CHECK (verse > 0),
  text text NOT NULL,
  search tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  PRIMARY KEY (translation_id, ref),
  FOREIGN KEY (translation_id, book_id, chapter) REFERENCES chapters (translation_id, book_id, chapter) ON DELETE CASCADE
);
CREATE INDEX verses_chapter ON verses (translation_id, book_id, chapter);
CREATE INDEX verses_search ON verses USING gin (search);

-- seq keeps a chapter's headings and notes in the order the source has them.
CREATE TABLE headings (
  translation_id text NOT NULL,
  book_id text NOT NULL,
  chapter int NOT NULL,
  seq int NOT NULL,
  ref int NOT NULL,
  level int,
  text text NOT NULL,
  PRIMARY KEY (translation_id, book_id, chapter, seq),
  FOREIGN KEY (translation_id, book_id, chapter) REFERENCES chapters (translation_id, book_id, chapter) ON DELETE CASCADE
);
CREATE INDEX headings_ref ON headings (translation_id, ref);

CREATE TABLE verse_notes (
  translation_id text NOT NULL,
  book_id text NOT NULL,
  chapter int NOT NULL,
  seq int NOT NULL,
  ref int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('footnote', 'crossref')),
  text text NOT NULL,
  passage text,
  PRIMARY KEY (translation_id, book_id, chapter, seq),
  FOREIGN KEY (translation_id, book_id, chapter) REFERENCES chapters (translation_id, book_id, chapter) ON DELETE CASCADE
);
CREATE INDEX verse_notes_ref ON verse_notes (translation_id, ref);

-- Fill the new tables from chapters already imported. A footnote the ESV import wrote as "Cross-reference: …" is
-- a cross reference; heading levels are not in the stored copy and stay null until the next import.
INSERT INTO verses (translation_id, ref, book_id, chapter, verse, text)
SELECT c.translation_id, k.book_number * 1000000 + c.chapter * 1000 + (v ->> 'number')::int, c.book_id, c.chapter, (v ->> 'number')::int, v ->> 'text'
FROM chapters c
JOIN canon k ON k.book_id = c.book_id
CROSS JOIN LATERAL jsonb_array_elements(c.content::jsonb -> 'verses') v;

INSERT INTO headings (translation_id, book_id, chapter, seq, ref, level, text)
SELECT c.translation_id, c.book_id, c.chapter, h.seq::int, k.book_number * 1000000 + c.chapter * 1000 + (h.item ->> 'beforeVerse')::int, NULL, h.item ->> 'text'
FROM chapters c
JOIN canon k ON k.book_id = c.book_id
CROSS JOIN LATERAL jsonb_array_elements(c.content::jsonb -> 'headings') WITH ORDINALITY AS h (item, seq);

INSERT INTO verse_notes (translation_id, book_id, chapter, seq, ref, kind, text, passage)
SELECT c.translation_id, c.book_id, c.chapter, n.seq::int, k.book_number * 1000000 + c.chapter * 1000 + (n.item ->> 'verse')::int,
  CASE WHEN n.item ->> 'text' LIKE 'Cross-reference: %' THEN 'crossref' ELSE 'footnote' END,
  CASE WHEN n.item ->> 'text' LIKE 'Cross-reference: %' THEN substr(n.item ->> 'text', 18) ELSE n.item ->> 'text' END,
  NULL
FROM chapters c
JOIN canon k ON k.book_id = c.book_id
CROSS JOIN LATERAL jsonb_array_elements(c.content::jsonb -> 'footnotes') WITH ORDINALITY AS n (item, seq);

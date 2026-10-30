-- Translations, the book catalog, chapter text and the import log (S2).

CREATE TABLE translations (
  id text PRIMARY KEY CHECK (id IN ('BSB', 'CSB')),
  name text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('aolab', 'apibible')),
  edition jsonb,
  license_summary text NOT NULL,
  copyright_notice text NOT NULL
);

INSERT INTO translations (id, name, source_kind, license_summary, copyright_notice) VALUES
  ('BSB', 'Berean Standard Bible', 'aolab', 'Public domain (dedicated by the Berean Bible publisher).',
   'The Holy Bible, Berean Standard Bible, BSB is produced in cooperation with Bible Hub, Discovery Bible, OpenBible.com, and the Berean Bible Translation Committee. This text of God''s Word has been dedicated to the public domain.'),
  ('CSB', 'Christian Standard Bible', 'apibible', 'Licensed through API.Bible; cached at most 14 days.',
   'Scripture quotations marked CSB have been taken from the Christian Standard Bible®, Copyright © 2017 by Holman Bible Publishers. Used by permission. Christian Standard Bible® and CSB® are federally registered trademarks of Holman Bible Publishers.');

CREATE TABLE books (
  translation_id text NOT NULL REFERENCES translations (id),
  book_id text NOT NULL,
  name text NOT NULL,
  book_order int NOT NULL,
  chapters int NOT NULL CHECK (chapters > 0),
  PRIMARY KEY (translation_id, book_id)
);

-- `content` is kept as text, not jsonb, so the bytes that content_sha256 hashes are the bytes served (I-10).
CREATE TABLE chapters (
  translation_id text NOT NULL REFERENCES translations (id),
  book_id text NOT NULL,
  chapter int NOT NULL CHECK (chapter > 0),
  verse_count int NOT NULL CHECK (verse_count > 0),
  content text NOT NULL,
  content_sha256 text NOT NULL,
  source_ref text NOT NULL,
  fetched_at timestamptz NOT NULL,
  expires_at timestamptz,
  PRIMARY KEY (translation_id, book_id, chapter)
);

CREATE TABLE import_manifests (
  id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  scope jsonb NOT NULL,
  source_versions jsonb NOT NULL,
  items jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed'))
);

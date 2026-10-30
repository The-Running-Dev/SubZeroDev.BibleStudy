-- Narrators, recorded chapters and on-demand audio jobs (S3).

-- A narrator is offered and imported only while enabled, and enabling needs a recorded license source (I-14).
CREATE TABLE narrators (
  id text PRIMARY KEY,
  translation_id text NOT NULL REFERENCES translations (id),
  display_name text NOT NULL,
  license text,
  license_source text,
  enabled boolean NOT NULL DEFAULT false,
  CHECK (NOT enabled OR (license IS NOT NULL AND license_source IS NOT NULL))
);

-- The Berean Bible publisher releases these BSB recordings as CC0 (D-2026-10-30-06).
-- `david` stays disabled until its license source is recorded.
INSERT INTO narrators (id, translation_id, display_name, license, license_source, enabled) VALUES
  ('souer', 'BSB', 'Bob Souer', 'CC0 1.0', 'https://bereanbible.com/audio/', true),
  ('hays', 'BSB', 'Barry Hays', 'CC0 1.0', 'https://bereanbible.com/audio/', true),
  ('david', 'BSB', 'David', NULL, NULL, false);

CREATE TABLE recordings (
  id uuid PRIMARY KEY,
  translation_id text NOT NULL,
  book_id text NOT NULL,
  chapter int NOT NULL,
  narrator_id text NOT NULL REFERENCES narrators (id),
  media_sha256 text NOT NULL CHECK (media_sha256 ~ '^[0-9a-f]{64}$'),
  bytes bigint NOT NULL CHECK (bytes > 0),
  duration_seconds double precision NOT NULL CHECK (duration_seconds > 0),
  mime_type text NOT NULL,
  source_url text NOT NULL,
  imported_at timestamptz NOT NULL,
  timing jsonb,
  timing_status text NOT NULL CHECK (timing_status IN ('verified', 'absent', 'rejected')),
  timing_reason text,
  FOREIGN KEY (translation_id, book_id, chapter) REFERENCES chapters (translation_id, book_id, chapter),
  UNIQUE (translation_id, book_id, chapter, narrator_id),
  CHECK ((timing_status = 'verified') = (timing_reason IS NULL))
);

CREATE INDEX recordings_media_sha256 ON recordings (media_sha256);

-- One row per chapter and narrator whose audio is being fetched on first request, or whose fetch failed.
-- The row is deleted once the recording is stored.
CREATE TABLE audio_jobs (
  translation_id text NOT NULL,
  book_id text NOT NULL,
  chapter int NOT NULL,
  narrator_id text NOT NULL REFERENCES narrators (id),
  status text NOT NULL CHECK (status IN ('preparing', 'failed')),
  reason text,
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  claimed_at timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (translation_id, book_id, chapter, narrator_id)
);

CREATE INDEX audio_jobs_due ON audio_jobs (status, next_attempt_at);

-- The group's stopping point (S9): append-only, the newest row is where Resume study opens. Only an explicit
-- confirmation writes a row (I-19), never playback, browsing or setup on its own.

CREATE TABLE group_progress (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES groups (id),
  book_id text NOT NULL,
  chapter integer NOT NULL CHECK (chapter > 0),
  verse integer NOT NULL CHECK (verse > 0),
  confirmed_by uuid NOT NULL REFERENCES users (id),
  confirmed_at timestamptz NOT NULL,
  session_id uuid REFERENCES study_sessions (id),
  -- The row the confirming member last saw; null only for the group's first stopping point.
  based_on_id uuid REFERENCES group_progress (id),
  -- Two confirmations based on the same row cannot both land (stale_progress).
  UNIQUE NULLS NOT DISTINCT (group_id, based_on_id)
);
CREATE INDEX group_progress_latest ON group_progress (group_id, confirmed_at DESC, id DESC);

-- The furthest verse the session reached on its current chapter, for the wrap-up suggestion. Starts over when the
-- passage moves to another chapter; it is never the group's stopping point by itself.
ALTER TABLE study_sessions ADD COLUMN reached_verse integer CHECK (reached_verse > 0);

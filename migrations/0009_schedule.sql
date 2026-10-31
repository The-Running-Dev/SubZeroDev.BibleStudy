-- Meeting occurrences (S10), materialized from the group's weekly schedule on a rolling eight-week window. Each row is
-- anchored to a wall-clock date and time in a zone; starts_at is derived from them (I-06), never taken as input.

CREATE TABLE occurrences (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES groups (id),
  -- The weekly slot the row was generated for. Regeneration finds rows by it, so a moved meeting is not made twice.
  slot_date text NOT NULL CHECK (slot_date ~ '^\d{4}-\d{2}-\d{2}$'),
  local_date text NOT NULL CHECK (local_date ~ '^\d{4}-\d{2}-\d{2}$'),
  local_time text NOT NULL CHECK (local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  time_zone text NOT NULL,
  starts_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
  -- A member moved it; a schedule change leaves its date and time alone.
  moved boolean NOT NULL DEFAULT false,
  planned_book_id text,
  planned_chapter integer CHECK (planned_chapter > 0),
  planned_start_verse integer CHECK (planned_start_verse > 0),
  planned_end_verse integer CHECK (planned_end_verse >= planned_start_verse),
  revision integer NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES users (id),
  updated_at timestamptz NOT NULL,
  UNIQUE (group_id, slot_date),
  CHECK ((planned_book_id IS NULL) = (planned_chapter IS NULL))
);
-- At most one scheduled meeting a day.
CREATE UNIQUE INDEX occurrences_one_a_day ON occurrences (group_id, local_date) WHERE status = 'scheduled';
CREATE INDEX occurrences_starts_at ON occurrences (starts_at);

-- Reminder emails (S11). A member's preference per group, and one delivery row per (occurrence revision, member,
-- offset) the tick has scheduled (I-07). A delivery is the record of what was owed; the email itself is an email_jobs row.

CREATE TABLE reminder_preferences (
  user_id uuid NOT NULL REFERENCES users (id),
  group_id uuid NOT NULL REFERENCES groups (id),
  enabled boolean NOT NULL DEFAULT true,
  offsets_minutes integer[] NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, group_id),
  CHECK (cardinality(offsets_minutes) <= 5),
  CHECK (5 <= ALL (offsets_minutes) AND 10080 >= ALL (offsets_minutes))
);

CREATE TABLE reminder_deliveries (
  id uuid PRIMARY KEY,
  occurrence_id uuid NOT NULL REFERENCES occurrences (id) ON DELETE CASCADE,
  occurrence_revision integer NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id),
  offset_minutes integer NOT NULL,
  send_after timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'suppressed', 'failed')),
  -- Set when the email is queued; the delivery stays pending until that job is sent or fails.
  email_job_id uuid REFERENCES email_jobs (id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (occurrence_id, occurrence_revision, user_id, offset_minutes)
);
CREATE INDEX reminder_deliveries_status_send_after ON reminder_deliveries (status, send_after);

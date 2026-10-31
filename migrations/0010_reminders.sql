-- Reminder emails (S11). A member's preference per group, and one live delivery row per (occurrence revision, member,
-- offset) the tick has scheduled (I-07). A delivery is the record of what was owed; the email itself is an email_jobs row.
-- A suppressed delivery no longer counts, so a reminder turned off and on again, or a member who rejoins, is owed anew.

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
  -- Null once a schedule change deleted the meeting; the row stays as the record of what was sent or taken back.
  occurrence_id uuid REFERENCES occurrences (id) ON DELETE SET NULL,
  occurrence_revision integer NOT NULL,
  group_id uuid NOT NULL REFERENCES groups (id),
  user_id uuid NOT NULL REFERENCES users (id),
  offset_minutes integer NOT NULL,
  send_after timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'suppressed', 'failed')),
  -- Set when the email is queued; the delivery stays pending until that job is sent or fails.
  email_job_id uuid REFERENCES email_jobs (id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX reminder_deliveries_live ON reminder_deliveries (occurrence_id, occurrence_revision, user_id, offset_minutes)
  WHERE status <> 'suppressed';
CREATE INDEX reminder_deliveries_status_send_after ON reminder_deliveries (status, send_after);
CREATE INDEX reminder_deliveries_group_user ON reminder_deliveries (group_id, user_id, send_after);

-- Live study sessions, their playback state, commands and drift samples (S5).

CREATE TABLE study_sessions (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES groups (id),
  occurrence_id uuid,
  status text NOT NULL CHECK (status IN ('active', 'ended')),
  started_by uuid NOT NULL REFERENCES users (id),
  started_at timestamptz NOT NULL,
  ended_by uuid REFERENCES users (id),
  ended_at timestamptz,
  -- PlaybackState. While playing, the position is derived from the anchor, never stored (design: PlaybackState).
  revision integer NOT NULL CHECK (revision >= 0),
  book_id text NOT NULL,
  chapter integer NOT NULL CHECK (chapter > 0),
  start_verse integer CHECK (start_verse > 0),
  end_verse integer CHECK (end_verse >= start_verse),
  translation_id text NOT NULL CHECK (translation_id IN ('BSB', 'CSB')),
  narrator_id text REFERENCES narrators (id),
  recording_id uuid REFERENCES recordings (id),
  mode text NOT NULL CHECK (mode IN ('narration', 'manual')),
  play_status text NOT NULL CHECK (play_status IN ('paused', 'playing', 'ended')),
  position_seconds double precision NOT NULL CHECK (position_seconds >= 0),
  anchor_server_time_ms bigint NOT NULL,
  rate numeric(3, 2) NOT NULL CHECK (rate BETWEEN 0.75 AND 1.5),
  manual_verse integer CHECK (manual_verse > 0),
  changed_by uuid REFERENCES users (id),
  changed_at timestamptz NOT NULL,
  paused_reason text CHECK (paused_reason IN ('member', 'room_empty', 'server_restart', 'range_end')),
  CHECK ((status = 'ended') = (ended_at IS NOT NULL)),
  CHECK (play_status <> 'playing' OR (mode = 'narration' AND recording_id IS NOT NULL))
);
-- I-15: at most one active session per group.
CREATE UNIQUE INDEX study_sessions_one_active ON study_sessions (group_id) WHERE status = 'active';

-- Each client command, so a retry returns its first outcome instead of applying twice (I-16).
CREATE TABLE session_commands (
  command_id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES study_sessions (id),
  user_id uuid NOT NULL REFERENCES users (id),
  kind text NOT NULL,
  expected_revision integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('applied', 'rejected_stale', 'rejected_invalid')),
  reason text,
  resulting_revision integer NOT NULL,
  received_at timestamptz NOT NULL
);
CREATE INDEX session_commands_session ON session_commands (session_id, received_at);

-- Drift each ready client measured while playing, for the DOD-09 report.
CREATE TABLE drift_samples (
  session_id uuid NOT NULL REFERENCES study_sessions (id),
  client_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id),
  drift_ms double precision NOT NULL,
  recorded_at timestamptz NOT NULL
);
CREATE INDEX drift_samples_session ON drift_samples (session_id, recorded_at);

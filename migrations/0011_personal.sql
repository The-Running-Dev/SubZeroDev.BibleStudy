-- A member's own study data (S12): notes, note conflicts, the solo reading position, and the sync operations that
-- wrote them. Only the owning user reads or writes any of it (I-21); no group query joins these tables.

-- Every write to a note or solo position takes the next value, so `pull` returns what changed after a cursor.
-- Writes for one user are serialised by an advisory lock, so their values rise in commit order.
CREATE SEQUENCE personal_changes;

CREATE TABLE notes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  translation_id text NOT NULL REFERENCES translations (id),
  book_id text NOT NULL,
  chapter integer NOT NULL CHECK (chapter > 0),
  start_verse integer CHECK (start_verse > 0),
  end_verse integer CHECK (end_verse >= start_verse),
  body text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL,
  -- A deleted note keeps its row, with the body removed, so other devices learn of the delete.
  deleted_at timestamptz,
  device_id text NOT NULL,
  change_seq bigint NOT NULL DEFAULT nextval('personal_changes'),
  CHECK ((start_verse IS NULL) = (end_verse IS NULL))
);
CREATE INDEX notes_user_updated ON notes (user_id, updated_at);
CREATE INDEX notes_user_change ON notes (user_id, change_seq);

-- A stale edit with a different body: neither side is lost. Resolution comes with S15.
CREATE TABLE note_conflicts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  note_id uuid NOT NULL REFERENCES notes (id),
  base_revision integer,
  server_revision integer NOT NULL,
  server_body text NOT NULL,
  incoming_body text NOT NULL,
  incoming_device_id text NOT NULL,
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolution text CHECK (resolution IN ('kept_server', 'kept_incoming', 'kept_both'))
);
CREATE INDEX note_conflicts_open ON note_conflicts (user_id) WHERE resolved_at IS NULL;

-- Where the member last read alone. Never the group's stopping point, and never changes it (S12.2).
CREATE TABLE solo_positions (
  user_id uuid PRIMARY KEY REFERENCES users (id),
  translation_id text NOT NULL REFERENCES translations (id),
  book_id text NOT NULL,
  chapter integer NOT NULL CHECK (chapter > 0),
  verse integer NOT NULL CHECK (verse > 0),
  revision integer NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL,
  change_seq bigint NOT NULL DEFAULT nextval('personal_changes')
);

-- Each applied operation, so a retried push returns the first outcome instead of applying twice (I-22).
CREATE TABLE sync_operations (
  op_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  entity text NOT NULL CHECK (entity IN ('note', 'solo_position')),
  entity_id uuid,
  base_revision integer,
  outcome text NOT NULL CHECK (outcome IN ('applied', 'already_applied', 'conflict')),
  resulting_revision integer NOT NULL,
  conflict_id uuid REFERENCES note_conflicts (id),
  received_at timestamptz NOT NULL
);
CREATE INDEX sync_operations_user ON sync_operations (user_id);

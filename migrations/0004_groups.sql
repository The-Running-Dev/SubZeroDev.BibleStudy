-- Groups, memberships and invitations (S4). One group in v1; every row carries group_id so a second needs no migration.

CREATE TABLE groups (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  owner_id uuid NOT NULL REFERENCES users (id),
  shared_translation_id text NOT NULL DEFAULT 'BSB' CHECK (shared_translation_id IN ('BSB', 'CSB')),
  narrator_id text,
  rate numeric(3, 2) NOT NULL DEFAULT 1.0 CHECK (rate BETWEEN 0.75 AND 1.5),
  -- ISO weekday, 1 = Monday.
  schedule_weekday integer NOT NULL CHECK (schedule_weekday BETWEEN 1 AND 7),
  schedule_local_time text NOT NULL CHECK (schedule_local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  schedule_time_zone text NOT NULL,
  start_book_id text NOT NULL,
  start_chapter integer NOT NULL CHECK (start_chapter > 0),
  created_at timestamptz NOT NULL
);

CREATE TABLE memberships (
  group_id uuid NOT NULL REFERENCES groups (id),
  user_id uuid NOT NULL REFERENCES users (id),
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at timestamptz NOT NULL,
  removed_at timestamptz,
  PRIMARY KEY (group_id, user_id),
  CHECK (role = 'member' OR removed_at IS NULL)
);
CREATE UNIQUE INDEX memberships_one_owner ON memberships (group_id) WHERE role = 'owner';
CREATE INDEX memberships_user_id ON memberships (user_id) WHERE removed_at IS NULL;

CREATE TABLE invitations (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES groups (id),
  token_hash text NOT NULL,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  accepted_by uuid REFERENCES users (id),
  accepted_at timestamptz,
  CHECK ((accepted_by IS NULL) = (accepted_at IS NULL))
);
CREATE UNIQUE INDEX invitations_token_hash_key ON invitations (token_hash);
CREATE INDEX invitations_group_created ON invitations (group_id, created_at);

-- The invitation a code was requested through, kept with the code so sign-in can join the group.
ALTER TABLE login_codes ADD COLUMN invitation_id uuid REFERENCES invitations (id);

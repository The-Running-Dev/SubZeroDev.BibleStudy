-- Questions and replies on a passage, owned by the group rather than a session (S8), and the dispositions behind their status (S9).

CREATE TABLE questions (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES groups (id),
  author_id uuid NOT NULL REFERENCES users (id),
  client_op_id uuid NOT NULL,
  -- The anchor. Both verses null is a chapter question; start = end a verse question; otherwise a range.
  translation_id text NOT NULL CHECK (translation_id IN ('BSB', 'CSB')),
  book_id text NOT NULL,
  chapter integer NOT NULL CHECK (chapter > 0),
  start_verse integer CHECK (start_verse > 0),
  end_verse integer CHECK (end_verse >= start_verse),
  body text,
  body_removed_at timestamptz,
  edited_at timestamptz,
  created_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'closed', 'carried', 'resolved', 'no_longer_relevant')),
  revision integer NOT NULL CHECK (revision >= 0),
  -- Raised by every change to the question or its replies, so clients can order what they receive.
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  CHECK ((start_verse IS NULL) = (end_verse IS NULL)),
  -- I-20: a removed post keeps its row but not its body. A deleted post keeps it too, so its clientOpId stays used.
  CHECK ((body IS NULL) = (body_removed_at IS NOT NULL)),
  UNIQUE (author_id, client_op_id)
);
CREATE INDEX questions_passage ON questions (group_id, book_id, chapter);

CREATE TABLE replies (
  id uuid PRIMARY KEY,
  question_id uuid NOT NULL REFERENCES questions (id),
  author_id uuid NOT NULL REFERENCES users (id),
  client_op_id uuid NOT NULL,
  body text,
  body_removed_at timestamptz,
  edited_at timestamptz,
  created_at timestamptz NOT NULL,
  revision integer NOT NULL CHECK (revision >= 0),
  CHECK ((body IS NULL) = (body_removed_at IS NOT NULL)),
  UNIQUE (author_id, client_op_id)
);
CREATE INDEX replies_question ON replies (question_id, created_at);

-- Append-only history behind questions.status.
CREATE TABLE question_dispositions (
  id uuid PRIMARY KEY,
  question_id uuid NOT NULL REFERENCES questions (id),
  session_id uuid REFERENCES study_sessions (id),
  status text NOT NULL CHECK (status IN ('closed', 'carried', 'resolved', 'no_longer_relevant')),
  decided_by uuid NOT NULL REFERENCES users (id),
  decided_at timestamptz NOT NULL
);
CREATE INDEX question_dispositions_question ON question_dispositions (question_id, decided_at);

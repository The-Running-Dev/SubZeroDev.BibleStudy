-- The owner's study-assistant conversations, their turns and the runtime transcript (S6).

CREATE TABLE assistant_conversations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  -- The AgentConsole session the connector created for it; never sent to the browser (I-25).
  runtime_session_id text,
  created_at timestamptz NOT NULL
);
CREATE INDEX assistant_conversations_user ON assistant_conversations (user_id, created_at DESC);

CREATE TABLE assistant_turns (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES assistant_conversations (id),
  client_turn_id uuid NOT NULL,
  prompt text NOT NULL,
  -- The translation, reference and exact verse text sent with the prompt.
  context jsonb NOT NULL,
  -- Runtime turn ids are unique only within a runtime session, and a conversation moves to a new session
  -- when the runtime loses the old one.
  runtime_session_id text,
  runtime_turn_id text,
  status text NOT NULL CHECK (status IN ('queued', 'dispatched', 'streaming', 'completed', 'interrupted', 'failed', 'uncertain')),
  failure text,
  created_at timestamptz NOT NULL,
  -- I-23: a clientTurnId creates at most one turn.
  UNIQUE (conversation_id, client_turn_id)
);
-- I-23: at most one unfinished turn per conversation.
CREATE UNIQUE INDEX assistant_turns_one_active ON assistant_turns (conversation_id)
  WHERE status IN ('queued', 'dispatched', 'streaming', 'uncertain');
CREATE INDEX assistant_turns_runtime ON assistant_turns (conversation_id, runtime_session_id, runtime_turn_id);

-- I-24: one entry per runtime event sequence number, so a replay after a reconnect adds nothing. Sequence
-- numbers restart in a new runtime session; `position` orders the whole conversation for the reader.
CREATE TABLE transcript_entries (
  position bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  conversation_id uuid NOT NULL REFERENCES assistant_conversations (id),
  runtime_session_id text NOT NULL,
  runtime_seq bigint NOT NULL CHECK (runtime_seq > 0),
  turn_id uuid NOT NULL REFERENCES assistant_turns (id),
  kind text NOT NULL CHECK (kind IN ('assistant_message', 'status')),
  text text NOT NULL,
  received_at timestamptz NOT NULL,
  PRIMARY KEY (conversation_id, runtime_session_id, runtime_seq)
);

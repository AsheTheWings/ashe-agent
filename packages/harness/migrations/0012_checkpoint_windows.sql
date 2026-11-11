-- Conversation state replaces LangGraph's checkpoints. Each row is owned
-- by the turn that made it, or by no turn when session creation made it,
-- so deleting turns deletes their rows.
DROP TABLE checkpoint_writes;
DROP TABLE checkpoint_blobs;
DROP TABLE checkpoints;
ALTER TABLE turns DROP COLUMN checkpoint_id;

-- A checkpoint window, numbered within its session; the newest is the
-- session's current one.
CREATE TABLE checkpoint_windows (
  session_id TEXT NOT NULL REFERENCES sessions (id),
  position INTEGER NOT NULL,
  run_id TEXT,
  -- The harness instructions of its first user input's `<system>` block.
  harness_instructions TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, position),
  FOREIGN KEY (session_id, run_id) REFERENCES turns (session_id, run_id) ON DELETE CASCADE
) STRICT;

-- One item of a checkpoint window, numbered within its session in window
-- order: a developer component, a user message, an assistant message, or
-- a tool result, as JSON, with the model of the turn that owns it.
CREATE TABLE window_items (
  session_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  window_position INTEGER NOT NULL,
  run_id TEXT,
  model TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('component', 'user', 'assistant', 'result')),
  body TEXT NOT NULL,
  PRIMARY KEY (session_id, position),
  FOREIGN KEY (session_id, window_position) REFERENCES checkpoint_windows (session_id, position) ON DELETE CASCADE,
  FOREIGN KEY (session_id, run_id) REFERENCES turns (session_id, run_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX window_items_window ON window_items (session_id, window_position, position);

-- A tool result item replaced by a placeholder, owned by the turn that
-- cleared it, with the clearing attempt that did.
CREATE TABLE tool_result_clearings (
  session_id TEXT NOT NULL,
  item_position INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  PRIMARY KEY (session_id, item_position),
  FOREIGN KEY (session_id, item_position) REFERENCES window_items (session_id, position) ON DELETE CASCADE,
  FOREIGN KEY (session_id, run_id) REFERENCES turns (session_id, run_id) ON DELETE CASCADE
) STRICT;

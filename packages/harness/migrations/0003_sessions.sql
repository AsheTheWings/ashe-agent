-- Sessions, their numbered events, and their turns.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  agent TEXT,
  model TEXT NOT NULL,
  -- The instructions recorded at creation, used for every model call.
  instructions TEXT,
  forked_from_session TEXT,
  forked_from_run TEXT,
  created_at INTEGER NOT NULL,
  -- The next event's sequence number; it only increases.
  next_seq INTEGER NOT NULL
) STRICT;

CREATE TABLE events (
  session_id TEXT NOT NULL REFERENCES sessions (id),
  seq INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) STRICT;

-- A turn, started by one user input; `first_seq` is the sequence number
-- of that input's event, where a rewind of the turn starts removing.
CREATE TABLE turns (
  session_id TEXT NOT NULL REFERENCES sessions (id),
  run_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  input_id TEXT NOT NULL,
  input_text TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'finished', 'cancelled', 'failed', 'interrupted')),
  first_seq INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  PRIMARY KEY (session_id, run_id),
  UNIQUE (session_id, position)
) STRICT;

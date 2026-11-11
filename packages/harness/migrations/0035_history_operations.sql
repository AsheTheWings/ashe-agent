-- Durable owner control-operation identities and their results. A started
-- row without a result is an explicit unresolved acknowledgement; a later
-- retry resolves it instead of creating a second branch or rerun.
CREATE TABLE history_operations (
  session_id TEXT NOT NULL REFERENCES sessions (id),
  operation_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('rewind', 'fork')),
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded')),
  result TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY (session_id, operation_id)
) STRICT;

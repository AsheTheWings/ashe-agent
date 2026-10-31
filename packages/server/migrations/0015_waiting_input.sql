-- User messages and notification components waiting for a turn, in
-- arrival order within their session, as JSON; the transaction that a
-- turn takes one in deletes it.
CREATE TABLE waiting_input (
  session_id TEXT NOT NULL REFERENCES sessions (id),
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'notification')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, position)
) STRICT;

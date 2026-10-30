-- Session-scoped allow rules that `always` answers add, in the order added.
CREATE TABLE session_grants (
  session_id TEXT NOT NULL REFERENCES sessions (id),
  position INTEGER NOT NULL,
  permission TEXT NOT NULL,
  pattern TEXT NOT NULL,
  PRIMARY KEY (session_id, position)
) STRICT;

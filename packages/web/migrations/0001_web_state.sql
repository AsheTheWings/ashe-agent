CREATE TABLE web_binding (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  harness_id TEXT NOT NULL,
  bound_at INTEGER NOT NULL
);

CREATE TABLE web_sessions (
  session_id TEXT PRIMARY KEY,
  pinned INTEGER NOT NULL DEFAULT 0,
  filed INTEGER NOT NULL DEFAULT 0,
  snoozed_until INTEGER,
  unread INTEGER NOT NULL DEFAULT 1,
  read_generation INTEGER NOT NULL DEFAULT 0,
  working INTEGER NOT NULL DEFAULT 0,
  needs_human INTEGER NOT NULL DEFAULT 0,
  available INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER NOT NULL,
  last_submission_at INTEGER NOT NULL,
  last_return_at INTEGER NOT NULL,
  source_cursor INTEGER NOT NULL DEFAULT 0,
  opted_out INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE web_operations (
  operation_id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  kind TEXT NOT NULL,
  session_id TEXT,
  payload_hash TEXT NOT NULL,
  outcome TEXT NOT NULL,
  revision INTEGER NOT NULL,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE web_observer_sessions (
  session_id TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL DEFAULT 0,
  reconciled_at INTEGER NOT NULL
);

CREATE TABLE web_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

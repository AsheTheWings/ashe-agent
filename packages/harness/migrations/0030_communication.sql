-- Session subscriptions, future-only publication delivery, causal reaction
-- roots, and durable agent-fork intents. Publications copy their attributed
-- content, so a source rewind cannot remove a recipient's pending or admitted
-- copy. The initial subscription tables were never used and carried no rows;
-- replace them with the turn-owned operation and current-filter shapes.

DROP TABLE subscriptions;
DROP TABLE subscription_operations;

CREATE TABLE session_subscriptions (
  receiver_session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  source_session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  messages TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (receiver_session_id, source_session_id)
) STRICT;

CREATE TABLE subscription_operations (
  operation_id TEXT PRIMARY KEY,
  receiver_session_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('subscribe', 'unsubscribe')),
  messages TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (receiver_session_id, run_id) REFERENCES turns (session_id, run_id) ON DELETE CASCADE,
  FOREIGN KEY (source_session_id) REFERENCES sessions (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX subscription_operations_run
  ON subscription_operations (receiver_session_id, run_id);

CREATE TABLE subscription_publications (
  publication_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  source_session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  source_message_id TEXT,
  category TEXT NOT NULL CHECK (category IN ('user', 'agent_intermediate', 'agent_final', 'abnormal')),
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  root_id TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE subscription_deliveries (
  publication_id TEXT NOT NULL REFERENCES subscription_publications (publication_id) ON DELETE CASCADE,
  receiver_session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  input_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'admitted', 'removed')),
  root_id TEXT,
  visited TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  admitted_at INTEGER,
  PRIMARY KEY (publication_id, receiver_session_id)
) STRICT;

CREATE INDEX subscription_deliveries_pending
  ON subscription_deliveries (receiver_session_id, status);

CREATE TABLE turn_reactions (
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  visited TEXT NOT NULL,
  automatic INTEGER NOT NULL CHECK (automatic IN (0, 1)),
  PRIMARY KEY (session_id, run_id, root_id),
  FOREIGN KEY (session_id, run_id) REFERENCES turns (session_id, run_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE agent_fork_intents (
  intent_id TEXT PRIMARY KEY,
  source_session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  source_run_id TEXT NOT NULL,
  source_invocation_id TEXT NOT NULL,
  source_model_call_id TEXT NOT NULL,
  source_provider_call_id TEXT NOT NULL,
  branch_session_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('preparing', 'ready')),
  created_at INTEGER NOT NULL,
  UNIQUE (source_session_id, source_invocation_id)
) STRICT;

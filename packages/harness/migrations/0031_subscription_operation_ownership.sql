CREATE TABLE subscription_operations_new (
  operation_id TEXT PRIMARY KEY,
  receiver_session_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  actor_session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('subscribe', 'unsubscribe')),
  messages TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (actor_session_id, run_id) REFERENCES turns (session_id, run_id) ON DELETE CASCADE,
  FOREIGN KEY (receiver_session_id) REFERENCES sessions (id) ON DELETE CASCADE,
  FOREIGN KEY (source_session_id) REFERENCES sessions (id) ON DELETE CASCADE
) STRICT;

INSERT INTO subscription_operations_new
  (operation_id, receiver_session_id, source_session_id, actor_session_id, run_id, action, messages, created_at)
SELECT operation_id, receiver_session_id, source_session_id, receiver_session_id, run_id, action, messages, created_at
FROM subscription_operations;

DROP TABLE subscription_operations;
ALTER TABLE subscription_operations_new RENAME TO subscription_operations;

CREATE INDEX subscription_operations_actor_run
  ON subscription_operations (actor_session_id, run_id);

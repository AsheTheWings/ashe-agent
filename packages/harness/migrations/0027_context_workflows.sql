-- A context workflow spans the turns that carry its injected developer
-- input. Its state survives ordinary turn handoffs and identifies the
-- draft to settle after cancellation, failure, or restart.
CREATE TABLE context_workflows (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id),
  trigger TEXT NOT NULL CHECK (trigger IN ('threshold', 'limit')),
  start_turn_id TEXT NOT NULL,
  current_turn_id TEXT NOT NULL,
  start_item INTEGER NOT NULL,
  clearings INTEGER NOT NULL,
  clearable INTEGER NOT NULL,
  freed INTEGER NOT NULL,
  validations INTEGER NOT NULL,
  compaction_waited INTEGER NOT NULL,
  constructed INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  FOREIGN KEY (session_id, start_turn_id) REFERENCES turns (session_id, run_id),
  FOREIGN KEY (session_id, current_turn_id) REFERENCES turns (session_id, run_id)
) STRICT;

ALTER TABLE turns ADD COLUMN context_workflow_id TEXT;
ALTER TABLE turns ADD COLUMN context_start_item INTEGER;
ALTER TABLE turns DROP COLUMN context_item;
ALTER TABLE turns DROP COLUMN context_trigger;

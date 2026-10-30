-- The first message of every model call of a session, rendered at its
-- creation, and the harness notes waiting for its next turn as a JSON array.
ALTER TABLE sessions ADD COLUMN first_message TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN pending_notes TEXT NOT NULL DEFAULT '[]';

-- The harness notes a turn delivered, as a JSON array, and the last
-- checkpoint of the session's window when the turn ended.
ALTER TABLE turns ADD COLUMN notes TEXT NOT NULL DEFAULT '[]';
ALTER TABLE turns ADD COLUMN checkpoint_id TEXT;

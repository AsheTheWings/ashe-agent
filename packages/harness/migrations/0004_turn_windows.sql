-- The first message of every model call of a session, rendered at its
-- creation, the catalogs it lists as JSON, and the harness notes waiting
-- for its next turn as a JSON array.
ALTER TABLE sessions ADD COLUMN first_message TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN catalogs TEXT NOT NULL DEFAULT '{"skills":null,"codeMode":null}';
ALTER TABLE sessions ADD COLUMN pending_notes TEXT NOT NULL DEFAULT '[]';

-- The fork and rewind notes a turn delivered, as a JSON array, the catalogs the
-- model knew from the turn on, as JSON, and the last checkpoint of the
-- session's window when the turn ended.
ALTER TABLE turns ADD COLUMN notes TEXT NOT NULL DEFAULT '[]';
ALTER TABLE turns ADD COLUMN catalogs TEXT NOT NULL DEFAULT '{"skills":null,"codeMode":null}';
ALTER TABLE turns ADD COLUMN checkpoint_id TEXT;

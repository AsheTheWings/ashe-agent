-- The reasoning effort selected for a session's model, and the selection
-- each turn recorded at its start; null selects the model's default.
ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT;
ALTER TABLE turns ADD COLUMN reasoning_effort TEXT;

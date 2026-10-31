-- A session keeps its agent as recorded at creation: the agent's title,
-- null for the implicit agent, its model setting overrides by model id as
-- a JSON object, and its permission rules as JSON, null when it has none.
ALTER TABLE sessions DROP COLUMN agent;
ALTER TABLE sessions DROP COLUMN instructions;
ALTER TABLE sessions DROP COLUMN agent_settings;
ALTER TABLE sessions ADD COLUMN agent_key TEXT;
ALTER TABLE sessions ADD COLUMN model_overrides TEXT NOT NULL DEFAULT '{}';
ALTER TABLE sessions ADD COLUMN permission TEXT;

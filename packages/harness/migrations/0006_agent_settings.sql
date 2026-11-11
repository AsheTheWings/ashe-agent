-- The settings a session took from its agent at creation, as JSON:
-- temperature, steps, and permission rules, each null when unset.
ALTER TABLE sessions ADD COLUMN agent_settings TEXT NOT NULL DEFAULT '{"temperature":null,"steps":null,"permission":null}';

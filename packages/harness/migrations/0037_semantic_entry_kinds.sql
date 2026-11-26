-- foreign-keys-off
-- Align session_entries.kind values with the canonical semantic entry kinds.

CREATE TABLE session_entries_new (
  session_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  owner_turn_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('system-message', 'developer-message', 'user-message', 'agent-message', 'agent-thought', 'agent-tool')),
  content_sha256 TEXT NOT NULL REFERENCES contents (sha256),
  model_call_id TEXT,
  agent_title TEXT NOT NULL,
  model_id TEXT,
  authorship_session_id TEXT NOT NULL,
  ownership_kind TEXT NOT NULL CHECK (ownership_kind IN ('local', 'inherited')),
  source_session_id TEXT,
  source_entry_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, entry_id),
  UNIQUE (session_id, position),
  FOREIGN KEY (session_id, owner_turn_id) REFERENCES turns (session_id, run_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, model_call_id) REFERENCES model_calls (session_id, model_call_id)
) STRICT;

INSERT INTO session_entries_new
  (session_id, entry_id, position, owner_turn_id, kind, content_sha256, model_call_id,
   agent_title, model_id, authorship_session_id, ownership_kind, source_session_id,
   source_entry_id, created_at)
SELECT session_id, entry_id, position, owner_turn_id,
  CASE kind
    WHEN 'system' THEN 'system-message'
    WHEN 'developer' THEN 'developer-message'
    WHEN 'user' THEN 'user-message'
    WHEN 'agent' THEN 'agent-message'
    WHEN 'thought' THEN 'agent-thought'
    WHEN 'tool' THEN 'agent-tool'
    ELSE kind
  END,
  content_sha256, model_call_id, agent_title, model_id, authorship_session_id,
  ownership_kind, source_session_id, source_entry_id, created_at
FROM session_entries;

DROP VIEW window_items;
DROP VIEW developer_components;
DROP VIEW tool_result_clearings;
DROP TABLE session_entries;
ALTER TABLE session_entries_new RENAME TO session_entries;

CREATE INDEX session_entries_position ON session_entries (session_id, position);

CREATE VIEW window_items AS
SELECT e.session_id, e.position, w.window_position, e.owner_turn_id AS run_id,
  e.model_id AS model,
  CASE e.kind WHEN 'developer-message' THEN 'component' WHEN 'agent-message' THEN 'assistant'
    WHEN 'agent-tool' THEN 'result' WHEN 'user-message' THEN 'user' ELSE e.kind END AS kind,
  CAST(c.data AS TEXT) AS body
FROM session_entries e
JOIN window_entries w ON w.session_id = e.session_id AND w.entry_id = e.entry_id
JOIN contents c ON c.sha256 = e.content_sha256
LEFT JOIN agent_tools a ON a.session_id = e.session_id AND a.entry_id = e.entry_id
WHERE e.kind != 'agent-tool' OR a.settled_at IS NOT NULL;

CREATE VIEW developer_components AS
SELECT e.session_id, e.position AS item_position,
  json_extract(c.data, '$.component.type') AS type,
  json_extract(c.data, '$.component.name') AS name,
  json_extract(c.data, '$.component.heading') AS heading,
  json_extract(c.data, '$.component.text') AS text,
  json_extract(c.data, '$.component.sources') AS sources
FROM session_entries e JOIN contents c ON c.sha256 = e.content_sha256
WHERE e.kind = 'developer-message';

CREATE VIEW tool_result_clearings AS
SELECT r.session_id, e.position AS item_position, r.run_id, r.attempt
FROM context_result_replacements r
JOIN session_entries e ON e.session_id = r.session_id AND e.entry_id = r.entry_id;

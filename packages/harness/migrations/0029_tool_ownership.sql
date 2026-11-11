-- foreign-keys-off

CREATE TABLE agent_tools_new (
  session_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  model_call_id TEXT,
  model_call_unavailable TEXT,
  provider_call_id TEXT,
  parent_invocation_id TEXT,
  name TEXT NOT NULL,
  arguments_ref TEXT NOT NULL REFERENCES contents (sha256),
  started_at INTEGER,
  settled_at INTEGER,
  outcome TEXT CHECK (outcome IN ('success', 'failed', 'canceled', 'declined', 'interrupted')),
  result_ref TEXT REFERENCES contents (sha256),
  PRIMARY KEY (session_id, entry_id),
  CHECK ((model_call_id IS NULL) != (model_call_unavailable IS NULL)),
  FOREIGN KEY (session_id, entry_id) REFERENCES session_entries (session_id, entry_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, model_call_id) REFERENCES model_calls (session_id, model_call_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, parent_invocation_id) REFERENCES agent_tools_new (session_id, entry_id) ON DELETE CASCADE
) STRICT;

INSERT INTO agent_tools_new
  (session_id, entry_id, model_call_id, model_call_unavailable, provider_call_id,
   parent_invocation_id, name, arguments_ref, started_at, settled_at, outcome, result_ref)
SELECT session_id, entry_id,
  CASE WHEN model_call_id LIKE 'unavailable:%' THEN NULL ELSE model_call_id END,
  CASE WHEN model_call_id LIKE 'unavailable:%' THEN 'model call unavailable' ELSE NULL END,
  provider_call_id, parent_invocation_id, name, arguments_ref, started_at, settled_at, outcome, result_ref
FROM agent_tools;

DROP VIEW window_items;
DROP VIEW developer_components;
DROP VIEW tool_result_clearings;
DROP TABLE agent_tools;
ALTER TABLE agent_tools_new RENAME TO agent_tools;

CREATE VIEW window_items AS
SELECT e.session_id, e.position, w.window_position, e.owner_turn_id AS run_id,
  e.model_id AS model,
  CASE e.kind WHEN 'developer' THEN 'component' WHEN 'agent' THEN 'assistant'
    WHEN 'tool' THEN 'result' ELSE e.kind END AS kind,
  CAST(c.data AS TEXT) AS body
FROM session_entries e
JOIN window_entries w ON w.session_id = e.session_id AND w.entry_id = e.entry_id
JOIN contents c ON c.sha256 = e.content_sha256
LEFT JOIN agent_tools a ON a.session_id = e.session_id AND a.entry_id = e.entry_id
WHERE e.kind != 'tool' OR a.settled_at IS NOT NULL;

CREATE VIEW developer_components AS
SELECT e.session_id, e.position AS item_position,
  json_extract(c.data, '$.component.type') AS type,
  json_extract(c.data, '$.component.name') AS name,
  json_extract(c.data, '$.component.heading') AS heading,
  json_extract(c.data, '$.component.text') AS text,
  json_extract(c.data, '$.component.sources') AS sources
FROM session_entries e JOIN contents c ON c.sha256 = e.content_sha256
WHERE e.kind = 'developer';

CREATE VIEW tool_result_clearings AS
SELECT r.session_id, e.position AS item_position, r.run_id, r.attempt
FROM context_result_replacements r
JOIN session_entries e ON e.session_id = r.session_id AND e.entry_id = r.entry_id;

CREATE TABLE request_manifest_rendered (
  session_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  content_ref TEXT NOT NULL REFERENCES contents (sha256),
  PRIMARY KEY (session_id, manifest_id, content_ref),
  FOREIGN KEY (session_id, manifest_id) REFERENCES request_manifests (session_id, manifest_id) ON DELETE CASCADE
) STRICT;

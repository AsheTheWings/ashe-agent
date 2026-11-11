-- foreign-keys-off
-- Canonical semantic history, immutable applied settings, reusable request
-- boundaries, tool lifecycles, retained content, and pending selection patches.
-- Existing window rows are translated into session entries; unavailable provider
-- request facts remain absent instead of being manufactured.

ALTER TABLE contents ADD COLUMN format TEXT NOT NULL DEFAULT 'text/plain';

CREATE TABLE session_settings (
  session_id TEXT NOT NULL REFERENCES sessions (id),
  revision TEXT NOT NULL,
  agent_title TEXT NOT NULL,
  model_id TEXT,
  reasoning_effort TEXT,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, revision)
) STRICT;

INSERT INTO session_settings (session_id, revision, agent_title, model_id, reasoning_effort, applied_at)
SELECT id, 'current', coalesce(agent_key, 'untitled'), model, reasoning_effort, created_at FROM sessions;

CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
  current_settings_revision TEXT NOT NULL,
  model_overrides TEXT NOT NULL DEFAULT '{}',
  permission TEXT,
  forked_from_session TEXT,
  forked_from_run TEXT,
  created_at INTEGER NOT NULL,
  next_seq INTEGER NOT NULL,
  memory_generation INTEGER NOT NULL DEFAULT 0,
  scratch_generation INTEGER NOT NULL DEFAULT 0,
  memory_restore_generation INTEGER NOT NULL DEFAULT 0,
  fork_skipped INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (id, current_settings_revision) REFERENCES session_settings (session_id, revision)
) STRICT;

INSERT INTO sessions_new
  (id, current_settings_revision, model_overrides, permission, forked_from_session, forked_from_run,
   created_at, next_seq, memory_generation, scratch_generation, memory_restore_generation, fork_skipped)
SELECT id, 'current', model_overrides, permission, forked_from_session, forked_from_run,
  created_at, next_seq, memory_generation, scratch_generation, memory_restore_generation, fork_skipped
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE TEMP TABLE turn_change_starts AS
WITH ordered AS (
  SELECT t.session_id, t.run_id, t.position, t.model, t.reasoning_effort, t.started_at,
    coalesce(s.agent_title, 'untitled') AS agent_title,
    lag(t.model) OVER (PARTITION BY t.session_id ORDER BY t.position) AS previous_model,
    lag(t.reasoning_effort) OVER (PARTITION BY t.session_id ORDER BY t.position) AS previous_effort,
    lag(s.agent_title) OVER (PARTITION BY t.session_id ORDER BY t.position) AS previous_title
  FROM turns t JOIN session_settings s ON s.session_id = t.session_id AND s.revision = 'current'
)
SELECT session_id, position, agent_title, model, reasoning_effort, started_at
FROM ordered
WHERE previous_model IS NULL OR model IS NOT previous_model OR reasoning_effort IS NOT previous_effort
  OR agent_title IS NOT previous_title;

INSERT INTO session_settings (session_id, revision, agent_title, model_id, reasoning_effort, applied_at)
SELECT session_id, 'turn:' || position, agent_title, model, reasoning_effort, started_at FROM turn_change_starts;

CREATE TEMP TABLE turn_revision_map AS
SELECT t.session_id, t.position, 'turn:' || max(c.position) AS revision
FROM turns t JOIN turn_change_starts c ON c.session_id = t.session_id AND c.position <= t.position
GROUP BY t.session_id, t.position;

CREATE TEMP TABLE turn_inputs_old AS SELECT * FROM turns;

CREATE TABLE turns_new (
  session_id TEXT NOT NULL REFERENCES sessions (id),
  run_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  settings_revision TEXT NOT NULL,
  cause TEXT NOT NULL CHECK (cause IN ('user', 'continuation', 'notification')),
  user_message_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('running', 'finished', 'cancelled', 'failed', 'interrupted')),
  first_seq INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  context_workflow_id TEXT,
  context_start_item INTEGER,
  PRIMARY KEY (session_id, run_id),
  UNIQUE (session_id, position),
  FOREIGN KEY (session_id, settings_revision) REFERENCES session_settings (session_id, revision)
) STRICT;

INSERT INTO turns_new
  (session_id, run_id, position, settings_revision, cause, user_message_ids, status, first_seq,
   started_at, ended_at, context_workflow_id, context_start_item)
SELECT t.session_id, t.run_id, t.position, m.revision, t.cause, t.user_message_ids, t.status,
  t.first_seq, t.started_at, t.ended_at, t.context_workflow_id, t.context_start_item
FROM turns t JOIN turn_revision_map m ON m.session_id = t.session_id AND m.position = t.position;

DROP TABLE turns;
ALTER TABLE turns_new RENAME TO turns;

CREATE TABLE turn_inputs (
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  input_id TEXT NOT NULL,
  entry_ref TEXT NOT NULL,
  applied_settings_revision TEXT,
  PRIMARY KEY (session_id, run_id, ordinal),
  FOREIGN KEY (session_id, run_id) REFERENCES turns (session_id, run_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, applied_settings_revision) REFERENCES session_settings (session_id, revision)
) STRICT;

INSERT INTO turn_inputs (session_id, run_id, ordinal, input_id, entry_ref, applied_settings_revision)
SELECT t.session_id, t.run_id, cast(j.key AS INTEGER) + 1,
  coalesce(json_extract(j.value, '$.inputId'), 'legacy-input:' || t.position || ':' || j.key),
  json_extract(j.value, '$.kind') || ':' || coalesce(json_extract(j.value, '$.inputId'), j.key), NULL
FROM turn_inputs_old t, json_each(t.input_membership) j;

DROP TABLE turn_change_starts;
DROP TABLE turn_revision_map;
DROP TABLE turn_inputs_old;

CREATE TABLE pending_inputs_new (
  session_id TEXT NOT NULL REFERENCES sessions (id),
  position INTEGER NOT NULL,
  input_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'notification')),
  body TEXT NOT NULL,
  agent_title_change TEXT,
  model_settings_change TEXT,
  delivery_metadata TEXT NOT NULL DEFAULT '{}',
  provenance TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, position),
  UNIQUE (session_id, input_id)
) STRICT;

INSERT INTO pending_inputs_new
  (session_id, position, input_id, kind, body, agent_title_change, model_settings_change,
   delivery_metadata, provenance, created_at)
SELECT session_id, position,
  coalesce(json_extract(body, '$.inputId'), 'legacy-input:' || position),
  kind, body, NULL, NULL,
  json_object('mode', json_extract(body, '$.mode'), 'trigger', json_extract(body, '$.trigger'),
    'workflowId', json_extract(body, '$.workflowId')),
  json_extract(body, '$.sender'), created_at
FROM waiting_input;

DROP TABLE waiting_input;
ALTER TABLE pending_inputs_new RENAME TO waiting_input;

CREATE TABLE checkpoint_windows_new (
  session_id TEXT NOT NULL REFERENCES sessions (id),
  position INTEGER NOT NULL,
  run_id TEXT,
  harness_instructions TEXT NOT NULL DEFAULT '',
  harness_content_sha256 TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, position),
  FOREIGN KEY (session_id, run_id) REFERENCES turns (session_id, run_id) ON DELETE CASCADE
) STRICT;

INSERT INTO checkpoint_windows_new
  (session_id, position, run_id, harness_instructions, harness_content_sha256, created_at)
SELECT session_id, position, run_id, harness_instructions, 'legacy-window:' || session_id || ':' || position, created_at
FROM checkpoint_windows;

INSERT INTO contents (sha256, data, format)
SELECT 'legacy-window:' || session_id || ':' || position, cast(harness_instructions AS BLOB), 'text/plain'
FROM checkpoint_windows;

DROP TABLE checkpoint_windows;
ALTER TABLE checkpoint_windows_new RENAME TO checkpoint_windows;

CREATE TABLE model_calls (
  session_id TEXT NOT NULL,
  model_call_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  window_position INTEGER NOT NULL,
  input_manifest_ref TEXT,
  offered_tools_ref TEXT REFERENCES contents (sha256),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT CHECK (outcome IN ('success', 'failed', 'cancelled', 'interrupted')),
  provider_replay_ref TEXT REFERENCES contents (sha256),
  PRIMARY KEY (session_id, model_call_id),
  UNIQUE (session_id, turn_id, ordinal),
  FOREIGN KEY (session_id, turn_id) REFERENCES turns (session_id, run_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, window_position) REFERENCES checkpoint_windows (session_id, position)
) STRICT;

CREATE TABLE request_manifests (
  session_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  model_call_id TEXT NOT NULL,
  body_ref TEXT NOT NULL REFERENCES contents (sha256),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, manifest_id),
  UNIQUE (session_id, model_call_id),
  FOREIGN KEY (session_id, model_call_id) REFERENCES model_calls (session_id, model_call_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE session_entries (
  session_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  owner_turn_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('system', 'developer', 'user', 'agent', 'thought', 'tool')),
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

CREATE TABLE window_entries (
  session_id TEXT NOT NULL,
  window_position INTEGER NOT NULL,
  entry_id TEXT NOT NULL,
  PRIMARY KEY (session_id, window_position, entry_id),
  FOREIGN KEY (session_id, window_position) REFERENCES checkpoint_windows (session_id, position) ON DELETE CASCADE,
  FOREIGN KEY (session_id, entry_id) REFERENCES session_entries (session_id, entry_id) ON DELETE CASCADE
) STRICT;

INSERT INTO contents (sha256, data, format)
SELECT 'legacy-entry:' || i.session_id || ':' || i.position,
  CASE i.kind
    WHEN 'component' THEN cast(json_object(
      'kind', 'component',
      'component', json_object('type', c.type, 'name', c.name, 'heading', c.heading,
        'text', c.text, 'sources', json(c.sources))) AS BLOB)
    ELSE cast(i.body AS BLOB)
  END,
  CASE i.kind WHEN 'assistant' THEN 'application/vnd.langchain.stored-message+json' ELSE 'application/json' END
FROM window_items i LEFT JOIN developer_components c
  ON c.session_id = i.session_id AND c.item_position = i.position;

INSERT INTO session_entries
  (session_id, entry_id, position, owner_turn_id, kind, content_sha256, model_call_id,
   agent_title, model_id, authorship_session_id, ownership_kind, source_session_id,
   source_entry_id, created_at)
SELECT i.session_id, 'legacy:' || i.position, i.position, i.run_id,
  CASE i.kind WHEN 'component' THEN 'developer' WHEN 'assistant' THEN 'agent' WHEN 'result' THEN 'tool' ELSE 'user' END,
  'legacy-entry:' || i.session_id || ':' || i.position, NULL,
  coalesce(s.agent_title, 'untitled'), i.model, i.session_id, 'local', NULL, NULL,
  coalesce(w.created_at, 0)
FROM window_items i
JOIN session_settings s ON s.session_id = i.session_id AND s.revision = 'current'
LEFT JOIN checkpoint_windows w ON w.session_id = i.session_id AND w.position = i.window_position;

INSERT INTO window_entries (session_id, window_position, entry_id)
SELECT session_id, window_position, 'legacy:' || position FROM window_items;

CREATE TABLE chat_boundaries_new (
  session_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  PRIMARY KEY (session_id, position),
  FOREIGN KEY (session_id, position) REFERENCES session_entries (session_id, position) ON DELETE CASCADE,
  FOREIGN KEY (session_id, run_id) REFERENCES turns (session_id, run_id) ON DELETE CASCADE
) STRICT;

INSERT INTO chat_boundaries_new (session_id, position, run_id)
SELECT session_id, position, run_id FROM chat_boundaries;

CREATE TABLE chat_boundary_closings_new (
  session_id TEXT NOT NULL,
  boundary INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  through_item INTEGER NOT NULL,
  PRIMARY KEY (session_id, boundary),
  FOREIGN KEY (session_id, boundary) REFERENCES chat_boundaries (session_id, position) ON DELETE CASCADE,
  FOREIGN KEY (session_id, run_id) REFERENCES turns (session_id, run_id) ON DELETE CASCADE
) STRICT;

INSERT INTO chat_boundary_closings_new (session_id, boundary, run_id, through_item)
SELECT session_id, boundary, run_id, through_item FROM chat_boundary_closings;

DROP TABLE chat_boundary_closings;
DROP TABLE chat_boundaries;
ALTER TABLE chat_boundaries_new RENAME TO chat_boundaries;
ALTER TABLE chat_boundary_closings_new RENAME TO chat_boundary_closings;

CREATE TABLE agent_tools (
  session_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  model_call_id TEXT NOT NULL,
  provider_call_id TEXT,
  parent_invocation_id TEXT,
  name TEXT NOT NULL,
  arguments_ref TEXT NOT NULL REFERENCES contents (sha256),
  started_at INTEGER,
  settled_at INTEGER,
  outcome TEXT CHECK (outcome IN ('success', 'failed', 'canceled', 'declined', 'interrupted')),
  result_ref TEXT REFERENCES contents (sha256),
  PRIMARY KEY (session_id, entry_id),
  FOREIGN KEY (session_id, entry_id) REFERENCES session_entries (session_id, entry_id) ON DELETE CASCADE
) STRICT;

INSERT INTO agent_tools
  (session_id, entry_id, model_call_id, provider_call_id, parent_invocation_id, name,
   arguments_ref, started_at, settled_at, outcome, result_ref)
SELECT i.session_id, 'legacy:' || i.position, 'unavailable:' || i.session_id || ':' || i.position,
  json_extract(i.body, '$.callId'), NULL, coalesce(json_extract(i.body, '$.name'), 'unknown'),
  'legacy-entry:' || i.session_id || ':' || i.position, NULL, 0,
  json_extract(i.body, '$.outcome'), 'legacy-entry:' || i.session_id || ':' || i.position
FROM window_items i WHERE i.kind = 'result';

CREATE TABLE context_result_replacements (
  session_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  replacement_ref TEXT NOT NULL REFERENCES contents (sha256),
  PRIMARY KEY (session_id, entry_id, attempt),
  FOREIGN KEY (session_id, entry_id) REFERENCES session_entries (session_id, entry_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, run_id) REFERENCES turns (session_id, run_id) ON DELETE CASCADE
) STRICT;

INSERT INTO contents (sha256, data, format)
SELECT DISTINCT 'legacy-cleared:' || session_id || ':' || item_position,
  cast('[Result cleared to free context. Run the call again if you need it.]' AS BLOB), 'text/plain'
FROM tool_result_clearings;

INSERT INTO context_result_replacements (session_id, entry_id, run_id, attempt, replacement_ref)
SELECT session_id, 'legacy:' || item_position, run_id, attempt,
  'legacy-cleared:' || session_id || ':' || item_position
FROM tool_result_clearings;

DROP TABLE tool_result_clearings;
DROP TABLE developer_components;
DROP TABLE window_items;

CREATE VIEW window_items AS
SELECT e.session_id, e.position, w.window_position, e.owner_turn_id AS run_id,
  e.model_id AS model,
  CASE e.kind WHEN 'developer' THEN 'component' WHEN 'agent' THEN 'assistant'
    WHEN 'tool' THEN 'result' ELSE e.kind END AS kind,
  c.data AS body
FROM session_entries e
JOIN window_entries w ON w.session_id = e.session_id AND w.entry_id = e.entry_id
JOIN contents c ON c.sha256 = e.content_sha256;

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
SELECT session_id, entry_id AS item_position, run_id, attempt FROM context_result_replacements;

CREATE INDEX model_calls_success ON model_calls (session_id, started_at) WHERE outcome = 'success';
CREATE INDEX session_entries_position ON session_entries (session_id, position);
CREATE INDEX window_entries_window ON window_entries (session_id, window_position);

CREATE TABLE session_grants_new (
  session_id TEXT NOT NULL REFERENCES sessions (id),
  title_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  permission TEXT NOT NULL,
  pattern TEXT NOT NULL,
  PRIMARY KEY (session_id, title_key, position)
) STRICT;

INSERT INTO session_grants_new (session_id, title_key, position, permission, pattern)
SELECT g.session_id, s.agent_title, g.position, g.permission, g.pattern
FROM session_grants g
JOIN session_settings s ON s.session_id = g.session_id AND s.revision = 'current';

DROP TABLE session_grants;
ALTER TABLE session_grants_new RENAME TO session_grants;

CREATE TABLE subscription_operations (
  receiver_session_id TEXT NOT NULL REFERENCES sessions (id),
  owner_turn_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  source_session_id TEXT NOT NULL REFERENCES sessions (id),
  operation TEXT NOT NULL CHECK (operation IN ('subscribe', 'update', 'unsubscribe')),
  filter TEXT,
  PRIMARY KEY (receiver_session_id, owner_turn_id, position),
  FOREIGN KEY (receiver_session_id, owner_turn_id) REFERENCES turns (session_id, run_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE subscriptions (
  receiver_session_id TEXT NOT NULL REFERENCES sessions (id),
  source_session_id TEXT NOT NULL REFERENCES sessions (id),
  filter TEXT,
  observation_boundary INTEGER NOT NULL,
  PRIMARY KEY (receiver_session_id, source_session_id),
  CHECK (receiver_session_id <> source_session_id)
) STRICT;

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  content_sha256 TEXT NOT NULL REFERENCES contents (sha256),
  format TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE attachment_references (
  attachment_id TEXT NOT NULL REFERENCES attachments (id),
  session_id TEXT NOT NULL REFERENCES sessions (id),
  kind TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (attachment_id, session_id, kind, reference_id)
) STRICT;

CREATE TABLE uploads (
  owner_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  expected_size INTEGER NOT NULL CHECK (expected_size >= 0),
  received_size INTEGER NOT NULL DEFAULT 0 CHECK (received_size >= 0),
  status TEXT NOT NULL CHECK (status IN ('open', 'finalized')),
  digest TEXT,
  attachment_id TEXT REFERENCES attachments (id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, upload_id)
) STRICT;

CREATE TABLE upload_chunks (
  owner_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  offset INTEGER NOT NULL CHECK (offset >= 0),
  digest TEXT NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (owner_id, upload_id, offset),
  FOREIGN KEY (owner_id, upload_id) REFERENCES uploads (owner_id, upload_id) ON DELETE CASCADE
) STRICT;

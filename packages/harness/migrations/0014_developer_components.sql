-- The developer component a component item holds: its type, name,
-- heading, and text, and as a JSON object the state of each source it
-- establishes, by source name.
CREATE TABLE developer_components (
  session_id TEXT NOT NULL,
  item_position INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('seed', 'state', 'notification')),
  name TEXT NOT NULL,
  heading TEXT NOT NULL,
  text TEXT NOT NULL,
  sources TEXT NOT NULL,
  PRIMARY KEY (session_id, item_position),
  FOREIGN KEY (session_id, item_position) REFERENCES window_items (session_id, position) ON DELETE CASCADE
) STRICT;

-- Stored file contents by SHA-256, such as the user instructions versions
-- components establish.
CREATE TABLE contents (
  sha256 TEXT PRIMARY KEY,
  data BLOB NOT NULL
) STRICT;

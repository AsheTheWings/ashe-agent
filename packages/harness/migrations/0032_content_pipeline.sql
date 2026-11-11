-- History-owned recoverable tool output and immutable attachment
-- representations. A fork copies reference rows with the retained entries;
-- derived attachment representations are shared by their original.

CREATE TABLE content_references (
  session_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL REFERENCES contents (sha256),
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  capture_loss_bytes INTEGER NOT NULL DEFAULT 0 CHECK (capture_loss_bytes >= 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, entry_id),
  FOREIGN KEY (session_id, entry_id) REFERENCES session_entries (session_id, entry_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE attachment_representations (
  attachment_id TEXT NOT NULL REFERENCES attachments (id) ON DELETE CASCADE,
  representation_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL REFERENCES contents (sha256),
  media_type TEXT NOT NULL,
  transformation TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (attachment_id, representation_id)
) STRICT;

CREATE INDEX attachment_representations_content
  ON attachment_representations (content_sha256);

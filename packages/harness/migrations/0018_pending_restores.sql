-- A rewind's restore of research and memory files, recorded in the
-- rewind's transaction and deleted once the files are written, so a
-- restore a crash or failure interrupts is completed later.
CREATE TABLE pending_restores (
  session_id TEXT PRIMARY KEY REFERENCES sessions (id),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE pending_restore_files (
  session_id TEXT NOT NULL REFERENCES pending_restores (session_id) ON DELETE CASCADE,
  area TEXT NOT NULL CHECK (area IN ('research', 'memory')),
  name TEXT NOT NULL,
  sha256 TEXT NOT NULL REFERENCES contents (sha256),
  PRIMARY KEY (session_id, area, name)
) STRICT;

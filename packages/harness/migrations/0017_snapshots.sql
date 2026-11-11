-- Research and memory file state. Every file's bytes live in `contents`
-- by SHA-256. `snapshot_files` lists the research files and the memory
-- files a turn started with; a turn without rows started with none.
-- `memory_generations` are a session's published memory directories,
-- `sessions.memory_generation` names the current one, and each file
-- records its metadata as published, so a check hashes only files whose
-- metadata differs. `research_baselines` records the research files a
-- checkpoint window started from.
CREATE TABLE snapshot_files (
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  area TEXT NOT NULL CHECK (area IN ('research', 'memory')),
  name TEXT NOT NULL,
  sha256 TEXT NOT NULL REFERENCES contents (sha256),
  PRIMARY KEY (session_id, run_id, area, name),
  FOREIGN KEY (session_id, run_id) REFERENCES turns (session_id, run_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE memory_generations (
  session_id TEXT NOT NULL REFERENCES sessions (id),
  generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, generation)
) STRICT;

CREATE TABLE memory_generation_files (
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  name TEXT NOT NULL,
  sha256 TEXT NOT NULL REFERENCES contents (sha256),
  metadata TEXT NOT NULL,
  PRIMARY KEY (session_id, generation, name),
  FOREIGN KEY (session_id, generation) REFERENCES memory_generations (session_id, generation) ON DELETE CASCADE
) STRICT;

ALTER TABLE sessions ADD COLUMN memory_generation INTEGER NOT NULL DEFAULT 0;

CREATE TABLE research_baselines (
  session_id TEXT NOT NULL,
  window_position INTEGER NOT NULL,
  run_id TEXT,
  name TEXT NOT NULL,
  sha256 TEXT NOT NULL REFERENCES contents (sha256),
  PRIMARY KEY (session_id, window_position, name),
  FOREIGN KEY (session_id, window_position) REFERENCES checkpoint_windows (session_id, position) ON DELETE CASCADE,
  FOREIGN KEY (session_id, run_id) REFERENCES turns (session_id, run_id) ON DELETE CASCADE
) STRICT;

-- A checkpoint window's research baseline as versions: its construction
-- records the first, and each idle of a context turn in it records the
-- next, owned by that turn. The newest kept version of a window is its
-- baseline. `files` is a JSON array of each research file's name and
-- SHA-256, whose bytes are in `contents`. The table it replaces held no
-- rows.
DROP TABLE research_baselines;

CREATE TABLE research_baselines (
  session_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  window_position INTEGER NOT NULL,
  run_id TEXT,
  files TEXT NOT NULL,
  PRIMARY KEY (session_id, position),
  FOREIGN KEY (session_id, window_position) REFERENCES checkpoint_windows (session_id, position) ON DELETE CASCADE,
  FOREIGN KEY (session_id, run_id) REFERENCES turns (session_id, run_id) ON DELETE CASCADE
) STRICT;

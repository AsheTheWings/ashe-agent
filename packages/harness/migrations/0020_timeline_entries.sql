-- The timeline entries of a session, numbered in one sequence for every
-- kind, each owned by the turn that recorded it. `fields` is a JSON object
-- of the entry's field values by field name, `resolves` a JSON array of
-- the entry numbers a done entry resolves, and `window_position` the
-- checkpoint window that was current when the entry was recorded. A
-- compaction entry's text is in `compaction_texts`.
CREATE TABLE timeline_entries (
  session_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('open', 'done', 'decision', 'problem', 'compaction', 'research', 'answer', 'handoff')),
  fields TEXT NOT NULL,
  resolves TEXT NOT NULL DEFAULT '[]',
  prompt_revision TEXT,
  window_position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, number),
  FOREIGN KEY (session_id, run_id) REFERENCES turns (session_id, run_id) ON DELETE CASCADE
) STRICT;

-- An entry trimmed from the primary timeline, owned by the context turn
-- that trimmed it; an entry without a row is in the primary timeline.
CREATE TABLE timeline_trims (
  session_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  PRIMARY KEY (session_id, number),
  FOREIGN KEY (session_id, number) REFERENCES timeline_entries (session_id, number) ON DELETE CASCADE,
  FOREIGN KEY (session_id, run_id) REFERENCES turns (session_id, run_id) ON DELETE CASCADE
) STRICT;

-- A chat boundary, named by the item position of its first user message
-- and owned by the turn holding that message. A boundary without a row in
-- `chat_boundary_closings` is open; a closing, owned by the turn that
-- closed the boundary, names the last item the boundary holds.
CREATE TABLE chat_boundaries (
  session_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  PRIMARY KEY (session_id, position),
  FOREIGN KEY (session_id, position) REFERENCES window_items (session_id, position) ON DELETE CASCADE,
  FOREIGN KEY (session_id, run_id) REFERENCES turns (session_id, run_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE chat_boundary_closings (
  session_id TEXT NOT NULL,
  boundary INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  through_item INTEGER NOT NULL,
  PRIMARY KEY (session_id, boundary),
  FOREIGN KEY (session_id, boundary) REFERENCES chat_boundaries (session_id, position) ON DELETE CASCADE,
  FOREIGN KEY (session_id, run_id) REFERENCES turns (session_id, run_id) ON DELETE CASCADE
) STRICT;

-- Each text a compaction call gave a boundary's compaction entry, in the
-- order stored, owned by the latest turn of the session when it was
-- stored; the newest kept row is the entry's text. `covers` is a JSON
-- array of the item positions of the messages the call summarized. A
-- boundary whose entry is in the primary timeline and covers fewer than
-- all its messages, or that has no entry, has a compaction call due: one
-- running, one that failed, or one a rewind or a server stop discarded.
CREATE TABLE compaction_texts (
  session_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  number INTEGER NOT NULL,
  boundary INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  window_position INTEGER NOT NULL,
  text TEXT NOT NULL,
  covers TEXT NOT NULL,
  prompt_revision TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, position),
  FOREIGN KEY (session_id, number) REFERENCES timeline_entries (session_id, number) ON DELETE CASCADE,
  FOREIGN KEY (session_id, boundary) REFERENCES chat_boundaries (session_id, position) ON DELETE CASCADE,
  FOREIGN KEY (session_id, run_id) REFERENCES turns (session_id, run_id) ON DELETE CASCADE
) STRICT;

-- One opaque identity for this retained harness database. Restoring the
-- database preserves it; a fresh database at the same endpoint gets a new
-- value.
CREATE TABLE harness_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  harness_id TEXT NOT NULL CHECK (length(harness_id) > 0)
) STRICT;

INSERT INTO harness_identity (singleton, harness_id) VALUES (1, lower(hex(randomblob(16))));

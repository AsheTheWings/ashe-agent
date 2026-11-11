-- One durable acceptance receipt per caller-owned session submission. A
-- receipt outlives admission and rewind so a retry cannot accept the same
-- payload twice or resurrect removed input.
CREATE TABLE input_receipts (
  session_id TEXT NOT NULL REFERENCES sessions (id),
  submission_id TEXT NOT NULL,
  input_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, submission_id),
  UNIQUE (session_id, input_id)
) STRICT;

CREATE INDEX input_receipts_input ON input_receipts (session_id, input_id);

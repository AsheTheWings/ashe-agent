-- How many times a session's scratch target was found lost and its
-- memory republished after a mismatch, which reconciliation compares with
-- what a checkpoint window knows, and how many scratch entries a fork
-- skipped when it copied its source's scratch.
ALTER TABLE sessions ADD COLUMN scratch_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN memory_restore_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN fork_skipped INTEGER NOT NULL DEFAULT 0;

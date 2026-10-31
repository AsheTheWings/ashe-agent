-- Checkpoint windows and their items hold what the first message, the
-- catalogs, and the harness notes held.
ALTER TABLE sessions DROP COLUMN first_message;
ALTER TABLE sessions DROP COLUMN catalogs;
ALTER TABLE sessions DROP COLUMN pending_notes;
ALTER TABLE turns DROP COLUMN notes;
ALTER TABLE turns DROP COLUMN catalogs;

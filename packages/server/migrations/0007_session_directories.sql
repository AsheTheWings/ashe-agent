-- A session's starting directory is its own session directory, named by
-- its id under the state directory, so sessions record no directory.
ALTER TABLE sessions DROP COLUMN cwd;

-- Sessions created before checkpoint windows have no window to run a turn
-- in, so their sessions, events, turns, and grants are removed.
DELETE FROM session_grants WHERE session_id NOT IN (SELECT session_id FROM checkpoint_windows);
DELETE FROM waiting_input WHERE session_id NOT IN (SELECT session_id FROM checkpoint_windows);
DELETE FROM turns WHERE session_id NOT IN (SELECT session_id FROM checkpoint_windows);
DELETE FROM events WHERE session_id NOT IN (SELECT session_id FROM checkpoint_windows);
DELETE FROM sessions WHERE id NOT IN (SELECT session_id FROM checkpoint_windows);

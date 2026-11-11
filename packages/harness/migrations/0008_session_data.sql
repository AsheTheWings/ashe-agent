-- Sessions created before the agents, providers, and checkpoint windows
-- of later migrations carry over no data: every session, its events,
-- turns, grants, and checkpoints are removed.
DELETE FROM session_grants;
DELETE FROM events;
DELETE FROM turns;
DELETE FROM sessions;
DELETE FROM checkpoint_writes;
DELETE FROM checkpoint_blobs;
DELETE FROM checkpoints;

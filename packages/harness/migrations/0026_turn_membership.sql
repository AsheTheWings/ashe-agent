-- Turns own an immutable, ordered record of the input content identities
-- admitted with them. Session history from the former steering model is
-- disposable, so this transition clears it while preserving authentication.
DELETE FROM session_grants;
DELETE FROM timeline_trims;
DELETE FROM timeline_entries;
DELETE FROM compaction_texts;
DELETE FROM chat_boundary_closings;
DELETE FROM chat_boundaries;
DELETE FROM research_baselines;
DELETE FROM tool_result_clearings;
DELETE FROM developer_components;
DELETE FROM window_items;
DELETE FROM checkpoint_windows;
DELETE FROM snapshot_files;
DELETE FROM memory_generation_files;
DELETE FROM memory_generations;
DELETE FROM pending_restore_files;
DELETE FROM pending_restores;
DELETE FROM waiting_input;
DELETE FROM turns;
DELETE FROM events;
DELETE FROM sessions;

ALTER TABLE turns ADD COLUMN input_membership TEXT NOT NULL DEFAULT '[]';

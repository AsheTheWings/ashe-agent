import m0001 from "../../migrations/0001_checkpoints.sql" with { type: "text" }
import m0002 from "../../migrations/0002_credentials.sql" with { type: "text" }
import m0003 from "../../migrations/0003_sessions.sql" with { type: "text" }
import m0004 from "../../migrations/0004_turn_windows.sql" with { type: "text" }
import m0005 from "../../migrations/0005_session_grants.sql" with { type: "text" }
import m0006 from "../../migrations/0006_agent_settings.sql" with { type: "text" }
import m0007 from "../../migrations/0007_session_directories.sql" with { type: "text" }
import m0008 from "../../migrations/0008_session_data.sql" with { type: "text" }
import m0009 from "../../migrations/0009_session_agents.sql" with { type: "text" }
import m0010 from "../../migrations/0010_reasoning_efforts.sql" with { type: "text" }
import m0011 from "../../migrations/0011_turn_causes.sql" with { type: "text" }
import m0012 from "../../migrations/0012_checkpoint_windows.sql" with { type: "text" }
import m0013 from "../../migrations/0013_first_message_columns.sql" with { type: "text" }
import m0014 from "../../migrations/0014_developer_components.sql" with { type: "text" }
import m0015 from "../../migrations/0015_waiting_input.sql" with { type: "text" }
import m0016 from "../../migrations/0016_sessions_without_windows.sql" with { type: "text" }
import m0017 from "../../migrations/0017_snapshots.sql" with { type: "text" }
import m0018 from "../../migrations/0018_pending_restores.sql" with { type: "text" }
import m0019 from "../../migrations/0019_session_generations.sql" with { type: "text" }
import m0020 from "../../migrations/0020_timeline_entries.sql" with { type: "text" }
import m0021 from "../../migrations/0021_chat_boundaries.sql" with { type: "text" }
import m0022 from "../../migrations/0022_context_turns.sql" with { type: "text" }
import m0023 from "../../migrations/0023_research_baseline_versions.sql" with { type: "text" }

/**
 * The migration directory `packages/server/migrations`, embedded so a
 * compiled binary carries it. A conformance test keeps this list equal to
 * the directory's files.
 */
export const migrationFiles: ReadonlyArray<{ readonly file: string; readonly sql: string }> = [
  { file: "0001_checkpoints.sql", sql: m0001 },
  { file: "0002_credentials.sql", sql: m0002 },
  { file: "0003_sessions.sql", sql: m0003 },
  { file: "0004_turn_windows.sql", sql: m0004 },
  { file: "0005_session_grants.sql", sql: m0005 },
  { file: "0006_agent_settings.sql", sql: m0006 },
  { file: "0007_session_directories.sql", sql: m0007 },
  { file: "0008_session_data.sql", sql: m0008 },
  { file: "0009_session_agents.sql", sql: m0009 },
  { file: "0010_reasoning_efforts.sql", sql: m0010 },
  { file: "0011_turn_causes.sql", sql: m0011 },
  { file: "0012_checkpoint_windows.sql", sql: m0012 },
  { file: "0013_first_message_columns.sql", sql: m0013 },
  { file: "0014_developer_components.sql", sql: m0014 },
  { file: "0015_waiting_input.sql", sql: m0015 },
  { file: "0016_sessions_without_windows.sql", sql: m0016 },
  { file: "0017_snapshots.sql", sql: m0017 },
  { file: "0018_pending_restores.sql", sql: m0018 },
  { file: "0019_session_generations.sql", sql: m0019 },
  { file: "0020_timeline_entries.sql", sql: m0020 },
  { file: "0021_chat_boundaries.sql", sql: m0021 },
  { file: "0022_context_turns.sql", sql: m0022 },
  { file: "0023_research_baseline_versions.sql", sql: m0023 },
]

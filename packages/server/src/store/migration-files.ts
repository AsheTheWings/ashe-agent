import m0001 from "../../migrations/0001_checkpoints.sql" with { type: "text" }
import m0002 from "../../migrations/0002_credentials.sql" with { type: "text" }
import m0003 from "../../migrations/0003_sessions.sql" with { type: "text" }
import m0004 from "../../migrations/0004_turn_windows.sql" with { type: "text" }
import m0005 from "../../migrations/0005_session_grants.sql" with { type: "text" }
import m0006 from "../../migrations/0006_agent_settings.sql" with { type: "text" }

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
]

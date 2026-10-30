import m0001 from "../../migrations/0001_checkpoints.sql" with { type: "text" }

/**
 * The migration directory `packages/server/migrations`, embedded so a
 * compiled binary carries it. A conformance test keeps this list equal to
 * the directory's files.
 */
export const migrationFiles: ReadonlyArray<{ readonly file: string; readonly sql: string }> = [
  { file: "0001_checkpoints.sql", sql: m0001 },
]

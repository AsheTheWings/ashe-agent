/**
 * LangGraph's checkpoint saver validation suite against the saver on a
 * real bun:sqlite file. It runs under Vitest on Bun: `bun run test:integration`.
 */
import { validate } from "@langchain/langgraph-checkpoint-validation"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Database } from "bun:sqlite"
import { openDatabase } from "../src/store/database.ts"
import { migrationFiles } from "../src/store/migration-files.ts"
import { applyMigrations, discoverMigrations } from "../src/store/migrations.ts"
import { SqliteCheckpointSaver } from "../src/store/checkpointer.ts"

const runDir = mkdtempSync(join(tmpdir(), "ashe-agent-checkpointer-"))
const open = new Map<SqliteCheckpointSaver, Database>()
let counter = 0

validate({
  checkpointerName: "SqliteCheckpointSaver",
  createCheckpointer() {
    const db = openDatabase(join(runDir, `checkpoints-${++counter}.db`))
    applyMigrations(db, discoverMigrations(migrationFiles))
    const saver = new SqliteCheckpointSaver(db)
    open.set(saver, db)
    return saver
  },
  destroyCheckpointer(saver) {
    open.get(saver)?.close()
    open.delete(saver)
  },
  afterAll() {
    rmSync(runDir, { recursive: true, force: true })
  },
})

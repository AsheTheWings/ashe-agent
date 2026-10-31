import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionStore } from "../src/sessions/store.ts"
import { openDatabase, openDatabaseReadonly } from "../src/store/database.ts"
import { dumpDatabase } from "../src/store/dump.ts"
import { migrationFiles } from "../src/store/migration-files.ts"
import {
  applyMigrations,
  discoverMigrations,
  MigrationError,
  readLedger,
  readMigrationStatus,
} from "../src/store/migrations.ts"

const runDir = mkdtempSync(join(tmpdir(), "ashe-agent-store-"))
let counter = 0
const freshPath = (name: string) => join(runDir, `${++counter}-${name}`)

afterAll(() => rmSync(runDir, { recursive: true, force: true }))

const migrations = discoverMigrations(migrationFiles)

const kindOf = (run: () => unknown) => {
  try {
    run()
  } catch (error) {
    if (error instanceof MigrationError) return error.kind
    throw error
  }
  return "none"
}

describe("migrations on a real SQLite file", () => {
  test("apply every migration, then rerun as a no-op", () => {
    const path = freshPath("migrate.db")
    const db = openDatabase(path)
    try {
      expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal")
      expect(applyMigrations(db, migrations).map((m) => m.name)).toEqual(migrations.map((m) => m.name))
      expect(readLedger(db).map((entry) => entry.name)).toEqual(migrations.map((m) => m.name))
      const schemaBefore = db.query("SELECT sql FROM sqlite_master ORDER BY name").all()
      expect(applyMigrations(db, migrations)).toEqual([])
      expect(readLedger(db)).toHaveLength(migrations.length)
      expect(db.query("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(schemaBefore)
    } finally {
      db.close()
    }
  })

  test("the context migrations remove windowless sessions, record causes and agent settings, and drop the checkpoint tables", () => {
    const path = freshPath("context.db")
    const db = openDatabase(path)
    try {
      const earlier = migrations.filter((migration) => migration.position <= 10)
      applyMigrations(db, earlier)
      db.run("INSERT INTO sessions (id, model, created_at, next_seq) VALUES ('old', 'test/alpha', 1, 3)")
      db.run(
        `INSERT INTO turns (session_id, run_id, position, input_id, input_text, model, status, first_seq, started_at, checkpoint_id)
          VALUES ('old', 'r0', 1, 'i0', 'hello', 'test/alpha', 'finished', 1, 1, 'c1')`,
      )
      const beforeCleanup = migrations.filter((migration) => migration.position <= 15)
      applyMigrations(db, beforeCleanup)
      // Rows of every table referencing a session: the windowless session's go, the windowed one's stay.
      for (const id of ["old", "kept"]) {
        if (id === "kept") db.run("INSERT INTO sessions (id, model, created_at, next_seq) VALUES ('kept', 'test/alpha', 1, 3)")
        db.run(`INSERT INTO events (session_id, seq, timestamp, body) VALUES ('${id}', 1, 1, '{}')`)
        db.run(`INSERT INTO session_grants (session_id, position, permission, pattern) VALUES ('${id}', 1, 'edit', '*')`)
        db.run(`INSERT INTO waiting_input (session_id, position, kind, body, created_at) VALUES ('${id}', 1, 'user', '{}', 1)`)
      }
      db.run(
        `INSERT INTO turns (session_id, run_id, position, model, status, first_seq, started_at)
          VALUES ('kept', 'k1', 1, 'test/alpha', 'finished', 1, 1)`,
      )
      db.run("INSERT INTO checkpoint_windows (session_id, position, run_id, harness_instructions, created_at) VALUES ('kept', 1, NULL, 'H', 1)")
      expect(applyMigrations(db, migrations).map((migration) => migration.name)).toEqual(
        migrations.slice(beforeCleanup.length).map((migration) => migration.name),
      )
      for (const table of ["events", "turns", "session_grants", "waiting_input", "checkpoint_windows"]) {
        const ids = db.query<{ session_id: string }, []>(`SELECT DISTINCT session_id FROM ${table}`).all().map((row) => row.session_id)
        expect([table, ids]).toEqual([table, ["kept"]])
      }
      expect(db.query<{ id: string }, []>("SELECT id FROM sessions").all().map((row) => row.id)).toEqual(["kept"])
      expect(readLedger(db).map((entry) => entry.name)).toEqual(migrations.map((migration) => migration.name))

      const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
      expect(tables).not.toContain("checkpoints")
      expect(tables).not.toContain("checkpoint_blobs")
      expect(tables).not.toContain("checkpoint_writes")
      expect(tables).toEqual(expect.arrayContaining(["checkpoint_windows", "window_items", "developer_components", "contents", "waiting_input"]))
      const turnColumns = db.query<{ name: string }, []>("PRAGMA table_info(turns)").all().map((row) => row.name)
      expect(turnColumns).not.toContain("checkpoint_id")
      expect(turnColumns).not.toContain("input_id")

      const store = new SessionStore(db, join(runDir, "sessions"))
      store.createSession(
        {
          id: "fresh",
          agent: "helper",
          model: "test/alpha",
          reasoningEffort: null,
          modelOverrides: { "test/alpha": { temperature: 0.5 } },
          permission: { edit: "deny" },
          createdAt: 1,
        },
        null,
      )
      store.conversation.insertWindow("fresh", null, "HARNESS", 1)
      expect(store.getSession("fresh")).toMatchObject({
        agent: "helper",
        modelOverrides: { "test/alpha": { temperature: 0.5 } },
        permission: { edit: "deny" },
      })
      const turn = { model: "test/alpha", reasoningEffort: null }
      expect(store.turns("kept")[0]).toMatchObject({ runId: "k1", cause: "user", userMessageIds: [] })
      store.insertTurn("fresh", { ...turn, runId: "r1", cause: "notification", userMessageIds: [], firstSeq: 2 }, 2)
      store.insertTurn("fresh", { ...turn, runId: "r2", cause: "user", userMessageIds: ["i1", "i2"], firstSeq: 3 }, 3)
      expect(store.turns("fresh")).toMatchObject([
        { runId: "r1", position: 1, cause: "notification", userMessageIds: [] },
        { runId: "r2", position: 2, cause: "user", userMessageIds: ["i1", "i2"] },
      ])
      expect(() => db.run("UPDATE turns SET cause = 'other' WHERE run_id = 'r1'")).toThrow()

      const schemaBefore = db.query("SELECT sql FROM sqlite_master ORDER BY name").all()
      expect(applyMigrations(db, migrations)).toEqual([])
      expect(db.query("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(schemaBefore)
      expect(store.getSession("fresh")).not.toBeNull()
      expect(store.getSession("kept")).not.toBeNull()
    } finally {
      db.close()
    }
  })

  test("status reads without writing and reports pending migrations", () => {
    const absent = freshPath("absent.db")
    expect(readMigrationStatus(openDatabaseReadonly(absent), migrations).pending).toHaveLength(migrations.length)
    expect(existsSync(absent)).toBe(false)

    const path = freshPath("status.db")
    openDatabase(path).close()
    const readonly = openDatabaseReadonly(path)!
    try {
      expect(readMigrationStatus(readonly, migrations).pending).toHaveLength(migrations.length)
    } finally {
      readonly.close()
    }
  })

  test("status reports applied and pending migrations of a migrated database", () => {
    const path = freshPath("applied.db")
    const first = migrations.slice(0, 1)
    const extended = discoverMigrations([
      ...migrationFiles,
      { file: `${String(migrations.length + 1).padStart(4, "0")}_extra.sql`, sql: "CREATE TABLE extra (x INTEGER);" },
    ])
    const db = openDatabase(path)
    try {
      applyMigrations(db, first)
    } finally {
      db.close()
    }
    const before = readFileSync(path)
    const readonly = openDatabaseReadonly(path)!
    try {
      const status = readMigrationStatus(readonly, extended)
      expect(status.applied.map((entry) => entry.name)).toEqual(first.map((m) => m.name))
      expect(status.pending.map((m) => m.name)).toEqual(extended.slice(1).map((m) => m.name))
    } finally {
      readonly.close()
    }
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  const migrated = () => {
    const path = freshPath("ledger.db")
    const db = openDatabase(path)
    applyMigrations(db, migrations)
    return db
  }

  test("refuses a ledger with a changed checksum", () => {
    const db = migrated()
    try {
      db.run("UPDATE schema_migrations SET sha256 = ? WHERE position = 1", ["0".repeat(64)])
      expect(kindOf(() => applyMigrations(db, migrations))).toBe("drift")
      expect(kindOf(() => readMigrationStatus(db, migrations))).toBe("drift")
    } finally {
      db.close()
    }
  })

  test("refuses a ledger with a gap", () => {
    const db = migrated()
    try {
      db.run("UPDATE schema_migrations SET position = 2 WHERE position = 1")
      expect(kindOf(() => applyMigrations(db, migrations))).toBe("gap")
    } finally {
      db.close()
    }
  })

  test("refuses a ledger with a duplicate", () => {
    const db = migrated()
    try {
      db.run(
        "INSERT INTO schema_migrations (position, name, sha256, applied_at) SELECT position, name, sha256, applied_at FROM schema_migrations WHERE position = 1",
      )
      expect(kindOf(() => applyMigrations(db, migrations))).toBe("duplicate")
    } finally {
      db.close()
    }
  })

  test("a failing migration leaves no partial schema or ledger row", () => {
    const db = openDatabase(freshPath("failing.db"))
    try {
      const failing = discoverMigrations([
        { file: "0001_ok.sql", sql: "CREATE TABLE ok (x INTEGER);" },
        { file: "0002_bad.sql", sql: "CREATE TABLE half (x INTEGER); INSERT INTO missing VALUES (1);" },
      ])
      expect(kindOf(() => applyMigrations(db, failing))).toBe("failed")
      expect(readLedger(db).map((entry) => entry.name)).toEqual(["0001_ok.sql"])
      expect(db.query("SELECT name FROM sqlite_master WHERE name = 'half'").get()).toBeNull()
    } finally {
      db.close()
    }
  })
})

describe("database dump", () => {
  let source: string
  let writer: ReturnType<typeof Bun.spawn> | undefined

  beforeAll(() => {
    source = freshPath("live.db")
    const db = openDatabase(source)
    db.run("CREATE TABLE rows (id INTEGER PRIMARY KEY, body TEXT NOT NULL)")
    db.close()
  })

  afterAll(() => writer?.kill())

  /** Waits under a deadline for the writer to commit at least `count` rows. */
  const committedAtLeast = async (count: number) => {
    const deadline = Date.now() + 10_000
    const reader = new Database(source, { readonly: true })
    try {
      while (Date.now() < deadline) {
        const row = reader.query<{ n: number }, []>("SELECT count(*) AS n FROM rows").get()
        if ((row?.n ?? 0) >= count) return row!.n
        await Bun.sleep(10)
      }
    } finally {
      reader.close()
    }
    throw new Error(`the writer did not commit ${count} rows within 10 seconds`)
  }

  test("copies a live WAL database being written, leaving no temporary file", async () => {
    const script = `
      import { Database } from "bun:sqlite"
      const db = new Database(${JSON.stringify(source)})
      db.run("PRAGMA journal_mode = WAL")
      db.run("PRAGMA busy_timeout = 5000")
      const insert = db.query("INSERT INTO rows (body) VALUES (?)")
      for (;;) { insert.run("x".repeat(512)); await Bun.sleep(1) }
    `
    writer = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "inherit" })
    const before = await committedAtLeast(200)

    const destination = freshPath("copy.db")
    dumpDatabase(source, destination)
    writer.kill()
    await writer.exited

    const copy = new Database(destination, { readonly: true })
    try {
      expect(copy.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check).toBe("ok")
      const copied = copy.query<{ n: number }, []>("SELECT count(*) AS n FROM rows").get()!.n
      expect(copied).toBeGreaterThanOrEqual(before)
      const ids = copy.query<{ id: number }, []>("SELECT id FROM rows ORDER BY id").all().map((row) => row.id)
      expect(ids).toEqual(Array.from({ length: copied }, (_, index) => index + 1))
    } finally {
      copy.close()
    }
    expect(readdirSync(runDir).filter((name) => name.includes(".tmp-"))).toEqual([])
  })

  test("a failed dump leaves an existing destination unchanged and no temporary file", () => {
    const notDatabase = freshPath("not-a-database")
    writeFileSync(notDatabase, "this is not an SQLite database, only text long enough to read".repeat(10))
    const destination = freshPath("existing.db")
    writeFileSync(destination, "previous dump")
    expect(() => dumpDatabase(notDatabase, destination)).toThrow()
    expect(readFileSync(destination, "utf8")).toBe("previous dump")
    expect(readdirSync(runDir).filter((name) => name.includes(".tmp-"))).toEqual([])
  })

  test("a dump that fails after copying leaves an existing destination unchanged", () => {
    const locked = freshPath("locked")
    mkdirSync(locked)
    const destination = join(locked, "existing.db")
    writeFileSync(destination, "previous dump")
    chmodSync(locked, 0o300)
    try {
      expect(() => dumpDatabase(source, destination)).toThrow()
    } finally {
      chmodSync(locked, 0o700)
    }
    expect(readFileSync(destination, "utf8")).toBe("previous dump")
    expect(readdirSync(locked)).toEqual(["existing.db"])
  })

  test("a dump whose rename fails removes its temporary copy and leaves the destination", () => {
    const parent = freshPath("parent")
    mkdirSync(parent)
    const destination = join(parent, "occupied")
    mkdirSync(destination)
    writeFileSync(join(destination, "kept"), "kept")
    expect(() => dumpDatabase(source, destination)).toThrow()
    expect(readdirSync(parent)).toEqual(["occupied"])
    expect(readFileSync(join(destination, "kept"), "utf8")).toBe("kept")
  })
})

import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../src/store/database.ts"
import { migrationFiles } from "../src/store/migration-files.ts"
import { applyMigrations, discoverMigrations } from "../src/store/migrations.ts"

test("SQLite migrations drop password state and logins while preserving API tokens byte for byte", () => {
  const dir = mkdtempSync(join(tmpdir(), "ashe-agent-github-migrations-"))
  const db = openDatabase(join(dir, "database.db"))
  try {
    const migrations = discoverMigrations(migrationFiles)
    applyMigrations(db, migrations.slice(0, 23))
    db.run("INSERT INTO owner VALUES (1, 'synthetic-hash', 1)")
    db.run("INSERT INTO login_failures VALUES (1, 1)")
    db.run("INSERT INTO logins VALUES ('old', 1, NULL)")
    db.run("INSERT INTO access_tokens VALUES ('old-access', 'old', 100)")
    db.run("INSERT INTO refresh_tokens VALUES ('old-refresh', 'old', 1, 100, NULL)")
    db.run("INSERT INTO api_tokens VALUES ('api', 'program', 'synthetic-hash', 1, NULL, NULL)")
    const before = db.query("SELECT * FROM api_tokens").all()
    expect(applyMigrations(db, migrations)).toHaveLength(2)
    expect(applyMigrations(db, migrations)).toHaveLength(0)
    expect(db.query("SELECT * FROM api_tokens").all()).toEqual(before)
    expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('owner', 'login_failures')").all()).toEqual([])
    for (const table of ["logins", "access_tokens", "refresh_tokens"]) expect(db.query(`SELECT * FROM ${table}`).all()).toEqual([])
    expect(db.query<{ name: string; notnull: number }, []>("PRAGMA table_info(logins)").all().find((row) => row.name === "github_user_id")?.notnull).toBe(1)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"

export type Migration = { readonly name: string; readonly sha256: string; readonly sql: string }

export class MigrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MigrationError"
  }
}

const ledger = `CREATE TABLE IF NOT EXISTS web_schema_migrations (
  position INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`

/** Reads the ordered SQL migrations from their directory; names are their positions. */
export const discoverMigrations = (directory: string): ReadonlyArray<Migration> => {
  if (!statSync(directory).isDirectory()) throw new MigrationError(`${directory} is not a migration directory`)
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name, index) => {
      const expected = String(index + 1).padStart(4, "0")
      if (!name.startsWith(`${expected}_`)) throw new MigrationError(`migration ${name} is out of position`)
      const sql = readFileSync(join(directory, name), "utf8")
      return { name, sha256: createHash("sha256").update(sql).digest("hex"), sql }
    })
}

export type MigrationStatus = {
  readonly applied: ReadonlyArray<{ readonly position: number; readonly name: string }>
  readonly pending: ReadonlyArray<string>
}

export const readMigrationStatus = (db: Database, migrations: ReadonlyArray<Migration>): MigrationStatus => {
  const exists = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'web_schema_migrations'").get() !== null
  const applied = exists
    ? db
        .query<{ position: number; name: string; sha256: string }, []>("SELECT position, name, sha256 FROM web_schema_migrations ORDER BY position")
        .all()
    : []
  if (applied.length > migrations.length) throw new MigrationError("the web database has migrations this build does not know")
  for (const [index, row] of applied.entries()) {
    const migration = migrations[index]
    if (migration === undefined || row.position !== index + 1 || row.name !== migration.name || row.sha256 !== migration.sha256) {
      throw new MigrationError(`web migration drift at position ${index + 1}`)
    }
  }
  return { applied, pending: migrations.slice(applied.length).map((migration) => migration.name) }
}

/** Applies every pending migration in one transaction each. */
export const applyMigrations = (db: Database, migrations: ReadonlyArray<Migration>): number => {
  db.run(ledger)
  const status = readMigrationStatus(db, migrations)
  for (const [offset, name] of status.pending.entries()) {
    const position = status.applied.length + offset + 1
    const migration = migrations[position - 1]!
    db.transaction(() => {
      db.exec(migration.sql)
      db.run("INSERT INTO web_schema_migrations (position, name, sha256, applied_at) VALUES (?, ?, ?, ?)", [
        position,
        migration.name,
        migration.sha256,
        Date.now(),
      ])
    })()
  }
  return status.pending.length
}

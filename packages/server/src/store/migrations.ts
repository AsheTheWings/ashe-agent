import type { Database } from "bun:sqlite"
import { Schema } from "effect"

/** A migration file: its position in the directory, its name, its SQL, and the SHA-256 of its bytes. */
export interface Migration {
  readonly position: number
  readonly name: string
  readonly sql: string
  readonly sha256: string
}

/** A ledger row: one applied migration. */
export interface LedgerEntry {
  readonly position: number
  readonly name: string
  readonly sha256: string
  readonly appliedAt: number
}

export interface MigrationStatus {
  readonly applied: ReadonlyArray<LedgerEntry>
  readonly pending: ReadonlyArray<Migration>
}

export class MigrationError extends Schema.TaggedError<MigrationError>()("MigrationError", {
  kind: Schema.Literals(["directory", "drift", "gap", "duplicate", "unknown", "failed"]),
  message: Schema.String,
}) {}

const FILE_NAME = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/

const LEDGER = "schema_migrations"

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")

/**
 * Reads the migration directory: each file is `NNNN_name.sql`, numbered
 * from 0001 with no gap or repeat.
 */
export const discoverMigrations = (
  files: ReadonlyArray<{ readonly file: string; readonly sql: string }>,
): ReadonlyArray<Migration> => {
  const migrations = files.map(({ file, sql }) => {
    const match = FILE_NAME.exec(file)
    if (match === null) {
      throw new MigrationError({ kind: "directory", message: `${file} is not named NNNN_name.sql` })
    }
    return { position: Number(match[1]), name: file, sql, sha256: sha256(sql) }
  })
  migrations.sort((a, b) => a.position - b.position)
  migrations.forEach((migration, index) => {
    if (index > 0 && migration.position === migrations[index - 1]!.position) {
      throw new MigrationError({ kind: "duplicate", message: `two migrations have position ${migration.position}` })
    }
    if (migration.position !== index + 1) {
      throw new MigrationError({ kind: "gap", message: `no migration has position ${index + 1}` })
    }
  })
  return migrations
}

const ledgerExists = (db: Database) =>
  db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(LEDGER) !== null

/** The ledger's rows in the order they were recorded; empty when the ledger does not exist. */
export const readLedger = (db: Database): ReadonlyArray<LedgerEntry> => {
  if (!ledgerExists(db)) return []
  return db
    .query<{ position: number; name: string; sha256: string; applied_at: number }, []>(
      `SELECT position, name, sha256, applied_at FROM ${LEDGER} ORDER BY id`,
    )
    .all()
    .map((row) => ({ position: row.position, name: row.name, sha256: row.sha256, appliedAt: row.applied_at }))
}

/**
 * Compares the ledger with the directory and returns the pending
 * migrations. A ledger row that repeats or skips a position, names a
 * migration the directory lacks, or records another checksum is refused.
 */
export const migrationStatus = (
  ledger: ReadonlyArray<LedgerEntry>,
  migrations: ReadonlyArray<Migration>,
): MigrationStatus => {
  const seen = new Set<number>()
  ledger.forEach((entry, index) => {
    if (seen.has(entry.position)) {
      throw new MigrationError({ kind: "duplicate", message: `the ledger records position ${entry.position} twice` })
    }
    seen.add(entry.position)
    if (entry.position !== index + 1) {
      throw new MigrationError({ kind: "gap", message: `the ledger records position ${entry.position} after ${index}` })
    }
    const migration = migrations[index]
    if (migration === undefined) {
      throw new MigrationError({ kind: "unknown", message: `the ledger records ${entry.name}, which the directory lacks` })
    }
    if (migration.name !== entry.name || migration.sha256 !== entry.sha256) {
      throw new MigrationError({
        kind: "drift",
        message: `the ledger records ${entry.name} with a checksum or name the directory's ${migration.name} does not match`,
      })
    }
  })
  return { applied: ledger, pending: migrations.slice(ledger.length) }
}

/** The ledger's status against the directory, without writing. */
export const readMigrationStatus = (db: Database | null, migrations: ReadonlyArray<Migration>): MigrationStatus =>
  migrationStatus(db === null ? [] : readLedger(db), migrations)

const createLedger = (db: Database) =>
  db.run(
    `CREATE TABLE ${LEDGER} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position INTEGER NOT NULL,
      name TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT`,
  )

/**
 * Applies the pending migrations in order, each with its ledger row in one
 * transaction, after refusing any drift. Returns the migrations applied.
 */
export const applyMigrations = (
  db: Database,
  migrations: ReadonlyArray<Migration>,
  now: () => number = Date.now,
): ReadonlyArray<Migration> => {
  db.run("BEGIN IMMEDIATE")
  let status: MigrationStatus
  try {
    if (!ledgerExists(db)) createLedger(db)
    status = migrationStatus(readLedger(db), migrations)
    db.run("COMMIT")
  } catch (error) {
    db.run("ROLLBACK")
    throw error
  }
  for (const migration of status.pending) {
    db.run("BEGIN IMMEDIATE")
    try {
      const current = migrationStatus(readLedger(db), migrations)
      if (current.applied.length !== migration.position - 1) {
        throw new MigrationError({ kind: "failed", message: "another process changed the ledger while migrating" })
      }
      db.run(migration.sql)
      db.query(`INSERT INTO ${LEDGER} (position, name, sha256, applied_at) VALUES (?, ?, ?, ?)`).run(
        migration.position,
        migration.name,
        migration.sha256,
        now(),
      )
      db.run("COMMIT")
    } catch (error) {
      db.run("ROLLBACK")
      if (error instanceof MigrationError) throw error
      throw new MigrationError({
        kind: "failed",
        message: `${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  return status.pending
}

import { Database } from "bun:sqlite"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Context, Effect, Layer } from "effect"

/** The database file's name in the state directory. */
export const DATABASE_FILE = "ashe-agent.db"

export const databasePath = (stateDir: string) => `${stateDir}/${DATABASE_FILE}`

/**
 * Opens the server database for writing in WAL mode, creating it and its
 * directory, readable by its owner only, when absent, with foreign keys
 * enforced and a bounded wait on locks. It fails when SQLite cannot use WAL
 * mode for the file.
 */
export const openDatabase = (path: string): Database => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const creating = !existsSync(path)
  const db = new Database(path, { create: true, readwrite: true, strict: true })
  try {
    if (creating) chmodSync(path, 0o600)
    const mode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get()?.journal_mode
    if (mode !== "wal") throw new Error(`SQLite kept journal mode ${mode} instead of WAL for ${path}`)
    db.run("PRAGMA foreign_keys = ON")
    db.run("PRAGMA busy_timeout = 5000")
    db.run("PRAGMA synchronous = NORMAL")
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

/** Opens an existing database read-only, or returns null when it does not exist. */
export const openDatabaseReadonly = (path: string): Database | null => {
  if (!existsSync(path)) return null
  return new Database(path, { readonly: true, strict: true })
}

/** The server's open database, closed when its layer is released. */
export class Store extends Context.Service<Store, { readonly db: Database }>()("ashe-agent/store/Store") {
  static readonly layer = (path: string) =>
    Layer.effect(
      Store,
      Effect.acquireRelease(
        Effect.sync(() => openDatabase(path)),
        (db) => Effect.sync(() => db.close()),
      ).pipe(Effect.map((db) => Store.of({ db }))),
    )
}

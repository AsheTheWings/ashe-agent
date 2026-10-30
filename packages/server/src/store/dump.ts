import { Database } from "bun:sqlite"
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync } from "node:fs"
import { basename, dirname, join } from "node:path"

/**
 * Writes a consistent copy of the database at `source` to `destination`:
 * `VACUUM INTO` a temporary file beside the destination, flush it, then
 * rename it into place and flush the directory. Every step that can fail
 * runs before the rename, so a failure removes the temporary file and
 * leaves an existing destination unchanged. Only flushing the directory
 * follows the rename; if it fails, the complete copy is in place but the
 * rename may not survive a crash, and the error says so.
 */
export const dumpDatabase = (source: string, destination: string): void => {
  const temporary = join(dirname(destination), `.${basename(destination)}.tmp-${crypto.randomUUID()}`)
  const db = new Database(source, { readonly: true, strict: true })
  let directory: number | undefined
  try {
    try {
      directory = openSync(dirname(destination), "r")
      db.query("VACUUM INTO ?").run(temporary)
      const file = openSync(temporary, "r")
      try {
        fsyncSync(file)
      } finally {
        closeSync(file)
      }
      renameSync(temporary, destination)
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch {}
      throw error
    }
    try {
      fsyncSync(directory)
    } catch (error) {
      throw new Error(`the dump is in place at ${destination}, but flushing its directory failed`, { cause: error })
    }
  } finally {
    if (directory !== undefined) closeSync(directory)
    db.close()
  }
}

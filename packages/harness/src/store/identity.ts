import type { Database } from "bun:sqlite"

/** The durable opaque identity recorded for this harness database. */
export const harnessIdentity = (db: Database): string => {
  const row = db.query<{ harness_id: string }, []>("SELECT harness_id FROM harness_identity WHERE singleton = 1").get()
  if (row === null) throw new Error("the harness database has no identity")
  return row.harness_id
}

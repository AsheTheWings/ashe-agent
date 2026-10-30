import type { Database } from "bun:sqlite"

/*
 * Whole-thread operations on the checkpoint tables that the checkpoint
 * saver does not offer. A session's thread is linear: each checkpoint's id
 * sorts after its parent's, since LangGraph's ids are time-ordered.
 */

/** The id of the thread's latest checkpoint, or null when it has none. */
export const latestCheckpointId = (db: Database, threadId: string): string | null =>
  db
    .query<{ id: string | null }, [string]>(
      "SELECT max(checkpoint_id) AS id FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ''",
    )
    .get(threadId)?.id ?? null

/**
 * Removes the thread's checkpoints after `keep`, or all of them when `keep`
 * is null, with their pending writes, so `keep` is the thread's latest
 * checkpoint again. Channel values stay: the next checkpoint writes its
 * versions over those of the removed ones.
 */
export const truncateThread = (db: Database, threadId: string, keep: string | null) => {
  const after = keep ?? ""
  db.query("DELETE FROM checkpoint_writes WHERE thread_id = ? AND checkpoint_id > ?").run(threadId, after)
  db.query("DELETE FROM checkpoints WHERE thread_id = ? AND checkpoint_id > ?").run(threadId, after)
  if (keep === null) db.query("DELETE FROM checkpoint_blobs WHERE thread_id = ?").run(threadId)
}

/**
 * Copies the checkpoints of thread `source` through `through`, or all of
 * them when it is null, with their pending writes and every channel value,
 * into thread `target`.
 */
export const copyThread = (db: Database, source: string, target: string, through: string | null) => {
  const last = through ?? "\u{10FFFF}"
  db.query(
    `INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
      SELECT ?, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata
      FROM checkpoints WHERE thread_id = ? AND checkpoint_id <= ?`,
  ).run(target, source, last)
  db.query(
    `INSERT INTO checkpoint_writes (thread_id, checkpoint_ns, checkpoint_id, task_id, task_path, idx, channel, type, value)
      SELECT ?, checkpoint_ns, checkpoint_id, task_id, task_path, idx, channel, type, value
      FROM checkpoint_writes WHERE thread_id = ? AND checkpoint_id <= ?`,
  ).run(target, source, last)
  db.query(
    `INSERT INTO checkpoint_blobs (thread_id, checkpoint_ns, channel, version, type, blob)
      SELECT ?, checkpoint_ns, channel, version, type, blob FROM checkpoint_blobs WHERE thread_id = ?`,
  ).run(target, source)
}

import type { Database } from "bun:sqlite"
import type { Conversation } from "./conversation.ts"
import type { RecordedFile, StoredFile } from "./files.ts"

/** Which directory a recorded file belongs in. */
export type FileArea = "research" | "memory"

/** A recorded file: where it belongs, its name, and its digest. */
export interface FileRef {
  readonly area: FileArea
  readonly name: string
  readonly sha256: string
}

/** A session's file generations: its current memory generation and how often scratch and memory were found changed. */
export interface Generations {
  readonly memory: number
  readonly scratch: number
  readonly memoryRestore: number
  /** The scratch entries the fork that made the session skipped. */
  readonly forkSkipped: number
}

/**
 * The database side of sessions' files: memory generations with their
 * files, turn snapshots, pending restores, and the generations
 * reconciliation compares. Every file's bytes are stored contents.
 */
export class FileState {
  constructor(
    readonly db: Database,
    readonly conversation: Conversation,
  ) {}

  generations(sessionId: string): Generations {
    const row = this.db
      .query<{ memory_generation: number; scratch_generation: number; memory_restore_generation: number; fork_skipped: number }, [string]>(
        "SELECT memory_generation, scratch_generation, memory_restore_generation, fork_skipped FROM sessions WHERE id = ?",
      )
      .get(sessionId)!
    return {
      memory: row.memory_generation,
      scratch: row.scratch_generation,
      memoryRestore: row.memory_restore_generation,
      forkSkipped: row.fork_skipped,
    }
  }

  setGenerations(sessionId: string, generations: Partial<Generations>) {
    const columns = {
      memory: "memory_generation",
      scratch: "scratch_generation",
      memoryRestore: "memory_restore_generation",
      forkSkipped: "fork_skipped",
    } as const
    for (const [key, value] of Object.entries(generations) as Array<[keyof Generations, number]>) {
      this.db.query(`UPDATE sessions SET ${columns[key]} = ? WHERE id = ?`).run(value, sessionId)
    }
  }

  /** Stores each file's bytes as contents. */
  putFiles(files: ReadonlyArray<StoredFile>) {
    for (const file of files) this.conversation.putContent(file.sha256, file.data)
  }

  /** The files `refs` name, with their stored bytes. */
  files(refs: ReadonlyArray<{ readonly name: string; readonly sha256: string }>): ReadonlyArray<StoredFile> {
    return refs.map((ref) => ({ name: ref.name, sha256: ref.sha256, data: this.conversation.contentBytes(ref.sha256)! }))
  }

  /** Records `generation` as the session's current memory generation, holding `files` as published. */
  recordGeneration(sessionId: string, generation: number, files: ReadonlyArray<RecordedFile>, at: number) {
    this.db.query("INSERT INTO memory_generations (session_id, generation, created_at) VALUES (?, ?, ?)").run(sessionId, generation, at)
    for (const file of files) {
      this.db
        .query("INSERT INTO memory_generation_files (session_id, generation, name, sha256, metadata) VALUES (?, ?, ?, ?, ?)")
        .run(sessionId, generation, file.name, file.sha256, JSON.stringify(file.metadata))
    }
    this.db.query("DELETE FROM memory_generations WHERE session_id = ? AND generation <> ?").run(sessionId, generation)
    this.setGenerations(sessionId, { memory: generation })
  }

  /** The files of the session's memory generation `generation`, by name. */
  generationFiles(sessionId: string, generation: number): ReadonlyArray<RecordedFile> {
    return this.db
      .query<{ name: string; sha256: string; metadata: string }, [string, number]>(
        "SELECT name, sha256, metadata FROM memory_generation_files WHERE session_id = ? AND generation = ? ORDER BY name",
      )
      .all(sessionId, generation)
      .map((row) => ({ name: row.name, sha256: row.sha256, metadata: JSON.parse(row.metadata) }))
  }

  /** Records the files the turn `runId` started with. */
  recordSnapshot(sessionId: string, runId: string, refs: ReadonlyArray<FileRef>) {
    for (const ref of refs) {
      this.db
        .query("INSERT INTO snapshot_files (session_id, run_id, area, name, sha256) VALUES (?, ?, ?, ?, ?)")
        .run(sessionId, runId, ref.area, ref.name, ref.sha256)
    }
  }

  /** The files the turn `runId` started with. */
  snapshot(sessionId: string, runId: string): ReadonlyArray<FileRef> {
    return this.db
      .query<FileRef, [string, string]>(
        "SELECT area, name, sha256 FROM snapshot_files WHERE session_id = ? AND run_id = ? ORDER BY area, name",
      )
      .all(sessionId, runId)
  }

  /** Records the session's pending restore of `refs`. */
  recordPendingRestore(sessionId: string, refs: ReadonlyArray<FileRef>, at: number) {
    this.db.query("INSERT INTO pending_restores (session_id, created_at) VALUES (?, ?)").run(sessionId, at)
    for (const ref of refs) {
      this.db
        .query("INSERT INTO pending_restore_files (session_id, area, name, sha256) VALUES (?, ?, ?, ?)")
        .run(sessionId, ref.area, ref.name, ref.sha256)
    }
  }

  /** The files of the session's pending restore, or null when it has none. */
  pendingRestore(sessionId: string): ReadonlyArray<FileRef> | null {
    if (this.db.query("SELECT 1 FROM pending_restores WHERE session_id = ?").get(sessionId) === null) return null
    return this.db
      .query<FileRef, [string]>("SELECT area, name, sha256 FROM pending_restore_files WHERE session_id = ? ORDER BY area, name")
      .all(sessionId)
  }

  deletePendingRestore(sessionId: string) {
    this.db.query("DELETE FROM pending_restores WHERE session_id = ?").run(sessionId)
  }

  /** Sessions with a pending restore. */
  sessionsPendingRestore(): ReadonlyArray<string> {
    return this.db
      .query<{ session_id: string }, []>("SELECT session_id FROM pending_restores ORDER BY created_at, session_id")
      .all()
      .map((row) => row.session_id)
  }

  /**
   * Deletes the stored contents that no snapshot, memory generation,
   * pending restore, research baseline, or developer component of any
   * session references.
   */
  deleteUnreferencedContents() {
    this.db.run(
      `DELETE FROM contents WHERE sha256 NOT IN (
        SELECT sha256 FROM snapshot_files
        UNION SELECT sha256 FROM memory_generation_files
        UNION SELECT sha256 FROM pending_restore_files
        UNION SELECT json_extract(f.value, '$.sha256') FROM research_baselines b, json_each(b.files) f
        UNION SELECT json_extract(sources, '$.userInstructions.sha256') FROM developer_components
          WHERE json_extract(sources, '$.userInstructions.sha256') IS NOT NULL
      )`,
    )
  }
}

import type { Database } from "bun:sqlite"
import type { Entry, EntryKind, NewEntry } from "../context/entries.ts"

/** Who records an entry or a compaction text: its owning turn and the checkpoint window current then. */
export interface EntryOwner {
  readonly runId: string
  readonly windowPosition: number
}

/** A chat boundary: the item position of its first user message, and the last item it holds once closed. */
export interface Boundary {
  readonly position: number
  readonly runId: string
  readonly closedThrough: number | null
}

/** A boundary's compaction entry: its number, the messages its text covers, and whether it was trimmed. */
export interface CompactionState {
  readonly number: number
  readonly covers: ReadonlyArray<number>
  readonly trimmed: boolean
}

interface EntryRow {
  number: number
  run_id: string
  kind: EntryKind
  fields: string
  resolves: string
  window_position: number
  trimmed: number
  text: string | null
  text_window: number | null
}

const toEntry = (row: EntryRow): Entry => ({
  number: row.number,
  kind: row.kind,
  fields: row.kind === "compaction" ? { Text: row.text ?? "" } : JSON.parse(row.fields),
  resolves: JSON.parse(row.resolves),
  trimmed: row.trimmed === 1,
  runId: row.run_id,
  windowPosition: row.text_window ?? row.window_position,
})

const latestText = (column: string) =>
  `(SELECT ${column} FROM compaction_texts c WHERE c.session_id = e.session_id AND c.number = e.number ORDER BY c.position DESC LIMIT 1)`

/**
 * A session's timelines: entries in one numbered sequence, their trims,
 * chat boundaries with their closings, and compaction entry texts. Every
 * row is owned by the turn that made it, so a rewind deletes the rows of
 * the turns it removes and a fork copies those of the turns it keeps.
 */
export class Timeline {
  constructor(readonly db: Database) {}

  /** Every entry of the session in number order, a compaction entry with its newest text. */
  entries(sessionId: string): ReadonlyArray<Entry> {
    return this.db
      .query<EntryRow, [string]>(
        `SELECT e.number, e.run_id, e.kind, e.fields, e.resolves, e.window_position,
            (SELECT count(*) FROM timeline_trims t WHERE t.session_id = e.session_id AND t.number = e.number) AS trimmed,
            ${latestText("text")} AS text, ${latestText("window_position")} AS text_window
          FROM timeline_entries e WHERE e.session_id = ? ORDER BY e.number`,
      )
      .all(sessionId)
      .map(toEntry)
  }

  /** Records `entry` under the session's next number. */
  append(sessionId: string, owner: EntryOwner, entry: NewEntry, revision: string | null, at: number): Entry {
    const number =
      (this.db.query<{ n: number | null }, [string]>("SELECT max(number) AS n FROM timeline_entries WHERE session_id = ?").get(sessionId)?.n ??
        0) + 1
    this.db
      .query(
        `INSERT INTO timeline_entries (session_id, number, run_id, kind, fields, resolves, prompt_revision, window_position, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        number,
        owner.runId,
        entry.kind,
        JSON.stringify(entry.kind === "compaction" ? {} : entry.fields),
        JSON.stringify(entry.resolves ?? []),
        revision,
        owner.windowPosition,
        at,
      )
    return {
      number,
      kind: entry.kind,
      fields: entry.fields,
      resolves: entry.resolves ?? [],
      trimmed: false,
      runId: owner.runId,
      windowPosition: owner.windowPosition,
    }
  }

  /** Trims `numbers` from the primary timeline, owned by the context turn `runId`. */
  trim(sessionId: string, runId: string, numbers: ReadonlyArray<number>) {
    const insert = this.db.query("INSERT INTO timeline_trims (session_id, number, run_id) VALUES (?, ?, ?)")
    for (const number of numbers) insert.run(sessionId, number, runId)
  }

  /** The entries the turn `runId` trimmed, in number order. */
  trimmedBy(sessionId: string, runId: string): ReadonlyArray<number> {
    return this.db
      .query<{ number: number }, [string, string]>("SELECT number FROM timeline_trims WHERE session_id = ? AND run_id = ? ORDER BY number")
      .all(sessionId, runId)
      .map((row) => row.number)
  }

  /** The session's chat boundaries in order. */
  boundaries(sessionId: string): ReadonlyArray<Boundary> {
    return this.db
      .query<{ position: number; run_id: string; through: number | null }, [string]>(
        `SELECT b.position, b.run_id, c.through_item AS through FROM chat_boundaries b
          LEFT JOIN chat_boundary_closings c ON c.session_id = b.session_id AND c.boundary = b.position
          WHERE b.session_id = ? ORDER BY b.position`,
      )
      .all(sessionId)
      .map((row) => ({ position: row.position, runId: row.run_id, closedThrough: row.through }))
  }

  /** The session's open chat boundary: its newest, when no closing has closed it. */
  openBoundary(sessionId: string): Boundary | null {
    const last = this.boundaries(sessionId).at(-1)
    return last === undefined || last.closedThrough !== null ? null : last
  }

  /** Opens a chat boundary at the user message item `position`, owned by the turn `runId` holding it. */
  openAt(sessionId: string, position: number, runId: string) {
    this.db.query("INSERT INTO chat_boundaries (session_id, position, run_id) VALUES (?, ?, ?)").run(sessionId, position, runId)
  }

  /** Closes the boundary `boundary` through the item `through`, owned by the turn `runId`. */
  close(sessionId: string, boundary: number, runId: string, through: number) {
    this.db
      .query("INSERT INTO chat_boundary_closings (session_id, boundary, run_id, through_item) VALUES (?, ?, ?, ?)")
      .run(sessionId, boundary, runId, through)
  }

  /** The compaction entry of the boundary `boundary`, if it has one. */
  compaction(sessionId: string, boundary: number): CompactionState | null {
    const row = this.db
      .query<{ number: number; covers: string; trimmed: number }, [string, number]>(
        `SELECT c.number, c.covers,
            (SELECT count(*) FROM timeline_trims t WHERE t.session_id = c.session_id AND t.number = c.number) AS trimmed
          FROM compaction_texts c WHERE c.session_id = ? AND c.boundary = ? ORDER BY c.position DESC LIMIT 1`,
      )
      .get(sessionId, boundary)
    return row === null ? null : { number: row.number, covers: JSON.parse(row.covers), trimmed: row.trimmed === 1 }
  }

  /** The boundary whose compaction entry is `number`, if it is a compaction entry. */
  boundaryOf(sessionId: string, number: number): number | null {
    return (
      this.db
        .query<{ boundary: number }, [string, number]>("SELECT boundary FROM compaction_texts WHERE session_id = ? AND number = ? LIMIT 1")
        .get(sessionId, number)?.boundary ?? null
    )
  }

  /**
   * Stores a compaction call's text for its boundary: a new compaction
   * entry when the boundary has none, else the entry's new text. Returns
   * the entry and whether its text was replaced.
   */
  storeCompaction(
    sessionId: string,
    boundary: number,
    owner: EntryOwner,
    text: string,
    covers: ReadonlyArray<number>,
    revision: string,
    at: number,
  ): { readonly entry: Entry; readonly replaced: boolean } {
    const existing = this.compaction(sessionId, boundary)
    const entry =
      existing === null
        ? this.append(sessionId, owner, { kind: "compaction", fields: { Text: text } }, revision, at)
        : { ...this.entries(sessionId).find((candidate) => candidate.number === existing.number)!, fields: { Text: text } }
    const position =
      (this.db.query<{ p: number | null }, [string]>("SELECT max(position) AS p FROM compaction_texts WHERE session_id = ?").get(sessionId)
        ?.p ?? 0) + 1
    this.db
      .query(
        `INSERT INTO compaction_texts (session_id, position, number, boundary, run_id, window_position, text, covers, prompt_revision, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, position, entry.number, boundary, owner.runId, owner.windowPosition, text, JSON.stringify(covers), revision, at)
    return { entry: { ...entry, windowPosition: owner.windowPosition }, replaced: existing !== null }
  }

  /** Copies into `target` the timeline rows of `source` that the turns `runIds` own, keeping their numbers. */
  copy(source: string, target: string, runIds: ReadonlyArray<string>) {
    const kept = JSON.stringify(runIds)
    const owned = "run_id IN (SELECT value FROM json_each(?))"
    const statements = [
      `INSERT INTO timeline_entries (session_id, number, run_id, kind, fields, resolves, prompt_revision, window_position, created_at)
        SELECT ?, number, run_id, kind, fields, resolves, prompt_revision, window_position, created_at FROM timeline_entries
        WHERE session_id = ? AND ${owned}`,
      `INSERT INTO timeline_trims (session_id, number, run_id) SELECT ?, number, run_id FROM timeline_trims WHERE session_id = ? AND ${owned}`,
      `INSERT INTO chat_boundaries (session_id, position, run_id) SELECT ?, position, run_id FROM chat_boundaries WHERE session_id = ? AND ${owned}`,
      `INSERT INTO chat_boundary_closings (session_id, boundary, run_id, through_item)
        SELECT ?, boundary, run_id, through_item FROM chat_boundary_closings WHERE session_id = ? AND ${owned}`,
      `INSERT INTO compaction_texts (session_id, position, number, boundary, run_id, window_position, text, covers, prompt_revision, created_at)
        SELECT ?, position, number, boundary, run_id, window_position, text, covers, prompt_revision, created_at FROM compaction_texts
        WHERE session_id = ? AND ${owned}`,
    ]
    for (const statement of statements) this.db.query(statement).run(target, source, kept)
  }
}

import type { Database } from "bun:sqlite"
import { AIMessage, mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages, type StoredMessage } from "@langchain/core/messages"
import type { InputMode, Sender } from "@ashe-agent/protocol"
import type { ToolContent, ToolOutcome } from "../agent/window.ts"
import type { Component, SourceName, SourceStates } from "../context/components.ts"

/** What one window item holds. */
export type ItemBody =
  | { readonly kind: "component"; readonly component: Component }
  | { readonly kind: "user"; readonly inputId: string; readonly text: string; readonly sender: Sender }
  | { readonly kind: "assistant"; readonly message: AIMessage }
  | {
      readonly kind: "result"
      readonly callId: string
      readonly name: string
      readonly content: ToolContent
      readonly outcome: ToolOutcome
    }

/** A window item with its place, its owning turn, and that turn's model; both are null for an item session creation made. */
export type Item = ItemBody & {
  readonly position: number
  readonly runId: string | null
  readonly model: string | null
}

export interface CheckpointWindow {
  readonly position: number
  readonly runId: string | null
  readonly harnessInstructions: string
}

/** An input waiting for a turn, in arrival order. */
export type WaitingEntry =
  | {
      readonly position: number
      readonly kind: "user"
      readonly inputId: string
      readonly text: string
      readonly mode: InputMode
      readonly sender: Sender
    }
  | { readonly position: number; readonly kind: "notification"; readonly component: Component }

export type NewWaitingEntry =
  | Omit<Extract<WaitingEntry, { kind: "user" }>, "position">
  | Omit<Extract<WaitingEntry, { kind: "notification" }>, "position">

interface ItemRow {
  position: number
  run_id: string | null
  model: string | null
  kind: Item["kind"]
  body: string
  type: Component["type"] | null
  name: string | null
  heading: string | null
  text: string | null
  sources: string | null
}

const toItem = (row: ItemRow): Item => {
  const owned = { position: row.position, runId: row.run_id, model: row.model }
  switch (row.kind) {
    case "component":
      return {
        ...owned,
        kind: "component",
        component: { type: row.type!, name: row.name!, heading: row.heading!, text: row.text!, sources: JSON.parse(row.sources!) },
      }
    case "assistant": {
      const stored = JSON.parse(row.body) as StoredMessage
      return { ...owned, kind: "assistant", message: mapStoredMessagesToChatMessages([stored])[0] as AIMessage }
    }
    case "user":
    case "result":
      return { ...owned, ...JSON.parse(row.body) }
  }
}

const bodyOf = (body: ItemBody): string => {
  switch (body.kind) {
    case "component":
      return "{}"
    case "assistant":
      return JSON.stringify(mapChatMessagesToStoredMessages([body.message])[0])
    case "user":
      return JSON.stringify({ kind: body.kind, inputId: body.inputId, text: body.text, sender: body.sender })
    case "result":
      return JSON.stringify({ kind: body.kind, callId: body.callId, name: body.name, content: body.content, outcome: body.outcome })
  }
}

/**
 * A session's conversation state: checkpoint windows, their items, the
 * developer components items hold, stored contents, and waiting input.
 * Every row is owned by the turn that made it, or by none.
 */
export class Conversation {
  constructor(readonly db: Database) {}

  /** The session's current checkpoint window: its newest. */
  currentWindow(sessionId: string): CheckpointWindow | null {
    const row = this.db
      .query<{ position: number; run_id: string | null; harness_instructions: string }, [string]>(
        "SELECT position, run_id, harness_instructions FROM checkpoint_windows WHERE session_id = ? ORDER BY position DESC LIMIT 1",
      )
      .get(sessionId)
    return row === null ? null : { position: row.position, runId: row.run_id, harnessInstructions: row.harness_instructions }
  }

  insertWindow(sessionId: string, runId: string | null, harnessInstructions: string, createdAt: number): CheckpointWindow {
    const position =
      (this.db
        .query<{ p: number | null }, [string]>("SELECT max(position) AS p FROM checkpoint_windows WHERE session_id = ?")
        .get(sessionId)?.p ?? 0) + 1
    this.db
      .query("INSERT INTO checkpoint_windows (session_id, position, run_id, harness_instructions, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(sessionId, position, runId, harnessInstructions, createdAt)
    return { position, runId, harnessInstructions }
  }

  /** The items of the checkpoint window `window`, in order. */
  items(sessionId: string, window: number): ReadonlyArray<Item> {
    return this.db
      .query<ItemRow, [string, number]>(
        `SELECT i.position, i.run_id, i.model, i.kind, i.body, c.type, c.name, c.heading, c.text, c.sources
          FROM window_items i LEFT JOIN developer_components c ON c.session_id = i.session_id AND c.item_position = i.position
          WHERE i.session_id = ? AND i.window_position = ? ORDER BY i.position`,
      )
      .all(sessionId, window)
      .map(toItem)
  }

  /** The items the turn `runId` owns, in order. */
  turnItems(sessionId: string, runId: string): ReadonlyArray<Item> {
    return this.db
      .query<ItemRow, [string, string]>(
        `SELECT i.position, i.run_id, i.model, i.kind, i.body, c.type, c.name, c.heading, c.text, c.sources
          FROM window_items i LEFT JOIN developer_components c ON c.session_id = i.session_id AND c.item_position = i.position
          WHERE i.session_id = ? AND i.run_id = ? ORDER BY i.position`,
      )
      .all(sessionId, runId)
      .map(toItem)
  }

  /** Appends an item to the checkpoint window `window`, owned by `owner`, or by no turn. */
  appendItem(
    sessionId: string,
    window: number,
    owner: { readonly runId: string; readonly model: string } | null,
    body: ItemBody,
  ): Item {
    const position =
      (this.db.query<{ p: number | null }, [string]>("SELECT max(position) AS p FROM window_items WHERE session_id = ?").get(sessionId)
        ?.p ?? 0) + 1
    this.db
      .query("INSERT INTO window_items (session_id, position, window_position, run_id, model, kind, body) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(sessionId, position, window, owner?.runId ?? null, owner?.model ?? null, body.kind, bodyOf(body))
    if (body.kind === "component") {
      const { type, name, heading, text, sources } = body.component
      this.db
        .query(
          "INSERT INTO developer_components (session_id, item_position, type, name, heading, text, sources) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(sessionId, position, type, name, heading, text, JSON.stringify(sources))
    }
    return { ...body, position, runId: owner?.runId ?? null, model: owner?.model ?? null } as Item
  }

  /**
   * The state the checkpoint window `window` knows of each source: the one
   * its latest component of that source established, whichever model
   * received it. A source no kept component established is absent.
   */
  knownStates(sessionId: string, window: number): SourceStates {
    const known: Partial<Record<SourceName, unknown>> = {}
    const rows = this.db
      .query<{ sources: string }, [string, number]>(
        `SELECT c.sources FROM developer_components c JOIN window_items i ON i.session_id = c.session_id AND i.position = c.item_position
          WHERE i.session_id = ? AND i.window_position = ? ORDER BY i.position`,
      )
      .all(sessionId, window)
    for (const row of rows) Object.assign(known, JSON.parse(row.sources))
    return known as SourceStates
  }

  /** Stores `data` by its SHA-256 `sha256`, once. */
  putContent(sha256: string, data: string) {
    this.db.query("INSERT INTO contents (sha256, data) VALUES (?, ?) ON CONFLICT (sha256) DO NOTHING").run(sha256, Buffer.from(data, "utf8"))
  }

  content(sha256: string): string | null {
    const row = this.db.query<{ data: Uint8Array }, [string]>("SELECT data FROM contents WHERE sha256 = ?").get(sha256)
    return row === null ? null : Buffer.from(row.data).toString("utf8")
  }

  /** Stores an input waiting for a turn after every other waiting input of the session. */
  addWaiting(sessionId: string, entry: NewWaitingEntry, createdAt: number): WaitingEntry {
    const position =
      (this.db.query<{ p: number | null }, [string]>("SELECT max(position) AS p FROM waiting_input WHERE session_id = ?").get(sessionId)
        ?.p ?? 0) + 1
    const { kind, ...body } = entry
    this.db
      .query("INSERT INTO waiting_input (session_id, position, kind, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(sessionId, position, kind, JSON.stringify(body), createdAt)
    return { ...entry, position } as WaitingEntry
  }

  /** The session's waiting input, in arrival order. */
  waiting(sessionId: string): ReadonlyArray<WaitingEntry> {
    return this.db
      .query<{ position: number; kind: WaitingEntry["kind"]; body: string }, [string]>(
        "SELECT position, kind, body FROM waiting_input WHERE session_id = ? ORDER BY position",
      )
      .all(sessionId)
      .map((row) => ({ position: row.position, kind: row.kind, ...JSON.parse(row.body) }))
  }

  /** Sessions holding waiting input, in the order their oldest entry arrived. */
  sessionsWaiting(): ReadonlyArray<string> {
    return this.db
      .query<{ session_id: string }, []>("SELECT session_id FROM waiting_input GROUP BY session_id ORDER BY min(created_at), session_id")
      .all()
      .map((row) => row.session_id)
  }

  removeWaiting(sessionId: string, position: number) {
    this.db.query("DELETE FROM waiting_input WHERE session_id = ? AND position = ?").run(sessionId, position)
  }

  /**
   * Copies into `target` every row of `source`'s conversation state owned
   * by no turn or by one of `runIds`, keeping their positions.
   */
  copy(source: string, target: string, runIds: ReadonlyArray<string>) {
    const kept = JSON.stringify(runIds)
    const owned = "(run_id IS NULL OR run_id IN (SELECT value FROM json_each(?)))"
    this.db
      .query(
        `INSERT INTO checkpoint_windows (session_id, position, run_id, harness_instructions, created_at)
          SELECT ?, position, run_id, harness_instructions, created_at FROM checkpoint_windows WHERE session_id = ? AND ${owned}`,
      )
      .run(target, source, kept)
    this.db
      .query(
        `INSERT INTO window_items (session_id, position, window_position, run_id, model, kind, body)
          SELECT ?, position, window_position, run_id, model, kind, body FROM window_items WHERE session_id = ? AND ${owned}`,
      )
      .run(target, source, kept)
    this.db
      .query(
        `INSERT INTO developer_components (session_id, item_position, type, name, heading, text, sources)
          SELECT ?, c.item_position, c.type, c.name, c.heading, c.text, c.sources FROM developer_components c
          WHERE c.session_id = ? AND c.item_position IN (SELECT position FROM window_items WHERE session_id = ?)`,
      )
      .run(target, source, target)
    this.db
      .query(
        `INSERT INTO tool_result_clearings (session_id, item_position, run_id, attempt)
          SELECT ?, item_position, run_id, attempt FROM tool_result_clearings WHERE session_id = ? AND ${owned}
            AND item_position IN (SELECT position FROM window_items WHERE session_id = ?)`,
      )
      .run(target, source, kept, target)
  }
}

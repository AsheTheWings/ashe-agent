import { createHash } from "node:crypto"
import type { Database } from "bun:sqlite"
import type {
  WebCommand,
  WebOrganizationPatch,
  WebReceipt,
  WebSessionState,
  WebSnapshot,
} from "../shared/web-state.ts"

export class WebStoreError extends Error {
  constructor(
    readonly code: "conflict" | "stale" | "unauthorized" | "not_found" | "invalid",
    message: string,
  ) {
    super(message)
    this.name = "WebStoreError"
  }
}

type Row = {
  session_id: string
  pinned: number
  filed: number
  snoozed_until: number | null
  unread: number
  read_generation: number
  working: number
  needs_human: number
  available: number
  last_activity_at: number
  last_submission_at: number
  last_return_at: number
  source_cursor: number
  opted_out: number
  revision: number
}

type OperationRow = {
  principal: string
  kind: string
  session_id: string | null
  payload_hash: string
  outcome: string
  revision: number
  result: string
}

const toState = (row: Row): WebSessionState => ({
  sessionId: row.session_id,
  pinned: row.pinned === 1,
  filed: row.filed === 1,
  snoozedUntil: row.snoozed_until,
  unread: row.unread === 1,
  readGeneration: row.read_generation,
  working: row.working === 1,
  needsHuman: row.needs_human === 1,
  available: row.available === 1,
  lastActivityAt: row.last_activity_at,
  lastSubmissionAt: row.last_submission_at,
  lastReturnAt: row.last_return_at,
  sourceCursor: row.source_cursor,
  optedOut: row.opted_out === 1,
  revision: row.revision,
})

const stable = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`
}

const hash = (command: WebCommand) => createHash("sha256").update(stable(command)).digest("hex")

const patchFields: ReadonlyArray<keyof WebOrganizationPatch> = ["pinned", "filed", "snoozedUntil", "optedOut"]

/** The web backend's durable organization and observer state. */
export class WebStore {
  constructor(private readonly db: Database) {}

  close() {
    this.db.close()
  }

  database(): Database {
    return this.db
  }

  boundHarness(): string | null {
    const row = this.db.query<{ harness_id: string }, []>("SELECT harness_id FROM web_binding WHERE singleton = 1").get()
    return row?.harness_id ?? null
  }

  /** Binds the store once; a later different harness is refused. */
  bind(harnessId: string, now: number) {
    const bound = this.boundHarness()
    if (bound !== null) {
      if (bound !== harnessId) throw new WebStoreError("unauthorized", "the web store is bound to another harness")
      return
    }
    this.db.run("INSERT INTO web_binding (singleton, harness_id, bound_at) VALUES (1, ?, ?)", [harnessId, now])
  }

  private meta(key: string): string | null {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM web_meta WHERE key = ?").get(key)?.value ?? null
  }

  private setMeta(key: string, value: string) {
    this.db.run("INSERT INTO web_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value])
  }

  revision(): number {
    return Number(this.meta("revision") ?? "0")
  }

  private nextRevision(): number {
    const revision = this.revision() + 1
    this.setMeta("revision", String(revision))
    return revision
  }

  snapshot(principal: string, harnessId: string): WebSnapshot {
    const rows = this.db.query<Row, []>("SELECT * FROM web_sessions ORDER BY last_return_at DESC, session_id").all()
    return {
      type: "web.snapshot",
      protocolVersion: 1,
      revision: this.revision(),
      principal,
      harnessId,
      sessions: rows.map(toState),
    }
  }

  session(sessionId: string): WebSessionState | null {
    const row = this.db.query<Row, [string]>("SELECT * FROM web_sessions WHERE session_id = ?").get(sessionId)
    return row === null ? null : toState(row)
  }

  cursorFor(sessionId: string): number {
    return (
      this.db
        .query<{ cursor: number }, [string]>("SELECT cursor FROM web_observer_sessions WHERE session_id = ?")
        .get(sessionId)?.cursor ?? 0
    )
  }

  /** Ensures a session row exists without changing an existing row. */
  ensureSession(sessionId: string, now: number) {
    this.db.run(
      `INSERT INTO web_sessions
       (session_id, last_activity_at, last_submission_at, last_return_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING`,
      [sessionId, now, now, now, now, now],
    )
  }

  setObserverConnected(connected: boolean, now: number) {
    this.setMeta("observer.connected", connected ? "1" : "0")
    this.setMeta("observer.connected_at", String(now))
    if (connected) this.setMeta("observer.reconciled_at", String(now))
  }

  markReconciled(now: number) {
    this.setMeta("observer.reconciled_at", String(now))
  }

  freshness(now: number, maxAgeMs = 30_000): boolean {
    if (this.meta("observer.connected") !== "1") return false
    const at = Number(this.meta("observer.reconciled_at") ?? "0")
    return now - at <= maxAgeMs
  }

  /** Applies one observed event and advances its cursor in the same transaction. */
  observe(input: {
    readonly sessionId: string
    readonly seq: number
    readonly type: string
    readonly now: number
    readonly working: boolean
    readonly needsHuman: boolean
    readonly available: boolean
    readonly pendingText: boolean
    readonly senderKind?: "session" | "token" | "login"
  }): ReadonlyArray<WebSessionState> {
    return this.db.transaction(() => {
      this.ensureSession(input.sessionId, input.now)
      const row = this.db.query<Row, [string]>("SELECT * FROM web_sessions WHERE session_id = ?").get(input.sessionId)!
      const cursor = this.db
        .query<{ cursor: number }, [string]>("SELECT cursor FROM web_observer_sessions WHERE session_id = ?")
        .get(input.sessionId)?.cursor
      if (cursor !== undefined && input.seq <= cursor) return []
      const next = this.nextRevision()
      const acceptedWork =
        input.type === "INPUT_WAITING" || (input.type === "RUN_STARTED" && input.working)
      const failed = input.type === "RUN_ERROR"
      const attentionWake = input.type === "ACTION_ATTENTION" && input.needsHuman
      const returned = input.type === "RUN_FINISHED" || input.type === "ACTION_ATTENTION"
      const explicitSubmission = input.type === "INPUT_WAITING" && input.senderKind !== "session"
      const activity = ["INPUT_WAITING", "INPUT_RECEIVED", "RUN_STARTED", "RUN_FINISHED", "RUN_ERROR", "RUN_INTERRUPTED", "ACTION_ATTENTION", "ACTION_SETTLED", "SELECTION_CHANGED", "SESSION_REWOUND"].includes(input.type)
      const unread = row.unread === 1 || returned
      this.db.run(
        `UPDATE web_sessions SET
           working = ?, needs_human = ?, available = ?, source_cursor = ?, revision = ?, updated_at = ?,
           last_activity_at = CASE WHEN ? THEN ? ELSE last_activity_at END,
           last_submission_at = CASE WHEN ? THEN ? ELSE last_submission_at END,
           last_return_at = CASE WHEN ? THEN ? ELSE last_return_at END,
           unread = ?, filed = CASE WHEN ? THEN 0 ELSE filed END,
           snoozed_until = CASE WHEN ? THEN NULL WHEN ? THEN NULL ELSE snoozed_until END
         WHERE session_id = ?`,
        [
          input.working ? 1 : 0,
          input.needsHuman ? 1 : 0,
          input.available ? 1 : 0,
          input.seq,
          next,
          input.now,
          activity ? 1 : 0,
          input.now,
          acceptedWork ? 1 : 0,
          input.now,
          returned ? 1 : 0,
          input.now,
          unread ? 1 : 0,
          acceptedWork ? 1 : 0,
          explicitSubmission || failed || attentionWake ? 1 : 0,
          failed ? 1 : 0,
          input.sessionId,
        ],
      )
      this.db.run(
        `INSERT INTO web_observer_sessions (session_id, cursor, reconciled_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET cursor = excluded.cursor, reconciled_at = excluded.reconciled_at`,
        [input.sessionId, input.seq, input.now],
      )
      this.markReconciled(input.now)
      return [toState(this.db.query<Row, [string]>("SELECT * FROM web_sessions WHERE session_id = ?").get(input.sessionId)!)]
    })()
  }

  /** Replaces a session's shared facts from an authoritative owner observation. */
  reconcile(input: {
    readonly sessionId: string
    readonly cursor: number
    readonly now: number
    readonly working: boolean
    readonly pendingText: boolean
    readonly needsHuman: boolean
    readonly available: boolean
  }): ReadonlyArray<WebSessionState> {
    return this.db.transaction(() => {
      this.ensureSession(input.sessionId, input.now)
      const row = this.db.query<Row, [string]>("SELECT * FROM web_sessions WHERE session_id = ?").get(input.sessionId)!
      if (input.cursor < row.source_cursor) return []
      const work = input.working || input.pendingText
      const sameFacts = row.working === (work ? 1 : 0) && row.needs_human === (input.needsHuman ? 1 : 0) && row.available === (input.available ? 1 : 0)
      if (input.cursor === row.source_cursor && sameFacts) {
        this.db.run(
          "INSERT INTO web_observer_sessions (session_id, cursor, reconciled_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET reconciled_at = excluded.reconciled_at",
          [input.sessionId, input.cursor, input.now],
        )
        this.markReconciled(input.now)
        return []
      }
      const next = this.nextRevision()
      this.db.run(
        "UPDATE web_sessions SET working = ?, needs_human = ?, available = ?, source_cursor = ?, revision = ?, updated_at = ?, last_activity_at = ? WHERE session_id = ?",
        [work ? 1 : 0, input.needsHuman ? 1 : 0, input.available ? 1 : 0, input.cursor, next, input.now, row.last_activity_at, input.sessionId],
      )
      this.db.run(
        `INSERT INTO web_observer_sessions (session_id, cursor, reconciled_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET cursor = excluded.cursor, reconciled_at = excluded.reconciled_at`,
        [input.sessionId, input.cursor, input.now],
      )
      this.markReconciled(input.now)
      return [toState(this.db.query<Row, [string]>("SELECT * FROM web_sessions WHERE session_id = ?").get(input.sessionId)!)]
    })()
  }

  apply(principal: string, command: WebCommand, now: number): { receipt: WebReceipt; changed: ReadonlyArray<WebSessionState>; revision: number } {
    return this.db.transaction(() => {
      const payloadHash = hash(command)
      const existing = this.db
        .query<OperationRow, [string]>("SELECT * FROM web_operations WHERE operation_id = ?")
        .get(command.operationId)
      if (existing !== null) {
        if (existing.principal !== principal || existing.payload_hash !== payloadHash) {
          throw new WebStoreError("conflict", "the operation identity already belongs to another command")
        }
        const result = JSON.parse(existing.result) as { changed: ReadonlyArray<WebSessionState>; message?: string }
        const receipt: WebReceipt = {
            type: "web.receipt",
            operationId: command.operationId,
            outcome: existing.outcome as WebReceipt["outcome"],
            revision: existing.revision,
            changed: result.changed,
            ...(result.message === undefined ? {} : { message: result.message }),
          }
        return {
          receipt,
          changed: result.changed,
          revision: existing.revision,
        }
      }
      this.db.run("SAVEPOINT command")
      try {
        const before = "sessionId" in command ? this.session(command.sessionId) : null
        const changed = this.execute(principal, command, now)
        const revision = this.revision()
        const receipt: WebReceipt = {
          type: "web.receipt",
          operationId: command.operationId,
          outcome: "confirmed",
          revision,
          changed,
        }
        const undo = before === null ? undefined : this.undoFor(command, before)
        this.record(command, principal, "confirmed", revision, { changed, ...(undo === undefined ? {} : { undo }) }, now)
        this.db.run("RELEASE command")
        return { receipt, changed, revision }
      } catch (error) {
        this.db.run("ROLLBACK TO command")
        this.db.run("RELEASE command")
        const message = error instanceof Error ? error.message : String(error)
        const revision = this.revision()
        const receipt: WebReceipt = {
          type: "web.receipt",
          operationId: command.operationId,
          outcome: "rejected",
          revision,
          changed: [],
          message,
        }
        this.record(command, principal, "rejected", revision, { changed: [], message }, now)
        return { receipt, changed: [], revision }
      }
    })()
  }

  operation(principal: string, operationId: string): WebReceipt | null {
    const row = this.db
      .query<OperationRow, [string]>("SELECT * FROM web_operations WHERE operation_id = ?")
      .get(operationId)
    if (row === null) return null
    if (row.principal !== principal) throw new WebStoreError("unauthorized", "the operation belongs to another principal")
    const result = JSON.parse(row.result) as { changed: ReadonlyArray<WebSessionState>; message?: string }
    return {
      type: "web.receipt",
      operationId,
      outcome: row.outcome as WebReceipt["outcome"],
      revision: row.revision,
      changed: result.changed,
      ...(result.message === undefined ? {} : { message: result.message }),
    }
  }

  private undoFor(command: WebCommand, before: WebSessionState) {
    if (command.kind === "file.manual") {
      return { fields: ["filed"], before: { filed: before.filed }, after: { filed: true } }
    }
    if (command.kind !== "organization.set") return undefined
    const fields = patchFields.filter((field) => Object.hasOwn(command.patch, field))
    if (fields.length === 0) return undefined
    const beforeValues: Record<string, unknown> = {}
    const afterValues: Record<string, unknown> = {}
    for (const field of fields) {
      beforeValues[field] = before[field]
      afterValues[field] = command.patch[field]
    }
    return { fields, before: beforeValues, after: afterValues }
  }

  private record(command: WebCommand, principal: string, outcome: string, revision: number, result: object, now: number) {
    this.db.run(
      "INSERT INTO web_operations (operation_id, principal, kind, session_id, payload_hash, outcome, revision, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        command.operationId,
        principal,
        command.kind,
        "sessionId" in command ? command.sessionId : null,
        hash(command),
        outcome,
        revision,
        JSON.stringify(result),
        now,
      ],
    )
  }

  private execute(principal: string, command: WebCommand, now: number): ReadonlyArray<WebSessionState> {
    if (command.kind === "undo") return this.undo(principal, command.undoOf, command.operationId, now)
    if (!("sessionId" in command)) throw new WebStoreError("invalid", "the command has no session")
    this.ensureSession(command.sessionId, now)
    const row = this.db.query<Row, [string]>("SELECT * FROM web_sessions WHERE session_id = ?").get(command.sessionId)!
    if (command.kind === "read.set") {
      if (command.unread) {
        const next = this.nextRevision()
        this.db.run(
          "UPDATE web_sessions SET unread = 1, read_generation = read_generation + 1, revision = ?, updated_at = ? WHERE session_id = ?",
          [next, now, command.sessionId],
        )
        return [toState({ ...row, unread: 1, read_generation: row.read_generation + 1, revision: next })]
      }
      if (command.generation === undefined || command.generation !== row.read_generation) {
        throw new WebStoreError("stale", "the read acknowledgement belongs to an older generation")
      }
      if (row.unread === 0) return [toState(row)]
      const next = this.nextRevision()
      this.db.run("UPDATE web_sessions SET unread = 0, revision = ?, updated_at = ? WHERE session_id = ?", [next, now, command.sessionId])
      return [toState({ ...row, unread: 0, revision: next })]
    }
    if (command.kind === "file.manual") {
      if (!this.freshness(now)) throw new WebStoreError("stale", "web observation is not fresh")
      if (row.working === 1 || row.needs_human === 1 || row.source_cursor !== command.observedCursor || row.revision !== command.observedRevision) {
        throw new WebStoreError("stale", "the session is busy or the observation changed")
      }
      const next = this.nextRevision()
      this.db.run("UPDATE web_sessions SET filed = 1, revision = ?, updated_at = ? WHERE session_id = ?", [next, now, command.sessionId])
      return [toState({ ...row, filed: 1, revision: next })]
    }
    if (command.kind !== "organization.set") throw new WebStoreError("invalid", "unknown command")
    if (command.expectedRevision !== undefined && row.revision !== command.expectedRevision) {
      throw new WebStoreError("conflict", "the session organization changed")
    }
    const after: Record<string, unknown> = {}
    const assignments: Array<string> = []
    const values: Array<unknown> = []
    for (const field of patchFields) {
      if (!Object.hasOwn(command.patch, field)) continue
      const value = command.patch[field]
      if (value === undefined) continue
      const column = field === "snoozedUntil" ? "snoozed_until" : field === "optedOut" ? "opted_out" : field
      after[field] = value
      assignments.push(`${column} = ?`)
      values.push(field === "snoozedUntil" || field === "optedOut" ? value : value ? 1 : 0)
    }
    if (assignments.length === 0) return [toState(row)]
    const next = this.nextRevision()
    this.db.run(
      `UPDATE web_sessions SET ${assignments.join(", ")}, revision = ?, updated_at = ? WHERE session_id = ?`,
      [...(values as Array<string | number | null>), next, now, command.sessionId],
    )
    const changed: Row = { ...row }
    for (const field of Object.keys(after) as Array<keyof WebOrganizationPatch>) {
      if (field === "snoozedUntil") changed.snoozed_until = after[field] as number | null
      else if (field === "optedOut") changed.opted_out = after[field] ? 1 : 0
      else if (field === "pinned") changed.pinned = after[field] ? 1 : 0
      else if (field === "filed") changed.filed = after[field] ? 1 : 0
    }
    changed.revision = next
    return [toState(changed)]
  }

  private undo(principal: string, operationId: string, undoId: string, now: number): ReadonlyArray<WebSessionState> {
    const operation = this.db
      .query<OperationRow, [string]>("SELECT * FROM web_operations WHERE operation_id = ?")
      .get(operationId)
    if (operation === null || operation.session_id === null) throw new WebStoreError("not_found", "no operation to undo")
    if (operation.principal !== principal) throw new WebStoreError("unauthorized", "the operation belongs to another principal")
    const result = JSON.parse(operation.result) as {
      undo?: { fields: Array<keyof WebOrganizationPatch>; before: Record<string, unknown>; after: Record<string, unknown> }
    }
    if (result.undo === undefined) throw new WebStoreError("invalid", "the operation has no undo")
    const row = this.db.query<Row, [string]>("SELECT * FROM web_sessions WHERE session_id = ?").get(operation.session_id)!
    const current: Record<string, unknown> = {}
    for (const field of result.undo.fields) {
      current[field] = field === "snoozedUntil" ? row.snoozed_until : field === "pinned" ? row.pinned === 1 : field === "filed" ? row.filed === 1 : row.opted_out === 1
    }
    if (stable(current) !== stable(result.undo.after)) throw new WebStoreError("stale", "a later change replaced the value to undo")
    const assignments: Array<string> = []
    const values: Array<unknown> = []
    for (const field of result.undo.fields) {
      const column = field === "snoozedUntil" ? "snoozed_until" : field === "optedOut" ? "opted_out" : field
      assignments.push(`${column} = ?`)
      const value = result.undo.before[field]
      values.push(field === "snoozedUntil" || field === "optedOut" ? (value ?? null) : value ? 1 : 0)
    }
    const next = this.nextRevision()
    this.db.run(
      `UPDATE web_sessions SET ${assignments.join(", ")}, revision = ?, updated_at = ? WHERE session_id = ?`,
      [...(values as Array<string | number | null>), next, now, operation.session_id],
    )
    const changed: Row = { ...row, revision: next }
    for (const field of result.undo.fields) {
      if (field === "pinned") changed.pinned = result.undo.before[field] ? 1 : 0
      else if (field === "filed") changed.filed = result.undo.before[field] ? 1 : 0
      else if (field === "optedOut") changed.opted_out = result.undo.before[field] ? 1 : 0
      else changed.snoozed_until = (result.undo.before[field] as number | null) ?? null
    }
    return [toState(changed)]
  }

  /** Files inactive unpinned, unworked sessions after the configured quiet period. */
  fileInactive(now: number, days: number): ReadonlyArray<WebSessionState> {
    if (days <= 0 || !this.freshness(now)) return []
    const cutoff = now - days * 86_400_000
    const rows = this.db
      .query<Row, [number, number, number]>(
        `SELECT * FROM web_sessions WHERE filed = 0 AND pinned = 0 AND opted_out = 0 AND working = 0 AND needs_human = 0
         AND last_activity_at <= ? AND (snoozed_until IS NULL OR snoozed_until <= ?) AND created_at <= ?`,
      )
      .all(cutoff, now, cutoff)
    if (rows.length === 0) return []
    return this.db.transaction(() => {
      const revision = this.nextRevision()
      for (const row of rows) {
        this.db.run("UPDATE web_sessions SET filed = 1, revision = ?, updated_at = ? WHERE session_id = ?", [revision, now, row.session_id])
      }
      return rows.map((row) => toState({ ...row, filed: 1, revision }))
    })()
  }
}

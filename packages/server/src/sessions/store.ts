import type { Database } from "bun:sqlite"
import { join } from "node:path"
import type { SessionEvent, SessionEventBody, SessionSummary } from "@ashe-agent/protocol"
import type { ModelOverrides, Permission } from "../inputs/shapes.ts"
import { Conversation } from "./conversation.ts"
import { FileState } from "./file-state.ts"
import { Timeline } from "./timeline.ts"

export type TurnStatus = "running" | "finished" | "cancelled" | "failed" | "interrupted"

/** The catalogs a developer message lists. */
export interface Catalogs {
  readonly skills: string | null
  readonly codeMode: string | null
}

export interface SessionRecord {
  readonly id: string
  /** The session's own directory under the sessions directory, its starting working directory. */
  readonly sessionDir: string
  /** The title of the session's agent, or null for the implicit agent. */
  readonly agent: string | null
  readonly model: string
  /** The reasoning effort selected for the model, or null for its default. */
  readonly reasoningEffort: string | null
  /** The agent's model setting overrides, by model id, as recorded at creation. */
  readonly modelOverrides: Readonly<Record<string, ModelOverrides>>
  /** The agent's permission rules as recorded at creation, or null without any. */
  readonly permission: Permission | null
  readonly createdAt: number
  readonly nextSeq: number
}

/** What started a turn: an input holding a user message, a continuation, or another notification component. */
export type TurnCause = "user" | "continuation" | "notification"

export interface TurnRecord {
  readonly runId: string
  readonly position: number
  readonly cause: TurnCause
  /** The user messages the turn's starting input holds, in order; a turn holding any is a rewind and fork point. */
  readonly userMessageIds: ReadonlyArray<string>
  readonly model: string
  /** The session's reasoning effort selection when the turn started. */
  readonly reasoningEffort: string | null
  readonly status: TurnStatus
  /** The number of the turn's first event, where a rewind of it starts removing. */
  readonly firstSeq: number
  /** The item position of the turn's context turn component, or null for a turn that never became a context turn. */
  readonly contextItem: number | null
  /** What started the turn's context turn: the reserve running short, or the context limit. */
  readonly contextTrigger: "threshold" | "limit" | null
}

interface SessionRow {
  id: string
  agent_key: string | null
  model: string
  reasoning_effort: string | null
  model_overrides: string
  permission: string | null
  created_at: number
  next_seq: number
}

const toSession = (row: SessionRow, sessionsDir: string): SessionRecord => ({
  id: row.id,
  sessionDir: join(sessionsDir, row.id),
  agent: row.agent_key,
  model: row.model,
  reasoningEffort: row.reasoning_effort,
  modelOverrides: JSON.parse(row.model_overrides),
  permission: row.permission === null ? null : JSON.parse(row.permission),
  createdAt: row.created_at,
  nextSeq: row.next_seq,
})

interface TurnRow {
  run_id: string
  position: number
  cause: TurnCause
  user_message_ids: string
  model: string
  reasoning_effort: string | null
  status: TurnStatus
  first_seq: number
  context_item: number | null
  context_trigger: "threshold" | "limit" | null
}

const toTurn = (row: TurnRow): TurnRecord => ({
  runId: row.run_id,
  position: row.position,
  cause: row.cause,
  userMessageIds: JSON.parse(row.user_message_ids),
  model: row.model,
  reasoningEffort: row.reasoning_effort,
  status: row.status,
  firstSeq: row.first_seq,
  contextItem: row.context_item,
  contextTrigger: row.context_trigger,
})

const turnColumns = "run_id, position, cause, user_message_ids, model, reasoning_effort, status, first_seq, context_item, context_trigger"

/** Session, event, and turn persistence. Every write that numbers an event takes the session's counter. */
export class SessionStore {
  readonly conversation: Conversation
  readonly files: FileState
  readonly timeline: Timeline

  /** `sessionsDir` holds each session's directory, named by its id. */
  constructor(
    readonly db: Database,
    readonly sessionsDir: string,
  ) {
    this.conversation = new Conversation(db)
    this.files = new FileState(db, this.conversation)
    this.timeline = new Timeline(db)
  }

  /** Every session, oldest first. */
  sessions(): ReadonlyArray<SessionRecord> {
    return this.db
      .query<SessionRow, []>("SELECT * FROM sessions ORDER BY created_at, id")
      .all()
      .map((row) => toSession(row, this.sessionsDir))
  }

  /** The directory of the session `id`. */
  sessionDir(id: string) {
    return join(this.sessionsDir, id)
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id)
    return row === null ? null : toSession(row, this.sessionsDir)
  }

  listSessions(running: (id: string) => boolean): ReadonlyArray<SessionSummary> {
    return this.db
      .query<SessionRow, []>("SELECT * FROM sessions ORDER BY created_at DESC, id")
      .all()
      .map((row) => this.summary(toSession(row, this.sessionsDir), running(row.id)))
  }

  summary(session: SessionRecord, running: boolean): SessionSummary {
    const last = this.db
      .query<{ seq: number | null }, [string]>("SELECT max(seq) AS seq FROM events WHERE session_id = ?")
      .get(session.id)
    return {
      id: session.id,
      sessionDir: session.sessionDir,
      agent: session.agent,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      createdAt: session.createdAt,
      running,
      lastSeq: last?.seq ?? 0,
    }
  }

  /** Creates a session with its `SESSION_CREATED` event as event 1. */
  createSession(session: Omit<SessionRecord, "sessionDir" | "nextSeq">, forkedFrom: { sessionId: string; runId: string | null } | null) {
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO sessions
            (id, agent_key, model, reasoning_effort, model_overrides, permission, forked_from_session, forked_from_run,
             created_at, next_seq)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          session.id,
          session.agent,
          session.model,
          session.reasoningEffort,
          JSON.stringify(session.modelOverrides),
          session.permission === null ? null : JSON.stringify(session.permission),
          forkedFrom?.sessionId ?? null,
          forkedFrom?.runId ?? null,
          session.createdAt,
        )
      this.appendEvent(
        session.id,
        {
          type: "SESSION_CREATED",
          sessionDir: this.sessionDir(session.id),
          agent: session.agent,
          model: session.model,
          reasoningEffort: session.reasoningEffort,
          forkedFrom,
        },
        session.createdAt,
      )
    })()
  }

  setModel(sessionId: string, model: string, reasoningEffort: string | null) {
    this.db.query("UPDATE sessions SET model = ?, reasoning_effort = ? WHERE id = ?").run(model, reasoningEffort, sessionId)
  }

  /** The session's grants, as allow rules in the order they were added. */
  grants(sessionId: string): ReadonlyArray<{ readonly permission: string; readonly pattern: string }> {
    return this.db
      .query<{ permission: string; pattern: string }, [string]>(
        "SELECT permission, pattern FROM session_grants WHERE session_id = ? ORDER BY position",
      )
      .all(sessionId)
  }

  addGrants(sessionId: string, permission: string, patterns: ReadonlyArray<string>) {
    const insert = this.db.query(
      `INSERT INTO session_grants (session_id, position, permission, pattern)
        VALUES (?, (SELECT coalesce(max(position), 0) + 1 FROM session_grants WHERE session_id = ?), ?, ?)`,
    )
    this.db.transaction(() => {
      for (const pattern of patterns) insert.run(sessionId, sessionId, permission, pattern)
    })()
  }

  /** Persists an event under the session's next sequence number, advancing the counter first, and returns it. */
  appendEvent(sessionId: string, body: SessionEventBody, timestamp: number): SessionEvent {
    return this.db.transaction(() => {
      const row = this.db.query<{ next_seq: number }, [string]>("SELECT next_seq FROM sessions WHERE id = ?").get(sessionId)
      if (row === null) throw new Error(`no session ${sessionId}`)
      const seq = row.next_seq
      this.db.query("UPDATE sessions SET next_seq = ? WHERE id = ?").run(seq + 1, sessionId)
      this.db
        .query("INSERT INTO events (session_id, seq, timestamp, body) VALUES (?, ?, ?, ?)")
        .run(sessionId, seq, timestamp, JSON.stringify(body))
      return { sessionId, seq, timestamp, event: body }
    })()
  }

  /** The session's persisted events after `afterSeq`, in order. */
  eventsAfter(sessionId: string, afterSeq: number): ReadonlyArray<SessionEvent> {
    return this.db
      .query<{ seq: number; timestamp: number; body: string }, [string, number]>(
        "SELECT seq, timestamp, body FROM events WHERE session_id = ? AND seq > ? ORDER BY seq",
      )
      .all(sessionId, afterSeq)
      .map((row) => ({ sessionId, seq: row.seq, timestamp: row.timestamp, event: JSON.parse(row.body) }))
  }

  turns(sessionId: string): ReadonlyArray<TurnRecord> {
    return this.db
      .query<TurnRow, [string]>(`SELECT ${turnColumns} FROM turns WHERE session_id = ? ORDER BY position`)
      .all(sessionId)
      .map(toTurn)
  }

  getTurn(sessionId: string, runId: string): TurnRecord | null {
    const row = this.db
      .query<TurnRow, [string, string]>(`SELECT ${turnColumns} FROM turns WHERE session_id = ? AND run_id = ?`)
      .get(sessionId, runId)
    return row === null ? null : toTurn(row)
  }

  insertTurn(
    sessionId: string,
    turn: Omit<TurnRecord, "position" | "status" | "contextItem" | "contextTrigger">,
    startedAt: number,
  ): TurnRecord {
    const position =
      (this.db.query<{ p: number | null }, [string]>("SELECT max(position) AS p FROM turns WHERE session_id = ?").get(sessionId)
        ?.p ?? 0) + 1
    this.db
      .query(
        `INSERT INTO turns
          (session_id, run_id, position, cause, user_message_ids, model, reasoning_effort, status, first_seq, started_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(
        sessionId,
        turn.runId,
        position,
        turn.cause,
        JSON.stringify(turn.userMessageIds),
        turn.model,
        turn.reasoningEffort,
        turn.firstSeq,
        startedAt,
      )
    return { ...turn, position, status: "running", contextItem: null, contextTrigger: null }
  }

  /** Records that the turn `runId` became a context turn at the item `item`. */
  markContextTurn(sessionId: string, runId: string, item: number, trigger: "threshold" | "limit") {
    this.db.query("UPDATE turns SET context_item = ?, context_trigger = ? WHERE session_id = ? AND run_id = ?").run(item, trigger, sessionId, runId)
  }

  /** Whether the session's kept events hold one of `type`. */
  hasEvent(sessionId: string, type: SessionEventBody["type"]): boolean {
    return (
      this.db
        .query("SELECT 1 FROM events WHERE session_id = ? AND json_extract(body, '$.type') = ? LIMIT 1")
        .get(sessionId, type) !== null
    )
  }

  endTurn(sessionId: string, runId: string, status: Exclude<TurnStatus, "running">, endedAt: number) {
    this.db.query("UPDATE turns SET status = ?, ended_at = ? WHERE session_id = ? AND run_id = ?").run(status, endedAt, sessionId, runId)
  }

  /** Turns left running by a stopped server, with their sessions. */
  runningTurns(): ReadonlyArray<{ readonly sessionId: string; readonly runId: string }> {
    return this.db
      .query<{ session_id: string; run_id: string }, []>("SELECT session_id, run_id FROM turns WHERE status = 'running'")
      .all()
      .map((row) => ({ sessionId: row.session_id, runId: row.run_id }))
  }

  /**
   * Removes `turn` and every later turn, with their events, the
   * `INPUT_WAITING` events of the user messages they took, and every row of
   * conversation state they own, which their foreign keys delete with them.
   * The counter keeps its value, so no removed number is used again; the
   * caller appends the rewound event in the same transaction.
   */
  removeFrom(sessionId: string, turn: TurnRecord) {
    const removed = this.turns(sessionId).filter((candidate) => candidate.position >= turn.position)
    const taken = JSON.stringify(removed.flatMap((candidate) => candidate.userMessageIds))
    this.db
      .query(
        `DELETE FROM events WHERE session_id = ? AND (seq >= ? OR (json_extract(body, '$.type') = 'INPUT_WAITING'
          AND json_extract(body, '$.inputId') IN (SELECT value FROM json_each(?))))`,
      )
      .run(sessionId, turn.firstSeq, taken)
    this.db.query("DELETE FROM turns WHERE session_id = ? AND position >= ?").run(sessionId, turn.position)
  }

  /**
   * Creates `target` as a copy of `source` through the turn `throughRunId`,
   * or all of it: its turns and their events keep their numbers, it holds
   * the conversation state owned by no turn or by a copied turn and the
   * source's grants, and the copy's first event names its source and gives
   * its settings. Events about the source session itself, its rewinds and
   * model changes, and inputs no copied turn took, are not copied.
   */
  fork(source: SessionRecord, target: { id: string; createdAt: number }, throughRunId: string | null): SessionRecord {
    return this.db.transaction(() => {
      const turns = this.turns(source.id)
      const through = throughRunId === null ? null : turns.find((turn) => turn.runId === throughRunId)
      if (through === undefined) throw new Error(`no turn ${throughRunId}`)
      const next = through === null ? undefined : turns.find((turn) => turn.position > through.position)
      const cutoff = next === undefined ? source.nextSeq : next.firstSeq
      this.db
        .query(
          `INSERT INTO sessions
            (id, agent_key, model, reasoning_effort, model_overrides, permission, forked_from_session, forked_from_run,
             created_at, next_seq)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          target.id,
          source.agent,
          source.model,
          source.reasoningEffort,
          JSON.stringify(source.modelOverrides),
          source.permission === null ? null : JSON.stringify(source.permission),
          source.id,
          throughRunId,
          target.createdAt,
          cutoff,
        )
      const created: SessionEventBody = {
        type: "SESSION_CREATED",
        sessionDir: this.sessionDir(target.id),
        agent: source.agent,
        model: source.model,
        reasoningEffort: source.reasoningEffort,
        forkedFrom: { sessionId: source.id, runId: throughRunId },
      }
      const insert = this.db.query("INSERT INTO events (session_id, seq, timestamp, body) VALUES (?, ?, ?, ?)")
      const copied = this.eventsAfter(source.id, 0).filter((event) => event.seq < cutoff)
      // A waiting input's event is copied only with the copied turn that took it.
      const taken = new Set(copied.flatMap(({ event }) => (event.type === "INPUT_RECEIVED" ? [event.inputId] : [])))
      for (const event of copied) {
        const type = event.event.type
        if (type === "SESSION_REWOUND" || type === "MODEL_CHANGED") continue
        if (event.event.type === "INPUT_WAITING" && !taken.has(event.event.inputId)) continue
        const body = type === "SESSION_CREATED" ? created : withThread(event.event, target.id)
        insert.run(target.id, event.seq, type === "SESSION_CREATED" ? target.createdAt : event.timestamp, JSON.stringify(body))
      }
      this.db
        .query(
          `INSERT INTO turns
            (session_id, run_id, position, cause, user_message_ids, model, reasoning_effort, status, first_seq, started_at, ended_at,
             context_item, context_trigger)
            SELECT ?, run_id, position, cause, user_message_ids, model, reasoning_effort, status, first_seq, started_at, ended_at,
              context_item, context_trigger
            FROM turns WHERE session_id = ? AND first_seq < ?`,
        )
        .run(target.id, source.id, cutoff)
      const kept = turns.filter((turn) => turn.firstSeq < cutoff).map((turn) => turn.runId)
      this.conversation.copy(source.id, target.id, kept)
      this.timeline.copy(source.id, target.id, kept)
      this.db
        .query(
          `INSERT INTO session_grants (session_id, position, permission, pattern)
            SELECT ?, position, permission, pattern FROM session_grants WHERE session_id = ?`,
        )
        .run(target.id, source.id)
      return this.getSession(target.id)!
    })()
  }
}

/** An event as it reads in another session: AG-UI's threadId names the session. */
const withThread = (body: SessionEventBody, sessionId: string): SessionEventBody =>
  "threadId" in body ? ({ ...body, threadId: sessionId } as SessionEventBody) : body

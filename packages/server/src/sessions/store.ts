import type { Database } from "bun:sqlite"
import type { SessionEvent, SessionEventBody, SessionSummary } from "@ashe-agent/protocol"
import type { AgentSettings } from "../agents/agents.ts"
import { copyThread, latestCheckpointId, truncateThread } from "../store/checkpoint-threads.ts"

export type TurnStatus = "running" | "finished" | "cancelled" | "failed" | "interrupted"

/** The catalogs a developer message lists. */
export interface Catalogs {
  readonly skills: string | null
  readonly codeMode: string | null
}

export interface SessionRecord {
  readonly id: string
  readonly cwd: string
  readonly agent: string | null
  readonly model: string
  readonly instructions: string | null
  /** The agent's settings as recorded at creation. */
  readonly agentSettings: AgentSettings
  readonly createdAt: number
  readonly nextSeq: number
  /** The first message of every model call, rendered at creation. */
  readonly firstMessage: string
  /** The catalogs the first message lists. */
  readonly catalogs: Catalogs
  /** Harness notes the next turn delivers. */
  readonly pendingNotes: ReadonlyArray<string>
}

export interface TurnRecord {
  readonly runId: string
  readonly position: number
  readonly inputId: string
  readonly inputText: string
  readonly model: string
  readonly status: TurnStatus
  readonly firstSeq: number
  /** The fork and rewind notes the turn delivered, which a rewind of it delivers again; catalog notes are derived anew. */
  readonly notes: ReadonlyArray<string>
  /** The catalogs the model knew from the turn on: the first message's, or those a note gave it. */
  readonly catalogs: Catalogs
  /** The last checkpoint of the session's window when the turn ended. */
  readonly checkpointId: string | null
}

interface SessionRow {
  id: string
  cwd: string
  agent: string | null
  model: string
  instructions: string | null
  agent_settings: string
  created_at: number
  next_seq: number
  first_message: string
  catalogs: string
  pending_notes: string
}

const toSession = (row: SessionRow): SessionRecord => ({
  id: row.id,
  cwd: row.cwd,
  agent: row.agent,
  model: row.model,
  instructions: row.instructions,
  agentSettings: JSON.parse(row.agent_settings),
  createdAt: row.created_at,
  nextSeq: row.next_seq,
  firstMessage: row.first_message,
  catalogs: JSON.parse(row.catalogs),
  pendingNotes: JSON.parse(row.pending_notes),
})

interface TurnRow {
  run_id: string
  position: number
  input_id: string
  input_text: string
  model: string
  status: TurnStatus
  first_seq: number
  notes: string
  catalogs: string
  checkpoint_id: string | null
}

const toTurn = (row: TurnRow): TurnRecord => ({
  runId: row.run_id,
  position: row.position,
  inputId: row.input_id,
  inputText: row.input_text,
  model: row.model,
  status: row.status,
  firstSeq: row.first_seq,
  notes: JSON.parse(row.notes),
  catalogs: JSON.parse(row.catalogs),
  checkpointId: row.checkpoint_id,
})

const turnColumns = "run_id, position, input_id, input_text, model, status, first_seq, notes, catalogs, checkpoint_id"

/** Session, event, and turn persistence. Every write that numbers an event takes the session's counter. */
export class SessionStore {
  constructor(readonly db: Database) {}

  getSession(id: string): SessionRecord | null {
    const row = this.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id)
    return row === null ? null : toSession(row)
  }

  listSessions(running: (id: string) => boolean): ReadonlyArray<SessionSummary> {
    return this.db
      .query<SessionRow, []>("SELECT * FROM sessions ORDER BY created_at DESC, id")
      .all()
      .map((row) => this.summary(toSession(row), running(row.id)))
  }

  summary(session: SessionRecord, running: boolean): SessionSummary {
    const last = this.db
      .query<{ seq: number | null }, [string]>("SELECT max(seq) AS seq FROM events WHERE session_id = ?")
      .get(session.id)
    return {
      id: session.id,
      cwd: session.cwd,
      agent: session.agent,
      model: session.model,
      createdAt: session.createdAt,
      running,
      lastSeq: last?.seq ?? 0,
    }
  }

  /** Creates a session with its `SESSION_CREATED` event as event 1. */
  createSession(
    session: Omit<SessionRecord, "nextSeq" | "pendingNotes">,
    forkedFrom: { sessionId: string; runId: string | null } | null,
  ) {
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO sessions
            (id, cwd, agent, model, instructions, agent_settings, forked_from_session, forked_from_run, created_at, next_seq,
             first_message, catalogs)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          session.id,
          session.cwd,
          session.agent,
          session.model,
          session.instructions,
          JSON.stringify(session.agentSettings),
          forkedFrom?.sessionId ?? null,
          forkedFrom?.runId ?? null,
          session.createdAt,
          session.firstMessage,
          JSON.stringify(session.catalogs),
        )
      this.appendEvent(
        session.id,
        { type: "SESSION_CREATED", cwd: session.cwd, agent: session.agent, model: session.model, forkedFrom },
        session.createdAt,
      )
    })()
  }

  setModel(sessionId: string, model: string) {
    this.db.query("UPDATE sessions SET model = ? WHERE id = ?").run(model, sessionId)
  }

  setFirstMessage(sessionId: string, firstMessage: string, catalogs: Catalogs) {
    this.db
      .query("UPDATE sessions SET first_message = ?, catalogs = ? WHERE id = ?")
      .run(firstMessage, JSON.stringify(catalogs), sessionId)
  }

  setPendingNotes(sessionId: string, notes: ReadonlyArray<string>) {
    this.db.query("UPDATE sessions SET pending_notes = ? WHERE id = ?").run(JSON.stringify(notes), sessionId)
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

  /** The `TOOL_CALL_RESULT` event the session recorded for a tool call, if any. */
  toolResult(sessionId: string, toolCallId: string): Extract<SessionEventBody, { type: "TOOL_CALL_RESULT" }> | null {
    const row = this.db
      .query<{ body: string }, [string, string]>(
        `SELECT body FROM events WHERE session_id = ? AND json_extract(body, '$.type') = 'TOOL_CALL_RESULT'
          AND json_extract(body, '$.toolCallId') = ? ORDER BY seq LIMIT 1`,
      )
      .get(sessionId, toolCallId)
    return row === null ? null : JSON.parse(row.body)
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

  insertTurn(sessionId: string, turn: Omit<TurnRecord, "position" | "status" | "checkpointId">, startedAt: number): TurnRecord {
    const position =
      (this.db.query<{ p: number | null }, [string]>("SELECT max(position) AS p FROM turns WHERE session_id = ?").get(sessionId)
        ?.p ?? 0) + 1
    this.db
      .query(
        `INSERT INTO turns (session_id, run_id, position, input_id, input_text, model, status, first_seq, started_at, notes, catalogs)
          VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        turn.runId,
        position,
        turn.inputId,
        turn.inputText,
        turn.model,
        turn.firstSeq,
        startedAt,
        JSON.stringify(turn.notes),
        JSON.stringify(turn.catalogs),
      )
    return { ...turn, position, status: "running", checkpointId: null }
  }

  /** Ends a turn, recording the session's latest checkpoint as the turn's window. */
  endTurn(sessionId: string, runId: string, status: Exclude<TurnStatus, "running">, endedAt: number) {
    this.db
      .query("UPDATE turns SET status = ?, ended_at = ?, checkpoint_id = ? WHERE session_id = ? AND run_id = ?")
      .run(status, endedAt, latestCheckpointId(this.db, sessionId), sessionId, runId)
  }

  /** Turns left running by a stopped server, with their sessions. */
  runningTurns(): ReadonlyArray<{ readonly sessionId: string; readonly runId: string }> {
    return this.db
      .query<{ session_id: string; run_id: string }, []>("SELECT session_id, run_id FROM turns WHERE status = 'running'")
      .all()
      .map((row) => ({ sessionId: row.session_id, runId: row.run_id }))
  }

  /**
   * Removes `turn` and every later turn with their events, and returns the
   * fork and rewind notes those turns delivered; their catalog notes are
   * not kept. The window returns to the checkpoint of
   * the turn before, or to none. The counter keeps its value, so no removed
   * number is used again; the caller appends the rewound event in the same
   * transaction.
   */
  removeFrom(sessionId: string, turn: TurnRecord): ReadonlyArray<string> {
    const turns = this.turns(sessionId)
    const removed = turns.filter((candidate) => candidate.position >= turn.position)
    const before = turns.filter((candidate) => candidate.position < turn.position).at(-1)
    this.db.query("DELETE FROM events WHERE session_id = ? AND seq >= ?").run(sessionId, turn.firstSeq)
    this.db.query("DELETE FROM turns WHERE session_id = ? AND position >= ?").run(sessionId, turn.position)
    truncateThread(this.db, sessionId, before?.checkpointId ?? null)
    return removed.flatMap((candidate) => candidate.notes)
  }

  /**
   * Creates `target` as a copy of `source` through the turn `throughRunId`,
   * or all of it: its turns and their events keep their numbers, its window
   * is the source's as it stood after the last copied turn, it holds the
   * source's grants, and the copy's first event names its source and gives
   * its settings. Events about the
   * source session itself, its rewinds and model changes, are not copied.
   */
  fork(
    source: SessionRecord,
    target: { id: string; createdAt: number; firstMessage: string; notes: ReadonlyArray<string> },
    throughRunId: string | null,
  ): SessionRecord {
    return this.db.transaction(() => {
      const turns = this.turns(source.id)
      const through = throughRunId === null ? null : turns.find((turn) => turn.runId === throughRunId)
      if (through === undefined) throw new Error(`no turn ${throughRunId}`)
      const next = through === null ? undefined : turns.find((turn) => turn.position > through.position)
      const cutoff = next === undefined ? source.nextSeq : next.firstSeq
      this.db
        .query(
          `INSERT INTO sessions
            (id, cwd, agent, model, instructions, agent_settings, forked_from_session, forked_from_run, created_at, next_seq,
             first_message, catalogs, pending_notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          target.id,
          source.cwd,
          source.agent,
          source.model,
          source.instructions,
          JSON.stringify(source.agentSettings),
          source.id,
          throughRunId,
          target.createdAt,
          cutoff,
          target.firstMessage,
          JSON.stringify(source.catalogs),
          JSON.stringify(target.notes),
        )
      const created: SessionEventBody = {
        type: "SESSION_CREATED",
        cwd: source.cwd,
        agent: source.agent,
        model: source.model,
        forkedFrom: { sessionId: source.id, runId: throughRunId },
      }
      const insert = this.db.query("INSERT INTO events (session_id, seq, timestamp, body) VALUES (?, ?, ?, ?)")
      for (const event of this.eventsAfter(source.id, 0)) {
        if (event.seq >= cutoff) break
        const type = event.event.type
        if (type === "SESSION_REWOUND" || type === "MODEL_CHANGED") continue
        const body = type === "SESSION_CREATED" ? created : withThread(event.event, target.id)
        insert.run(target.id, event.seq, type === "SESSION_CREATED" ? target.createdAt : event.timestamp, JSON.stringify(body))
      }
      this.db
        .query(
          `INSERT INTO turns
            (session_id, run_id, position, input_id, input_text, model, status, first_seq, started_at, ended_at, notes, catalogs,
             checkpoint_id)
            SELECT ?, run_id, position, input_id, input_text, model, status, first_seq, started_at, ended_at, notes, catalogs,
              checkpoint_id
            FROM turns WHERE session_id = ? AND first_seq < ?`,
        )
        .run(target.id, source.id, cutoff)
      if (through === null) copyThread(this.db, source.id, target.id, null)
      else copyThread(this.db, source.id, target.id, through.checkpointId ?? "")
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

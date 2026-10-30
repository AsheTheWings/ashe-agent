import type { Database } from "bun:sqlite"
import type { SessionEvent, SessionEventBody, SessionSummary } from "@ashe-agent/protocol"

export type TurnStatus = "running" | "finished" | "cancelled" | "failed" | "interrupted"

export interface SessionRecord {
  readonly id: string
  readonly cwd: string
  readonly agent: string | null
  readonly model: string
  readonly instructions: string | null
  readonly createdAt: number
  readonly nextSeq: number
}

export interface TurnRecord {
  readonly runId: string
  readonly position: number
  readonly inputId: string
  readonly inputText: string
  readonly model: string
  readonly status: TurnStatus
  readonly firstSeq: number
}

interface SessionRow {
  id: string
  cwd: string
  agent: string | null
  model: string
  instructions: string | null
  created_at: number
  next_seq: number
}

const toSession = (row: SessionRow): SessionRecord => ({
  id: row.id,
  cwd: row.cwd,
  agent: row.agent,
  model: row.model,
  instructions: row.instructions,
  createdAt: row.created_at,
  nextSeq: row.next_seq,
})

interface TurnRow {
  run_id: string
  position: number
  input_id: string
  input_text: string
  model: string
  status: TurnStatus
  first_seq: number
}

const toTurn = (row: TurnRow): TurnRecord => ({
  runId: row.run_id,
  position: row.position,
  inputId: row.input_id,
  inputText: row.input_text,
  model: row.model,
  status: row.status,
  firstSeq: row.first_seq,
})

const turnColumns = "run_id, position, input_id, input_text, model, status, first_seq"

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
  createSession(session: Omit<SessionRecord, "nextSeq">, forkedFrom: { sessionId: string; runId: string | null } | null) {
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO sessions (id, cwd, agent, model, instructions, forked_from_session, forked_from_run, created_at, next_seq)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          session.id,
          session.cwd,
          session.agent,
          session.model,
          session.instructions,
          forkedFrom?.sessionId ?? null,
          forkedFrom?.runId ?? null,
          session.createdAt,
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

  insertTurn(sessionId: string, turn: Omit<TurnRecord, "position" | "status">, startedAt: number): TurnRecord {
    const position =
      (this.db.query<{ p: number | null }, [string]>("SELECT max(position) AS p FROM turns WHERE session_id = ?").get(sessionId)
        ?.p ?? 0) + 1
    this.db
      .query(
        `INSERT INTO turns (session_id, run_id, position, input_id, input_text, model, status, first_seq, started_at)
          VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(sessionId, turn.runId, position, turn.inputId, turn.inputText, turn.model, turn.firstSeq, startedAt)
    return { ...turn, position, status: "running" }
  }

  endTurn(sessionId: string, runId: string, status: Exclude<TurnStatus, "running">, endedAt: number) {
    this.db
      .query("UPDATE turns SET status = ?, ended_at = ? WHERE session_id = ? AND run_id = ?")
      .run(status, endedAt, sessionId, runId)
  }

  /** Turns left running by a stopped server, with their sessions. */
  runningTurns(): ReadonlyArray<{ readonly sessionId: string; readonly runId: string }> {
    return this.db
      .query<{ session_id: string; run_id: string }, []>("SELECT session_id, run_id FROM turns WHERE status = 'running'")
      .all()
      .map((row) => ({ sessionId: row.session_id, runId: row.run_id }))
  }

  /**
   * Removes `turn` and every later turn with their events. The counter
   * keeps its value, so no removed number is used again; the caller
   * appends the rewound event in the same transaction.
   */
  removeFrom(sessionId: string, turn: TurnRecord) {
    this.db.query("DELETE FROM events WHERE session_id = ? AND seq >= ?").run(sessionId, turn.firstSeq)
    this.db.query("DELETE FROM turns WHERE session_id = ? AND position >= ?").run(sessionId, turn.position)
  }

  /**
   * Creates `target` as a copy of `source` through the turn `throughRunId`,
   * or all of it: its turns and their events keep their numbers, and the
   * copy's first event names its source and gives its settings. Events
   * about the source session itself, its rewinds and model changes, are
   * not copied.
   */
  fork(
    source: SessionRecord,
    target: { id: string; createdAt: number },
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
          `INSERT INTO sessions (id, cwd, agent, model, instructions, forked_from_session, forked_from_run, created_at, next_seq)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(target.id, source.cwd, source.agent, source.model, source.instructions, source.id, throughRunId, target.createdAt, cutoff)
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
          `INSERT INTO turns (session_id, run_id, position, input_id, input_text, model, status, first_seq, started_at, ended_at)
            SELECT ?, run_id, position, input_id, input_text, model, status, first_seq, started_at, ended_at
            FROM turns WHERE session_id = ? AND first_seq < ?`,
        )
        .run(target.id, source.id, cutoff)
      return this.getSession(target.id)!
    })()
  }
}

/** An event as it reads in another session: AG-UI's threadId names the session. */
const withThread = (body: SessionEventBody, sessionId: string): SessionEventBody =>
  "threadId" in body ? ({ ...body, threadId: sessionId } as SessionEventBody) : body

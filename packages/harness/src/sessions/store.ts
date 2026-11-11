import type { Database } from "bun:sqlite"
import { join } from "node:path"
import type { AgentProfile, ApprovalGrant, SessionEvent, SessionEventBody, SessionSummary, TurnInput } from "@ashe-agent/protocol"
import { UNTITLED_AGENT_TITLE } from "@ashe-agent/protocol"
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
  readonly model: string | null
  /** The reasoning effort selected for the model, or null for its default. */
  readonly reasoningEffort: string | null
  /** The agent's model setting overrides, by model id, as recorded at creation. */
  readonly modelOverrides: Readonly<Record<string, ModelOverrides>>
  /** The agent's permission rules as recorded at creation, or null without any. */
  readonly permission: Permission | null
  readonly createdAt: number
  readonly nextSeq: number
  /** The immutable applied-settings revision the session currently references. */
  readonly settingsRevision: string
}

/** What started a turn: an input holding a user message, a continuation, or another notification component. */
export type TurnCause = "user" | "continuation" | "notification"

export interface TurnRecord {
  readonly runId: string
  readonly position: number
  readonly cause: TurnCause
  /** The ordered content identities admitted with this turn; never changed after admission. */
  readonly membership: ReadonlyArray<TurnInput>
  /** The user messages the turn's starting input holds, in order; a turn holding any is a rewind and fork point. */
  readonly userMessageIds: ReadonlyArray<string>
  readonly agentTitle: string
  readonly model: string | null
  /** The session's reasoning effort selection when the turn started. */
  readonly reasoningEffort: string | null
  /** The immutable applied-settings revision this turn references. */
  readonly settingsRevision: string
  readonly status: TurnStatus
  /** The number of the turn's first event, where a rewind of it starts removing. */
  readonly firstSeq: number
  /** The context workflow this turn participates in, or null for an ordinary turn. */
  readonly contextWorkflowId: string | null
  /** The session item position from which this turn's context work is excluded from chat accounting. */
  readonly contextStartItem: number | null
}

/** One context workflow's durable coordination state across its participating turns. */
export interface ContextWorkflowRecord {
  readonly id: string
  readonly sessionId: string
  readonly trigger: "threshold" | "limit"
  readonly startTurnId: string
  readonly currentTurnId: string
  readonly startItem: number
  readonly clearings: number
  readonly clearable: number
  readonly freed: number
  readonly validations: number
  readonly compactionWaited: boolean
  readonly constructed: boolean
  readonly createdAt: number
  readonly endedAt: number | null
}

interface SessionRow {
  id: string
  current_settings_revision: string
  agent_title: string
  model_id: string | null
  reasoning_effort: string | null
  model_overrides: string
  permission: string | null
  created_at: number
  next_seq: number
}

const toSession = (row: SessionRow, sessionsDir: string): SessionRecord => ({
  id: row.id,
  sessionDir: join(sessionsDir, row.id),
  agent: row.agent_title === UNTITLED_AGENT_TITLE ? null : row.agent_title,
  model: row.model_id,
  reasoningEffort: row.reasoning_effort,
  modelOverrides: JSON.parse(row.model_overrides),
  permission: row.permission === null ? null : JSON.parse(row.permission),
  createdAt: row.created_at,
  nextSeq: row.next_seq,
  settingsRevision: row.current_settings_revision,
})

const profile = (session: SessionRecord): AgentProfile => ({
  agentTitle: session.agent ?? UNTITLED_AGENT_TITLE,
  modelSettings: {
    modelId: session.model,
    reasoningEffort: session.reasoningEffort,
  },
})

interface TurnRow {
  run_id: string
  position: number
  cause: TurnCause
  input_membership: string
  user_message_ids: string
  agent_title: string
  model_id: string | null
  reasoning_effort: string | null
  settings_revision: string
  status: TurnStatus
  first_seq: number
  context_workflow_id: string | null
  context_start_item: number | null
}

interface ContextWorkflowRow {
  id: string
  session_id: string
  trigger: "threshold" | "limit"
  start_turn_id: string
  current_turn_id: string
  start_item: number
  clearings: number
  clearable: number
  freed: number
  validations: number
  compaction_waited: number
  constructed: number
  created_at: number
  ended_at: number | null
}

const toTurn = (row: TurnRow): TurnRecord => ({
  runId: row.run_id,
  position: row.position,
  cause: row.cause,
  membership: JSON.parse(row.input_membership),
  userMessageIds: JSON.parse(row.user_message_ids),
  agentTitle: row.agent_title,
  model: row.model_id,
  reasoningEffort: row.reasoning_effort,
  settingsRevision: row.settings_revision,
  status: row.status,
  firstSeq: row.first_seq,
  contextWorkflowId: row.context_workflow_id,
  contextStartItem: row.context_start_item,
})

const toContextWorkflow = (row: ContextWorkflowRow): ContextWorkflowRecord => ({
  id: row.id,
  sessionId: row.session_id,
  trigger: row.trigger,
  startTurnId: row.start_turn_id,
  currentTurnId: row.current_turn_id,
  startItem: row.start_item,
  clearings: row.clearings,
  clearable: row.clearable,
  freed: row.freed,
  validations: row.validations,
  compactionWaited: row.compaction_waited === 1,
  constructed: row.constructed === 1,
  createdAt: row.created_at,
  endedAt: row.ended_at,
})

const turnColumns =
  "t.run_id, t.position, t.cause, t.user_message_ids, t.status, t.first_seq, t.context_workflow_id, t.context_start_item, " +
  "t.settings_revision, s.agent_title, s.model_id, s.reasoning_effort, " +
  "(SELECT coalesce(json_group_array(json_object('kind', substr(i.entry_ref, 1, instr(i.entry_ref, ':') - 1), " +
  "'inputId', i.input_id)), '[]') FROM turn_inputs i WHERE i.session_id = t.session_id AND i.run_id = t.run_id) AS input_membership"
const turnTables = "turns t JOIN session_settings s ON s.session_id = t.session_id AND s.revision = t.settings_revision"

const sessionColumns =
  "s.id, s.current_settings_revision, s.model_overrides, s.permission, s.forked_from_session, s.forked_from_run, " +
  "s.created_at, s.next_seq, s.memory_generation, s.scratch_generation, s.memory_restore_generation, s.fork_skipped, " +
  "ss.agent_title, ss.model_id, ss.reasoning_effort"
const sessionTables = "sessions s JOIN session_settings ss ON ss.session_id = s.id AND ss.revision = s.current_settings_revision"

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
      .query<SessionRow, []>(`SELECT ${sessionColumns} FROM ${sessionTables} ORDER BY s.created_at, s.id`)
      .all()
      .map((row) => toSession(row, this.sessionsDir))
  }

  /** The directory of the session `id`. */
  sessionDir(id: string) {
    return join(this.sessionsDir, id)
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.query<SessionRow, [string]>(`SELECT ${sessionColumns} FROM ${sessionTables} WHERE s.id = ?`).get(id)
    return row === null ? null : toSession(row, this.sessionsDir)
  }

  listSessions(activeTurn: (id: string) => TurnRecord | null): ReadonlyArray<SessionSummary> {
    return this.db
      .query<SessionRow, []>(`SELECT ${sessionColumns} FROM ${sessionTables} ORDER BY s.created_at DESC, s.id`)
      .all()
      .map((row) => this.summary(toSession(row, this.sessionsDir), activeTurn(row.id)))
  }

  summary(session: SessionRecord, activeTurn: TurnRecord | null): SessionSummary {
    const last = this.db
      .query<{ seq: number | null }, [string]>("SELECT max(seq) AS seq FROM events WHERE session_id = ?")
      .get(session.id)
    return {
      id: session.id,
      sessionDir: session.sessionDir,
      identity: {
        sessionId: session.id,
        agentTitle: session.agent ?? UNTITLED_AGENT_TITLE,
        modelId: session.model,
      },
      selection: profile(session),
      activeSelection:
        activeTurn === null
          ? null
          : (this.startedSelection(session.id, activeTurn.runId) ?? {
              agentTitle: activeTurn.agentTitle,
              modelSettings: { modelId: activeTurn.model, reasoningEffort: activeTurn.reasoningEffort },
            }),
      activity: activeTurn === null ? "idle" : "working",
      createdAt: session.createdAt,
      lastSeq: last?.seq ?? 0,
    }
  }

  /** The immutable selection a turn's RUN_STARTED event recorded. */
  private startedSelection(sessionId: string, runId: string): AgentProfile | null {
    const row = this.db
      .query<{ body: string }, [string, string]>(
        `SELECT body FROM events WHERE session_id = ? AND json_extract(body, '$.type') = 'RUN_STARTED'
          AND json_extract(body, '$.runId') = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(sessionId, runId)
    return row === null ? null : (JSON.parse(row.body).selection as AgentProfile)
  }

  /** Creates a session with its `SESSION_CREATED` event as event 1. */
  createSession(
    session: Omit<SessionRecord, "sessionDir" | "nextSeq" | "settingsRevision">,
    forkedFrom: { sessionId: string; runId: string | null } | null,
  ) {
    this.db.transaction(() => {
      this.db.run("PRAGMA defer_foreign_keys = ON")
      this.db
        .query(
          `INSERT INTO sessions
            (id, current_settings_revision, model_overrides, permission, forked_from_session, forked_from_run,
             created_at, next_seq)
            VALUES (?, 'settings:1', ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          session.id,
          JSON.stringify(session.modelOverrides),
          session.permission === null ? null : JSON.stringify(session.permission),
          forkedFrom?.sessionId ?? null,
          forkedFrom?.runId ?? null,
          session.createdAt,
        )
      this.db
        .query(
          `INSERT INTO session_settings (session_id, revision, agent_title, model_id, reasoning_effort, applied_at)
            VALUES (?, 'settings:1', ?, ?, ?, ?)`,
        )
        .run(
          session.id,
          session.agent ?? UNTITLED_AGENT_TITLE,
          session.model,
          session.reasoningEffort,
          session.createdAt,
        )
      this.appendEvent(
        session.id,
        {
          type: "SESSION_CREATED",
          sessionDir: this.sessionDir(session.id),
          selection: profile({
            ...session,
            sessionDir: this.sessionDir(session.id),
            nextSeq: 1,
            settingsRevision: "settings:1",
          }),
          forkedFrom,
        },
        session.createdAt,
      )
    })()
  }

  /** Applies a changed title/model/effort selection as one immutable revision and returns it. */
  setSettings(sessionId: string, profile: AgentProfile): string {
    const session = this.getSession(sessionId)
    if (session === null) throw new Error(`no session ${sessionId}`)
    const current = this.profile(session.id)
    if (
      current !== null &&
      current.agentTitle === profile.agentTitle &&
      current.modelSettings.modelId === profile.modelSettings.modelId &&
      current.modelSettings.reasoningEffort === profile.modelSettings.reasoningEffort
    ) {
      return session.settingsRevision
    }
    const revision = crypto.randomUUID()
    this.db
      .query(
        `INSERT INTO session_settings (session_id, revision, agent_title, model_id, reasoning_effort, applied_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        revision,
        profile.agentTitle,
        profile.modelSettings.modelId,
        profile.modelSettings.reasoningEffort,
        Date.now(),
      )
    this.db.query("UPDATE sessions SET current_settings_revision = ? WHERE id = ?").run(revision, sessionId)
    return revision
  }

  /** The profile of the session's current applied settings revision. */
  profile(sessionId: string): AgentProfile | null {
    const session = this.getSession(sessionId)
    return session === null ? null : profile(session)
  }

  setModel(sessionId: string, model: string, reasoningEffort: string | null) {
    const current = this.profile(sessionId)
    if (current === null) throw new Error(`no session ${sessionId}`)
    return this.setSettings(sessionId, { ...current, modelSettings: { modelId: model, reasoningEffort } })
  }

  setInputSettingsRevision(sessionId: string, runId: string, inputId: string, revision: string) {
    this.db
      .query("UPDATE turn_inputs SET applied_settings_revision = ? WHERE session_id = ? AND run_id = ? AND input_id = ?")
      .run(revision, sessionId, runId, inputId)
  }

  /** The session's grants, as allow rules in the order they were added. */
  grants(sessionId: string, titleKey?: string): ReadonlyArray<{ readonly permission: string; readonly pattern: string }> {
    const title = titleKey ?? this.profile(sessionId)?.agentTitle ?? UNTITLED_AGENT_TITLE
    return this.db
      .query<{ permission: string; pattern: string }, [string, string]>(
        "SELECT permission, pattern FROM session_grants WHERE session_id = ? AND title_key = ? ORDER BY position",
      )
      .all(sessionId, title)
  }

  grantsForSession(sessionId: string): ReadonlyArray<ApprovalGrant> {
    return this.db
      .query<ApprovalGrant, [string]>(
        `SELECT session_id AS sessionId, title_key AS agentTitle, position, permission, pattern
          FROM session_grants WHERE session_id = ? ORDER BY title_key, position`,
      )
      .all(sessionId)
  }

  clearGrants(sessionId: string, agentTitle: string): number {
    return this.db
      .query("DELETE FROM session_grants WHERE session_id = ? AND title_key = ?")
      .run(sessionId, agentTitle).changes
  }

  addGrants(sessionId: string, permission: string, patterns: ReadonlyArray<string>) {
    const title = this.profile(sessionId)?.agentTitle ?? UNTITLED_AGENT_TITLE
    const insert = this.db.query(
      `INSERT INTO session_grants (session_id, title_key, position, permission, pattern)
        VALUES (?, ?, (SELECT coalesce(max(position), 0) + 1 FROM session_grants WHERE session_id = ? AND title_key = ?), ?, ?)`,
    )
    this.db.transaction(() => {
      for (const pattern of patterns) insert.run(sessionId, title, sessionId, title, permission, pattern)
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
      .query<TurnRow, [string]>(`SELECT ${turnColumns} FROM ${turnTables} WHERE t.session_id = ? ORDER BY t.position`)
      .all(sessionId)
      .map(toTurn)
  }

  getTurn(sessionId: string, runId: string): TurnRecord | null {
    const row = this.db
      .query<TurnRow, [string, string]>(`SELECT ${turnColumns} FROM ${turnTables} WHERE t.session_id = ? AND t.run_id = ?`)
      .get(sessionId, runId)
    return row === null ? null : toTurn(row)
  }

  insertTurn(
    sessionId: string,
    turn: {
      readonly runId: string
      readonly cause: TurnCause
      readonly membership: ReadonlyArray<TurnInput>
      readonly userMessageIds: ReadonlyArray<string>
      readonly settingsRevision: string
      readonly firstSeq: number
      readonly contextWorkflowId: string | null
      readonly contextStartItem: number | null
    },
    startedAt: number,
  ): TurnRecord {
    const position =
      (this.db.query<{ p: number | null }, [string]>("SELECT max(position) AS p FROM turns WHERE session_id = ?").get(sessionId)
        ?.p ?? 0) + 1
    this.db
      .query(
        `INSERT INTO turns
          (session_id, run_id, position, settings_revision, cause, user_message_ids, status, first_seq,
           context_workflow_id, context_start_item, started_at)
          VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        turn.runId,
        position,
        turn.settingsRevision,
        turn.cause,
        JSON.stringify(turn.userMessageIds),
        turn.firstSeq,
        turn.contextWorkflowId,
        turn.contextStartItem,
        startedAt,
      )
    const insertInput = this.db.query(
      `INSERT INTO turn_inputs (session_id, run_id, ordinal, input_id, entry_ref, applied_settings_revision)
        VALUES (?, ?, ?, ?, ?, NULL)`,
    )
    for (const [index, input] of turn.membership.entries()) {
      insertInput.run(sessionId, turn.runId, index + 1, input.inputId, `${input.kind}:${input.inputId}`)
    }
    return this.getTurn(sessionId, turn.runId)!
  }

  /** Records that the turn `runId` participates in a context workflow from the session item `startItem`. */
  markContextTurn(sessionId: string, runId: string, workflowId: string, startItem: number) {
    this.db
      .query("UPDATE turns SET context_workflow_id = ?, context_start_item = ? WHERE session_id = ? AND run_id = ?")
      .run(workflowId, startItem, sessionId, runId)
  }

  /** The session's unfinished context workflow, if any. */
  contextWorkflow(sessionId: string): ContextWorkflowRecord | null {
    const row = this.db
      .query<ContextWorkflowRow, [string]>("SELECT * FROM context_workflows WHERE session_id = ? AND ended_at IS NULL")
      .get(sessionId)
    return row === null ? null : toContextWorkflow(row)
  }

  /** Every unfinished context workflow, oldest first. */
  contextWorkflows(): ReadonlyArray<ContextWorkflowRecord> {
    return this.db
      .query<ContextWorkflowRow, []>("SELECT * FROM context_workflows WHERE ended_at IS NULL ORDER BY created_at, id")
      .all()
      .map(toContextWorkflow)
  }

  /** The turns that participated in `workflowId`, in session order. */
  contextWorkflowTurnIds(workflowId: string): ReadonlyArray<string> {
    return this.db
      .query<{ run_id: string }, [string]>("SELECT run_id FROM turns WHERE context_workflow_id = ? ORDER BY position")
      .all(workflowId)
      .map((row) => row.run_id)
  }

  /** Inserts a context workflow, which the caller's transaction may also record the turn's participation in. */
  createContextWorkflow(workflow: ContextWorkflowRecord) {
    this.writeContextWorkflow(workflow, "INSERT")
  }

  /** Saves a workflow's turn association and mutable coordination state. */
  saveContextWorkflow(workflow: ContextWorkflowRecord) {
    this.writeContextWorkflow(workflow, "UPDATE")
  }

  private writeContextWorkflow(workflow: ContextWorkflowRecord, kind: "INSERT" | "UPDATE") {
    if (kind === "INSERT") {
      this.db
        .query(
          `INSERT INTO context_workflows
            (id, session_id, trigger, start_turn_id, current_turn_id, start_item, clearings, clearable, freed, validations,
             compaction_waited, constructed, created_at, ended_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          workflow.id,
          workflow.sessionId,
          workflow.trigger,
          workflow.startTurnId,
          workflow.currentTurnId,
          workflow.startItem,
          workflow.clearings,
          workflow.clearable,
          workflow.freed,
          workflow.validations,
          workflow.compactionWaited ? 1 : 0,
          workflow.constructed ? 1 : 0,
          workflow.createdAt,
          workflow.endedAt,
        )
      return
    }
    this.db
      .query(
        `UPDATE context_workflows SET current_turn_id = ?, clearings = ?, clearable = ?, freed = ?, validations = ?,
          compaction_waited = ?, constructed = ?, ended_at = ? WHERE id = ?`,
      )
      .run(
        workflow.currentTurnId,
        workflow.clearings,
        workflow.clearable,
        workflow.freed,
        workflow.validations,
        workflow.compactionWaited ? 1 : 0,
        workflow.constructed ? 1 : 0,
        workflow.endedAt,
        workflow.id,
      )
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
    const removedIds = JSON.stringify(removed.map((candidate) => candidate.runId))
    this.db
      .query(
        `DELETE FROM context_workflows WHERE session_id = ?
          AND (start_turn_id IN (SELECT value FROM json_each(?)) OR current_turn_id IN (SELECT value FROM json_each(?)))`,
      )
      .run(sessionId, removedIds, removedIds)
    this.db.query("DELETE FROM turns WHERE session_id = ? AND position >= ?").run(sessionId, turn.position)
    this.db
      .query(
        `DELETE FROM attachment_references
          WHERE session_id = ? AND reference_id IN (SELECT value FROM json_each(?))
            AND NOT EXISTS (SELECT 1 FROM turn_inputs i WHERE i.session_id = ? AND i.input_id = attachment_references.reference_id)`,
      )
      .run(sessionId, taken, sessionId)
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
      this.db.run("PRAGMA defer_foreign_keys = ON")
      const turns = this.turns(source.id)
      const through = throughRunId === null ? null : turns.find((turn) => turn.runId === throughRunId)
      if (through === undefined) throw new Error(`no turn ${throughRunId}`)
      const next = through === null ? undefined : turns.find((turn) => turn.position > through.position)
      const cutoff = next === undefined ? source.nextSeq : next.firstSeq
      const keptTurns = turns.filter((turn) => turn.firstSeq < cutoff)
      const appliedRevisions = this.db
        .query<{ revision: string | null }, [string, number]>(
          `SELECT DISTINCT i.applied_settings_revision AS revision FROM turn_inputs i
            JOIN turns t ON t.session_id = i.session_id AND t.run_id = i.run_id
            WHERE i.session_id = ? AND t.first_seq < ? AND i.applied_settings_revision IS NOT NULL`,
        )
        .all(source.id, cutoff)
        .map((row) => row.revision!)
      const keptRevisions = JSON.stringify([
        ...new Set([...keptTurns.map((turn) => turn.settingsRevision), ...appliedRevisions, source.settingsRevision]),
      ])
      this.db
        .query(
          `INSERT INTO session_settings
            (session_id, revision, agent_title, model_id, reasoning_effort, applied_at)
            SELECT ?, revision, agent_title, model_id, reasoning_effort, applied_at
            FROM session_settings WHERE session_id = ? AND revision IN (SELECT value FROM json_each(?))`,
        )
        .run(target.id, source.id, keptRevisions)
      this.db
        .query(
          `INSERT INTO sessions
            (id, current_settings_revision, model_overrides, permission, forked_from_session, forked_from_run,
             created_at, next_seq)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          target.id,
          source.settingsRevision,
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
        selection: profile(source),
        forkedFrom: { sessionId: source.id, runId: throughRunId },
      }
      const insert = this.db.query("INSERT INTO events (session_id, seq, timestamp, body) VALUES (?, ?, ?, ?)")
      const copied = this.eventsAfter(source.id, 0).filter((event) => event.seq < cutoff)
      // A waiting input's event is copied only with the copied turn that took it.
      const taken = new Set(copied.flatMap(({ event }) => (event.type === "INPUT_RECEIVED" ? [event.inputId] : [])))
      for (const event of copied) {
        const type = event.event.type
        if (type === "SESSION_REWOUND" || type === "SELECTION_CHANGED") continue
        if (event.event.type === "INPUT_WAITING" && !taken.has(event.event.inputId)) continue
        const body = type === "SESSION_CREATED" ? created : withThread(event.event, target.id)
        insert.run(target.id, event.seq, type === "SESSION_CREATED" ? target.createdAt : event.timestamp, JSON.stringify(body))
      }
      this.db
        .query(
          `INSERT INTO turns
            (session_id, run_id, position, cause, settings_revision, status, first_seq, started_at, ended_at,
             context_workflow_id, context_start_item)
            SELECT ?, run_id, position, cause, settings_revision, status, first_seq, started_at, ended_at,
              NULL, context_start_item
            FROM turns WHERE session_id = ? AND first_seq < ?`,
        )
        .run(target.id, source.id, cutoff)
      this.db
        .query(
          `INSERT INTO turn_inputs (session_id, run_id, ordinal, input_id, entry_ref, applied_settings_revision)
            SELECT ?, i.run_id, i.ordinal, i.input_id, i.entry_ref, i.applied_settings_revision
            FROM turn_inputs i JOIN turns t ON t.session_id = i.session_id AND t.run_id = i.run_id
            WHERE i.session_id = ? AND t.first_seq < ?`,
        )
        .run(target.id, source.id, cutoff)
      const kept = keptTurns.map((turn) => turn.runId)
      this.conversation.copy(source.id, target.id, kept)
      this.timeline.copy(source.id, target.id, kept)
      this.db
        .query(
          `INSERT INTO session_grants (session_id, title_key, position, permission, pattern)
            SELECT ?, title_key, position, permission, pattern FROM session_grants WHERE session_id = ?`,
        )
        .run(target.id, source.id)
      const violations = this.db.query<{ table: string; rowid: number; parent: string }, []>("PRAGMA foreign_key_check").all()
      if (violations.length > 0) throw new Error(`fork integrity failed: ${JSON.stringify(violations)}`)
      return this.getSession(target.id)!
    })()
  }
}

/** An event as it reads in another session: AG-UI's threadId names the session. */
const withThread = (body: SessionEventBody, sessionId: string): SessionEventBody =>
  "threadId" in body ? ({ ...body, threadId: sessionId } as SessionEventBody) : body

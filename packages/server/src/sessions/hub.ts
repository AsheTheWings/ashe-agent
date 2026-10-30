import type { Database } from "bun:sqlite"
import { mkdirSync, rmdirSync } from "node:fs"
import type { Context as TraceContext, Span } from "@opentelemetry/api"
import { Context, Effect, Exit, Fiber, Layer } from "effect"
import {
  type Agent,
  ErrorCode,
  type InputMode,
  type Model,
  type Sender,
  type SessionEvent,
  type SessionEventBody,
  type SessionSummary,
} from "@ashe-agent/protocol"
import { firstMessage } from "../agent/blocks.ts"
import { catalogNote, forkNote, programCallsNote, rewindNote, unfinishedResult } from "../agent/notes.ts"
import type { AgentSettings } from "../agents/agents.ts"
import type { Permission } from "../inputs/shapes.ts"
import {
  compileRules,
  decide,
  PermissionDenied,
  PermissionRejected,
  type PermissionCheck,
  type Rule,
} from "../permissions/rules.ts"
import { ProtocolError } from "../server/websocket.ts"
import { Store } from "../store/database.ts"
import { endSpan, recordDuration, startSpan, withSpan, type ErrorClass } from "../telemetry/signals.ts"
import { SessionStore, type Catalogs, type SessionRecord, type TurnRecord } from "./store.ts"

/** An input a client sent, waiting for a turn to take it. */
export interface Input {
  readonly inputId: string
  readonly text: string
  readonly mode: InputMode
  readonly sender: Sender
}

/** What a turn's runner gets from the hub. */
export interface TurnContext {
  readonly session: SessionRecord
  readonly turn: TurnRecord
  readonly input: Input
  /** The harness notes the turn delivers before its input. */
  readonly notes: ReadonlyArray<string>
  /** Persists an event of the turn and sends it to every subscriber. */
  readonly emit: (body: SessionEventBody) => SessionEvent
  /** Takes the inputs steered into the turn since the last step boundary, emitting their events. */
  readonly takeSteered: () => ReadonlyArray<Input>
  /** Whether a cancel request, rather than a server stop, is ending the turn. */
  readonly isCancelled: () => boolean
  /** The result the session's events recorded for a tool call, if any. */
  readonly toolResult: (toolCallId: string) => { readonly content: string; readonly outcome: ToolOutcome } | null
  /**
   * Decides a tool call by the global rules, the session agent's rules, and
   * the session's grants. It returns when the call may run, waiting on an
   * ask until a client answers; it throws `PermissionDenied` for a denied
   * call, `PermissionRejected` for a rejected one, and the abort reason
   * when `signal` aborts while it waits.
   */
  readonly authorize: (toolCallId: string, check: PermissionCheck, signal: AbortSignal) => Promise<void>
  /** The trace context holding the turn's span, the parent of its model and tool call spans. */
  readonly trace: TraceContext
}

export type TurnOutcome = { readonly status: "finished" } | { readonly status: "failed"; readonly message: string; readonly code?: string }

/** Runs one turn to its end; interrupting it cancels the turn. */
export type TurnRunner = (context: TurnContext) => Effect.Effect<TurnOutcome>

/** What a session takes from its agent, and the catalogs its developer message lists. */
export interface SessionSetup {
  /**
   * The session's agent, the instructions recorded at its creation, the
   * model the agent names, if any, and the agent's settings; it throws a
   * `ProtocolError` for an agent that cannot run a session.
   */
  readonly resolve: (agent: string | null) => {
    readonly agent: string | null
    readonly instructions: string | null
    readonly model: string | null
    readonly settings: AgentSettings
  }
  /** The catalogs as they stand now. */
  readonly catalogs: () => Catalogs
  /** The valid agents and the refused agent files as they stand now; none when absent. */
  readonly agents?: () => { readonly agents: ReadonlyArray<Agent>; readonly refused: ReadonlyArray<{ readonly path: string; readonly reason: string }> }
}

type ToolOutcome = Extract<SessionEventBody, { type: "TOOL_CALL_RESULT" }>["outcome"]

export interface HubOptions {
  readonly models: ReadonlyArray<Model>
  readonly runner: TurnRunner
  readonly setup: SessionSetup
  /** The global permission rules. */
  readonly permission?: Permission
  /** The home directory `~` and `$HOME` patterns expand to. */
  readonly home?: string
  readonly now?: () => number
}

type Listener = (event: SessionEvent) => void

interface Live {
  fiber: Fiber.Fiber<TurnOutcome>
  readonly turn: TurnRecord
  cancelled: boolean
  readonly span: Span
  readonly startedAt: number
}

type AskOutcome = { readonly kind: "allowed" } | { readonly kind: "rejected"; readonly message: string | undefined }

/** A permission request waiting for an answer, in memory only. */
interface Ask {
  readonly runId: string
  readonly check: PermissionCheck
  readonly settle: (outcome: AskOutcome) => void
}

interface SessionState {
  readonly listeners: Set<Listener>
  /**
   * Inputs not yet in the conversation, in order of arrival: steered ones
   * wait for the running turn's next step boundary, queued ones for its end.
   */
  pending: Array<Input>
  live: Live | null
  /** Permission requests waiting for an answer, by request id, in arrival order. */
  readonly asks: Map<string, Ask>
}

const notFound = (what: string) => new ProtocolError({ code: ErrorCode.notFound, message: `no ${what}` })
const conflict = (message: string) => new ProtocolError({ code: ErrorCode.conflict, message })
const invalid = (message: string) => new ProtocolError({ code: ErrorCode.invalidInput, message })

/**
 * Keeps every session's live state: its subscribers, its running turn, and
 * the inputs waiting for it. Events are persisted before they are sent, so
 * subscribers and later readers see the same numbered history.
 */
export class SessionHub {
  private readonly states = new Map<string, SessionState>()
  private readonly now: () => number
  private stopping = false

  constructor(
    readonly store: SessionStore,
    private readonly options: HubOptions,
  ) {
    this.now = options.now ?? Date.now
  }

  /**
   * Ends every turn a stopped server left running: withdraws its
   * unanswered permission requests, gives each of its tool calls without a
   * result an interrupted one, which for an `execute` call lists the tool
   * calls its program had finished, then emits its interrupted event. A turn
   * that ended withdrew its own requests and answered its own calls, so
   * only running turns can hold unanswered ones.
   */
  recover() {
    for (const { sessionId, runId } of this.store.runningTurns()) {
      this.store.db.transaction(() => {
        for (const requestId of this.openRequests(sessionId, runId)) {
          this.store.appendEvent(sessionId, { type: "PERMISSION_WITHDRAWN", requestId, reason: "restart" }, this.now())
        }
        for (const { toolCallId, started, program } of this.unansweredCalls(sessionId, runId)) {
          const content = unfinishedResult("interrupted", started)
          this.store.appendEvent(
            sessionId,
            {
              type: "TOOL_CALL_RESULT",
              messageId: crypto.randomUUID(),
              toolCallId,
              role: "tool",
              content: program === null ? content : `${content} ${programCallsNote(program)}`,
              outcome: "interrupted",
            },
            this.now(),
          )
        }
        this.store.endTurn(sessionId, runId, "interrupted", this.now())
        this.store.appendEvent(sessionId, { type: "RUN_INTERRUPTED", threadId: sessionId, runId }, this.now())
      })()
    }
  }

  /** The events of the turn `runId`, from its input on. */
  private turnEvents(sessionId: string, runId: string) {
    const turn = this.store.getTurn(sessionId, runId)!
    return this.store.eventsAfter(sessionId, turn.firstSeq - 1)
  }

  /** The permission requests of the turn `runId` that are neither resolved nor withdrawn. */
  private openRequests(sessionId: string, runId: string): ReadonlyArray<string> {
    const open = new Set<string>()
    for (const { event } of this.turnEvents(sessionId, runId)) {
      if (event.type === "PERMISSION_REQUESTED" && event.runId === runId) open.add(event.requestId)
      if (event.type === "PERMISSION_RESOLVED" || event.type === "PERMISSION_WITHDRAWN") open.delete(event.requestId)
    }
    return [...open]
  }

  /** The tool calls the turn `runId` started streaming that have no result, with whether each started running. */
  private unansweredCalls(sessionId: string, runId: string) {
    type Call = { toolCallId: string; started: boolean; program: Array<{ tool: string; outcome: string }> | null }
    const calls = new Map<string, Call>()
    for (const { event } of this.turnEvents(sessionId, runId)) {
      if (event.type === "TOOL_CALL_START") {
        calls.set(event.toolCallId, { toolCallId: event.toolCallId, started: false, program: event.toolCallName === "execute" ? [] : null })
      }
      if (event.type === "PROGRAM_CALL_FINISHED") calls.get(event.toolCallId)?.program?.push({ tool: event.tool, outcome: event.outcome })
      if (event.type === "TOOL_EXECUTION_STARTED") {
        const call = calls.get(event.toolCallId)
        if (call !== undefined) call.started = true
      }
      if (event.type === "TOOL_CALL_RESULT") calls.delete(event.toolCallId)
    }
    return [...calls.values()]
  }

  private state(sessionId: string): SessionState {
    let state = this.states.get(sessionId)
    if (state === undefined) {
      state = { listeners: new Set(), pending: [], live: null, asks: new Map() }
      this.states.set(sessionId, state)
    }
    return state
  }

  /** The rules deciding a session's calls: global, then its agent's, then its grants as allow rules. */
  private rules(session: SessionRecord): ReadonlyArray<Rule> {
    const home = this.options.home ?? "/"
    const agent = session.agentSettings.permission
    return [
      ...compileRules(this.options.permission ?? {}, home),
      ...(agent === null ? [] : compileRules(agent, home)),
      ...this.store.grants(session.id).map((grant) => ({ ...grant, action: "allow" as const })),
    ]
  }

  private authorize(sessionId: string, runId: string, toolCallId: string, check: PermissionCheck, signal: AbortSignal) {
    const decision = decide(this.rules(this.session(sessionId)), check)
    if (decision.action === "allow") return Promise.resolve()
    if (decision.action === "deny") return Promise.reject(new PermissionDenied(decision.denied))
    signal.throwIfAborted()
    const asks = this.state(sessionId).asks
    const requestId = crypto.randomUUID()
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        asks.delete(requestId)
        reject(signal.reason)
      }
      asks.set(requestId, {
        runId,
        check,
        settle: (outcome) => {
          signal.removeEventListener("abort", onAbort)
          asks.delete(requestId)
          if (outcome.kind === "allowed") resolve()
          else reject(new PermissionRejected(outcome.message))
        },
      })
      signal.addEventListener("abort", onAbort, { once: true })
      this.emit(sessionId, {
        type: "PERMISSION_REQUESTED",
        requestId,
        runId,
        toolCallId,
        permission: check.permission,
        subjects: [...decision.asked],
        patterns: [...check.patterns],
      })
    })
  }

  /**
   * Answers a pending permission request. `always` grants the request's
   * patterns for the rest of the session and approves the session's other
   * requests the grant now allows; `reject` rejects every other pending
   * request of the session with the same message.
   */
  answer(sessionId: string, requestId: string, answer: "once" | "always" | "reject", message: string | undefined, sender: Sender) {
    const session = this.session(sessionId)
    const asks = this.state(sessionId).asks
    const ask = asks.get(requestId)
    if (ask === undefined) {
      const known = this.store
        .eventsAfter(sessionId, 0)
        .some(({ event }) => event.type === "PERMISSION_REQUESTED" && event.requestId === requestId)
      throw known
        ? new ProtocolError({ code: ErrorCode.alreadyResolved, message: `request ${requestId} is already resolved` })
        : notFound(`permission request ${requestId}`)
    }
    const resolved = (id: string, by: "once" | "always" | "reject", from?: Sender) =>
      this.emit(sessionId, {
        type: "PERMISSION_RESOLVED",
        requestId: id,
        answer: by,
        ...(by === "reject" && message !== undefined ? { message } : {}),
        ...(from === undefined ? {} : { sender: from }),
      })
    if (answer === "reject") {
      const others = [...asks.entries()].filter(([id]) => id !== requestId)
      resolved(requestId, "reject", sender)
      ask.settle({ kind: "rejected", message })
      for (const [id, other] of others) {
        resolved(id, "reject")
        other.settle({ kind: "rejected", message })
      }
      return
    }
    if (answer === "always") this.store.addGrants(sessionId, ask.check.permission, ask.check.patterns)
    resolved(requestId, answer, sender)
    ask.settle({ kind: "allowed" })
    if (answer !== "always") return
    const rules = this.rules(session)
    for (const [id, other] of [...asks.entries()]) {
      if (decide(rules, other.check).action !== "allow") continue
      resolved(id, "always")
      other.settle({ kind: "allowed" })
    }
  }

  private session(sessionId: string): SessionRecord {
    const session = this.store.getSession(sessionId)
    if (session === null) throw notFound(`session ${sessionId}`)
    return session
  }

  private emit(sessionId: string, body: SessionEventBody): SessionEvent {
    return this.commit(sessionId, (append) => append(body))
  }

  /**
   * Runs `write` in one transaction and sends the events it appended to
   * the session's subscribers once it commits; a failure sends none.
   */
  private commit<A>(sessionId: string, write: (append: (body: SessionEventBody) => SessionEvent) => A): A {
    const appended: Array<SessionEvent> = []
    const result = this.store.db.transaction(() =>
      write((body) => {
        const event = this.store.appendEvent(sessionId, body, this.now())
        appended.push(event)
        return event
      }),
    )()
    const listeners = this.state(sessionId).listeners
    for (const event of appended) for (const listener of listeners) listener(event)
    return result
  }

  isRunning(sessionId: string) {
    return this.states.get(sessionId)?.live != null
  }

  models(): ReadonlyArray<Model> {
    return this.options.models
  }

  list(): ReadonlyArray<SessionSummary> {
    return this.store.listSessions((id) => this.isRunning(id))
  }

  summary(sessionId: string): SessionSummary {
    return this.store.summary(this.session(sessionId), this.isRunning(sessionId))
  }

  /** The first message of a session with this identity, recorded instructions, and catalogs. */
  private firstMessage(id: string, instructions: string | null, catalogs: Catalogs) {
    const sessionDir = this.store.sessionDir(id)
    return firstMessage({ instructions, skills: catalogs.skills, codeMode: catalogs.codeMode, sessionId: id, sessionDir })
  }

  /**
   * Creates the directory of a new session, readable by the server's user
   * only, then records the session with `record`; the directory is removed
   * again when recording fails.
   */
  private withSessionDir<A>(id: string, record: () => A): A {
    const dir = this.store.sessionDir(id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      return record()
    } catch (error) {
      rmdirSync(dir)
      throw error
    }
  }

  /**
   * Creates a session in its own new directory. Its model is the one its
   * agent names, else the one given, which must be configured, else the
   * first configured model.
   */
  create(params: { model?: string; agent?: string }): SessionSummary {
    const { agent, instructions, model: agentModel, settings } = this.options.setup.resolve(params.agent ?? null)
    const model = agentModel ?? params.model ?? this.options.models[0]!.id
    if (!this.options.models.some((candidate) => candidate.id === model)) throw invalid(`no configured model ${model}`)
    const id = crypto.randomUUID()
    const catalogs = this.options.setup.catalogs()
    this.withSessionDir(id, () =>
      this.store.createSession(
        {
          id,
          agent,
          model,
          instructions,
          agentSettings: settings,
          createdAt: this.now(),
          firstMessage: this.firstMessage(id, instructions, catalogs),
          catalogs,
        },
        null,
      ),
    )
    return this.summary(id)
  }

  /**
   * Sends the session's persisted events after `afterSeq`, then every live
   * event, to `listener`. Both happen in one synchronous step, so no event
   * is missed or repeated. Returns the unsubscribe function.
   */
  subscribe(sessionId: string, afterSeq: number, listener: Listener): () => void {
    this.session(sessionId)
    for (const event of this.store.eventsAfter(sessionId, afterSeq)) listener(event)
    const listeners = this.state(sessionId).listeners
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  /** The valid agents, with their names, descriptions, modes, and models, and the refused agent files with the reason. */
  agents() {
    return this.options.setup.agents?.() ?? { agents: [], refused: [] }
  }

  setModel(sessionId: string, model: string, sender: Sender) {
    this.session(sessionId)
    if (!this.options.models.some((candidate) => candidate.id === model)) throw invalid(`no configured model ${model}`)
    this.commit(sessionId, (append) => {
      this.store.setModel(sessionId, model)
      append({ type: "MODEL_CHANGED", model, sender })
    })
  }

  /**
   * Takes an input: it starts a turn on an idle session, else it steers
   * the running turn or, in queue mode, waits for it to end. Its event is
   * emitted when it enters the conversation, so inputs of each mode enter
   * in order of arrival and a steered input can enter before a queued one.
   */
  input(sessionId: string, text: string, mode: InputMode | undefined, sender: Sender): string {
    this.session(sessionId)
    if (this.stopping) throw conflict("the server is stopping")
    const input: Input = { inputId: crypto.randomUUID(), text, mode: mode ?? "steer", sender }
    const state = this.state(sessionId)
    if (state.live === null) this.startTurn(sessionId, input)
    else state.pending.push(input)
    return input.inputId
  }

  cancel(sessionId: string) {
    this.session(sessionId)
    const live = this.state(sessionId).live
    if (live === null) throw conflict("no turn is running")
    live.cancelled = true
    Effect.runFork(Fiber.interrupt(live.fiber))
  }

  /**
   * Starts a turn with `input`, after `before` writes in the same
   * transaction. The turn delivers the session's pending notes, and a
   * catalog note when the catalogs differ from those the model last knew.
   */
  private startTurn(sessionId: string, input: Input, before?: (append: (body: SessionEventBody) => SessionEvent) => void) {
    const state = this.state(sessionId)
    const { session, turn, notes } = this.commit(sessionId, (append) => {
      before?.(append)
      let session = this.session(sessionId)
      if (session.firstMessage === "") {
        const catalogs = this.options.setup.catalogs()
        this.store.setFirstMessage(sessionId, this.firstMessage(session.id, session.instructions, catalogs), catalogs)
        session = this.session(sessionId)
      }
      const known = this.store.turns(sessionId).at(-1)?.catalogs ?? session.catalogs
      const catalogs = this.options.setup.catalogs()
      const changes = [
        ...(catalogs.skills === known.skills ? [] : [{ name: "Skills", catalog: catalogs.skills }]),
        ...(catalogs.codeMode === known.codeMode ? [] : [{ name: "Code mode", catalog: catalogs.codeMode }]),
      ]
      // A catalog note is not kept with the turn's notes: it is derived from the catalogs, so a rewind derives it again.
      const carried = session.pendingNotes
      const notes = changes.length === 0 ? carried : [...carried, catalogNote(changes)]
      this.store.setPendingNotes(sessionId, [])
      const runId = crypto.randomUUID()
      const received = append({ type: "INPUT_RECEIVED", inputId: input.inputId, text: input.text, mode: input.mode, sender: input.sender })
      const turn = this.store.insertTurn(
        sessionId,
        { runId, inputId: input.inputId, inputText: input.text, model: session.model, firstSeq: received.seq, notes: carried, catalogs },
        this.now(),
      )
      append({ type: "RUN_STARTED", threadId: sessionId, runId, model: turn.model, inputId: input.inputId })
      return { session, turn, notes }
    })
    const span = startSpan("ashe_agent.turn", { "ashe_agent.model": turn.model })
    const live: Live = { fiber: null as unknown as Fiber.Fiber<TurnOutcome>, turn, cancelled: false, span, startedAt: performance.now() }
    const context: TurnContext = {
      session,
      turn,
      input,
      notes,
      emit: (body) => this.emit(sessionId, body),
      takeSteered: () => {
        const taken = state.pending.filter((pending) => pending.mode === "steer")
        state.pending = state.pending.filter((pending) => pending.mode !== "steer")
        for (const steered of taken) {
          this.emit(sessionId, { type: "INPUT_RECEIVED", inputId: steered.inputId, text: steered.text, mode: steered.mode, sender: steered.sender })
        }
        return taken
      },
      isCancelled: () => live.cancelled,
      toolResult: (toolCallId) => this.store.toolResult(sessionId, toolCallId),
      authorize: (toolCallId, check, signal) => this.authorize(sessionId, turn.runId, toolCallId, check, signal),
      trace: withSpan(span),
    }
    const fiber = Effect.runFork(this.options.runner(context))
    live.fiber = fiber
    state.live = live
    fiber.addObserver((exit) => this.endTurn(sessionId, live, exit))
  }

  private endTurn(sessionId: string, live: Live, exit: Exit.Exit<TurnOutcome>) {
    const state = this.state(sessionId)
    state.live = null
    const runId = live.turn.runId
    for (const [requestId, ask] of [...state.asks.entries()]) if (ask.runId === runId) state.asks.delete(requestId)
    this.endTurnSpan(live, exit)
    if (this.stopping) return
    this.commit(sessionId, (append) => {
      // No answer can apply to an ended turn, so its open requests are withdrawn with it.
      for (const requestId of this.openRequests(sessionId, runId)) {
        append({ type: "PERMISSION_WITHDRAWN", requestId, reason: "canceled" })
      }
      if (Exit.isSuccess(exit) && exit.value.status === "finished") {
        this.store.endTurn(sessionId, runId, "finished", this.now())
        append({ type: "RUN_FINISHED", threadId: sessionId, runId, outcome: { type: "success" } })
      } else if (Exit.isFailure(exit) && live.cancelled) {
        this.store.endTurn(sessionId, runId, "cancelled", this.now())
        append({ type: "RUN_FINISHED", threadId: sessionId, runId, outcome: { type: "cancelled" } })
      } else {
        const failure =
          Exit.isSuccess(exit) && exit.value.status === "failed" ? exit.value : { message: "the turn failed", code: "internal" }
        this.store.endTurn(sessionId, runId, "failed", this.now())
        append({ type: "RUN_ERROR", runId, message: failure.message, ...(failure.code === undefined ? {} : { code: failure.code }) })
      }
    })
    const next = state.pending.shift()
    if (next === undefined) return
    this.startTurn(sessionId, next)
  }

  /** Ends the turn's span and records its duration, with how it ended. */
  private endTurnSpan(live: Live, exit: Exit.Exit<TurnOutcome>) {
    const [status, errorClass]: readonly ["finished" | "failed" | "canceled" | "interrupted", ErrorClass | undefined] =
      Exit.isSuccess(exit)
        ? exit.value.status === "finished"
          ? ["finished", undefined]
          : ["failed", "turn_failed"]
        : live.cancelled
          ? ["canceled", undefined]
          : this.stopping
            ? ["interrupted", "interrupted"]
            : ["failed", "internal"]
    endSpan(live.span, { "ashe_agent.turn.status": status }, errorClass)
    recordDuration("ashe_agent.turn.duration", (performance.now() - live.startedAt) / 1000, { "ashe_agent.model": live.turn.model, "ashe_agent.turn.status": status })
  }

  /** Copies the session through the user turn `runId`, or entirely, into a new session with its own new directory. */
  fork(sessionId: string, runId: string | undefined): SessionSummary {
    const source = this.session(sessionId)
    if (this.isRunning(sessionId)) throw conflict("a turn is running; fork after it ends")
    if (runId !== undefined && this.store.getTurn(sessionId, runId) === null) throw notFound(`turn ${runId}`)
    const id = crypto.randomUUID()
    const forked = this.withSessionDir(id, () =>
      this.store.fork(
        source,
        {
          id,
          createdAt: this.now(),
          // The source's catalogs, so the copied turns' catalog notes stay consistent with the first message.
          firstMessage: this.firstMessage(id, source.instructions, source.catalogs),
          notes: [...source.pendingNotes, forkNote(source.id, id, this.store.sessionDir(id))],
        },
        runId ?? null,
      ),
    )
    return this.summary(forked.id)
  }

  /**
   * Removes the user turn `runId` and every later turn, then starts a turn
   * with its input, or with `text` instead, before taking any other input.
   * The new turn delivers the fork and rewind notes of the removed turns
   * and a rewind note, plus a catalog note when the current catalogs differ
   * from those of the last kept turn. The removal and the new turn's start
   * commit together.
   */
  rewind(sessionId: string, runId: string, text: string | undefined, sender: Sender) {
    this.session(sessionId)
    if (this.isRunning(sessionId)) throw conflict("a turn is running; rewind after it ends")
    const turn = this.store.getTurn(sessionId, runId)
    if (turn === null) throw notFound(`turn ${runId}`)
    this.startTurn(sessionId, { inputId: crypto.randomUUID(), text: text ?? turn.inputText, mode: "steer", sender }, (append) => {
      const removedNotes = this.store.removeFrom(sessionId, turn)
      const session = this.session(sessionId)
      this.store.setPendingNotes(sessionId, [...new Set([...session.pendingNotes, ...removedNotes, rewindNote()])])
      append({ type: "SESSION_REWOUND", runId: turn.runId, firstRemovedSeq: turn.firstSeq })
    })
  }

  /** Stops taking input and interrupts every running turn; their turns stay running for `recover`. */
  async stop() {
    this.stopping = true
    const fibers = [...this.states.values()].flatMap((state) => (state.live === null ? [] : [state.live.fiber]))
    await Effect.runPromise(Fiber.interruptAll(fibers))
  }
}

/** The server's session hub over its database, stopped when its layer is released. */
export class Sessions extends Context.Service<Sessions, SessionHub>()("ashe-agent/sessions/Sessions") {
  /** The hub over the `Store` database; `runner` builds the turn runner over that database. */
  static readonly layer = (
    options: Omit<HubOptions, "runner"> & {
      readonly runner: (db: Database) => TurnRunner
      /** The directory holding each session's directory. */
      readonly sessionsDir: string
    },
  ) =>
    Layer.effect(
      Sessions,
      Effect.gen(function* () {
        const { db } = yield* Store
        return yield* Effect.acquireRelease(
          Effect.sync(() => {
            const hub = new SessionHub(new SessionStore(db, options.sessionsDir), { ...options, runner: options.runner(db) })
            hub.recover()
            return hub
          }),
          (hub) => Effect.promise(() => hub.stop()),
        )
      }),
    )
}

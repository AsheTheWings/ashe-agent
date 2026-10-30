import type { Database } from "bun:sqlite"
import { existsSync, statSync } from "node:fs"
import { isAbsolute } from "node:path"
import { Context, Effect, Exit, Fiber, Layer } from "effect"
import {
  ErrorCode,
  type InputMode,
  type Model,
  type Sender,
  type SessionEvent,
  type SessionEventBody,
  type SessionSummary,
} from "@ashe-agent/protocol"
import { firstMessage } from "../agent/blocks.ts"
import { forkNote, rewindNote, unfinishedResult } from "../agent/notes.ts"
import { ProtocolError } from "../server/websocket.ts"
import { Store } from "../store/database.ts"
import { SessionStore, type SessionRecord, type TurnRecord } from "./store.ts"

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
}

export type TurnOutcome = { readonly status: "finished" } | { readonly status: "failed"; readonly message: string; readonly code?: string }

/** Runs one turn to its end; interrupting it cancels the turn. */
export type TurnRunner = (context: TurnContext) => Effect.Effect<TurnOutcome>

/** What a session takes from its agent, and the catalogs its developer message lists. */
export interface SessionSetup {
  /** The session's agent, the instructions recorded at its creation, and the model the agent names, if any. */
  readonly resolve: (agent: string | null) => {
    readonly agent: string | null
    readonly instructions: string | null
    readonly model: string | null
  }
  readonly catalogs: () => { readonly skills: string | null; readonly codeMode: string | null }
}

type ToolOutcome = Extract<SessionEventBody, { type: "TOOL_CALL_RESULT" }>["outcome"]

export interface HubOptions {
  readonly models: ReadonlyArray<Model>
  readonly runner: TurnRunner
  readonly setup: SessionSetup
  readonly now?: () => number
}

type Listener = (event: SessionEvent) => void

interface Live {
  fiber: Fiber.Fiber<TurnOutcome>
  readonly turn: TurnRecord
  cancelled: boolean
}

interface SessionState {
  readonly listeners: Set<Listener>
  /**
   * Inputs not yet in the conversation, in order of arrival: steered ones
   * wait for the running turn's next step boundary, queued ones for its end.
   */
  pending: Array<Input>
  live: Live | null
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
   * result an interrupted one, then emits its interrupted event. A turn
   * that ended withdrew its own requests and answered its own calls, so
   * only running turns can hold unanswered ones.
   */
  recover() {
    for (const { sessionId, runId } of this.store.runningTurns()) {
      this.store.db.transaction(() => {
        for (const requestId of this.openRequests(sessionId, runId)) {
          this.store.appendEvent(sessionId, { type: "PERMISSION_WITHDRAWN", requestId, reason: "restart" }, this.now())
        }
        for (const { toolCallId, started } of this.unansweredCalls(sessionId, runId)) {
          this.store.appendEvent(
            sessionId,
            {
              type: "TOOL_CALL_RESULT",
              messageId: crypto.randomUUID(),
              toolCallId,
              role: "tool",
              content: unfinishedResult("interrupted", started),
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
    const calls = new Map<string, { toolCallId: string; started: boolean }>()
    for (const { event } of this.turnEvents(sessionId, runId)) {
      if (event.type === "TOOL_CALL_START") calls.set(event.toolCallId, { toolCallId: event.toolCallId, started: false })
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
      state = { listeners: new Set(), pending: [], live: null }
      this.states.set(sessionId, state)
    }
    return state
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

  /** The first message of a session with this identity and recorded instructions, with today's catalogs. */
  private firstMessage(id: string, cwd: string, instructions: string | null) {
    const { skills, codeMode } = this.options.setup.catalogs()
    return firstMessage({ instructions, skills, codeMode, sessionId: id, cwd })
  }

  /**
   * Creates a session. Its model is the one its agent names, else the one
   * given, which must be configured, else the first configured model.
   */
  create(params: { cwd: string; model?: string; agent?: string }): SessionSummary {
    if (!isAbsolute(params.cwd) || !existsSync(params.cwd) || !statSync(params.cwd).isDirectory()) {
      throw invalid("the working directory must be an absolute path of an existing directory")
    }
    const { agent, instructions, model: agentModel } = this.options.setup.resolve(params.agent ?? null)
    const model = agentModel ?? params.model ?? this.options.models[0]!.id
    if (!this.options.models.some((candidate) => candidate.id === model)) throw invalid(`no configured model ${model}`)
    const id = crypto.randomUUID()
    this.store.createSession(
      { id, cwd: params.cwd, agent, model, instructions, createdAt: this.now(), firstMessage: this.firstMessage(id, params.cwd, instructions) },
      null,
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

  /** Starts a turn with `input`, after `before` writes in the same transaction. */
  private startTurn(sessionId: string, input: Input, before?: (append: (body: SessionEventBody) => SessionEvent) => void) {
    const state = this.state(sessionId)
    const { session, turn, notes } = this.commit(sessionId, (append) => {
      before?.(append)
      let session = this.session(sessionId)
      if (session.firstMessage === "") {
        this.store.setFirstMessage(sessionId, this.firstMessage(session.id, session.cwd, session.instructions))
        session = this.session(sessionId)
      }
      const notes = session.pendingNotes
      this.store.setPendingNotes(sessionId, [])
      const runId = crypto.randomUUID()
      const received = append({ type: "INPUT_RECEIVED", inputId: input.inputId, text: input.text, mode: input.mode, sender: input.sender })
      const turn = this.store.insertTurn(
        sessionId,
        { runId, inputId: input.inputId, inputText: input.text, model: session.model, firstSeq: received.seq, notes },
        this.now(),
      )
      append({ type: "RUN_STARTED", threadId: sessionId, runId, model: turn.model, inputId: input.inputId })
      return { session, turn, notes }
    })
    const live: Live = { fiber: null as unknown as Fiber.Fiber<TurnOutcome>, turn, cancelled: false }
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

  /** Copies the session through the user turn `runId`, or entirely, into a new session. */
  fork(sessionId: string, runId: string | undefined): SessionSummary {
    const source = this.session(sessionId)
    if (this.isRunning(sessionId)) throw conflict("a turn is running; fork after it ends")
    if (runId !== undefined && this.store.getTurn(sessionId, runId) === null) throw notFound(`turn ${runId}`)
    const id = crypto.randomUUID()
    const forked = this.store.fork(
      source,
      {
        id,
        createdAt: this.now(),
        firstMessage: this.firstMessage(id, source.cwd, source.instructions),
        notes: [...source.pendingNotes, forkNote(source.id, id)],
      },
      runId ?? null,
    )
    return this.summary(forked.id)
  }

  /**
   * Removes the user turn `runId` and every later turn, then starts a turn
   * with its input, or with `text` instead, before taking any other input.
   * The new turn delivers the notes of the removed turns and a rewind note.
   * The removal and the new turn's start commit together.
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
  static readonly layer = (options: Omit<HubOptions, "runner"> & { readonly runner: (db: Database) => TurnRunner }) =>
    Layer.effect(
      Sessions,
      Effect.gen(function* () {
        const { db } = yield* Store
        return yield* Effect.acquireRelease(
          Effect.sync(() => {
            const hub = new SessionHub(new SessionStore(db), { ...options, runner: options.runner(db) })
            hub.recover()
            return hub
          }),
          (hub) => Effect.promise(() => hub.stop()),
        )
      }),
    )
}

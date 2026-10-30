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
  /** Persists an event of the turn and sends it to every subscriber. */
  readonly emit: (body: SessionEventBody) => SessionEvent
  /** Takes the inputs steered into the turn since the last step boundary, emitting their events. */
  readonly takeSteered: () => ReadonlyArray<Input>
}

export type TurnOutcome = { readonly status: "finished" } | { readonly status: "failed"; readonly message: string; readonly code?: string }

/** Runs one turn to its end; interrupting it cancels the turn. */
export type TurnRunner = (context: TurnContext) => Effect.Effect<TurnOutcome>

/** Resolves a session's agent and the instructions recorded at its creation. */
export interface SessionSetup {
  readonly resolve: (agent: string | null) => { readonly agent: string | null; readonly instructions: string | null }
}

export interface HubOptions {
  readonly models: ReadonlyArray<Model>
  readonly runner: TurnRunner
  readonly setup: SessionSetup
  readonly now?: () => number
}

type Listener = (event: SessionEvent) => void

interface Live {
  readonly fiber: Fiber.Fiber<TurnOutcome>
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
   * unanswered permission requests, then emits its interrupted event. A
   * turn that ended withdrew its own requests, so only running turns can
   * hold unanswered ones.
   */
  recover() {
    for (const { sessionId, runId } of this.store.runningTurns()) {
      this.store.db.transaction(() => {
        for (const requestId of this.openRequests(sessionId, runId)) {
          this.store.appendEvent(sessionId, { type: "PERMISSION_WITHDRAWN", requestId, reason: "restart" }, this.now())
        }
        this.store.endTurn(sessionId, runId, "interrupted", this.now())
        this.store.appendEvent(sessionId, { type: "RUN_INTERRUPTED", threadId: sessionId, runId }, this.now())
      })()
    }
  }

  /** The permission requests of the turn `runId` that are neither resolved nor withdrawn. */
  private openRequests(sessionId: string, runId: string): ReadonlyArray<string> {
    const turn = this.store.getTurn(sessionId, runId)!
    const open = new Set<string>()
    for (const { event } of this.store.eventsAfter(sessionId, turn.firstSeq - 1)) {
      if (event.type === "PERMISSION_REQUESTED" && event.runId === runId) open.add(event.requestId)
      if (event.type === "PERMISSION_RESOLVED" || event.type === "PERMISSION_WITHDRAWN") open.delete(event.requestId)
    }
    return [...open]
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

  create(params: { cwd: string; model?: string; agent?: string }): SessionSummary {
    if (!isAbsolute(params.cwd) || !existsSync(params.cwd) || !statSync(params.cwd).isDirectory()) {
      throw invalid("the working directory must be an absolute path of an existing directory")
    }
    const model = params.model ?? this.options.models[0]!.id
    if (!this.options.models.some((candidate) => candidate.id === model)) throw invalid(`no configured model ${model}`)
    const { agent, instructions } = this.options.setup.resolve(params.agent ?? null)
    const id = crypto.randomUUID()
    this.store.createSession({ id, cwd: params.cwd, agent, model, instructions, createdAt: this.now() }, null)
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
    const { session, turn } = this.commit(sessionId, (append) => {
      before?.(append)
      const session = this.session(sessionId)
      const runId = crypto.randomUUID()
      const received = append({ type: "INPUT_RECEIVED", inputId: input.inputId, text: input.text, mode: input.mode, sender: input.sender })
      const turn = this.store.insertTurn(
        sessionId,
        { runId, inputId: input.inputId, inputText: input.text, model: session.model, firstSeq: received.seq },
        this.now(),
      )
      append({ type: "RUN_STARTED", threadId: sessionId, runId, model: turn.model, inputId: input.inputId })
      return { session, turn }
    })
    const context: TurnContext = {
      session,
      turn,
      input,
      emit: (body) => this.emit(sessionId, body),
      takeSteered: () => {
        const taken = state.pending.filter((pending) => pending.mode === "steer")
        state.pending = state.pending.filter((pending) => pending.mode !== "steer")
        for (const steered of taken) {
          this.emit(sessionId, { type: "INPUT_RECEIVED", inputId: steered.inputId, text: steered.text, mode: steered.mode, sender: steered.sender })
        }
        return taken
      },
    }
    const fiber = Effect.runFork(this.options.runner(context))
    const live: Live = { fiber, turn, cancelled: false }
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
    const forked = this.store.fork(source, { id: crypto.randomUUID(), createdAt: this.now() }, runId ?? null)
    return this.summary(forked.id)
  }

  /**
   * Removes the user turn `runId` and every later turn, then starts a turn
   * with its input, or with `text` instead, before taking any other input.
   * The removal and the new turn's start commit together.
   */
  rewind(sessionId: string, runId: string, text: string | undefined, sender: Sender) {
    this.session(sessionId)
    if (this.isRunning(sessionId)) throw conflict("a turn is running; rewind after it ends")
    const turn = this.store.getTurn(sessionId, runId)
    if (turn === null) throw notFound(`turn ${runId}`)
    this.startTurn(sessionId, { inputId: crypto.randomUUID(), text: text ?? turn.inputText, mode: "steer", sender }, (append) => {
      this.store.removeFrom(sessionId, turn)
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
  static readonly layer = (options: HubOptions) =>
    Layer.effect(
      Sessions,
      Effect.gen(function* () {
        const { db } = yield* Store
        return yield* Effect.acquireRelease(
          Effect.sync(() => {
            const hub = new SessionHub(new SessionStore(db), options)
            hub.recover()
            return hub
          }),
          (hub) => Effect.promise(() => hub.stop()),
        )
      }),
    )
}

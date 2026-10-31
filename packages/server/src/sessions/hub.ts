import { existsSync, mkdirSync, rmdirSync } from "node:fs"
import type { AIMessage } from "@langchain/core/messages"
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
import { programCallsNote, unfinishedResult } from "../agent/notes.ts"
import { withholdingName, type Tool } from "../agent/tools.ts"
import type { ToolContent, ToolOutcome } from "../agent/window.ts"
import type { SessionAgent } from "../agents/agents.ts"
import { InstructionsUnreadable, type KnownInstructions } from "../agents/setup.ts"
import { displayTitle, type FileMetadata } from "../agents/titles.ts"
import {
  currentDates,
  datesChanged,
  forkComponent,
  harnessInstructions,
  rewindComponent,
  sameDates,
  type Component,
  type SourceStates,
} from "../context/components.ts"
import { SESSION_ID_LENGTH } from "../context/constants.ts"
import { allowanceMessage, catalogChanges, instructionsChange, renderSeed } from "../context/seed.ts"
import type { Permission } from "../inputs/shapes.ts"
import type { ConfiguredModel } from "../models/registry.ts"
import {
  compileRules,
  decide,
  PermissionDenied,
  PermissionRejected,
  whollyDenied,
  type PermissionCheck,
  type Rule,
} from "../permissions/rules.ts"
import { ProtocolError } from "../server/websocket.ts"
import { Store } from "../store/database.ts"
import { endSpan, recordDuration, startSpan, withSpan, type ErrorClass } from "../telemetry/signals.ts"
import type { Item, WaitingEntry } from "./conversation.ts"
import { SessionStore, type Catalogs, type SessionRecord, type TurnRecord } from "./store.ts"

export type { Catalogs } from "./store.ts"

/** What a turn's runner gets from the hub. */
export interface TurnContext {
  readonly session: SessionRecord
  readonly turn: TurnRecord
  /** Persists an event of the turn and sends it to every subscriber. */
  readonly emit: (body: SessionEventBody) => SessionEvent
  /** The session's current checkpoint window: its harness instructions and its items. */
  readonly window: () => { readonly harness: string; readonly items: ReadonlyArray<Item> }
  /** The tools the session's rules leave offered now. */
  readonly tools: () => ReadonlyArray<Tool>
  /** Records a model call's assistant message as an item, in one transaction with the events that end its streams. */
  readonly commitAssistant: (message: AIMessage, events: ReadonlyArray<SessionEventBody>) => void
  /** Records a tool result as an item, in one transaction with its `TOOL_CALL_RESULT` event. */
  readonly commitResult: (
    result: { readonly callId: string; readonly name: string; readonly content: ToolContent; readonly outcome: ToolOutcome },
    event: SessionEventBody,
  ) => void
  /**
   * The step boundary's delivery: the steered user messages and the
   * notification components waiting, with the state components that ride
   * on them, join the turn. Returns whether anything joined.
   */
  readonly deliver: () => boolean
  /** Whether a cancel request, rather than a server stop, is ending the turn. */
  readonly isCancelled: () => boolean
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
  /** Whether the session's rules leave `tool` offered: false for a tool they wholly deny. */
  readonly offered: (tool: Tool) => boolean
}

export type TurnOutcome = { readonly status: "finished" } | { readonly status: "failed"; readonly message: string; readonly code?: string }

/** Runs one turn to its end; interrupting it cancels the turn. */
export type TurnRunner = (context: TurnContext) => Effect.Effect<TurnOutcome>

/** A version of a session's user instructions: where it was read and what it says. */
export interface UserInstructions {
  /** The agent's title file, or the global instructions file. */
  readonly source: "title" | "global"
  readonly path: string
  readonly text: string
  readonly sha256: string
  readonly metadata: FileMetadata
}

/** What a session takes from its agent, and the sources its developer components give. */
export interface SessionSetup {
  /** The agent a new session runs as; it throws a `ProtocolError` for a key that is no agent. */
  readonly resolve: (agent: string | null) => SessionAgent
  /**
   * The agent's user instructions as they stand now, or null when there are
   * none, or "unchanged" when the chosen file is `known`'s with the same
   * metadata; it throws `InstructionsUnreadable` when the chosen source
   * exists but cannot be used.
   */
  readonly userInstructions: (agent: SessionAgent, known?: KnownInstructions) => UserInstructions | null | "unchanged"
  /** The catalogs as they stand now, without what `rules` deny. */
  readonly catalogs: (rules: ReadonlyArray<Rule>) => Catalogs
  /** The configured agents and the default one. */
  readonly agents: () => { readonly agents: ReadonlyArray<Agent>; readonly defaultAgent: string | null }
}

export interface HubOptions {
  readonly models: ReadonlyArray<ConfiguredModel>
  /** The model sessions start with when neither the request nor the agent names one. */
  readonly defaultModel: string
  readonly runner: TurnRunner
  readonly setup: SessionSetup
  /** The tools available now, before a session's rules withhold any. */
  readonly tools?: () => ReadonlyArray<Tool>
  /** The global permission rules. */
  readonly permission?: Permission
  /** The home directory `~` and `$HOME` patterns expand to. */
  readonly home?: string
  /** The user's IANA time zone; UTC when unset. */
  readonly userTimeZone?: string
  /** The server's own time zone; the process's when unset. */
  readonly serverTimeZone?: string
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
  live: Live | null
  /** Permission requests waiting for an answer, by request id, in arrival order. */
  readonly asks: Map<string, Ask>
}

type Append = (body: SessionEventBody) => SessionEvent

const notFound = (what: string) => new ProtocolError({ code: ErrorCode.notFound, message: `no ${what}` })
const conflict = (message: string) => new ProtocolError({ code: ErrorCode.conflict, message })
const invalid = (message: string) => new ProtocolError({ code: ErrorCode.invalidInput, message })

const SESSION_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
/** The largest multiple of the alphabet's size below 256: bytes from it on are discarded, so each character is uniform. */
const SESSION_ID_BYTE_LIMIT = 256 - (256 % SESSION_ID_ALPHABET.length)

/** A random session id of `a-z` and `0-9` from a cryptographically secure source. */
export const randomSessionId = (): string => {
  let id = ""
  while (id.length < SESSION_ID_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(SESSION_ID_LENGTH * 2))) {
      if (byte < SESSION_ID_BYTE_LIMIT && id.length < SESSION_ID_LENGTH) id += SESSION_ID_ALPHABET[byte % SESSION_ID_ALPHABET.length]
    }
  }
  return id
}

/** Whether a waiting entry joins a turn other than as its first entry: a steered user message or a notification. */
const joins = (entry: WaitingEntry) => entry.kind === "notification" || entry.mode === "steer"

const wire = (component: Component) => ({ type: component.type, heading: component.heading, text: component.text })

/**
 * Keeps every session's live state: its subscribers, its running turn, and
 * its permission requests. Events are persisted before they are sent, so
 * subscribers and later readers see the same numbered history; input
 * waiting for a turn is stored in the session's conversation state.
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

  private get conversation() {
    return this.store.conversation
  }

  /**
   * Ends every turn a stopped server left running: withdraws its
   * unanswered permission requests, gives each of its tool calls without a
   * result an interrupted one, as an item when an assistant item holds the
   * call, which for an `execute` call lists the tool calls its program had
   * finished, then emits its interrupted event, all in one transaction. A
   * turn that ended withdrew its own requests and answered its own calls,
   * so only running turns can hold unanswered ones.
   */
  recover() {
    for (const { sessionId, runId } of this.store.runningTurns()) {
      this.store.db.transaction(() => {
        const turn = this.store.getTurn(sessionId, runId)!
        const window = this.conversation.currentWindow(sessionId)!
        const items = this.conversation.turnItems(sessionId, runId)
        const committed = new Map(
          items.flatMap((item) => (item.kind === "assistant" ? (item.message.tool_calls ?? []).map((call) => [call.id!, call.name] as const) : [])),
        )
        for (const requestId of this.openRequests(sessionId, runId)) {
          this.store.appendEvent(sessionId, { type: "PERMISSION_WITHDRAWN", requestId, reason: "restart" }, this.now())
        }
        for (const { toolCallId, started, program } of this.unansweredCalls(sessionId, runId)) {
          const unfinished = unfinishedResult("interrupted", started)
          const content = program === null ? unfinished : `${unfinished} ${programCallsNote(program)}`
          const name = committed.get(toolCallId)
          if (name !== undefined) {
            this.conversation.appendItem(sessionId, window.position, { runId, model: turn.model }, {
              kind: "result",
              callId: toolCallId,
              name,
              content,
              outcome: "interrupted",
            })
          }
          this.store.appendEvent(
            sessionId,
            { type: "TOOL_CALL_RESULT", messageId: crypto.randomUUID(), toolCallId, role: "tool", content, outcome: "interrupted" },
            this.now(),
          )
        }
        this.store.endTurn(sessionId, runId, "interrupted", this.now())
        this.store.appendEvent(sessionId, { type: "RUN_INTERRUPTED", threadId: sessionId, runId }, this.now())
      })()
    }
  }

  /** Starts turns for the input left waiting at a server stop, in arrival order, once recovery is done. */
  resumeWaiting() {
    for (const sessionId of this.conversation.sessionsWaiting()) this.startNext(sessionId)
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
      state = { listeners: new Set(), live: null, asks: new Map() }
      this.states.set(sessionId, state)
    }
    return state
  }


  /** The rules deciding a session's calls: global, then its agent's, then its grants as allow rules. */
  rules(session: SessionRecord): ReadonlyArray<Rule> {
    return this.rulesOf(session.permission, this.store.grants(session.id))
  }

  private rulesOf(agent: Permission | null, grants: ReturnType<SessionStore["grants"]>): ReadonlyArray<Rule> {
    const home = this.options.home ?? "/"
    return [
      ...compileRules(this.options.permission ?? {}, home),
      ...(agent === null ? [] : compileRules(agent, home)),
      ...grants.map((grant) => ({ ...grant, action: "allow" as const })),
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

  /** The configured models as clients list them, and the default one. */
  models(): { readonly models: ReadonlyArray<Model>; readonly defaultModel: string } {
    return {
      models: this.options.models.map((model) => ({
        id: model.id,
        name: model.name,
        contextLimit: model.contextLimit,
        imageInput: model.imageInput,
        reasoningEfforts: [...model.efforts],
        reasoningEffort: model.settings.reasoningEffort ?? null,
      })),
      defaultModel: this.options.defaultModel,
    }
  }

  private model(id: string): ConfiguredModel {
    const model = this.options.models.find((candidate) => candidate.id === id)
    if (model === undefined) throw invalid(`no configured model ${id}`)
    return model
  }

  /** `effort` when `model` lists it; refused otherwise. */
  private effort(model: ConfiguredModel, effort: string | undefined): string | null {
    if (effort === undefined) return null
    if (!model.efforts.includes(effort)) throw invalid(`the model ${model.id} lists no reasoning effort ${effort}`)
    return effort
  }


  list(): ReadonlyArray<SessionSummary> {
    return this.store.listSessions((id) => this.isRunning(id))
  }

  summary(sessionId: string): SessionSummary {
    return this.store.summary(this.session(sessionId), this.isRunning(sessionId))
  }


  /** The tools `rules` leave offered: every available tool they do not wholly deny. */
  private offeredTools(rules: ReadonlyArray<Rule>): ReadonlyArray<Tool> {
    return (this.options.tools?.() ?? []).filter((tool) => !whollyDenied(rules, withholdingName(tool)))
  }

  private dates() {
    return currentDates(this.now(), this.options.userTimeZone ?? "UTC", this.options.serverTimeZone)
  }

  /** A new session id that no session and no directory has. */
  private newSessionId() {
    for (;;) {
      const id = randomSessionId()
      if (this.store.getSession(id) === null && !existsSync(this.store.sessionDir(id))) return id
    }
  }

  /**
   * Creates a session in its own new directory, running as `agent`, else
   * the default agent, else the implicit agent. Its model is the one its
   * agent names, else the one given, else the default model, and it starts
   * with the given reasoning effort, which that model must list. Its first
   * checkpoint window is constructed with it; a seed component or the tool
   * definitions over their allowance, or user instructions that cannot be
   * read, fail the creation.
   */
  create(params: { model?: string; agent?: string; reasoningEffort?: string }): SessionSummary {
    const agent = this.options.setup.resolve(params.agent ?? null)
    const model = this.model(agent.model ?? params.model ?? this.options.defaultModel)
    const reasoningEffort = this.effort(model, params.reasoningEffort)
    let instructions: UserInstructions | null
    try {
      const read = this.options.setup.userInstructions(agent)
      instructions = read === "unchanged" ? null : read
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error))
    }
    const id = this.newSessionId()
    const rules = this.rulesOf(agent.permission, [])
    const harness = harnessInstructions(this.store.sessionsDir)
    const seed = renderSeed({
      harness,
      instructions,
      title: agent.key === null ? null : displayTitle(agent.key),
      catalogs: this.options.setup.catalogs(rules),
      sessionId: id,
      dates: this.dates(),
      tools: this.offeredTools(rules).map((tool) => tool.spec),
    })
    if (!seed.ok) throw invalid(`the session's first checkpoint window cannot be built: ${allowanceMessage(seed.issue)}`)
    const createdAt = this.now()
    this.withSessionDir(id, () =>
      this.store.db.transaction(() => {
        this.store.createSession(
          { id, agent: agent.key, model: model.id, reasoningEffort, modelOverrides: agent.overrides, permission: agent.permission, createdAt },
          null,
        )
        if (instructions !== null) this.conversation.putContent(instructions.sha256, instructions.text)
        const window = this.conversation.insertWindow(id, null, harness, createdAt)
        for (const component of seed.components) this.conversation.appendItem(id, window.position, null, { kind: "component", component })
        this.store.appendEvent(
          id,
          { type: "CHECKPOINT_WINDOW_SEEDED", runId: null, window: window.position, components: seed.components.map(wire) },
          createdAt,
        )
      })(),
    )
    return this.summary(id)
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

  /** The configured agents, each with its title, title file state, and settings, and the default agent. */
  agents() {
    return this.options.setup.agents()
  }

  /**
   * Selects the session's model and reasoning effort, which the model must
   * list; without an effort, the selection is cleared. A running turn keeps
   * the model and effort it started with.
   */
  setModel(sessionId: string, model: string, reasoningEffort: string | undefined, sender: Sender) {
    this.session(sessionId)
    const configured = this.model(model)
    const effort = this.effort(configured, reasoningEffort)
    this.commit(sessionId, (append) => {
      this.store.setModel(sessionId, configured.id, effort)
      append({ type: "MODEL_CHANGED", model: configured.id, reasoningEffort: effort, sender })
    })
  }


  /**
   * Takes a user message: it is stored as waiting input, then starts a turn
   * on an idle session. Waiting, a steered message joins the running turn
   * at its next step boundary, and a queued one starts a turn after it
   * ends; messages of each mode enter in order of arrival.
   */
  input(sessionId: string, text: string, mode: InputMode | undefined, sender: Sender): string {
    this.session(sessionId)
    if (this.stopping) throw conflict("the server is stopping")
    const inputId = crypto.randomUUID()
    const entry = { kind: "user" as const, inputId, text, mode: mode ?? "steer", sender }
    this.commit(sessionId, (append) => {
      this.conversation.addWaiting(sessionId, entry, this.now())
      append({ type: "INPUT_WAITING", inputId, text, mode: entry.mode, sender })
    })
    this.startNext(sessionId)
    return inputId
  }

  cancel(sessionId: string) {
    this.session(sessionId)
    const live = this.state(sessionId).live
    if (live === null) throw conflict("no turn is running")
    live.cancelled = true
    Effect.runFork(Fiber.interrupt(live.fiber))
  }


  /**
   * Starts a turn on an idle session with waiting input: its first entry,
   * with every steered message and notification after it. When the turn
   * cannot start, its input stays waiting for the next start, and a
   * session error event says why.
   */
  private startNext(sessionId: string) {
    if (this.stopping || this.state(sessionId).live !== null) return
    const [first, ...rest] = this.conversation.waiting(sessionId)
    if (first === undefined) return
    try {
      this.startTurn(sessionId, [first, ...rest.filter(joins)])
    } catch (error) {
      const message = `the turn could not start, and its input stays waiting: ${error instanceof Error ? error.message : String(error)}`
      try {
        this.commit(sessionId, (append) => append({ type: "SESSION_ERROR", code: "turn_start_failed", message }))
      } catch {
        // The input stays waiting either way; the next input or server start tries again.
      }
    }
  }

  /**
   * The state components a delivery carries, one per source whose current
   * state differs from what the session's current checkpoint window knows,
   * and the errors of sources that cannot be read or are over allowance.
   */
  private reconcile(session: SessionRecord, known: SourceStates) {
    const components: Array<Component> = []
    const errors: Array<{ readonly code: string; readonly message: string }> = []
    const title = session.agent === null ? null : displayTitle(session.agent)
    const agent: SessionAgent = { key: session.agent, model: null, overrides: session.modelOverrides, permission: session.permission }
    const knownInstructions = known.userInstructions ?? { kind: "none" as const }
    try {
      const read = this.options.setup.userInstructions(
        agent,
        knownInstructions.kind === "none" ? undefined : { path: knownInstructions.path, metadata: knownInstructions.metadata },
      )
      if (read !== "unchanged") {
        const knownText = knownInstructions.kind === "none" ? null : this.conversation.content(knownInstructions.sha256)
        const change = instructionsChange(knownInstructions, knownText, read, title)
        if (change !== null) {
          if (read !== null) this.conversation.putContent(read.sha256, read.text)
          components.push(change)
        }
      }
    } catch (error) {
      if (!(error instanceof InstructionsUnreadable)) throw error
      errors.push({ code: "user_instructions_unreadable", message: `${error.message}; the known user instructions stay` })
    }
    const catalogs = catalogChanges(
      { skills: known.skillCatalog?.text ?? null, codeMode: known.codeModeCatalog?.text ?? null },
      this.options.setup.catalogs(this.rules(session)),
    )
    components.push(...catalogs.components)
    for (const issue of catalogs.issues) {
      errors.push({ code: "catalog_over_allowance", message: `${allowanceMessage(issue)}; the known catalog stays` })
    }
    const dates = this.dates()
    if (known.dates === undefined || !sameDates(known.dates, dates)) components.push(datesChanged(dates))
    if (known.identity?.sessionId !== session.id) components.push(forkComponent(known.identity?.sessionId ?? session.id, session.id))
    return { components, errors }
  }

  /**
   * Delivers `taken` waiting entries into `turn`, in the session's current
   * checkpoint window: in arrival order, with the state components
   * reconciliation yields before the first user message. Adjoining
   * components form one developer message with its event; each user
   * message gets its `INPUT_RECEIVED`. The taken entries stop waiting.
   */
  private deliverInto(sessionId: string, turn: TurnRecord, taken: ReadonlyArray<WaitingEntry>, append: Append) {
    const session = this.session(sessionId)
    const window = this.conversation.currentWindow(sessionId)!
    const { components: state, errors } = this.reconcile(session, this.conversation.knownStates(sessionId, window.position))
    for (const error of errors) append({ type: "SESSION_ERROR", code: error.code, message: error.message, runId: turn.runId })
    type Delivered = { readonly kind: "component"; readonly component: Component } | Extract<WaitingEntry, { kind: "user" }>
    const delivered: Array<Delivered> = taken.map((entry) => (entry.kind === "user" ? entry : { kind: "component", component: entry.component }))
    const firstUser = delivered.findIndex((entry) => entry.kind === "user")
    delivered.splice(firstUser === -1 ? delivered.length : firstUser, 0, ...state.map((component) => ({ kind: "component" as const, component })))
    const owner = { runId: turn.runId, model: turn.model }
    let message: Array<Component> = []
    const closeMessage = () => {
      if (message.length > 0) append({ type: "DEVELOPER_MESSAGE", runId: turn.runId, components: message.map(wire) })
      message = []
    }
    for (const entry of delivered) {
      if (entry.kind === "component") {
        this.conversation.appendItem(sessionId, window.position, owner, entry)
        message.push(entry.component)
        continue
      }
      closeMessage()
      this.conversation.appendItem(sessionId, window.position, owner, { kind: "user", inputId: entry.inputId, text: entry.text, sender: entry.sender })
      append({ type: "INPUT_RECEIVED", inputId: entry.inputId, text: entry.text, mode: entry.mode, sender: entry.sender })
    }
    closeMessage()
    for (const entry of taken) this.conversation.removeWaiting(sessionId, entry.position)
  }

  /**
   * Starts a turn with the `taken` waiting entries as its input, delivered
   * in the transaction that records the turn and its start event.
   */
  private startTurn(sessionId: string, taken: ReadonlyArray<WaitingEntry>) {
    const state = this.state(sessionId)
    const { session, turn } = this.commit(sessionId, (append) => {
      const session = this.session(sessionId)
      const userMessageIds = taken.flatMap((entry) => (entry.kind === "user" ? [entry.inputId] : []))
      const cause = userMessageIds.length > 0 ? "user" : "notification"
      const turn = this.store.insertTurn(
        sessionId,
        {
          runId: crypto.randomUUID(),
          cause,
          userMessageIds,
          model: session.model,
          reasoningEffort: session.reasoningEffort,
          firstSeq: session.nextSeq,
        },
        this.now(),
      )
      this.deliverInto(sessionId, turn, taken, append)
      append({ type: "RUN_STARTED", threadId: sessionId, runId: turn.runId, model: turn.model, cause, userMessageIds })
      return { session, turn }
    })
    const span = startSpan("ashe_agent.turn", { "ashe_agent.model": turn.model })
    const live: Live = { fiber: null as unknown as Fiber.Fiber<TurnOutcome>, turn, cancelled: false, span, startedAt: performance.now() }
    const owner = { runId: turn.runId, model: turn.model }
    const rules = () => this.rules(this.session(sessionId))
    const context: TurnContext = {
      session,
      turn,
      emit: (body) => this.emit(sessionId, body),
      window: () => {
        const window = this.conversation.currentWindow(sessionId)!
        return { harness: window.harnessInstructions, items: this.conversation.items(sessionId, window.position) }
      },
      tools: () => this.offeredTools(rules()),
      commitAssistant: (message, events) =>
        this.commit(sessionId, (append) => {
          const window = this.conversation.currentWindow(sessionId)!
          this.conversation.appendItem(sessionId, window.position, owner, { kind: "assistant", message })
          for (const body of events) append(body)
        }),
      commitResult: (result, event) =>
        this.commit(sessionId, (append) => {
          const window = this.conversation.currentWindow(sessionId)!
          this.conversation.appendItem(sessionId, window.position, owner, { kind: "result", ...result })
          append(event)
        }),
      deliver: () => {
        const taken = this.conversation.waiting(sessionId).filter(joins)
        if (taken.length === 0) return false
        this.commit(sessionId, (append) => this.deliverInto(sessionId, turn, taken, append))
        return true
      },
      isCancelled: () => live.cancelled,
      authorize: (toolCallId, check, signal) => this.authorize(sessionId, turn.runId, toolCallId, check, signal),
      trace: withSpan(span),
      offered: (tool) => !whollyDenied(rules(), withholdingName(tool)),
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
    this.startNext(sessionId)
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


  /** The turn `runId` when it is a rewind and fork point: a turn whose starting input holds a user message. */
  private point(sessionId: string, runId: string): TurnRecord {
    const turn = this.store.getTurn(sessionId, runId)
    if (turn === null) throw notFound(`turn ${runId}`)
    if (turn.userMessageIds.length === 0) throw invalid(`turn ${runId} starts with no user message, so it is no rewind or fork point`)
    return turn
  }

  /**
   * Copies the session through the turn `runId`, a fork point, or entirely,
   * into a new session with its own new directory. Its first delivery
   * reconciles the new session identity with a fork component.
   */
  fork(sessionId: string, runId: string | undefined): SessionSummary {
    const source = this.session(sessionId)
    if (this.isRunning(sessionId)) throw conflict("a turn is running; fork after it ends")
    if (runId !== undefined) this.point(sessionId, runId)
    const id = this.newSessionId()
    const forked = this.withSessionDir(id, () => this.store.fork(source, { id, createdAt: this.now() }, runId ?? null))
    return this.summary(forked.id)
  }

  /**
   * Removes the turn `runId`, a rewind point, and every later turn with
   * every row they own, then stores the rewind component and the user
   * messages of the turn's starting input, or `text` instead, as waiting
   * input with new ids, which starts the rerun turn. The removal and the
   * waiting input commit together.
   */
  rewind(sessionId: string, runId: string, text: string | undefined, sender: Sender) {
    this.session(sessionId)
    if (this.isRunning(sessionId)) throw conflict("a turn is running; rewind after it ends")
    const turn = this.point(sessionId, runId)
    const users = new Map(
      this.conversation.turnItems(sessionId, runId).flatMap((item) => (item.kind === "user" ? [[item.inputId, item.text] as const] : [])),
    )
    const texts = text === undefined ? turn.userMessageIds.map((id) => users.get(id) ?? "") : [text]
    this.commit(sessionId, (append) => {
      this.store.removeFrom(sessionId, turn)
      append({ type: "SESSION_REWOUND", runId: turn.runId, firstRemovedSeq: turn.firstSeq })
      this.conversation.addWaiting(sessionId, { kind: "notification", component: rewindComponent() }, this.now())
      for (const message of texts) {
        const inputId = crypto.randomUUID()
        this.conversation.addWaiting(sessionId, { kind: "user", inputId, text: message, mode: "steer", sender }, this.now())
        append({ type: "INPUT_WAITING", inputId, text: message, mode: "steer", sender })
      }
    })
    this.startNext(sessionId)
  }

  /** Stops taking input and interrupts every running turn; their turns stay running for `recover`. */
  async stop() {
    this.stopping = true
    const fibers = [...this.states.values()].flatMap((state) => (state.live === null ? [] : [state.live.fiber]))
    await Effect.runPromise(Fiber.interruptAll(fibers))
  }
}

export class Sessions extends Context.Service<Sessions, SessionHub>()("ashe-agent/sessions/Sessions") {
  /** The hub over the `Store` database, recovered and resuming waiting input before it serves. */
  static readonly layer = (
    options: HubOptions & {
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
            const hub = new SessionHub(new SessionStore(db, options.sessionsDir), options)
            hub.recover()
            hub.resumeWaiting()
            return hub
          }),
          (hub) => Effect.promise(() => hub.stop()),
        )
      }),
    )
}

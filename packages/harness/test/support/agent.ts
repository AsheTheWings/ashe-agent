import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Database } from "bun:sqlite"
import { AIMessageChunk, type AIMessageChunkFields, type BaseMessage } from "@langchain/core/messages"
import { convertMessagesToResponsesInput } from "@langchain/openai"
import { PERMISSION_ACTION, QUESTIONS_ACTION, type SessionEvent } from "@ashe-agent/protocol"
import { Effect, Schema } from "effect"
import type { ModelCall, ModelPort } from "../../src/agent/model.ts"
import { agentRunner } from "../../src/agent/runner.ts"
import { builtinTool, type Tool, type ToolClock } from "../../src/agent/tools.ts"
import type { AuxiliaryModels, ModelOverrides, Permission } from "../../src/inputs/shapes.ts"
import type { ConfiguredModel } from "../../src/models/registry.ts"
import { permissionPath } from "../../src/permissions/paths.ts"
import { SessionHub, type SessionSetup } from "../../src/sessions/hub.ts"
import { noAgents } from "../../src/sessions/setup.ts"
import { removeTree, SessionFiles } from "../../src/sessions/files.ts"
import { SessionStore } from "../../src/sessions/store.ts"
import { openDatabase } from "../../src/store/database.ts"
import { migrationFiles } from "../../src/store/migration-files.ts"
import { applyMigrations, discoverMigrations } from "../../src/store/migrations.ts"
import { waitFor } from "./cli.ts"
import type { Connection } from "../../src/server/websocket.ts"

/** A configured model of the provider its id names, taking text only and no settings unless given. */
export const configuredModel = (
  id: string,
  options: {
    readonly contextLimit?: number
    readonly imageInput?: boolean
    readonly pdfInput?: boolean
    readonly temperatureCapable?: boolean
    readonly efforts?: ReadonlyArray<string>
    readonly settings?: ModelOverrides
  } = {},
): ConfiguredModel => ({
  id,
  provider: id.slice(0, id.indexOf("/")),
  upstream: id.slice(id.indexOf("/") + 1),
  name: id,
  contextLimit: options.contextLimit ?? 400_000,
  imageInput: options.imageInput ?? false,
  pdfInput: options.pdfInput ?? false,
  temperatureCapable: options.temperatureCapable ?? false,
  efforts: options.efforts ?? [],
  settings: options.settings ?? {},
})

export const agentModels: ReadonlyArray<ConfiguredModel> = [
  configuredModel("test/alpha", { contextLimit: 200_000 }),
  configuredModel("test/beta", { contextLimit: 200_000, imageInput: true }),
]

/** A controlled tool clock: timers fire only when a test advances it. */
export class ManualClock implements ToolClock {
  private time = 0
  private next = 0
  private readonly timers = new Map<number, { readonly at: number; readonly callback: () => void }>()

  now = () => this.time

  setTimeout = (callback: () => void, delayMs: number) => {
    const id = ++this.next
    this.timers.set(id, { at: this.time + Math.max(0, delayMs), callback })
    return id
  }

  clearTimeout = (handle: unknown) => {
    if (typeof handle === "number") this.timers.delete(handle)
  }

  async advance(ms: number) {
    this.time += ms
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.time)
        .sort((a, b) => a[1].at - b[1].at)
      const first = due[0]
      if (first === undefined) return
      this.timers.delete(first[0])
      first[1].callback()
      await Promise.resolve()
      await Promise.resolve()
    }
  }
}

/** One scripted model reply: the chunks a call streams. */
export type Reply = (call: ModelCall, signal: AbortSignal) => AsyncIterable<AIMessageChunk>

const chunk = (fields: AIMessageChunkFields) =>
  new AIMessageChunk({ response_metadata: { model_provider: "openai" }, ...fields })

// The declared field type omits usage, which streamed chunks carry.
const usageChunk = (inputTokens: number): AIMessageChunk =>
  new AIMessageChunk({
    content: [],
    response_metadata: { model_provider: "openai" },
    usage_metadata: { input_tokens: inputTokens, output_tokens: 1, total_tokens: inputTokens + 1 },
  } as unknown as AIMessageChunkFields)

/** A reply of text, optionally after reasoning carrying encrypted content, reporting `inputTokens`. */
export const say =
  (text: string, options: { reasoning?: string; inputTokens?: number } = {}): Reply =>
  async function* () {
    if (options.reasoning !== undefined) {
      yield chunk({
        content: [{ type: "reasoning", reasoning: options.reasoning, index: 0 }],
        additional_kwargs: { reasoning: { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: options.reasoning }], encrypted_content: "ENC" } },
      })
    }
    yield chunk({ content: [{ type: "text", text, index: 0 }] })
    yield usageChunk(options.inputTokens ?? 1_000)
  }

let callCount = 0

/** A reply calling tools, each given a unique id `call_<name>_<n>` unless it names one. */
export const callTools = (calls: ReadonlyArray<{ name: string; args: unknown; id?: string }>, options: { inputTokens?: number } = {}): Reply =>
  async function* () {
    for (const [index, call] of calls.entries()) {
      yield chunk({
        content: [],
        tool_call_chunks: [{ type: "tool_call_chunk", index, id: call.id ?? `call_${call.name}_${nextCall()}`, name: call.name, args: JSON.stringify(call.args) }],
      })
    }
    yield usageChunk(options.inputTokens ?? 1_000)
  }

const nextCall = () => (callCount += 1)

/** A reply that waits for `gate`, or fails when the call is aborted, then streams `then`. */
export const hold = (gate: Promise<void>, then: Reply = say("held")): Reply =>
  async function* (call, signal) {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) reject(signal.reason)
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      gate.then(resolve)
    })
    yield* then(call, signal)
  }

/** A reply whose call fails with `error`. */
export const failWith = (error: unknown): Reply =>
  async function* () {
    throw error
  }

/** A promise with its resolve function. */
export const gate = () => {
  let open = () => {}
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { promise, open }
}

/** A model port that answers each call with the next scripted reply and records every call. */
export class FakeModel implements ModelPort {
  readonly calls: Array<{ readonly call: ModelCall; readonly signal: AbortSignal }> = []
  private readonly replies: Array<Reply> = []

  /** Queues replies for the next calls. */
  next(...replies: ReadonlyArray<Reply>) {
    this.replies.push(...replies)
  }

  readonly stream = (call: ModelCall, signal: AbortSignal) => {
    this.calls.push({ call, signal })
    const reply = this.replies.shift()
    if (reply === undefined) throw new Error(`no scripted reply for call ${this.calls.length}`)
    return reply(call, signal)
  }

  last() {
    return this.calls.at(-1)!.call
  }
}

/** The text of a message's content. */
export const messageText = (message: BaseMessage): string =>
  typeof message.content === "string"
    ? message.content
    : message.content.map((part) => (typeof part === "object" && "text" in part ? String(part.text) : "")).join("")

/** A call's input as Responses API items, as the model port's provider receives it. */
export const responsesInput = (call: ModelCall) =>
  convertMessagesToResponsesInput({ messages: [...call.messages], zdrEnabled: true, model: call.model }) as Array<Record<string, any>>

/**
 * Test tools: `echo` returns its text; `wait` runs until the turn is aborted;
 * `refuse` is a plain reject; `touch` and `pair` authorize `edit` subjects.
 */
export const testTools = (): ReadonlyArray<Tool> => [
  builtinTool({
    name: "echo",
    permission: null,
    description: "Returns its text.",
    args: Schema.Struct({ text: Schema.String }),
    run: async ({ text }) => ({ outcome: "success", content: `echoed ${text}` }),
  }),
  builtinTool({
    name: "wait",
    permission: null,
    description: "Runs until the turn ends.",
    args: Schema.Struct({}),
    run: (_, run) =>
      new Promise((_resolve, reject) => run.signal.addEventListener("abort", () => reject(run.signal.reason), { once: true })),
  }),
  builtinTool({
    name: "refuse",
    permission: null,
    description: "Declines as a plain reject.",
    args: Schema.Struct({}),
    run: async () => ({ outcome: "declined", content: "The user declined this tool call.", endTurn: true }),
  }),
  builtinTool({
    name: "touch",
    permission: "edit",
    description: "Asks the `edit` permission for its paths, resolved against the session directory.",
    args: Schema.Struct({ paths: Schema.Array(Schema.String) }),
    prepare: ({ paths }, run) => {
      const subjects = paths.map((path) => permissionPath(path, run.cwd))
      return { check: { permission: "edit", subjects, patterns: subjects }, plan: undefined }
    },
    run: async ({ paths }) => ({ outcome: "success", content: `touched ${paths.join(" ")}` }),
  }),
  builtinTool({
    name: "pair",
    permission: "edit",
    description: "Asks the `edit` permission for two subjects at once, as a program's parallel calls would.",
    args: Schema.Struct({ a: Schema.String, b: Schema.String }),
    run: async ({ a, b }, run) => {
      const settled = await Promise.allSettled(
        [a, b].map((subject) => run.authorize({ permission: "edit", subjects: [subject], patterns: [subject] })),
      )
      const report = settled.map((entry, index) =>
        `${[a, b][index]}: ${entry.status === "fulfilled" ? "allowed" : (entry.reason as Error).message}`,
      )
      return { outcome: "success", content: report.join(", ") }
    },
  }),
]

/** A session hub over a run-owned database file, running the agent loop on a fake model. */
export class AgentHarness {
  readonly dir = mkdtempSync(join(tmpdir(), "ashe-agent-component-"))
  readonly db: Database
  readonly model = new FakeModel()
  hub: SessionHub
  readonly sender = { kind: "login" as const, loginId: "component" }
  readonly files = new SessionFiles(join(this.dir, "sessions"), join(this.dir, "memory"), join(this.dir, "scratch"))
  private readonly attached = new Set<string>()
  private readonly clients = new Map<string, Connection>()
  private readonly actionBySubject = new Map<string, { actionId: string; sessionId: string; name: string }>()
  private clientSequence = 0

  constructor(
    readonly options: {
      readonly tools?: ReadonlyArray<Tool> | (() => ReadonlyArray<Tool>)
      readonly setup?: SessionSetup
      readonly models?: ReadonlyArray<ConfiguredModel>
    /** The model port; the fake model by default. */
    readonly port?: ModelPort
      /** The global permission rules; everything is allowed by default. */
      readonly permission?: Permission
      /** Runs after each turn's agent loop returns and before the turn ends. */
      readonly afterLoop?: (hub: SessionHub, sessionId: string) => void
      /** The user's time zone; UTC by default. */
      readonly userTimeZone?: string
      /** The clock; the system's by default. */
      readonly now?: () => number
      /** The model of each auxiliary task; the latest turn's model by default. */
      readonly auxiliaryModels?: AuxiliaryModels
      readonly communicationWaitMinMs?: number
      readonly communicationWaitDefaultMs?: number
      readonly communicationWaitMaxMs?: number
      readonly sqlite3Path?: string
      /** Attach a capable subscribed test connection to each created session; true by default. */
      readonly clientActions?: boolean
      /** Elapsed-time limits for tool invocations. */
      readonly toolPolicy?: import("../../src/agent/tools.ts").ToolExecutionPolicy
    } = {},
  ) {
    this.db = openDatabase(join(this.dir, "ashe-agent.db"))
    applyMigrations(this.db, discoverMigrations(migrationFiles))
    this.hub = this.makeHub()
  }

  private makeHub() {
    const models = this.options.models ?? agentModels
    const runner = agentRunner({ port: this.options.port ?? this.model, models })
    const tools = this.options.tools ?? testTools()
    const afterLoop = this.options.afterLoop
    const hub: SessionHub = new SessionHub(new SessionStore(this.db, join(this.dir, "sessions")), {
      files: this.files,
      models,
      port: this.options.port ?? this.model,
      ...(this.options.auxiliaryModels === undefined ? {} : { auxiliaryModels: this.options.auxiliaryModels }),
      defaultModel: models[0]!.id,
      setup: this.options.setup ?? noAgents,
      tools: typeof tools === "function" ? tools : () => tools,
      ...(this.options.permission === undefined ? {} : { permission: this.options.permission }),
      ...(this.options.userTimeZone === undefined ? {} : { userTimeZone: this.options.userTimeZone }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      ...(this.options.toolPolicy === undefined ? {} : { toolPolicy: this.options.toolPolicy }),
      ...(this.options.communicationWaitMinMs === undefined ? {} : { communicationWaitMinMs: this.options.communicationWaitMinMs }),
      ...(this.options.communicationWaitDefaultMs === undefined ? {} : { communicationWaitDefaultMs: this.options.communicationWaitDefaultMs }),
      ...(this.options.communicationWaitMaxMs === undefined ? {} : { communicationWaitMaxMs: this.options.communicationWaitMaxMs }),
      ...(this.options.sqlite3Path === undefined ? {} : { sqlite3Path: this.options.sqlite3Path }),
      databasePath: join(this.dir, "ashe-agent.db"),
      serverTimeZone: "UTC",
      home: realpathSync(this.dir),
      runner:
        afterLoop === undefined
          ? runner
          : (context) => Effect.tap(runner(context), () => Effect.sync(() => afterLoop(hub, context.session.id))),
    })
    this.hub = hub
    hub.start()
    this.actionBySubject.clear()
    if (this.options.clientActions !== false) for (const sessionId of this.attached) this.attachClient(sessionId)
    return hub
  }

  /** Attaches a connected client that supports questions and permissions and subscribes to `sessionId`. */
  attachClient(sessionId: string) {
    this.attached.add(sessionId)
    const connection: Connection = { id: `test-client-${++this.clientSequence}`, principal: this.sender, authenticating: false, deadline: null }
    const send = (message: unknown) => {
      const notice = message as { method?: string; params?: { actionId?: string; sessionId?: string; name?: string; arguments?: unknown } }
      if (notice.method !== "action.execute" || notice.params === undefined) return
      const { actionId, sessionId: owner, name, arguments: args } = notice.params
      if (actionId === undefined || owner === undefined || name === undefined || typeof args !== "object" || args === null) return
      const value = args as Record<string, unknown>
      const subject = name === QUESTIONS_ACTION ? value.questionSetId : name === PERMISSION_ACTION ? value.requestId : undefined
      if (typeof subject === "string") this.actionBySubject.set(`${owner}:${name}:${subject}`, { actionId, sessionId: owner, name })
    }
    this.hub.actions.setCapabilities(connection, this.sender, [QUESTIONS_ACTION, PERMISSION_ACTION], send)
    this.hub.actions.subscribed(connection, this.sender, sessionId, send)
    this.clients.set(sessionId, connection)
  }

  /** Withdraws the attached test connection's action support without disconnecting or unsubscribing it. */
  withdrawActionSupport(sessionId: string) {
    const connection = this.clients.get(sessionId)
    if (connection === undefined) throw new Error(`no attached client for ${sessionId}`)
    this.hub.actions.setCapabilities(connection, this.sender, [], () => {})
  }

  /** Stops the hub as a server stop would and starts a new one on the same database. */
  async restart() {
    await this.hub.stop()
    this.hub = this.makeHub()
  }

  create(params: { model?: string | null; agent?: string; reasoningEffort?: string | null } = {}) {
    const id = this.hub.create(params).id
    if (this.options.clientActions !== false) this.attachClient(id)
    return id
  }

  /** The directory of the session `id`, its starting working directory. */
  sessionDir(id: string) {
    return this.hub.store.sessionDir(id)
  }

  input(sessionId: string, text: string, mode?: "steer" | "queue") {
    return this.hub.input(sessionId, text, mode, this.sender)
  }

  answer(sessionId: string, requestId: string, answer: "once" | "always" | "reject", message?: string) {
    const action = this.actionBySubject.get(`${sessionId}:${PERMISSION_ACTION}:${requestId}`)
    const connection = this.clients.get(sessionId)
    if (action === undefined || connection === undefined) {
      this.hub.answer(sessionId, requestId, answer, message, this.sender)
      return
    }
    this.actionBySubject.delete(`${sessionId}:${PERMISSION_ACTION}:${requestId}`)
    this.hub.actions.complete(connection.id, sessionId, action.actionId, message === undefined ? { answer } : { answer, message })
  }

  /** The live assignment of a permission request, for exercising broker result validation. */
  permissionAssignment(sessionId: string, requestId: string) {
    const action = this.actionBySubject.get(`${sessionId}:${PERMISSION_ACTION}:${requestId}`)
    const connection = this.clients.get(sessionId)
    if (action === undefined || connection === undefined) throw new Error(`no assigned permission action for ${requestId}`)
    return { actionId: action.actionId, connectionId: connection.id }
  }

  answerQuestion(
    sessionId: string,
    questionSetId: string,
    answers: ReadonlyArray<{ readonly id: string; readonly selection?: string; readonly note?: string }>,
  ) {
    const action = this.actionBySubject.get(`${sessionId}:${QUESTIONS_ACTION}:${questionSetId}`)
    const connection = this.clients.get(sessionId)
    if (action === undefined || connection === undefined) throw new Error(`no assigned question action for ${questionSetId}`)
    this.actionBySubject.delete(`${sessionId}:${QUESTIONS_ACTION}:${questionSetId}`)
    this.hub.actions.complete(connection.id, sessionId, action.actionId, { kind: "answered", answers })
  }

  replyQuestionByMessage(sessionId: string, questionSetId: string) {
    const action = this.actionBySubject.get(`${sessionId}:${QUESTIONS_ACTION}:${questionSetId}`)
    const connection = this.clients.get(sessionId)
    if (action === undefined || connection === undefined) throw new Error(`no assigned question action for ${questionSetId}`)
    this.actionBySubject.delete(`${sessionId}:${QUESTIONS_ACTION}:${questionSetId}`)
    this.hub.actions.complete(connection.id, sessionId, action.actionId, { kind: "repliedByMessage" })
  }

  events(sessionId: string): ReadonlyArray<SessionEvent> {
    return this.hub.store.eventsAfter(sessionId, 0)
  }

  types(sessionId: string) {
    return this.events(sessionId).map((event) => event.event.type)
  }

  /** Waits until the session's turns, counted by their end events, reach `count`. */
  async turnsEnded(sessionId: string, count: number) {
    await waitFor(
      `${count} ended turns`,
      () => (this.types(sessionId).filter((type) => type === "RUN_FINISHED" || type === "RUN_ERROR").length >= count && !this.hub.isRunning(sessionId) ? true : undefined),
      10_000,
    )
  }

  async calls(count: number) {
    await waitFor(`${count} model calls`, () => (this.model.calls.length >= count ? true : undefined), 10_000)
  }

  async cleanup() {
    await this.hub.stop()
    this.db.close()
    // Memory generations are read-only, which a plain recursive removal cannot delete.
    removeTree(this.dir)
  }
}

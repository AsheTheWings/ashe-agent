import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Database } from "bun:sqlite"
import { AIMessageChunk, type AIMessageChunkFields, type BaseMessage } from "@langchain/core/messages"
import { convertMessagesToResponsesInput } from "@langchain/openai"
import type { SessionEvent } from "@ashe-agent/protocol"
import { Effect, Schema } from "effect"
import type { ModelCall, ModelPort } from "../../src/agent/model.ts"
import { agentRunner } from "../../src/agent/runner.ts"
import { builtinTool, type Tool } from "../../src/agent/tools.ts"
import type { ModelOverrides, Permission } from "../../src/inputs/shapes.ts"
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

/** A configured model of the provider its id names, taking text only and no settings unless given. */
export const configuredModel = (
  id: string,
  options: {
    readonly contextLimit?: number
    readonly imageInput?: boolean
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
  temperatureCapable: options.temperatureCapable ?? false,
  efforts: options.efforts ?? [],
  settings: options.settings ?? {},
})

export const agentModels: ReadonlyArray<ConfiguredModel> = [
  configuredModel("test/alpha", { contextLimit: 200_000 }),
  configuredModel("test/beta", { contextLimit: 200_000, imageInput: true }),
]

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
      defaultModel: models[0]!.id,
      setup: this.options.setup ?? noAgents,
      tools: typeof tools === "function" ? tools : () => tools,
      ...(this.options.permission === undefined ? {} : { permission: this.options.permission }),
      ...(this.options.userTimeZone === undefined ? {} : { userTimeZone: this.options.userTimeZone }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      serverTimeZone: "UTC",
      home: realpathSync(this.dir),
      runner:
        afterLoop === undefined
          ? runner
          : (context) => Effect.tap(runner(context), () => Effect.sync(() => afterLoop(hub, context.session.id))),
    })
    hub.start()
    return hub
  }

  /** Stops the hub as a server stop would and starts a new one on the same database. */
  async restart() {
    await this.hub.stop()
    this.hub = this.makeHub()
  }

  create(params: { model?: string; agent?: string; reasoningEffort?: string } = {}) {
    return this.hub.create(params).id
  }

  /** The directory of the session `id`, its starting working directory. */
  sessionDir(id: string) {
    return this.hub.store.sessionDir(id)
  }

  input(sessionId: string, text: string, mode?: "steer" | "queue") {
    return this.hub.input(sessionId, text, mode, this.sender)
  }

  answer(sessionId: string, requestId: string, answer: "once" | "always" | "reject", message?: string) {
    this.hub.answer(sessionId, requestId, answer, message, this.sender)
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

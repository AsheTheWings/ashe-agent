import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Exit, Layer, ManagedRuntime, Redacted } from "effect"
import { createApiToken } from "../../src/auth/credentials.ts"
import type { AuxiliaryModels, Permission } from "../../src/inputs/shapes.ts"
import { ProtocolServer } from "../../src/server/serve.ts"
import type { ModelPort } from "../../src/agent/model.ts"
import type { Tool } from "../../src/agent/tools.ts"
import type { ConfiguredModel } from "../../src/models/registry.ts"
import { Sessions, type SessionSetup, type TurnRunner } from "../../src/sessions/hub.ts"
import { noAgents } from "../../src/sessions/setup.ts"
import { openDatabase, Store } from "../../src/store/database.ts"
import { migrationFiles } from "../../src/store/migration-files.ts"
import { applyMigrations, discoverMigrations } from "../../src/store/migrations.ts"
import { removeTree } from "../../src/sessions/files.ts"
import { configuredModel } from "./agent.ts"
import { Client, waitFor } from "./cli.ts"

/** The model port of servers whose turns a script runs: no auxiliary call reaches a model. */
const noAuxiliaryModel: ModelPort = {
  stream: () => {
    throw new Error("no model serves auxiliary calls in this test")
  },
}

export const models = [
  configuredModel("test/first", { contextLimit: 400_000, efforts: ["low", "high"], settings: { reasoningEffort: "low" } }),
  configuredModel("test/second", { contextLimit: 300_000, imageInput: true }),
]

/** Composition choices for a server that runs something besides the scripted fake runner. */
export type TestServerOptions = {
  readonly dir?: string
  readonly models?: ReadonlyArray<ConfiguredModel>
  readonly setup?: SessionSetup
  readonly runner?: TurnRunner
  readonly modelPort?: ModelPort
  readonly auxiliaryModels?: AuxiliaryModels
  readonly tools?: () => ReadonlyArray<Tool>
  readonly communicationWaitMinMs?: number
  readonly communicationWaitDefaultMs?: number
  readonly communicationWaitMaxMs?: number
  readonly sqlite3Path?: string
}

/**
 * A scripted turn runner. Each turn echoes its input as one assistant
 * message, then, while its gate is closed, takes steered inputs at each
 * step boundary, echoing them. `release(text)` opens the gate of the turn
 * whose input is `text`, which then finishes; turns whose input starts
 * with "fail" fail, and a turn whose input is "ask <command>" first
 * authorizes `<command>` under the `shell` permission, granting it as its
 * own pattern, and says "permission: allowed" or the reason it may not
 * run. A turn whose input starts with "hold" passes
 * its last step boundary, is listed in `pastLastBoundary`, and finishes
 * only on `release(text + " end")`.
 */
export class ScriptedRunner {
  private readonly gates = new Map<string, Deferred.Deferred<void>>()
  started: Array<string> = []
  readonly pastLastBoundary = new Set<string>()

  private gate(text: string) {
    let gate = this.gates.get(text)
    if (gate === undefined) {
      gate = Deferred.makeUnsafe<void>()
      this.gates.set(text, gate)
    }
    return gate
  }

  release(text: string) {
    Deferred.doneUnsafe(this.gate(text), Exit.void)
  }

  readonly runner: TurnRunner = (context) => {
    const self = this
    const input = () => context.window().items.find((item) => item.kind === "user" && item.runId === context.turn.runId)
    return Effect.gen(function* () {
      if (context.turn.model === null) {
        return { status: "failed" as const, message: "the session has no model selected", code: "model_unavailable" }
      }
      const first = input()
      const text = first?.kind === "user" ? first.text : ""
      self.started.push(text)
      const say = (message: string) => {
        const modelCallId = crypto.randomUUID()
        const messageId = crypto.randomUUID()
        context.emit({ type: "MODEL_CALL_STARTED", runId: context.turn.runId, modelCallId, ordinal: 1 })
        context.emit({ type: "TEXT_MESSAGE_START", modelCallId, messageId, role: "assistant" })
        context.emit({ type: "TEXT_MESSAGE_CONTENT", modelCallId, messageId, delta: message })
        context.emit({ type: "TEXT_MESSAGE_END", modelCallId, messageId })
        context.emit({
          type: "MODEL_CALL_COMMITTED",
          runId: context.turn.runId,
          modelCallId,
          inputBoundaryId: crypto.randomUUID(),
        })
      }
      say(`echo: ${text}`)
      if (text.startsWith("fail")) return { status: "failed" as const, message: "scripted failure" }
      if (text.startsWith("ask")) {
        const command = text.slice("ask".length).trim()
        const outcome = yield* Effect.tryPromise({
          try: (signal) =>
            context.authorize(crypto.randomUUID(), { permission: "shell", subjects: [command], patterns: [command] }, signal),
          catch: (error) => error as Error,
        }).pipe(Effect.match({ onSuccess: () => "allowed", onFailure: (error) => error.message }))
        say(`permission: ${outcome}`)
      }
      const gate = self.gate(text)
      for (;;) {
        if (context.deliver()) return { status: "finished" as const }
        if (yield* Deferred.isDone(gate)) break
        yield* Effect.sleep("10 millis")
      }
      if (text.startsWith("hold")) {
        self.pastLastBoundary.add(text)
        yield* Deferred.await(self.gate(`${text} end`))
      }
      return { status: "finished" as const }
    })
  }
}

/** A server running in this process on a run-owned database file, restartable on the same file. */
export class TestServer {
  readonly dir: string
  readonly origins = ["http://allowed.test"]
  readonly databasePath: string
  readonly sessionsDir: string
  readonly memoryDir: string
  readonly scratchRoot: string
  readonly script = new ScriptedRunner()
  private runtime: ManagedRuntime.ManagedRuntime<ProtocolServer | Sessions | Store, never> | null = null
  url = ""

  /** `permission` gives the global rules; by default every `shell` call asks. */
  constructor(
    readonly permission: Permission = { shell: "ask" },
    readonly options: TestServerOptions = {},
  ) {
    this.dir = options.dir ?? mkdtempSync(join(tmpdir(), "ashe-agent-server-"))
    this.databasePath = join(this.dir, "ashe-agent.db")
    this.sessionsDir = join(this.dir, "sessions")
    this.memoryDir = join(this.dir, "memory")
    this.scratchRoot = join(this.dir, "scratch")
    const db = openDatabase(this.databasePath)
    applyMigrations(db, discoverMigrations(migrationFiles))
    db.close()
  }

  /** Creates an API token named `name` and returns it. */
  token(name: string): string {
    const db = openDatabase(this.databasePath)
    try {
      const result = createApiToken(db, name, Date.now())
      if (!result.ok) throw new Error(result.reason)
      return result.token
    } finally {
      db.close()
    }
  }

  async start() {
    const layer = ProtocolServer.layer({ hostname: "127.0.0.1", port: 0, origins: this.origins, github: { clientId: "test", clientSecret: Redacted.make("synthetic"), callbackUrl: "http://127.0.0.1/callback", ownerId: 42, githubUrl: "http://127.0.0.1:9", githubApiUrl: "http://127.0.0.1:9" } }).pipe(
      Layer.provideMerge(
        Sessions.layer({
          models: this.options.models ?? models,
          defaultModel: (this.options.models ?? models)[0]!.id,
          runner: this.options.runner ?? this.script.runner,
          port: this.options.modelPort ?? noAuxiliaryModel,
          setup: this.options.setup ?? noAgents,
          ...(this.options.auxiliaryModels === undefined ? {} : { auxiliaryModels: this.options.auxiliaryModels }),
          databasePath: this.databasePath,
          sqlite3Path: this.options.sqlite3Path ?? "/usr/bin/sqlite3",
          ...(this.options.tools === undefined ? {} : { tools: this.options.tools }),
          ...(this.options.communicationWaitMinMs === undefined ? {} : { communicationWaitMinMs: this.options.communicationWaitMinMs }),
          ...(this.options.communicationWaitDefaultMs === undefined ? {} : { communicationWaitDefaultMs: this.options.communicationWaitDefaultMs }),
          ...(this.options.communicationWaitMaxMs === undefined ? {} : { communicationWaitMaxMs: this.options.communicationWaitMaxMs }),
          permission: this.permission,
          home: this.dir,
          sessionsDir: this.sessionsDir,
          memoryDir: this.memoryDir,
          scratchRoot: this.scratchRoot,
        }),
      ),
      Layer.provideMerge(Store.layer(this.databasePath)),
    )
    this.runtime = ManagedRuntime.make(layer)
    this.url = (await this.runtime.runPromise(ProtocolServer)).url
    return this
  }

  hub() {
    return this.runtime!.runPromise(Sessions)
  }

  async stop() {
    await this.runtime?.dispose()
    this.runtime = null
  }

  async restart() {
    await this.stop()
    return await this.start()
  }

  async cleanup() {
    await this.stop()
    // Memory generations are read-only, which a plain recursive removal cannot delete.
    removeTree(this.dir)
  }
}

/** A client that tracks one session's events as the session client would, applying rewinds. */
export class SessionView {
  events: Array<any> = []
  lastSeq = 0
  readonly actions = new Map<string, { readonly name: string; readonly arguments: any }>()
  readonly actionExecutions: Array<{ readonly actionId: string; readonly name: string; readonly arguments: any }> = []
  private constructor(
    readonly client: Client,
    readonly sessionId: string,
  ) {}

  static async open(url: string, token: string, sessionId: string, afterSeq = 0) {
    const client = await Client.connect(url)
    const auth = await client.request("auth.authenticate", { token, protocolVersion: 1 })
    if (auth.error !== undefined) throw new Error(auth.error.message)
    const view = new SessionView(client, sessionId)
    view.lastSeq = afterSeq
    client.onNotification = (message) => view.apply(message.params)
    client.onActionExecute = (params) => {
      view.actionExecutions.push(params)
      view.actions.set(params.actionId, { name: params.name, arguments: params.arguments })
    }
    client.onActionCancel = (params) => void view.actions.delete(params.actionId)
    const declared = await client.request("actions.list")
    if (declared.error !== undefined) throw new Error(declared.error.message)
    const supported = declared.result.actions.map((action: { name: string }) => action.name)
    const registered = await client.request("client.setActions", { actions: supported })
    if (registered.error !== undefined) throw new Error(registered.error.message)
    const subscribed = await client.request("session.subscribe", { sessionId, ...(afterSeq > 0 ? { afterSeq } : {}) })
    if (subscribed.error !== undefined) throw new Error(subscribed.error.message)
    return view
  }

  /** Every seq received, in order, including those later dropped by a rewind. */
  readonly received: Array<number> = []

  private apply(event: any) {
    if (event.sessionId !== this.sessionId) return
    this.received.push(event.seq)
    if (event.event.type === "SESSION_REWOUND") {
      this.events = this.events.filter((kept) => kept.seq < event.event.firstRemovedSeq)
    }
    this.events.push(event)
    this.lastSeq = event.seq
  }

  types() {
    return this.events.map((event) => event.event.type)
  }

  async executeAction(actionId: string, result: unknown) {
    const response = await this.client.request("action.complete", { sessionId: this.sessionId, actionId, result })
    if (response.error !== undefined) throw new Error(response.error.message)
    this.actions.delete(actionId)
    return response.result
  }

  async answerPermission(requestId: string, answer: "once" | "always" | "reject", message?: string) {
    const entry = [...this.actions.entries()].find(
      ([, action]) => action.name === "permission.decide" && action.arguments.requestId === requestId,
    )
    if (entry === undefined) throw new Error(`no assigned permission action for ${requestId}`)
    return await this.executeAction(entry[0], message === undefined ? { answer } : { answer, message })
  }

  async answerQuestion(questionSetId: string, answers: ReadonlyArray<Record<string, unknown>>) {
    const entry = [...this.actions.entries()].find(
      ([, action]) => action.name === "questions.answer" && action.arguments.questionSetId === questionSetId,
    )
    if (entry === undefined) throw new Error(`no assigned question action for ${questionSetId}`)
    return await this.executeAction(entry[0], { kind: "answered", answers })
  }

  texts() {
    return this.events.filter((event) => event.event.type === "TEXT_MESSAGE_CONTENT").map((event) => event.event.delta)
  }

  async waitFor(what: string, predicate: (view: SessionView) => boolean, timeoutMs = 10_000) {
    await waitFor(what, () => (predicate(this) ? true : undefined), timeoutMs)
  }
}

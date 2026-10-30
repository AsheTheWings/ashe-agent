import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Exit, Layer, ManagedRuntime } from "effect"
import type { Model } from "@ashe-agent/protocol"
import { createApiToken } from "../../src/auth/credentials.ts"
import { ProtocolServer } from "../../src/server/serve.ts"
import { Sessions, type TurnRunner } from "../../src/sessions/hub.ts"
import { noAgents } from "../../src/sessions/placeholder.ts"
import { openDatabase, Store } from "../../src/store/database.ts"
import { migrationFiles } from "../../src/store/migration-files.ts"
import { applyMigrations, discoverMigrations } from "../../src/store/migrations.ts"
import { Client, waitFor } from "./cli.ts"

export const models: ReadonlyArray<Model> = [
  { id: "test/first", contextWindow: 400_000, imageInput: false },
  { id: "test/second", contextWindow: 200_000, imageInput: true },
]

/**
 * A scripted turn runner. Each turn echoes its input as one assistant
 * message, then, while its gate is closed, takes steered inputs at each
 * step boundary, echoing them. `release(text)` opens the gate of the turn
 * whose input is `text`, which then finishes; turns whose input starts
 * with "fail" fail, and inputs starting with "ask" emit a permission
 * request before waiting. A turn whose input starts with "hold" passes
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
    return Effect.gen(function* () {
      const text = context.input.text
      self.started.push(text)
      const say = (message: string) => {
        const messageId = crypto.randomUUID()
        context.emit({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" })
        context.emit({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: message })
        context.emit({ type: "TEXT_MESSAGE_END", messageId })
      }
      say(`echo: ${text}`)
      if (text.startsWith("fail")) return { status: "failed" as const, message: "scripted failure" }
      if (text.startsWith("ask")) {
        context.emit({
          type: "PERMISSION_REQUESTED",
          requestId: crypto.randomUUID(),
          runId: context.turn.runId,
          toolCallId: crypto.randomUUID(),
          permission: "shell",
          subjects: ["ls"],
          patterns: ["ls *"],
        })
      }
      const gate = self.gate(text)
      for (;;) {
        for (const steered of context.takeSteered()) say(`steered: ${steered.text}`)
        if (yield* Deferred.isDone(gate)) break
        yield* Effect.sleep("10 millis")
      }
      for (const steered of context.takeSteered()) say(`steered: ${steered.text}`)
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
  readonly dir = mkdtempSync(join(tmpdir(), "ashe-agent-server-"))
  readonly databasePath = join(this.dir, "ashe-agent.db")
  readonly script = new ScriptedRunner()
  private runtime: ManagedRuntime.ManagedRuntime<ProtocolServer | Sessions | Store, never> | null = null
  url = ""

  constructor() {
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
    const layer = ProtocolServer.layer({ hostname: "127.0.0.1", port: 0, origins: [] }).pipe(
      Layer.provideMerge(Sessions.layer({ models, runner: this.script.runner, setup: noAgents })),
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
    rmSync(this.dir, { recursive: true, force: true })
  }
}

/** A client that tracks one session's events as the session client would, applying rewinds. */
export class SessionView {
  events: Array<any> = []
  lastSeq = 0
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

  texts() {
    return this.events.filter((event) => event.event.type === "TEXT_MESSAGE_CONTENT").map((event) => event.event.delta)
  }

  async waitFor(what: string, predicate: (view: SessionView) => boolean, timeoutMs = 10_000) {
    await waitFor(what, () => (predicate(this) ? true : undefined), timeoutMs)
  }
}

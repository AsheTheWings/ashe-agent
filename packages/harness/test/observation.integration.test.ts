import { describe, expect, test } from "bun:test"
import { copyFileSync, mkdtempSync } from "node:fs"
import { Database } from "bun:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { harnessIdentity } from "../src/store/identity.ts"
import { ModelCallError } from "../src/agent/model.ts"
import { agentRunner } from "../src/agent/runner.ts"
import { Client, inspectHistory, waitFor } from "./support/cli.ts"
import { failWith, FakeModel, gate, hold, say, testTools } from "./support/agent.ts"
import { models, SessionView, TestServer } from "./support/server.ts"

const connect = async (url: string, token: string) => {
  const client = await Client.connect(url)
  const auth = await client.request("auth.authenticate", { token, protocolVersion: 1 })
  if (auth.error !== undefined) throw new Error(auth.error.message)
  return client
}

const createSession = async (client: Client) => {
  const response = await client.request("session.create", {})
  if (response.error !== undefined) throw new Error(response.error.message)
  return response.result.session.id as string
}

/** The user inputs still waiting after the events through `cursor`. */
const expectedPending = (events: ReadonlyArray<{ seq: number; event: { type: string } & Record<string, any> }>, cursor: number) => {
  const waiting = new Set<string>()
  for (const entry of events) {
    if (entry.seq > cursor) break
    if (entry.event.type === "INPUT_WAITING") waiting.add(entry.event.inputId)
    if (entry.event.type === "INPUT_RECEIVED") waiting.delete(entry.event.inputId)
    if (entry.event.type === "SESSION_REWOUND") {
      waiting.clear()
    }
  }
  return [...waiting]
}

describe("harness identity and owner observation", () => {
  test("harnessId survives restart and a database copy but differs for a fresh database", async () => {
    const server = new TestServer()
    const token = server.token("identity")
    try {
      await server.start()
      await connect(server.url, token)
      const first = (await fetchIdentity(server, token)) as string
      const revokedToken = server.token("revoked")
      const revokedObserveToken = server.token("revoked-observe")
      const revoked = await connect(server.url, revokedToken)
      const revokedObserve = await connect(server.url, revokedObserveToken)
      const liveDb = new Database(server.databasePath)
      liveDb.run("UPDATE api_tokens SET revoked_at = 1 WHERE name IN ('revoked', 'revoked-observe')")
      liveDb.close()
      expect((await revoked.request("session.input.receipt", { sessionId: "any", submissionId: "any" })).error.code)
        .toBe(-32001)
      expect((await revokedObserve.request("session.observe", { sessionId: "any" })).error.code).toBe(-32001)
      expect((await revoked.waitClosed()).code).toBe(1008)
      expect((await revokedObserve.waitClosed()).code).toBe(1008)

      const unauthenticated = await Client.connect(server.url)
      expect((await unauthenticated.request("session.observe", { sessionId: "any" })).error.code).toBe(-32001)
      await unauthenticated.waitClosed()
      const unauthenticatedReceipt = await Client.connect(server.url)
      expect((await unauthenticatedReceipt.request("session.input.receipt", { sessionId: "any", submissionId: "any" })).error.code)
        .toBe(-32001)
      await unauthenticatedReceipt.waitClosed()
      await server.restart()
      expect(await fetchIdentity(server, token)).toBe(first)

      await server.stop()
      const copyDir = mkdtempSync(join(tmpdir(), "ashe-agent-identity-copy-"))
      copyFileSync(server.databasePath, join(copyDir, "ashe-agent.db"))
      const restored = new TestServer({ shell: "ask" }, { dir: copyDir })
      expect(identityOf(restored.databasePath)).toBe(first)

      const freshDir = mkdtempSync(join(tmpdir(), "ashe-agent-identity-fresh-"))
      const fresh = new TestServer({ shell: "ask" }, { dir: freshDir })
      expect(identityOf(fresh.databasePath)).not.toBe(first)
    } finally {
      await server.cleanup()
    }
  }, 30_000)

  test("observation reports ordered pending input and coordinated eligibility", async () => {
    const server = new TestServer()
    const token = server.token("observe")
    try {
      await server.start()
      const client = await connect(server.url, token)
      const sessionId = await createSession(client)
      const view = await SessionView.open(server.url, token, sessionId)
      const initial = await client.request("session.observe", { sessionId })
      expect(initial.result).toMatchObject({
        sessionId,
        pending: [],
        execution: { activeTurnId: null, activity: "idle", canRewind: false, canFork: false, restorePending: false },
      })
      expect(initial.result.cursor).toBeGreaterThan(0)

      await client.request("session.input", { sessionId, text: "hold observation" })
      const [queuedSent, ...concurrent] = await Promise.all([
        client.request("session.input", {
          sessionId,
          text: "queued",
          mode: "queue",
          selection: { modelSettings: { reasoningEffort: null } },
        }),
        client.request("session.observe", { sessionId }),
        client.request("session.observe", { sessionId }),
        client.request("session.observe", { sessionId }),
      ])
      expect(queuedSent.error).toBeUndefined()
      for (const snapshot of concurrent) {
        expect(snapshot.result.execution).toMatchObject({ activity: "working", canResume: false })
        expect(snapshot.result.execution.activeTurnId).toBeString()
      }
      const observed = await client.request("session.observe", { sessionId })
      expect(observed.result.pending).toHaveLength(1)
      expect(observed.result.pending[0]).toMatchObject({ kind: "user", text: "queued", mode: "queue" })
      expect(observed.result.pending[0].selection).toEqual({ modelSettings: { reasoningEffort: null } })
      expect(observed.result.pending[0].attachments).toEqual([])
      expect(observed.result.execution).toMatchObject({ activity: "working", canRewind: true, canFork: false })
      expect(observed.result.execution.activeTurnId).toBeString()
      await waitFor("the subscription cursor", () =>
        view.events.at(-1)!.seq >= observed.result.cursor ? true : undefined,
      )
      expect(view.events.at(-1)!.seq).toBe(observed.result.cursor)
      expect(observed.result.pending.filter((entry: { kind: string }) => entry.kind === "user").map((entry: { inputId: string }) => entry.inputId))
        .toEqual(expectedPending(view.events, observed.result.cursor))

      server.script.release("hold observation")
      server.script.release("hold observation end")
      server.script.release("queued")
      await waitFor("the turn to end", async () =>
        (await client.request("session.observe", { sessionId })).result.execution.activeTurnId === null ? true : undefined,
      )
      const idle = await client.request("session.observe", { sessionId })
      expect(idle.result.execution).toMatchObject({ activity: "idle", canFork: true })
      await client.request("session.observe", { sessionId })
      await client.request("session.observe", { sessionId })
      expect((await server.hub()).store.lastEventSeq(sessionId)).toBe(idle.result.cursor)

      const developerSession = await createSession(client)
      const beforeResume = (await client.request("session.observe", { sessionId: developerSession })).result.cursor
      await client.request("session.resume", { sessionId: developerSession })
      const developerEvents = (await server.hub()).store.eventsAfter(developerSession, beforeResume)
      expect(developerEvents.some((event) => event.event.type === "OBSERVATION_CHANGED")).toBe(true)
      expect(developerEvents.some((event) => event.event.type === "RUN_STARTED")).toBe(true)
      server.script.release("")

      const restoreSession = await createSession(client)
      const restoredText = "restored research"
      const restoredDigest = new Bun.CryptoHasher("sha256").update(restoredText).digest("hex")
      const restoreDb = new Database(server.databasePath)
      restoreDb.run("INSERT INTO contents (sha256, data, format) VALUES (?, ?, 'text/plain')", [restoredDigest, Buffer.from(restoredText)])
      restoreDb.run("INSERT INTO pending_restores (session_id, created_at) VALUES (?, ?)", [restoreSession, Date.now()])
      restoreDb.run(
        "INSERT INTO pending_restore_files (session_id, area, name, sha256) VALUES (?, 'research', 'note.txt', ?)",
        [restoreSession, restoredDigest],
      )
      restoreDb.close()
      const pendingRestore = await client.request("session.observe", { sessionId: restoreSession })
      expect(pendingRestore.result.execution).toMatchObject({
        restorePending: true,
        canResume: false,
        canRewind: false,
        canFork: false,
      })
      await client.request("session.input", { sessionId: restoreSession, text: "hold restore" })
      const completedRestore = await client.request("session.observe", { sessionId: restoreSession })
      expect(completedRestore.result.execution.restorePending).toBe(false)
      const restoredDb = new Database(server.databasePath, { readonly: true })
      expect(restoredDb.query("SELECT count(*) AS n FROM pending_restores WHERE session_id = ?").get(restoreSession)).toEqual({ n: 0 })
      restoredDb.close()
      server.script.release("hold restore")
      server.script.release("hold restore end")

      const firstRun = view.events.find((event) => event.event.type === "RUN_STARTED")!.event.runId as string
      const scope = await inspectHistory(client, sessionId, firstRun)
      const revisionBefore = idle.result.revision
      await client.request("session.rewind", {
        sessionId,
        runId: firstRun,
        historyScope: scope.scope.token,
        operationId: crypto.randomUUID(),
      })
      const afterRewind = await client.request("session.observe", { sessionId })
      expect(afterRewind.result.revision).not.toBe(revisionBefore)
      expect(afterRewind.result.pending.some((entry: { kind: string; text?: string }) => entry.kind === "user" && entry.text === "queued"))
        .toBe(false)
      const rewoundSeq = view.events.find((event) => event.event.type === "SESSION_REWOUND")!.seq
      expect(afterRewind.result.cursor).toBeGreaterThanOrEqual(rewoundSeq)
      await waitFor("the rewind subscription", () =>
        view.events.at(-1)!.seq >= afterRewind.result.cursor ? true : undefined,
      )
      expect(afterRewind.result.pending.filter((entry: { kind: string }) => entry.kind === "user").map((entry: { inputId: string }) => entry.inputId))
        .toEqual(expectedPending(view.events, afterRewind.result.cursor))
      const runsBeforeObserving = view.events.filter((event) => event.event.type === "RUN_STARTED").length
      await client.request("session.observe", { sessionId })
      await client.request("session.observe", { sessionId })
      expect(view.events.filter((event) => event.event.type === "RUN_STARTED")).toHaveLength(runsBeforeObserving)
      server.script.release("hold observation")
      server.script.release("hold observation end")
    } finally {
      await server.cleanup()
    }
  }, 30_000)

  test("a live subscription and observation stay contiguous through a context transition", async () => {
    const model = new FakeModel()
    const server = new TestServer({ shell: "deny" }, {
      models,
      runner: agentRunner({ port: model, models }),
      modelPort: model,
      tools: testTools,
    })
    const token = server.token("observation-context")
    try {
      await server.start()
      const client = await connect(server.url, token)
      const sessionId = await createSession(client)
      const view = await SessionView.open(server.url, token, sessionId)
      const paused = gate()
      model.next(
        failWith(new ModelCallError("context_length_exceeded", true)),
        hold(paused.promise, say("context")),
        say("after"),
      )
      await client.request("session.input", { sessionId, text: "start context" })
      await view.waitFor("the context turn", (value) =>
        value.events.some((event) => event.event.type === "CONTEXT_TURN_STARTED"),
      )
      const during = await client.request("session.observe", { sessionId })
      expect(during.result.execution.contextWorkflowActive).toBe(true)
      expect(during.result.execution.activity).toBe("working")
      expect(during.result.execution.activeTurnId).toBeString()
      const sequences = view.events.map((event) => event.seq)
      expect(sequences).toEqual(sequences.map((_, index) => index + 1))
      expect(during.result.cursor).toBe(sequences.at(-1))
      const contextEvent = view.events.find((event) => event.event.type === "CONTEXT_TURN_STARTED")
      if (contextEvent === undefined || contextEvent.event.type !== "CONTEXT_TURN_STARTED") {
        throw new Error("the context turn did not start")
      }
      const contextRunId = contextEvent.event.runId
      paused.open()
      await view.waitFor("the context completion", (value) =>
        value.events.some((event) => event.event.type === "RUN_FINISHED" && event.event.runId === contextRunId),
      )
      const after = await client.request("session.observe", { sessionId })
      expect(after.result.execution.contextWorkflowActive).toBe(false)
    } finally {
      await server.cleanup()
    }
  }, 30_000)
})

const fetchIdentity = async (server: TestServer, token: string) => {
  const url = new URL(server.url)
  const response = await fetch(`http://${url.host}/v1/auth/identity`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { harnessId: string }).harnessId
}

const identityOf = (path: string) => {
  const db = new Database(path, { readonly: true, strict: true })
  try {
    return harnessIdentity(db)
  } finally {
    db.close()
  }
}

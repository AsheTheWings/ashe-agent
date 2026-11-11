import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { applyMigrations, discoverMigrations } from "../src/backend/migrations.ts"
import { WebObserver } from "../src/backend/observer.ts"
import { WebStore } from "../src/backend/store.ts"

const migrations = discoverMigrations(join(import.meta.dir, "../migrations"))
const waitFor = async (predicate: () => boolean, timeout = 3_000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("timed out")
}

describe("web observer", () => {
  test("discovers sessions without browsers, reconciles events, and sends no execution commands", async () => {
    const methods: Array<{ method: string; params: unknown }> = []
    const sockets = new Set<import("bun").ServerWebSocket<unknown>>()
    const fake = Bun.serve<unknown>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request, { data: {} })) return undefined
        return new Response("not found", { status: 404 })
      },
      websocket: {
        open(socket) { sockets.add(socket) },
        close(socket) { sockets.delete(socket) },
        message(socket, raw) {
          const request = JSON.parse(String(raw)) as { id: number; method: string; params: unknown }
          methods.push({ method: request.method, params: request.params })
          const respond = (result: unknown) => socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }))
          if (request.method === "auth.authenticate") respond({ principal: { kind: "token", tokenId: "obs", name: "observer" } })
          else if (request.method === "client.setActions") respond({})
          else if (request.method === "session.list") respond({
            sessions: [{
              id: "s1",
              sessionDir: "/tmp/s1",
              identity: { sessionId: "s1", agentTitle: "untitled", modelId: null },
              selection: { agentTitle: "untitled", modelSettings: { modelId: null, reasoningEffort: null } },
              activeSelection: null,
              activity: "idle",
              createdAt: 1,
              lastSeq: 0,
            }],
          })
          else if (request.method === "session.subscribe") {
            respond({
              session: {
                id: "s1",
                sessionDir: "/tmp/s1",
                identity: { sessionId: "s1", agentTitle: "untitled", modelId: null },
                selection: { agentTitle: "untitled", modelSettings: { modelId: null, reasoningEffort: null } },
                activeSelection: null,
                activity: "working",
                createdAt: 1,
                lastSeq: 2,
              },
            })
            const after = (request.params as { afterSeq?: number }).afterSeq ?? 0
            if (after === 0) {
              socket.send(JSON.stringify({ jsonrpc: "2.0", method: "session.event", params: { sessionId: "s1", seq: 1, timestamp: 1, event: { type: "SESSION_CREATED", sessionDir: "/tmp/s1", selection: { agentTitle: "untitled", modelSettings: { modelId: null, reasoningEffort: null } }, forkedFrom: null } } }))
              socket.send(JSON.stringify({ jsonrpc: "2.0", method: "session.event", params: { sessionId: "s1", seq: 2, timestamp: 2, event: { type: "RUN_STARTED", threadId: "s1", runId: "r1", selection: { agentTitle: "untitled", modelSettings: { modelId: null, reasoningEffort: null } }, settingsRevision: "v1", cause: "user", userMessageIds: ["i1"], membership: [{ kind: "user", inputId: "i1" }] } } }))
            }
          } else if (request.method === "session.observe") {
            respond({
              sessionId: "s1",
              revision: "rev-1",
              cursor: 2,
              selection: { agentTitle: "untitled", modelSettings: { modelId: null, reasoningEffort: null } },
              activeSelection: { agentTitle: "untitled", modelSettings: { modelId: null, reasoningEffort: null } },
              pending: [],
              execution: { activeTurnId: "r1", activity: "working", canResume: false, canRewind: true, canFork: false, contextWorkflowActive: false, restorePending: false },
              userTurnIds: ["r1"],
              latestSuccessfulBoundaryId: null,
              attention: [],
            })
          } else respond({})
        },
      },
    })
    const dir = mkdtempSync(join(tmpdir(), "ashe-web-observer-"))
    const db = new Database(join(dir, "state.sqlite"), { create: true })
    applyMigrations(db, migrations)
    const store = new WebStore(db)
    const observer = new WebObserver({
      harnessUrl: `ws://127.0.0.1:${fake.port}/v1/ws`,
      token: "observer-token",
      store,
      now: Date.now,
      onChange: () => {},
    })
    try {
      observer.start()
      await waitFor(() => store.session("s1")?.working === true && methods.some((entry) => entry.method === "session.observe"))
      expect(methods.map((entry) => entry.method)).toContain("session.subscribe")
      expect(methods.map((entry) => entry.method)).toContain("session.observe")
      expect(methods.map((entry) => entry.method)).not.toContain("session.input")
      expect(methods.map((entry) => entry.method)).not.toContain("session.resume")
      expect(methods.map((entry) => entry.method)).not.toContain("action.complete")
      expect(store.cursorFor("s1")).toBe(2)
      expect(store.freshness(Date.now())).toBe(true)
      observer.stop()
      expect(store.freshness(Date.now())).toBe(false)
      await waitFor(() => [...sockets].every((socket) => socket.readyState !== 1))
    } finally {
      observer.stop()
      store.close()
      fake.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

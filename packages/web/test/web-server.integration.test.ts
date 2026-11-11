import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { applyMigrations, discoverMigrations } from "../src/backend/migrations.ts"
import { WebServer } from "../src/backend/server.ts"
import { WebStore } from "../src/backend/store.ts"
import { validateCredential } from "../src/backend/auth.ts"
import type { WebServerMessage } from "../src/shared/web-state.ts"

const migrations = discoverMigrations(join(import.meta.dir, "../migrations"))
const ORIGIN = "http://127.0.0.1:7430"
const NOW = 1_800_000_000_000

type Identity = { principal: unknown; harnessId: string; credentialExpiresAt: number | null; revoked?: boolean }

const identities: Record<string, Identity> = {
  "token-a": { principal: { kind: "login", loginId: "alice" }, harnessId: "harness-a", credentialExpiresAt: null },
  "token-b": { principal: { kind: "login", loginId: "bob" }, harnessId: "harness-a", credentialExpiresAt: null },
  "expired": { principal: { kind: "login", loginId: "alice" }, harnessId: "harness-a", credentialExpiresAt: NOW - 1 },
  "revoked": { principal: { kind: "login", loginId: "alice" }, harnessId: "harness-a", credentialExpiresAt: null, revoked: true },
  "other-harness": { principal: { kind: "login", loginId: "alice" }, harnessId: "harness-b", credentialExpiresAt: null },
}

let harness: ReturnType<typeof Bun.serve>
let server: WebServer
let store: WebStore
let dir: string

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ashe-web-server-"))
  harness = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/v1/auth/identity") return new Response("not found", { status: 404 })
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""
      const identity = identities[token]
      if (identity === undefined || identity.revoked) return json({ code: "authentication_failed" }, 401)
      return json({ principal: identity.principal, harnessId: identity.harnessId, credentialExpiresAt: identity.credentialExpiresAt })
    },
  })
  const db = new Database(join(dir, "state.sqlite"), { create: true })
  applyMigrations(db, migrations)
  store = new WebStore(db)
  store.ensureSession("s1", NOW)
  const assets = join(dir, "dist")
  mkdirSync(join(assets, "assets"), { recursive: true })
  writeFileSync(join(assets, "index.html"), "<!doctype html><title>AsheAgent</title>")
  writeFileSync(join(assets, "assets", "app-abcdef12.js"), "console.log('web')")
  server = new WebServer({
    hostname: "127.0.0.1",
    port: 0,
    harnessUrl: `ws://127.0.0.1:${harness.port}/v1/ws`,
    origins: [ORIGIN],
    assetsDir: assets,
    store,
    migrations,
    revision: "a".repeat(40),
    now: () => NOW,
  })
})

afterAll(() => {
  server.stop()
  store.close()
  harness.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

const base = () => `http://127.0.0.1:${server.server.port}`

class Socket {
  readonly messages: Array<WebServerMessage> = []
  private constructor(readonly socket: WebSocket) {}
  static async connect() {
    const socket = new WebSocket(base().replace("http", "ws") + "/v1/web-state", { headers: { origin: ORIGIN } } as never)
    const wrapped = new Socket(socket)
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error("socket failed"))
    })
    socket.onmessage = (event) => { if (typeof event.data === "string") wrapped.messages.push(JSON.parse(event.data) as WebServerMessage) }
    return wrapped
  }
  send(message: unknown) { this.socket.send(JSON.stringify(message)) }
  async receive(predicate: (message: WebServerMessage) => boolean, timeout = 2_000) {
    const found = this.messages.find(predicate)
    if (found !== undefined) return found
    const started = Date.now()
    while (Date.now() - started < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      const next = this.messages.find(predicate)
      if (next !== undefined) return next
    }
    throw new Error("timed out waiting for a web state message")
  }
  close() { this.socket.close(1000, "done") }
}

describe("web credential validation", () => {
  test("validates online and distinguishes expired, revoked, and malformed credentials", async () => {
    const harnessUrl = `ws://127.0.0.1:${harness.port}/v1/ws`
    expect((await validateCredential(harnessUrl, "token-a", () => NOW)).principal).toBe("login:alice")
    await expect(validateCredential(harnessUrl, "expired", () => NOW)).rejects.toThrow("expired")
    await expect(validateCredential(harnessUrl, "revoked", () => NOW)).rejects.toThrow("not authorized")
    await expect(validateCredential(harnessUrl, "missing", () => NOW)).rejects.toThrow("not authorized")
  })
})

describe("web server boundaries", () => {
  test("serves an explicit asset root with immutable hashes, a revalidated shell, and no state fallthrough", async () => {
    const shell = await fetch(base() + "/")
    expect(shell.status).toBe(200)
    expect(shell.headers.get("cache-control")).toBe("no-cache")
    const asset = await fetch(base() + "/assets/app-abcdef12.js")
    expect(asset.status).toBe(200)
    expect(asset.headers.get("cache-control")).toContain("immutable")
    expect((await fetch(base() + "/state.sqlite")).status).toBe(404)
    expect((await fetch(base() + "/assets/../state.sqlite")).status).toBe(404)
    const health = await fetch(base() + "/v1/web/health")
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ ready: true, database: "current" })
  })

  test("rejects diagnostics without an allowed origin or credential and exports only allowlisted records", async () => {
    const body = { records: [{ name: "web.sync", attributes: { "web.operation": "snapshot", "web.outcome": "ok" } }] }
    expect((await fetch(base() + "/v1/web/diagnostics", { method: "POST", headers: { origin: "https://evil.example", authorization: "Bearer token-a" }, body: JSON.stringify(body) })).status).toBe(403)
    expect((await fetch(base() + "/v1/web/diagnostics", { method: "POST", headers: { origin: ORIGIN }, body: JSON.stringify(body) })).status).toBe(401)
    expect((await fetch(base() + "/v1/web/diagnostics", { method: "POST", headers: { origin: ORIGIN, authorization: "Bearer revoked" }, body: JSON.stringify(body) })).status).toBe(401)
    const accepted = await fetch(base() + "/v1/web/diagnostics", { method: "POST", headers: { origin: ORIGIN, authorization: "Bearer token-a" }, body: JSON.stringify(body) })
    expect(accepted.status).toBe(202)
    const secret = { records: [{ name: "web.sync", attributes: { "web.operation": "snapshot" }, body: "secret message" }] }
    expect((await fetch(base() + "/v1/web/diagnostics", { method: "POST", headers: { origin: ORIGIN, authorization: "Bearer token-a" }, body: JSON.stringify(secret) })).status).toBe(400)
    const unknown = { records: [{ name: "web.sync", attributes: { secret: "value" } }] }
    expect((await fetch(base() + "/v1/web/diagnostics", { method: "POST", headers: { origin: ORIGIN, authorization: "Bearer token-a" }, body: JSON.stringify(unknown) })).status).toBe(400)
    const many = { records: Array.from({ length: 101 }, () => ({ name: "web.sync", attributes: {} })) }
    expect((await fetch(base() + "/v1/web/diagnostics", { method: "POST", headers: { origin: ORIGIN, authorization: "Bearer token-a" }, body: JSON.stringify(many) })).status).toBe(400)
    expect((await fetch(base() + "/v1/web/diagnostics", { method: "POST", headers: { origin: ORIGIN, authorization: "Bearer token-a" }, body: "x".repeat(70_000) })).status).toBe(413)
  })

  test("snapshots, applies a repeat-safe command, renews on the same socket, and rejects cross-principal replacement", async () => {
    const socket = await Socket.connect()
    try {
      socket.send({ type: "web.authenticate", token: "token-a", protocolVersion: 1 })
      const snapshot = await socket.receive((message) => message.type === "web.snapshot")
      expect(snapshot).toMatchObject({ type: "web.snapshot", principal: "login:alice", harnessId: "harness-a" })
      socket.send({ type: "web.command", command: { kind: "organization.set", operationId: "sock-1", sessionId: "s1", patch: { pinned: true } } })
      const receipt = await socket.receive((message) => message.type === "web.receipt")
      expect(receipt).toMatchObject({ type: "web.receipt", operationId: "sock-1", outcome: "confirmed" })
      socket.send({ type: "web.operation", operationId: "sock-1" })
      expect(await socket.receive((message) => message.type === "web.receipt" && message.operationId === "sock-1" && message.revision > 0)).toBeDefined()
      socket.send({ type: "web.authenticate", token: "token-a", protocolVersion: 1 })
      expect(await socket.receive((message) => message.type === "web.snapshot" && message.revision >= 1)).toBeDefined()
      socket.send({ type: "web.authenticate", token: "token-b", protocolVersion: 1 })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(socket.socket.readyState).not.toBe(WebSocket.OPEN)
    } finally {
      socket.close()
    }
  })

  test("refuses an unknown harness binding without rewriting it", async () => {
    const before = store.boundHarness()
    const socket = await Socket.connect()
    try {
      socket.send({ type: "web.authenticate", token: "other-harness", protocolVersion: 1 })
      const error = await socket.receive((message) => message.type === "web.error")
      expect(error).toMatchObject({ type: "web.error", code: "unauthorized" })
      expect(store.boundHarness()).toBe(before)
    } finally {
      socket.close()
    }
  })
})

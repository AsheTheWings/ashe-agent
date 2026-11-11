import { describe, expect, test } from "bun:test"
import { UncertainOperation, WebStateClient } from "../src/client/web-state-client.ts"
import { parseDiagnostics } from "../src/backend/diagnostics.ts"

class FakeSocket {
  static readonly instances: Array<FakeSocket> = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  readonly sent: Array<Record<string, unknown>> = []
  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
    queueMicrotask(() => { this.readyState = 1; this.onopen?.() })
  }
  send(text: string) { this.sent.push(JSON.parse(text) as Record<string, unknown>) }
  close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code }) }
  emit(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }) }
}

const original = globalThis.WebSocket
const install = () => {
  FakeSocket.instances.length = 0
  ;(globalThis as { WebSocket: unknown }).WebSocket = Object.assign(FakeSocket, { OPEN: 1, CLOSED: 3 })
}
const restore = () => { (globalThis as { WebSocket: unknown }).WebSocket = original }

const waitFor = async (predicate: () => boolean, timeout = 2_000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("timed out")
}

describe("web state browser protocol", () => {
  test("authenticates without a token URL, applies a receipt, and reconciles a revision gap", async () => {
    install()
    try {
      const client = new WebStateClient("ws://test.invalid", () => ({ token: "access", expiresAt: Date.now() + 600_000 }), async () => {}, 100)
      client.start()
      await waitFor(() => FakeSocket.instances.length === 1)
      const socket = FakeSocket.instances[0]!
      await waitFor(() => socket.sent.some((message) => message.type === "web.authenticate"))
      expect(socket.url).not.toContain("access")
      socket.emit({ type: "web.snapshot", protocolVersion: 1, revision: 1, principal: "login:alice", harnessId: "h1", sessions: [] })
      expect(client.snapshot()).toMatchObject({ status: "live", revision: 1, harnessId: "h1" })
      const command = client.command({ kind: "organization.set", operationId: "op1", sessionId: "s1", patch: { pinned: true } })
      await waitFor(() => socket.sent.some((message) => message.type === "web.command"))
      socket.emit({ type: "web.receipt", operationId: "op1", outcome: "confirmed", revision: 2, changed: [{ sessionId: "s1", pinned: true, filed: false, snoozedUntil: null, unread: true, readGeneration: 0, working: false, needsHuman: false, available: false, lastActivityAt: 1, lastSubmissionAt: 1, lastReturnAt: 1, sourceCursor: 0, optedOut: false, revision: 2 }] })
      expect((await command).outcome).toBe("confirmed")
      expect(client.snapshot().sessions.s1?.pinned).toBe(true)
      socket.emit({ type: "web.update", revision: 4, changed: [] })
      expect(client.snapshot().status).toBe("stale")
      await expect(client.command({ kind: "organization.set", operationId: "gap", sessionId: "s1", patch: { pinned: true } })).rejects.toThrow("unavailable")
      await waitFor(() => socket.sent.some((message) => message.type === "web.snapshot"))
      socket.emit({ type: "web.snapshot", protocolVersion: 1, revision: 4, principal: "login:alice", harnessId: "h1", sessions: [] })
      await waitFor(() => client.snapshot().status === "live")
      client.stop()
    } finally {
      restore()
    }
  })

  test("keeps an unknown operation explicit and reconciles it after reconnect before mutations", async () => {
    install()
    try {
      const client = new WebStateClient("ws://test.invalid", () => ({ token: "access", expiresAt: Date.now() + 600_000 }), async () => {}, 20)
      client.start()
      await waitFor(() => FakeSocket.instances.length === 1)
      const first = FakeSocket.instances[0]!
      await waitFor(() => first.sent.some((message) => message.type === "web.authenticate"))
      first.emit({ type: "web.snapshot", protocolVersion: 1, revision: 1, principal: "login:alice", harnessId: "h1", sessions: [] })
      const command = client.command({ kind: "organization.set", operationId: "lost", sessionId: "s1", patch: { pinned: true } })
      await expect(command).rejects.toBeInstanceOf(UncertainOperation)
      expect(client.snapshot().pending.lost).toBe("organization.set")
      first.close()
      expect(client.snapshot().status).toBe("stale")
      await waitFor(() => FakeSocket.instances.length === 2, 3_000)
      const second = FakeSocket.instances[1]!
      await waitFor(() => second.sent.some((message) => message.type === "web.authenticate"))
      second.emit({ type: "web.snapshot", protocolVersion: 1, revision: 1, principal: "login:alice", harnessId: "h1", sessions: [] })
      await waitFor(() => second.sent.some((message) => message.type === "web.operation" && message.operationId === "lost"))
      expect(client.snapshot().status).toBe("stale")
      await expect(client.command({ kind: "organization.set", operationId: "new", sessionId: "s1", patch: { filed: true } })).rejects.toThrow("unavailable")
      second.emit({ type: "web.receipt", operationId: "lost", outcome: "confirmed", revision: 2, changed: [] })
      expect(client.snapshot().status).toBe("live")
      expect(client.snapshot().pending.lost).toBeUndefined()
      client.stop()
    } finally {
      restore()
    }
  })

  test("asks for a reload when the backend rejects the protocol version", async () => {
    install()
    try {
      const client = new WebStateClient("ws://test.invalid", () => ({ token: "access", expiresAt: Date.now() + 600_000 }), async () => {}, 20)
      client.start()
      await waitFor(() => FakeSocket.instances.length === 1)
      const socket = FakeSocket.instances[0]!
      await waitFor(() => socket.sent.some((message) => message.type === "web.authenticate"))
      socket.close(4004)
      expect(client.snapshot()).toMatchObject({ status: "incompatible" })
      expect(client.snapshot().error).toContain("Reload")
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(FakeSocket.instances).toHaveLength(1)
      client.stop()
    } finally {
      restore()
    }
  })

  test("reports a revision gap through the bounded diagnostic path", async () => {
    install()
    const originalFetch = globalThis.fetch
    const requests: Array<{ url: string; body: string }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: String(init?.body ?? "") })
      return new Response(null, { status: 202 })
    }) as typeof fetch
    try {
      const client = new WebStateClient("ws://test.invalid", () => ({ token: "access", expiresAt: Date.now() + 600_000 }), async () => {}, 100)
      client.start()
      await waitFor(() => FakeSocket.instances.length === 1)
      const socket = FakeSocket.instances[0]!
      await waitFor(() => socket.sent.some((message) => message.type === "web.authenticate"))
      socket.emit({ type: "web.snapshot", protocolVersion: 1, revision: 1, principal: "login:alice", harnessId: "h1", sessions: [] })
      socket.emit({ type: "web.update", revision: 4, changed: [] })
      await waitFor(() => requests.length === 1)
      expect(requests[0]!.url).toContain("/v1/web/diagnostics")
      expect(JSON.parse(requests[0]!.body)).toMatchObject({ records: [{ name: "web.sync" }] })
      client.stop()
    } finally {
      globalThis.fetch = originalFetch
      restore()
    }
  })

  test("a render-failure record passes the real diagnostic intake", async () => {
    install()
    const originalFetch = globalThis.fetch
    const bodies: string[] = []
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""))
      return new Response(null, { status: 202 })
    }) as typeof fetch
    try {
      const client = new WebStateClient("ws://test.invalid", () => ({ token: "access", expiresAt: Date.now() + 600_000 }), async () => {}, 100)
      client.start()
      await waitFor(() => FakeSocket.instances.length === 1)
      const socket = FakeSocket.instances[0]!
      await waitFor(() => socket.sent.some((message) => message.type === "web.authenticate"))
      socket.emit({ type: "web.snapshot", protocolVersion: 1, revision: 1, principal: "login:alice", harnessId: "h1", sessions: [] })
      client.reportDiagnostic("web.render_failure", { "web.error_type": "component_error" })
      await waitFor(() => bodies.length === 1)
      expect(parseDiagnostics(JSON.parse(bodies[0]!))).toMatchObject([{ name: "web.render_failure", attributes: { "web.error_type": "component_error" } }])
      client.stop()
    } finally {
      globalThis.fetch = originalFetch
      restore()
    }
  })
})

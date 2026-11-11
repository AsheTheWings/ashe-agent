import { useSyncExternalStore } from "react"
import {
  WEB_PROTOCOL_VERSION,
  WEB_STATE_PATH,
  type WebCommand,
  type WebClientMessage,
  type WebReceipt,
  type WebServerMessage,
  type WebSessionState,
  type WebSnapshot,
} from "../shared/web-state.ts"

export type WebStateStatus = "signedOut" | "connecting" | "live" | "stale" | "unauthorized" | "incompatible"

export type WebStateView = {
  readonly status: WebStateStatus
  readonly error: string | null
  readonly revision: number
  readonly principal: string | null
  readonly harnessId: string | null
  readonly sessions: Readonly<Record<string, WebSessionState>>
  readonly pending: Readonly<Record<string, string>>
}

type PendingOperation = {
  readonly resolve: (receipt: WebReceipt) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly kind: string
}

export class UncertainOperation extends Error {
  constructor(readonly operationId: string) {
    super("the web state acknowledgement was lost; reconcile before retrying")
    this.name = "UncertainOperation"
  }
}

export class WebStateClient {
  private view: WebStateView = {
    status: "signedOut",
    error: null,
    revision: 0,
    principal: null,
    harnessId: null,
    sessions: {},
    pending: {},
  }
  private readonly listeners = new Set<() => void>()
  private socket: WebSocket | null = null
  private retry = 1_000
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private readonly operations = new Map<string, PendingOperation>()
  private renewal: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly endpoint: string,
    private readonly token: () => { readonly token: string; readonly expiresAt: number } | null,
    private readonly renew: () => Promise<void>,
    private readonly commandTimeoutMs = 10_000,
  ) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly snapshot = () => this.view

  private set(change: Partial<WebStateView>) {
    this.view = { ...this.view, ...change }
    for (const listener of this.listeners) listener()
  }

  start() {
    this.stopped = false
    this.open()
    if (this.renewal !== null) clearInterval(this.renewal)
    this.renewal = setInterval(() => void this.ensureCredential(), 30_000)
  }

  stop() {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    if (this.renewal !== null) clearInterval(this.renewal)
    this.timer = null
    this.renewal = null
    this.socket?.close(1000, "signed out")
    this.socket = null
    for (const [operationId, pending] of this.operations) {
      clearTimeout(pending.timer)
      pending.reject(new UncertainOperation(operationId))
    }
    this.operations.clear()
    this.set({ status: "signedOut", error: null, revision: 0, principal: null, harnessId: null, sessions: {}, pending: {} })
  }

  private async ensureCredential() {
    const token = this.token()
    if (token === null || token.expiresAt - Date.now() < 60_000) {
      try {
        await this.renew()
      } catch {
        if (this.view.status === "live" || this.view.status === "stale") this.set({ error: "the credential could not be renewed" })
        return
      }
    }
    const current = this.token()
    if (current === null) return
    if (this.socket === null || this.socket.readyState === WebSocket.CLOSED) {
      this.open()
      return
    }
    if (this.socket?.readyState === WebSocket.OPEN && this.view.status === "live") {
      this.send({ type: "web.authenticate", token: current.token, protocolVersion: WEB_PROTOCOL_VERSION })
    }
  }

  private open() {
    if (this.stopped) return
    const token = this.token()
    if (token === null) {
      this.set({ status: "signedOut" })
      return
    }
    this.set({ status: this.view.status === "stale" ? "stale" : "connecting", error: null })
    const socket = new WebSocket(this.endpoint.endsWith(WEB_STATE_PATH) ? this.endpoint : new URL(WEB_STATE_PATH, this.endpoint).href)
    this.socket = socket
    socket.onopen = () => {
      const current = this.token()
      if (current === null) return socket.close(1000, "signed out")
      this.send({ type: "web.authenticate", token: current.token, protocolVersion: WEB_PROTOCOL_VERSION })
    }
    socket.onmessage = (message) => {
      if (typeof message.data !== "string") return
      let parsed: WebServerMessage
      try {
        parsed = JSON.parse(message.data) as WebServerMessage
      } catch {
        return socket.close(4002, "malformed web state")
      }
      this.receive(parsed)
    }
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.socket = null
      if (this.stopped) return
      if (event.code === 4004) {
        this.set({ status: "incompatible", error: "This browser client speaks an unsupported web protocol. Reload to update it." })
        return
      }
      this.set({ status: this.view.status === "unauthorized" ? "unauthorized" : "stale", error: "web organization is disconnected; cached state is stale" })
      this.timer = setTimeout(() => this.open(), this.retry)
      this.retry = Math.min(this.retry * 2, 30_000)
    }
  }

  private receive(message: WebServerMessage) {
    if (message.type === "web.snapshot") {
      this.acceptSnapshot(message)
      return
    }
    if (message.type === "web.receipt") {
      this.acceptReceipt(message)
      return
    }
    if (message.type === "web.update") {
      if (message.revision > this.view.revision + 1) {
        this.diagnostic("web.sync", { "web.operation": "reconcile", "web.revision_gap": true, "web.protocol_version": WEB_PROTOCOL_VERSION })
        this.set({ status: "stale", error: "Shared organization changed; reconciling a consistent snapshot" })
        this.send({ type: "web.snapshot" })
        return
      }
      this.set({ revision: Math.max(this.view.revision, message.revision), sessions: mergeSessions(this.view.sessions, message.changed) })
      return
    }
    if (message.type === "web.error") {
      if (message.code === "unauthenticated" || message.code === "expired" || message.code === "binding") {
        this.diagnostic("web.auth", { "web.operation": "validate", "web.outcome": message.code })
        this.set({ status: "unauthorized", error: message.message })
      } else {
        this.set({ error: message.message })
      }
    }
  }

  private acceptSnapshot(snapshot: WebSnapshot) {
    const sessions = Object.fromEntries(snapshot.sessions.map((session) => [session.sessionId, session]))
    const unresolved = Object.keys(this.view.pending).length > 0
    this.set({
      status: unresolved ? "stale" : "live",
      error: null,
      revision: snapshot.revision,
      principal: snapshot.principal,
      harnessId: snapshot.harnessId,
      sessions,
    })
    this.retry = 1_000
    for (const operationId of Object.keys(this.view.pending)) this.send({ type: "web.operation", operationId })
  }

  private acceptReceipt(receipt: WebReceipt) {
    const pending = this.operations.get(receipt.operationId)
    if (pending !== undefined) {
      clearTimeout(pending.timer)
      this.operations.delete(receipt.operationId)
      if (receipt.outcome === "uncertain") {
        this.set({ status: "stale", error: `operation ${receipt.operationId} was not observed; reconcile before submitting new intent`, revision: Math.max(this.view.revision, receipt.revision), sessions: mergeSessions(this.view.sessions, receipt.changed) })
        this.diagnostic("web.sync", { "web.operation": "command", "web.outcome": "uncertain" })
        this.diagnostic("web.interaction", { "web.operation": pending.kind, "web.outcome": receipt.outcome })
        pending.resolve(receipt)
        return
      }
      const nextPending = { ...this.view.pending }
      delete nextPending[receipt.operationId]
      const status = Object.keys(nextPending).length === 0 && this.socket !== null ? "live" : this.view.status
      this.set({
        status,
        revision: Math.max(this.view.revision, receipt.revision),
        sessions: mergeSessions(this.view.sessions, receipt.changed),
        pending: nextPending,
      })
      this.diagnostic("web.interaction", { "web.operation": pending.kind, "web.outcome": receipt.outcome })
      pending.resolve(receipt)
    } else if (receipt.outcome !== "uncertain") {
      const nextPending = { ...this.view.pending }
      delete nextPending[receipt.operationId]
      this.set({
        status: Object.keys(nextPending).length === 0 && this.socket !== null ? "live" : this.view.status,
        revision: Math.max(this.view.revision, receipt.revision),
        sessions: mergeSessions(this.view.sessions, receipt.changed),
        pending: nextPending,
      })
    }
  }

  /** Sends one bounded, payload-free browser diagnostic through the web backend. */
  /** Reports a bounded browser interaction event through the authenticated backend. */
  reportDiagnostic(name: "web.interaction" | "web.draft" | "web.render_failure", attributes: Readonly<Record<string, string | number | boolean>>) {
    this.diagnostic(name, attributes)
  }

  private diagnostic(name: "web.sync" | "web.auth" | "web.interaction" | "web.draft" | "web.render_failure", attributes: Readonly<Record<string, string | number | boolean>>) {
    const token = this.token()
    if (token === null) return
    const url = new URL(this.endpoint)
    url.protocol = url.protocol === "wss:" ? "https:" : "http:"
    url.pathname = "/v1/web/diagnostics"
    url.search = ""
    url.hash = ""
    void fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ records: [{ name, attributes, timeUnixNano: String(Date.now() * 1_000_000) }] }),
    }).catch(() => {})
  }

  private send(message: WebClientMessage): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify(message))
    return true
  }

  async command(command: WebCommand): Promise<WebReceipt> {
    if (this.view.status !== "live") throw new Error("shared organization is unavailable")
    return await new Promise<WebReceipt>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.operations.delete(command.operationId)
        reject(new UncertainOperation(command.operationId))
      }, this.commandTimeoutMs)
      this.operations.set(command.operationId, { resolve, reject, timer, kind: command.kind })
      this.set({ pending: { ...this.view.pending, [command.operationId]: command.kind } })
      if (!this.send({ type: "web.command", command })) {
        clearTimeout(timer)
        this.operations.delete(command.operationId)
        const nextPending = { ...this.view.pending }
        delete nextPending[command.operationId]
        this.set({ pending: nextPending })
        reject(new Error("shared organization is unavailable"))
      }
    })
  }
}

const mergeSessions = (current: Readonly<Record<string, WebSessionState>>, changed: ReadonlyArray<WebSessionState>) => {
  if (changed.length === 0) return current
  const next = { ...current }
  for (const session of changed) {
    const known = next[session.sessionId]
    if (known === undefined || known.revision <= session.revision) next[session.sessionId] = session
  }
  return next
}

export const useWebState = (client: WebStateClient): WebStateView =>
  useSyncExternalStore(client.subscribe, client.snapshot, client.snapshot)

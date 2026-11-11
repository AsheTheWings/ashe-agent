import { existsSync, readFileSync, statSync } from "node:fs"
import { extname, join, resolve, sep } from "node:path"
import type { ServerWebSocket } from "bun"
import { AuthenticationError, MAX_MESSAGE_BYTES, originAllowed, validateCredential } from "./auth.ts"
import { DiagnosticError, exportDiagnostics, parseDiagnostics } from "./diagnostics.ts"
import { readMigrationStatus, type Migration } from "./migrations.ts"
import type { WebStore } from "./store.ts"
import { WebStoreError } from "./store.ts"
import {
  WEB_DIAGNOSTICS_PATH,
  WEB_HEALTH_PATH,
  WEB_IDENTITY_PATH,
  WEB_PROTOCOL_VERSION,
  WEB_STATE_PATH,
  type WebClientMessage,
  type WebCommand,
  type WebIdentity,
  type WebServerMessage,
} from "../shared/web-state.ts"

type SocketData = {
  identity: WebIdentity | null
  token: string | null
  validatedAt: number
}

export type WebServerOptions = {
  readonly hostname: string
  readonly port: number
  readonly harnessUrl: string
  readonly origins: ReadonlyArray<string>
  readonly assetsDir: string | null
  readonly store: WebStore
  readonly migrations: ReadonlyArray<Migration>
  readonly revision: string
  readonly now: () => number
}

const contentTypes: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
}

const securityHeaders = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
} as const

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...securityHeaders, ...headers },
  })

const bearer = (request: Request): string | null => {
  const header = request.headers.get("authorization")
  if (header === null || !header.startsWith("Bearer ")) return null
  const token = header.slice(7).trim()
  return token === "" ? null : token
}

const hashed = (path: string) => /(?:^|[-.])[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(path)

export class WebServer {
  readonly server: ReturnType<typeof Bun.serve<SocketData>>
  private readonly sockets = new Set<ServerWebSocket<SocketData>>()
  private readonly intake = new Map<string, { count: number; resetAt: number }>()
  private validationTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: WebServerOptions) {
    const root = options.assetsDir === null ? null : resolve(options.assetsDir)
    this.server = Bun.serve<SocketData>({
      hostname: options.hostname,
      port: options.port,
      fetch: async (request, server) => {
        const url = new URL(request.url)
        if (url.pathname === WEB_STATE_PATH) {
          if (!originAllowed(request.headers.get("origin"), options.origins)) return new Response("forbidden", { status: 403 })
          const data: SocketData = { identity: null, token: null, validatedAt: 0 }
          return server.upgrade(request, { data }) ? undefined : new Response("upgrade required", { status: 426 })
        }
        if (url.pathname === WEB_HEALTH_PATH) {
          const status = readMigrationStatus(this.options.store.database(), options.migrations)
          return json(
            {
              ready: status.pending.length === 0,
              database: status.pending.length === 0 ? "current" : "pending",
              protocolVersion: WEB_PROTOCOL_VERSION,
              revision: options.revision,
            },
            status.pending.length === 0 ? 200 : 503,
          )
        }
        if (url.pathname === WEB_IDENTITY_PATH) return this.identity(request)
        if (url.pathname === WEB_DIAGNOSTICS_PATH) return this.diagnostics(request)
        if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405 })
        return this.staticAsset(url.pathname, root)
      },
      websocket: {
        open: (socket) => {
          this.sockets.add(socket)
        },
        close: (socket) => {
          this.sockets.delete(socket)
        },
        message: (socket, message) => void this.message(socket, message),
      },
    })
    this.validationTimer = setInterval(() => void this.revalidateSockets(), 10_000)
  }

  stop() {
    if (this.validationTimer !== null) clearInterval(this.validationTimer)
    this.validationTimer = null
    for (const socket of this.sockets) socket.close(1001, "server stopping")
    this.sockets.clear()
    this.server.stop(true)
  }

  broadcast(changed: ReadonlyArray<{ readonly sessionId: string }>) {
    if (changed.length === 0) return
    const message: WebServerMessage = { type: "web.update", revision: this.options.store.revision(), changed: changed as never }
    void this.broadcastAuthorized(message)
  }

  private async broadcastAuthorized(message: WebServerMessage) {
    for (const socket of this.sockets) {
      if (socket.data.identity === null) continue
      try {
        await this.currentIdentity(socket)
        socket.send(JSON.stringify(message))
      } catch {
        socket.send(JSON.stringify({ type: "web.error", code: "unauthenticated", message: "sign in again" }))
        socket.close(4001, "credential is no longer authorized")
      }
    }
  }

  private staticAsset(pathname: string, root: string | null): Response {
    if (root === null) return new Response("the web application is not built", { status: 503 })
    const relative = pathname === "/" ? "/index.html" : pathname
    let decoded: string
    try {
      decoded = decodeURIComponent(relative)
    } catch {
      return new Response("not found", { status: 404 })
    }
    const path = resolve(join(root, `.${decoded}`))
    if (!path.startsWith(`${root}${sep}`) || !existsSync(path) || !statSync(path).isFile()) return new Response("not found", { status: 404 })
    const type = contentTypes[extname(path).toLowerCase()]
    if (type === undefined) return new Response("not found", { status: 404 })
    const cache = pathname === "/" || pathname === "/index.html" || !hashed(pathname) ? "no-cache" : "public, max-age=31536000, immutable"
    return new Response(readFileSync(path), { headers: { "content-type": type, "cache-control": cache, ...securityHeaders } })
  }

  private async identity(request: Request): Promise<Response> {
    if (!originAllowed(request.headers.get("origin"), this.options.origins)) return new Response("forbidden", { status: 403 })
    const token = bearer(request)
    if (token === null) return json({ code: "unauthenticated" }, 401)
    try {
      const identity = await validateCredential(this.options.harnessUrl, token, this.options.now)
      this.options.store.bind(identity.harnessId, this.options.now())
      return json({ protocolVersion: WEB_PROTOCOL_VERSION, ...identity })
    } catch (error) {
      return json({ code: error instanceof AuthenticationError ? error.code : "unauthenticated" }, 401)
    }
  }

  private async diagnostics(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 })
    if (!originAllowed(request.headers.get("origin"), this.options.origins)) return new Response("forbidden", { status: 403 })
    const token = bearer(request)
    if (token === null) return json({ code: "unauthenticated" }, 401)
    let identity: WebIdentity
    try {
      identity = await validateCredential(this.options.harnessUrl, token, this.options.now)
      this.options.store.bind(identity.harnessId, this.options.now())
    } catch {
      return json({ code: "unauthenticated" }, 401)
    }
    const length = Number(request.headers.get("content-length") ?? "0")
    if (length > MAX_MESSAGE_BYTES) return json({ code: "too_large" }, 413)
    const now = this.options.now()
    const entry = this.intake.get(identity.principal)
    const window = entry === undefined || entry.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : entry
    if (window.count >= 20) return json({ code: "rate_limited" }, 429)
    window.count++
    this.intake.set(identity.principal, window)
    let body: unknown
    try {
      const text = await request.text()
      if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) return json({ code: "too_large" }, 413)
      body = JSON.parse(text)
    } catch {
      return json({ code: "invalid" }, 400)
    }
    try {
      exportDiagnostics(parseDiagnostics(body))
      return new Response(null, { status: 202, headers: { "cache-control": "no-store", ...securityHeaders } })
    } catch (error) {
      return json({ code: "invalid", message: error instanceof DiagnosticError ? error.message : "invalid diagnostics" }, 400)
    }
  }

  private async message(socket: ServerWebSocket<SocketData>, raw: string | Buffer) {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) {
      socket.close(4003, "message too large")
      return
    }
    let message: WebClientMessage
    try {
      message = JSON.parse(raw) as WebClientMessage
    } catch {
      socket.close(4003, "malformed message")
      return
    }
    if (message === null || typeof message !== "object" || typeof message.type !== "string") {
      socket.close(4003, "malformed message")
      return
    }
    if (message.type === "web.authenticate") return this.authenticate(socket, message.token, message.protocolVersion)
    if (socket.data.identity === null || socket.data.token === null) {
      socket.send(JSON.stringify({ type: "web.error", code: "unauthenticated", message: "authenticate first" }))
      return
    }
    let current: WebIdentity
    try {
      current = await this.currentIdentity(socket)
    } catch {
      socket.close(4001, "credential is no longer authorized")
      return
    }
    if (message.type === "web.ping") {
      socket.send(JSON.stringify({ type: "web.update", revision: this.options.store.revision(), changed: [] }))
      return
    }
    if (message.type === "web.snapshot") {
      socket.send(JSON.stringify(this.options.store.snapshot(current.principal, current.harnessId)))
      return
    }
    if (message.type === "web.operation") {
      try {
        const receipt = this.options.store.operation(current.principal, message.operationId)
        socket.send(
          JSON.stringify(
            receipt ?? {
              type: "web.receipt",
              operationId: message.operationId,
              outcome: "uncertain",
              revision: this.options.store.revision(),
              changed: [],
            },
          ),
        )
      } catch (error) {
        socket.send(JSON.stringify({ type: "web.error", code: "unauthorized", message: error instanceof Error ? error.message : "operation lookup failed" }))
      }
      return
    }
    if (message.type !== "web.command" || !validCommand(message.command)) {
      socket.send(JSON.stringify({ type: "web.error", code: "invalid", message: "invalid web command" }))
      return
    }
    try {
      const result = this.options.store.apply(current.principal, message.command, this.options.now())
      socket.send(JSON.stringify(result.receipt))
      const others: WebServerMessage = { type: "web.update", revision: result.revision, changed: result.changed }
      for (const peer of this.sockets) {
        if (peer !== socket && peer.data.identity !== null) peer.send(JSON.stringify(others))
      }
    } catch (error) {
      socket.send(
        JSON.stringify({
          type: "web.error",
          code: error instanceof WebStoreError ? error.code : "internal",
          message: error instanceof Error ? error.message : "web command failed",
        }),
      )
    }
  }

  private async authenticate(socket: ServerWebSocket<SocketData>, token: string, version: number) {
    if (version !== WEB_PROTOCOL_VERSION) {
      socket.send(JSON.stringify({ type: "web.error", code: "unsupported_version", message: "reload the web application" }))
      socket.close(4004, "protocol version mismatch")
      return
    }
    try {
      const identity = await validateCredential(this.options.harnessUrl, token, this.options.now)
      this.options.store.bind(identity.harnessId, this.options.now())
      if (socket.data.identity !== null && (socket.data.identity.principal !== identity.principal || socket.data.identity.harnessId !== identity.harnessId)) {
        socket.close(4003, "credential authority changed")
        return
      }
      socket.data.identity = identity
      socket.data.token = token
      socket.data.validatedAt = this.options.now()
      socket.send(JSON.stringify(this.options.store.snapshot(identity.principal, identity.harnessId)))
    } catch (error) {
      socket.send(
        JSON.stringify({
          type: "web.error",
          code: error instanceof WebStoreError ? error.code : error instanceof AuthenticationError ? error.code : "unauthenticated",
          message: error instanceof Error ? error.message : "authentication failed",
        }),
      )
    }
  }

  private async currentIdentity(socket: ServerWebSocket<SocketData>): Promise<WebIdentity> {
    if (socket.data.identity === null || socket.data.token === null) throw new AuthenticationError("unauthenticated", "not authenticated")
    const identity = await validateCredential(this.options.harnessUrl, socket.data.token, this.options.now)
    this.options.store.bind(identity.harnessId, this.options.now())
    if (identity.principal !== socket.data.identity.principal || identity.harnessId !== socket.data.identity.harnessId) {
      throw new AuthenticationError("binding", "credential authority changed")
    }
    socket.data.identity = identity
    socket.data.validatedAt = this.options.now()
    return identity
  }

  private async revalidateSockets() {
    for (const socket of this.sockets) {
      if (socket.data.identity === null || socket.data.token === null) continue
      try {
        await this.currentIdentity(socket)
      } catch {
        socket.send(JSON.stringify({ type: "web.error", code: "unauthenticated", message: "sign in again" }))
        socket.close(4001, "credential is no longer authorized")
      }
    }
  }
}

const validCommand = (command: WebCommand): boolean => {
  if (command === null || typeof command !== "object") return false
  if (typeof command.operationId !== "string" || command.operationId.length === 0) return false
  switch (command.kind) {
    case "organization.set":
      return typeof command.sessionId === "string" && typeof command.patch === "object" && command.patch !== null && Object.entries(command.patch).every(([key, value]) =>
        key === "pinned" || key === "filed" || key === "optedOut" ? typeof value === "boolean" : key === "snoozedUntil" ? value === null || Number.isInteger(value) : false,
      )
    case "read.set":
      return typeof command.sessionId === "string" && typeof command.unread === "boolean" && (command.generation === undefined || Number.isInteger(command.generation))
    case "file.manual":
      return typeof command.sessionId === "string" && Number.isInteger(command.observedCursor) && Number.isInteger(command.observedRevision)
    case "undo":
      return typeof command.undoOf === "string" && command.undoOf.length > 0
    default:
      return false
  }
}

import type { Database } from "bun:sqlite"
import type { Server, ServerWebSocket } from "bun"
import { Result, Schema } from "effect"
import {
  AnyRequest,
  ErrorCode,
  PROTOCOL_PATH,
  PROTOCOL_VERSIONS,
  authMethods,
  methods,
  unsupportedVersionError,
  type ErrorObject,
  type MethodName,
  type ParamsOf,
  type RequestId,
  type ResultOf,
  type Sender,
} from "@ashe-agent/protocol"
import { authenticate, login, principalActive, refresh } from "../auth/credentials.ts"

/** How long a connection may wait before its first message, which must authenticate it. */
export const AUTH_DEADLINE_MS = 10_000

/** How often the server checks whether a connection's login or API token was revoked. */
export const REVOCATION_CHECK_MS = 1_000

/** The WebSocket close code for a connection refused by authentication or policy. */
export const POLICY_VIOLATION = 1008

export interface Connection {
  readonly id: string
  principal: Sender | null
  /** Set while the first message is authenticating; any other message then closes the connection. */
  authenticating: boolean
  deadline: ReturnType<typeof setTimeout> | null
}

/** What a method handler gets: the connection's principal and ways to send it notifications. */
export interface RequestContext {
  readonly principal: Sender
  readonly connection: Connection
  readonly notify: (message: unknown) => void
  /** Runs `action` right after the request's response is sent. */
  readonly afterResponse: (action: () => void) => void
}

/** A method's handler; it throws a `ProtocolError` to answer with an error. */
export type Handler<M extends MethodName> = (params: ParamsOf<M>, context: RequestContext) => Promise<ResultOf<M>>

export type Handlers = { readonly [M in Exclude<MethodName, (typeof authMethods)[number]>]?: Handler<M> }

export class ProtocolError extends Error {
  constructor(readonly error: ErrorObject) {
    super(error.message)
  }
}

export interface WebSocketServerOptions {
  readonly db: Database
  readonly hostname: string
  readonly port: number
  readonly origins: ReadonlyArray<string>
  readonly handlers: Handlers
  readonly now?: () => number
  readonly onClose?: (connection: Connection) => void
  /** Receives a handler's unexpected failure, which the client sees only as an internal error. */
  readonly onInternalError?: (method: string, failure: unknown) => void
}

export interface WebSocketServer {
  /** The URL clients connect to. */
  readonly url: string
  readonly stop: () => Promise<void>
}

const formatHost = (hostname: string) => (hostname.includes(":") ? `[${hostname}]` : hostname)

const error = (code: number, message: string): ErrorObject => ({ code, message })

const decodeRequest = Schema.decodeUnknownResult(AnyRequest)

/**
 * Serves the protocol on one WebSocket path. A connection's first message
 * must authenticate it within `AUTH_DEADLINE_MS`; any other first message,
 * a failed authentication, or an unsupported version closes it.
 */
export const startWebSocketServer = (options: WebSocketServerOptions): WebSocketServer => {
  const now = options.now ?? Date.now
  const sockets = new Set<ServerWebSocket<Connection>>()

  const send = (socket: ServerWebSocket<Connection>, message: unknown) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }
  const respond = (socket: ServerWebSocket<Connection>, id: RequestId | null, result: unknown) =>
    send(socket, { jsonrpc: "2.0", id, result })
  const fail = (socket: ServerWebSocket<Connection>, id: RequestId | null, failure: ErrorObject) =>
    send(socket, { jsonrpc: "2.0", id, error: failure })
  const refuse = (socket: ServerWebSocket<Connection>, id: RequestId | null, failure: ErrorObject) => {
    fail(socket, id, failure)
    socket.close(POLICY_VIOLATION, failure.message.slice(0, 120))
  }

  const authenticateConnection = async (socket: ServerWebSocket<Connection>, request: AnyRequest) => {
    if (socket.data.authenticating) {
      return refuse(socket, request.id, error(ErrorCode.unauthenticated, "wait for authentication before sending more"))
    }
    socket.data.authenticating = true
    const method = request.method as (typeof authMethods)[number]
    if (!(authMethods as ReadonlyArray<string>).includes(method)) {
      return refuse(socket, request.id, error(ErrorCode.unauthenticated, "the first message must authenticate"))
    }
    const params = Schema.decodeUnknownResult(methods[method].params as Schema.Codec<any, unknown>)(request.params)
    if (Result.isFailure(params)) {
      return refuse(socket, request.id, error(ErrorCode.invalidParams, `invalid params for ${method}`))
    }
    const value = params.success as { protocolVersion: number }
    if (!(PROTOCOL_VERSIONS as ReadonlyArray<number>).includes(value.protocolVersion)) {
      return refuse(socket, request.id, unsupportedVersionError())
    }
    let result: { principal: Sender } & Record<string, unknown>
    if (method === "auth.login") {
      const outcome = await login(options.db, (value as unknown as ParamsOf<"auth.login">).password, now())
      if (!outcome.ok) {
        if (outcome.reason === "rate-limited") {
          return refuse(socket, request.id, {
            code: ErrorCode.rateLimited,
            message: "too many failed logins",
            data: { retryAt: outcome.retryAt },
          })
        }
        const message = outcome.reason === "no-password" ? "no owner password is set" : "wrong password"
        return refuse(socket, request.id, error(ErrorCode.authenticationFailed, message))
      }
      result = { ...outcome.tokens }
    } else if (method === "auth.refresh") {
      const outcome = refresh(options.db, (value as unknown as ParamsOf<"auth.refresh">).refreshToken, now())
      if (!outcome.ok) return refuse(socket, request.id, error(ErrorCode.authenticationFailed, "invalid refresh token"))
      result = { ...outcome.tokens }
    } else {
      const outcome = authenticate(options.db, (value as unknown as ParamsOf<"auth.authenticate">).token, now())
      if (!outcome.ok) return refuse(socket, request.id, error(ErrorCode.authenticationFailed, "invalid token"))
      result = { principal: outcome.principal }
    }
    if (socket.readyState !== WebSocket.OPEN) return
    if (socket.data.deadline !== null) clearTimeout(socket.data.deadline)
    socket.data.deadline = null
    socket.data.principal = result.principal
    respond(socket, request.id, result)
  }

  const dispatch = async (socket: ServerWebSocket<Connection>, request: AnyRequest, principal: Sender) => {
    if (!principalActive(options.db, principal)) {
      return refuse(socket, request.id, error(ErrorCode.unauthenticated, "the login or API token was revoked"))
    }
    if ((authMethods as ReadonlyArray<string>).includes(request.method)) {
      return fail(socket, request.id, error(ErrorCode.invalidRequest, "the connection is already authenticated"))
    }
    const name = request.method as Exclude<MethodName, (typeof authMethods)[number]>
    const handler = Object.hasOwn(methods, name) ? (options.handlers[name] as Handler<typeof name> | undefined) : undefined
    if (handler === undefined) return fail(socket, request.id, error(ErrorCode.methodNotFound, `unknown method ${request.method}`))
    const params = Schema.decodeUnknownResult(methods[name].params as Schema.Codec<any, unknown>)(request.params ?? {})
    if (Result.isFailure(params)) return fail(socket, request.id, error(ErrorCode.invalidParams, params.failure.message))
    try {
      const after: Array<() => void> = []
      const result = await handler(params.success, {
        principal,
        connection: socket.data,
        notify: (message) => send(socket, message),
        afterResponse: (action) => after.push(action),
      })
      respond(socket, request.id, result)
      for (const action of after) action()
    } catch (failure) {
      if (failure instanceof ProtocolError) return fail(socket, request.id, failure.error)
      fail(socket, request.id, error(ErrorCode.internalError, "internal error"))
      options.onInternalError?.(request.method, failure)
    }
  }

  const server: Server<Connection> = Bun.serve<Connection>({
    hostname: options.hostname,
    port: options.port,
    fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname !== PROTOCOL_PATH) return new Response("not found", { status: 404 })
      const origin = request.headers.get("origin")
      if (origin !== null && !options.origins.includes(origin)) return new Response("origin not allowed", { status: 403 })
      const connection: Connection = { id: crypto.randomUUID(), principal: null, authenticating: false, deadline: null }
      if (server.upgrade(request, { data: connection })) return undefined
      return new Response("a WebSocket upgrade is required", { status: 426 })
    },
    websocket: {
      open(socket) {
        sockets.add(socket)
        socket.data.deadline = setTimeout(() => {
          if (socket.data.principal === null) socket.close(POLICY_VIOLATION, "authentication timed out")
        }, AUTH_DEADLINE_MS)
      },
      async message(socket, raw) {
        let parsed: unknown
        try {
          parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString())
        } catch {
          const failure = error(ErrorCode.parseError, "the message is not JSON")
          return socket.data.principal === null ? refuse(socket, null, failure) : fail(socket, null, failure)
        }
        const request = decodeRequest(parsed)
        if (Result.isFailure(request)) {
          const id = (parsed as { id?: unknown })?.id
          const failure = error(ErrorCode.invalidRequest, "the message is not a JSON-RPC 2.0 request")
          const replyId = typeof id === "string" || Number.isInteger(id) ? (id as RequestId) : null
          return socket.data.principal === null ? refuse(socket, replyId, failure) : fail(socket, replyId, failure)
        }
        const principal = socket.data.principal
        if (principal === null) return authenticateConnection(socket, request.success)
        return dispatch(socket, request.success, principal)
      },
      close(socket) {
        sockets.delete(socket)
        if (socket.data.deadline !== null) clearTimeout(socket.data.deadline)
        options.onClose?.(socket.data)
      },
    },
  })

  let dataVersion = -1
  const checkRevocations = () => {
    const version = options.db.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ?? 0
    if (version === dataVersion) return
    dataVersion = version
    for (const socket of sockets) {
      const principal = socket.data.principal
      if (principal !== null && !principalActive(options.db, principal)) {
        socket.close(POLICY_VIOLATION, "the login or API token was revoked")
      }
    }
  }
  const revocationTimer = setInterval(checkRevocations, REVOCATION_CHECK_MS)

  return {
    url: `ws://${formatHost(options.hostname)}:${server.port}${PROTOCOL_PATH}`,
    stop: async () => {
      clearInterval(revocationTimer)
      for (const socket of sockets) socket.close(1001, "the server is stopping")
      await server.stop(true)
    },
  }
}

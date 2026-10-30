/**
 * One WebSocket connection speaking the protocol's JSON-RPC: requests with
 * decoded results, and session events as they arrive.
 */
import {
  ServerMessage,
  methods,
  type ErrorObject,
  type MethodName,
  type ParamsOf,
  type ResultOf,
  type SessionEvent,
} from "@ashe-agent/protocol"
import { Result, Schema } from "effect"
import type { SessionClientPorts, Socket } from "./ports.ts"

/** A request the server answered with an error. */
export class ProtocolError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(error: ErrorObject) {
    super(error.message)
    this.name = "ProtocolError"
    this.code = error.code
    this.data = error.data
  }
}

/** A request that ended without an answer because its connection closed. */
export class ConnectionClosed extends Error {
  constructor() {
    super("the connection closed")
    this.name = "ConnectionClosed"
  }
}

const decodeMessage = Schema.decodeUnknownResult(ServerMessage)

type Pending = {
  readonly method: MethodName
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
}

export type ConnectionHandlers = {
  readonly onEvent: (event: SessionEvent) => void
  readonly onClose: (code: number, reason: string) => void
}

export class Connection {
  private readonly socket: Socket
  private readonly pending = new Map<number, Pending>()
  private readonly opened: Promise<void>
  private nextId = 1
  private closed = false

  constructor(url: string, ports: SessionClientPorts, handlers: ConnectionHandlers) {
    let open = () => {}
    let fail = (_error: Error) => {}
    this.opened = new Promise<void>((resolve, reject) => {
      open = resolve
      fail = reject
    })
    // A connection that never opens rejects `opened` once; nobody else awaits it.
    this.opened.catch(() => {})
    this.socket = ports.openSocket(url, {
      onOpen: () => open(),
      onMessage: (text) => this.receive(text, handlers),
      onClose: (code, reason) => {
        this.closed = true
        fail(new ConnectionClosed())
        for (const request of this.pending.values()) request.reject(new ConnectionClosed())
        this.pending.clear()
        handlers.onClose(code, reason)
      },
    })
  }

  async request<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    await this.opened
    if (this.closed) throw new ConnectionClosed()
    const id = this.nextId++
    const answer = new Promise<unknown>((resolve, reject) => this.pending.set(id, { method, resolve, reject }))
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    return (await answer) as ResultOf<M>
  }

  close() {
    if (!this.closed) this.socket.close(1000, "closed by the client")
  }

  private receive(text: string, handlers: ConnectionHandlers) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return this.violate()
    }
    const decoded = decodeMessage(parsed)
    if (Result.isFailure(decoded)) return this.violate()
    const message = decoded.success
    if ("method" in message) return handlers.onEvent(message.params)
    if (typeof message.id !== "number") return
    const request = this.pending.get(message.id)
    if (request === undefined) return
    this.pending.delete(message.id)
    if ("error" in message && message.error !== undefined) return request.reject(new ProtocolError(message.error))
    const result = Schema.decodeUnknownResult(methods[request.method].result as Schema.Codec<unknown, unknown>)(
      (message as { result: unknown }).result,
    )
    if (Result.isFailure(result)) {
      request.reject(new Error(`the server answered ${request.method} with a malformed result`))
      return this.violate()
    }
    request.resolve(result.success)
  }

  /** A server that breaks the protocol gets its connection closed. */
  private violate() {
    this.socket.close(4002, "the server broke the protocol")
  }
}

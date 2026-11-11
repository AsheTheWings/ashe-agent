import { SessionEvent, SessionObservation, methods, type MethodName, type ParamsOf, type ResultOf } from "@ashe-agent/protocol"
import { Schema } from "effect"
import type { WebSessionState } from "../shared/web-state.ts"
import type { WebStore } from "./store.ts"

type Pending = {
  readonly method: MethodName
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

/** A small server-side harness client; it advertises no client actions. */
class HarnessConnection {
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closed = false
  private readonly opened: Promise<void>

  constructor(
    url: string,
    private readonly onEvent: (event: SessionEvent) => void,
    private readonly onClose: () => void,
  ) {
    let resolveOpen = () => {}
    let rejectOpen = (_error: Error) => {}
    this.opened = new Promise<void>((resolve, reject) => {
      resolveOpen = resolve
      rejectOpen = reject
    })
    this.opened.catch(() => {})
    const socket = new WebSocket(url)
    socket.onopen = () => resolveOpen()
    socket.onmessage = (message) => {
      if (typeof message.data !== "string") return
      let parsed: unknown
      try {
        parsed = JSON.parse(message.data)
      } catch {
        socket.close(4002, "malformed harness message")
        return
      }
      if (parsed === null || typeof parsed !== "object") return
      const envelope = parsed as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown }
      if (envelope.method === "session.event") {
        const event = Schema.decodeUnknownResult(SessionEvent)(envelope.params)
        if (event._tag === "Success") this.onEvent(event.success)
        return
      }
      if (typeof envelope.id !== "number") return
      const request = this.pending.get(envelope.id)
      if (request === undefined) return
      this.pending.delete(envelope.id)
      if (envelope.error !== undefined) {
        request.reject(new Error(`the harness refused ${request.method}`))
        return
      }
      const decoded = Schema.decodeUnknownResult(methods[request.method].result as Schema.Codec<unknown, unknown>)(envelope.result)
      if (decoded._tag === "Failure") {
        request.reject(new Error(`the harness answered ${request.method} with a malformed result`))
        return
      }
      request.resolve(decoded.success)
    }
    socket.onclose = () => {
      this.closed = true
      rejectOpen(new Error("the harness connection closed"))
      for (const request of this.pending.values()) request.reject(new Error("the harness connection closed"))
      this.pending.clear()
      this.onClose()
    }
    this.socket = socket
  }

  private readonly socket: WebSocket

  async call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    await this.opened
    if (this.closed) throw new Error("the harness connection closed")
    const id = this.nextId++
    const answer = new Promise<unknown>((resolve, reject) => this.pending.set(id, { method, resolve, reject }))
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    return (await answer) as ResultOf<M>
  }

  close() {
    this.closed = true
    this.socket.close(1000, "observer stopped")
  }
}

export type ObserverOptions = {
  readonly harnessUrl: string
  readonly token: string
  readonly store: WebStore
  readonly now: () => number
  readonly onChange: (changed: ReadonlyArray<WebSessionState>) => void
  readonly onStatus?: (connected: boolean) => void
}

/**
 * Discovers every harness session and reconciles revision-bound owner
 * snapshots. It never sends model input, resumes work, or accepts actions.
 */
export class WebObserver {
  private stopped = false
  private connection: HarnessConnection | null = null
  private retry = 1_000
  private timer: ReturnType<typeof setTimeout> | null = null
  private discovery: ReturnType<typeof setInterval> | null = null
  private readonly subscribed = new Set<string>()
  private readonly working = new Map<string, boolean>()
  private readonly needsHuman = new Map<string, boolean>()
  private readonly available = new Map<string, boolean>()

  constructor(private readonly options: ObserverOptions) {}

  start() {
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    if (this.discovery !== null) clearInterval(this.discovery)
    this.timer = null
    this.discovery = null
    this.connection?.close()
    this.connection = null
    this.subscribed.clear()
    this.options.store.setObserverConnected(false, this.options.now())
    this.options.onStatus?.(false)
  }

  private connect() {
    if (this.stopped) return
    const connection = new HarnessConnection(
      this.options.harnessUrl,
      (event) => void this.event(event),
      () => this.lost(),
    )
    this.connection = connection
    void (async () => {
      try {
        await connection.call("auth.authenticate", { token: this.options.token, protocolVersion: 1 })
        await connection.call("client.setActions", { actions: [] })
        this.retry = 1_000
        this.options.store.setObserverConnected(true, this.options.now())
        this.options.onStatus?.(true)
        await this.discover(connection)
        this.discovery = setInterval(() => void this.discover(connection), 5_000)
      } catch {
        connection.close()
      }
    })()
  }

  private lost() {
    if (this.connection === null) return
    this.connection = null
    this.subscribed.clear()
    if (this.discovery !== null) clearInterval(this.discovery)
    this.discovery = null
    this.options.store.setObserverConnected(false, this.options.now())
    this.options.onStatus?.(false)
    if (this.stopped) return
    this.timer = setTimeout(() => this.connect(), this.retry)
    this.retry = Math.min(this.retry * 2, 30_000)
  }

  private async discover(connection: HarnessConnection) {
    const { sessions } = await connection.call("session.list", {})
    for (const session of sessions) {
      this.options.store.ensureSession(session.id, session.createdAt)
      if (this.subscribed.has(session.id)) continue
      const cursor = this.options.store.cursorFor(session.id)
      // First discovery reconciles the owner snapshot; it never replays retained
      // history as fresh work. A known cursor continues from its consumed position.
      await connection.call("session.subscribe", { sessionId: session.id, afterSeq: cursor > 0 ? cursor : session.lastSeq })
      this.subscribed.add(session.id)
      await this.observe(connection, session.id)
    }
    this.options.store.markReconciled(this.options.now())
  }

  private async observe(connection: HarnessConnection, sessionId: string) {
    const observation = await connection.call("session.observe", { sessionId })
    this.applyObservation(sessionId, observation)
  }

  private applyObservation(sessionId: string, observation: typeof SessionObservation.Type) {
    this.working.set(sessionId, observation.execution.activity === "working")
    this.needsHuman.set(sessionId, observation.attention.length > 0)
    this.available.set(sessionId, observation.attention.length > 0)
    const changed = this.options.store.reconcile({
      sessionId,
      cursor: observation.cursor,
      now: this.options.now(),
      working: observation.execution.activity === "working",
      pendingText: observation.pending.some((entry) => entry.kind === "user" && entry.text.trim() !== ""),
      needsHuman: observation.attention.length > 0,
      available: observation.attention.length > 0,
    })
    if (changed.length > 0) this.options.onChange(changed)
  }

  private async event(event: SessionEvent) {
    const sessionId = event.sessionId
    const type = event.event.type
    const attention = event.event.type === "ACTION_ATTENTION" ? event.event.needsHumanInput : undefined
    const working =
      type === "RUN_STARTED"
        ? true
        : ["RUN_FINISHED", "RUN_ERROR", "RUN_INTERRUPTED"].includes(type)
          ? false
          : (this.working.get(sessionId) ?? false)
    if (type === "RUN_STARTED" || ["RUN_FINISHED", "RUN_ERROR", "RUN_INTERRUPTED"].includes(type)) {
      this.working.set(sessionId, working)
    }
    if (attention !== undefined) {
      this.needsHuman.set(sessionId, attention)
      this.available.set(sessionId, attention)
    }
    if (type === "ACTION_SETTLED") {
      this.needsHuman.set(sessionId, false)
      this.available.set(sessionId, false)
    }
    const changed = this.options.store.observe({
      sessionId,
      seq: event.seq,
      type,
      now: this.options.now(),
      working,
      needsHuman: this.needsHuman.get(sessionId) ?? false,
      available: this.available.get(sessionId) ?? false,
      pendingText: type === "INPUT_WAITING",
      ...(type === "INPUT_WAITING" ? { senderKind: event.event.sender.kind } : {}),
    })
    if (changed.length > 0) this.options.onChange(changed)
    if (
      ["OBSERVATION_CHANGED", "INPUT_WAITING", "INPUT_RECEIVED", "RUN_STARTED", "RUN_FINISHED", "RUN_ERROR", "ACTION_ATTENTION", "ACTION_SETTLED", "SESSION_REWOUND", "SELECTION_CHANGED"].includes(type) &&
      this.connection !== null
    ) {
      await this.observe(this.connection, sessionId).catch(() => {})
    }
  }
}

import { describe, expect, test } from "bun:test"
import type { Model, SessionEvent, SessionEventBody } from "@ashe-agent/protocol"
import { ErrorCode } from "@ashe-agent/protocol"
import { REFRESH_MARGIN_MS, SessionClient, storageKeys } from "../src/session/client.ts"
import type { KeyValueStorage, SessionClientPorts, SocketHandlers } from "../src/session/ports.ts"
import type { SessionView } from "../src/session/projection.ts"
import { splitPending } from "../src/chat/pending-permissions.ts"

type Request = { readonly id: number; readonly method: string; readonly params: Record<string, unknown> }
type Answer = { readonly result: unknown } | { readonly error: { code: number; message: string } }

const SESSION = "s1"
const START = 1_800_000_000_000
const models: Array<Model> = [
  { id: "alpha", contextWindow: 200_000, imageInput: false },
  { id: "beta", contextWindow: 480_000, imageInput: true },
]
const summary = { id: SESSION, sessionDir: "/state/sessions/s1", agent: null, model: "alpha", createdAt: START, running: false, lastSeq: 0 }
const principal = { kind: "login", loginId: "l1" } as const

/** One socket the fake server accepted, with the requests it received. */
class FakeSocket {
  readonly requests: Array<Request> = []
  closed = false
  constructor(
    readonly url: string,
    private readonly handlers: SocketHandlers,
    private readonly server: FakeServer,
  ) {}
  send(text: string) {
    const request = JSON.parse(text) as Request
    this.requests.push(request)
    const answer = this.server.answer(request)
    const deliver = () => this.handlers.onMessage(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...answer }))
    if (this.server.held.has(request.method)) this.server.pending.push(deliver)
    else deliver()
  }
  /** Like a browser's, the close event arrives after `close()` returns, so a message already received may come first. */
  close() {
    if (this.closed) return
    this.closed = true
    queueMicrotask(() => this.handlers.onClose(1000, ""))
  }
  /** The server sends one session event. */
  push(seq: number, event: SessionEventBody) {
    const params: SessionEvent = { sessionId: SESSION, seq, timestamp: START + seq, event }
    this.handlers.onMessage(JSON.stringify({ jsonrpc: "2.0", method: "session.event", params }))
  }
  /** The server drops the connection. */
  drop() {
    this.closed = true
    this.handlers.onClose(1006, "")
  }
  methods() {
    return this.requests.map((request) => request.method)
  }
}

/** A scripted server behind the socket port, issuing numbered token pairs. */
class FakeServer {
  readonly sockets: Array<FakeSocket> = []
  /** Methods whose answers wait in `pending` until the test delivers them. */
  readonly held = new Set<string>()
  readonly pending: Array<() => void> = []
  private issued = 0
  now = START
  answer(request: Request): Answer {
    switch (request.method) {
      case "auth.login":
      case "auth.refresh":
        this.issued++
        return {
          result: {
            accessToken: `access-${this.issued}`,
            accessTokenExpiresAt: this.now + 15 * 60_000,
            refreshToken: `refresh-${this.issued}`,
            refreshTokenExpiresAt: this.now + 30 * 86_400_000,
            principal,
          },
        }
      case "auth.authenticate":
        return { result: { principal } }
      case "models.list":
        return { result: { models } }
      case "agents.list":
        return { result: { agents: [], refused: [] } }
      case "session.list":
        return { result: { sessions: [summary] } }
      case "session.subscribe":
        return { result: { session: summary } }
      default:
        return { error: { code: ErrorCode.methodNotFound, message: `unscripted ${request.method}` } }
    }
  }
  last() {
    return this.sockets.at(-1)!
  }
}

const memoryStorage = (): KeyValueStorage & { readonly entries: Map<string, string> } => {
  const entries = new Map<string, string>()
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  }
}

/** Ports over the fake server, with timers the test fires by hand. */
const fakePorts = (server: FakeServer) => {
  const timers = new Map<number, { readonly callback: () => void; readonly delayMs: number }>()
  let nextTimer = 1
  const storage = memoryStorage()
  const ports: SessionClientPorts = {
    openSocket: (url, handlers) => {
      const socket = new FakeSocket(url, handlers, server)
      server.sockets.push(socket)
      queueMicrotask(() => handlers.onOpen())
      return socket
    },
    storage,
    withLock: (_name, task) => task(),
    now: () => server.now,
    setTimer: (callback, delayMs) => {
      const id = nextTimer++
      timers.set(id, { callback, delayMs })
      return id
    },
    clearTimer: (timer) => void timers.delete(timer as number),
  }
  /** Fires the pending timer whose delay is `delayMs`. */
  const fire = (delayMs: number) => {
    const entry = [...timers.entries()].find(([, timer]) => timer.delayMs === delayMs)
    if (entry === undefined) throw new Error(`no timer of ${delayMs} ms; pending: ${[...timers.values()].map((t) => t.delayMs)}`)
    timers.delete(entry[0])
    entry[1].callback()
  }
  return { ports, storage, fire, timers: () => timers.size }
}

/** Yields to pending promise reactions until `condition` holds, within a bounded number of turns. */
const until = async (what: string, condition: () => boolean) => {
  for (let turn = 0; turn < 1_000; turn++) {
    if (condition()) return
    await null
  }
  throw new Error(`timed out waiting for ${what}`)
}

const signedIn = async () => {
  const server = new FakeServer()
  const { ports, storage, fire, timers } = fakePorts(server)
  const client = new SessionClient(ports)
  await client.signIn("ws://server.test/", "owner password")
  await until("models", () => client.store.getState().models.length > 0)
  return { server, client, storage, fire, timers }
}

const view = (client: SessionClient): SessionView => client.store.getState().views[SESSION]!

const created: SessionEventBody = {
  type: "SESSION_CREATED",
  sessionDir: "/state/sessions/s1",
  agent: null,
  model: "alpha",
  forkedFrom: null,
}
const sender = principal

/** Events 1-6: a turn that streams "Hello" and asks a permission. */
const firstTurn: Array<[number, SessionEventBody]> = [
  [1, created],
  [2, { type: "INPUT_RECEIVED", inputId: "i1", text: "greet me", mode: "steer", sender }],
  [3, { type: "RUN_STARTED", threadId: SESSION, runId: "r1", model: "alpha", inputId: "i1" }],
  [4, { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" }],
  [5, { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hel" }],
  [6, { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "lo" }],
]
const permission: SessionEventBody = {
  type: "PERMISSION_REQUESTED",
  requestId: "p1",
  runId: "r1",
  toolCallId: "t1",
  permission: "shell",
  subjects: ["ls"],
  patterns: ["ls *"],
}

const texts = (current: SessionView) =>
  current.items.map((item) =>
    item.kind === "user"
      ? `user:${item.text}`
      : item.kind === "assistant"
        ? `assistant:${item.parts.map((part) => (part.type === "tool" ? part.name : part.text)).join("|")}:${item.status}`
        : `notice:${item.text}`,
  )

describe("session client", () => {
  test("sign-in keeps the refresh token, remembers the server, and takes model choices from models.list", async () => {
    const { server, client, storage } = await signedIn()
    const state = client.store.getState()
    expect(state.status).toBe("connected")
    expect(state.models.map((model) => model.id)).toEqual(["alpha", "beta"])
    expect(storage.entries.get(storageKeys.serverUrl)).toBe("ws://server.test/")
    expect(storage.entries.get(storageKeys.refreshToken)).toBe("refresh-1")
    expect([...storage.entries.values()]).not.toContain("access-1")
    expect(server.last().methods()).toEqual(["auth.login", "models.list", "agents.list", "session.list"])
  })

  test("streamed deltas and a replayed range build the conversation, and a permission request stays until resolved", async () => {
    const { server, client } = await signedIn()
    await client.open(SESSION)
    const socket = server.last()
    expect(socket.requests.at(-1)).toMatchObject({ method: "session.subscribe", params: { sessionId: SESSION } })
    for (const [seq, event] of firstTurn) socket.push(seq, event)
    expect(texts(view(client))).toEqual(["user:greet me", "assistant:Hello:running"])
    expect(view(client).runId).toBe("r1")

    // A replayed range overlapping what was applied changes nothing.
    for (const [seq, event] of firstTurn.slice(3)) socket.push(seq, event)
    expect(texts(view(client))).toEqual(["user:greet me", "assistant:Hello:running"])
    expect(view(client).lastSeq).toBe(6)

    socket.push(7, permission)
    expect(view(client).permissions.map((request) => request.requestId)).toEqual(["p1"])
    socket.push(8, { type: "PERMISSION_RESOLVED", requestId: "p1", answer: "once", sender })
    expect(view(client).permissions).toEqual([])
    socket.push(9, { type: "RUN_FINISHED", threadId: SESSION, runId: "r1", outcome: { type: "success" } })
    expect(texts(view(client)).at(1)).toBe("assistant:Hello:finished")
    expect(view(client).runId).toBeNull()
  })

  test("two concurrent asks of one tool call both show until each is answered", async () => {
    const { server, client } = await signedIn()
    await client.open(SESSION)
    const socket = server.last()
    for (const [seq, event] of firstTurn) socket.push(seq, event)
    socket.push(7, permission)
    socket.push(8, { ...permission, requestId: "p2", subjects: ["pwd"], patterns: ["pwd *"] })
    const shown = (current: SessionView) => {
      const { byToolCall, queued } = splitPending(current.permissions)
      return { approvals: [...byToolCall.values()].map((request) => request.requestId), queued: queued.map((request) => request.requestId) }
    }
    expect(shown(view(client))).toEqual({ approvals: ["p1"], queued: ["p2"] })
    socket.push(9, { type: "PERMISSION_RESOLVED", requestId: "p1", answer: "once", sender })
    expect(shown(view(client))).toEqual({ approvals: ["p2"], queued: [] })
    socket.push(10, { type: "PERMISSION_WITHDRAWN", requestId: "p2", reason: "canceled" })
    expect(shown(view(client))).toEqual({ approvals: [], queued: [] })
  })

  test("a rewound event applied live removes its range before later events apply", async () => {
    const { server, client } = await signedIn()
    await client.open(SESSION)
    const socket = server.last()
    for (const [seq, event] of firstTurn) socket.push(seq, event)
    socket.push(7, permission)
    socket.push(8, { type: "SESSION_REWOUND", runId: "r1", firstRemovedSeq: 2 })
    expect(texts(view(client))).toEqual([])
    expect(view(client).permissions).toEqual([])
    expect(view(client).runId).toBeNull()
    expect(view(client).lastSeq).toBe(8)
    socket.push(9, { type: "INPUT_RECEIVED", inputId: "i2", text: "greet me again", mode: "steer", sender })
    socket.push(10, { type: "RUN_STARTED", threadId: SESSION, runId: "r2", model: "alpha", inputId: "i2" })
    expect(texts(view(client))).toEqual(["user:greet me again"])
    expect(view(client).items[0]).toMatchObject({ kind: "user", runId: "r2" })
  })

  test("a replay that crosses a rewind ends where the live session does", async () => {
    const { server, client, fire } = await signedIn()
    await client.open(SESSION)
    const first = server.last()
    for (const [seq, event] of firstTurn.slice(0, 4)) first.push(seq, event)
    first.drop()
    expect(client.store.getState().status).toBe("reconnecting")
    fire(1_000)
    await until("the resubscription", () => server.last() !== first && server.last().methods().includes("session.subscribe"))
    const second = server.last()
    expect(second.methods()).toEqual(["auth.authenticate", "models.list", "agents.list", "session.list", "session.subscribe"])
    expect(second.requests.at(-1)!.params).toEqual({ sessionId: SESSION, afterSeq: 4 })
    // The replay after 4: the rest of the first turn, the rewind of 2 on at 7, then a new input.
    for (const [seq, event] of firstTurn.slice(4)) second.push(seq, event)
    second.push(7, { type: "SESSION_REWOUND", runId: "r1", firstRemovedSeq: 2 })
    second.push(8, { type: "INPUT_RECEIVED", inputId: "i2", text: "greet me again", mode: "steer", sender })
    expect(texts(view(client))).toEqual(["user:greet me again"])
    expect(view(client).lastSeq).toBe(8)
    expect(client.store.getState().status).toBe("connected")
  })

  test("a refresh before expiry exchanges the stored refresh token on a connection of its own", async () => {
    const { server, client, storage, fire } = await signedIn()
    const main = server.last()
    server.now += 15 * 60_000 - REFRESH_MARGIN_MS
    fire(15 * 60_000 - REFRESH_MARGIN_MS)
    await until("the new refresh token", () => storage.entries.get(storageKeys.refreshToken) === "refresh-2")
    const side = server.last()
    expect(side).not.toBe(main)
    expect(side.requests).toMatchObject([{ method: "auth.refresh", params: { refreshToken: "refresh-1" } }])
    await until("the side connection to close", () => side.closed)
    expect(main.closed).toBe(false)
    expect(client.store.getState().status).toBe("connected")
  })

  test("tokens a refresh receives after sign-out are dropped, and no refresh stays scheduled", async () => {
    const { server, client, storage, fire, timers } = await signedIn()
    server.held.add("auth.refresh")
    server.now += 15 * 60_000 - REFRESH_MARGIN_MS
    fire(15 * 60_000 - REFRESH_MARGIN_MS)
    await until("the refresh request", () => server.pending.length === 1)
    const side = server.last()
    client.signOut()
    // The answer was already received when sign-out closed the side connection.
    server.pending.shift()!()
    await until("the side connection to close", () => side.closed)
    for (let turn = 0; turn < 20; turn++) await null
    expect(storage.entries.has(storageKeys.refreshToken)).toBe(false)
    expect(timers()).toBe(0)
    expect(client.store.getState().status).toBe("signedOut")
  })
})

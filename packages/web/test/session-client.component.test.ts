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
  { id: "alpha", name: "Alpha", contextLimit: 200_000, imageInput: false, reasoningEfforts: [], reasoningEffort: null },
  { id: "beta", name: "Beta", contextLimit: 480_000, imageInput: true, reasoningEfforts: ["low", "high"], reasoningEffort: "low" },
]
const summary = { id: SESSION, sessionDir: "/state/sessions/s1", agent: null, model: "alpha", reasoningEffort: null, createdAt: START, running: false, lastSeq: 0 }
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
      case "auth.exchange":
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
        return { result: { models, defaultModel: "alpha" } }
      case "agents.list":
        return { result: { agents: [], defaultAgent: null } }
      case "session.list":
        return { result: { sessions: [summary] } }
      case "session.subscribe":
        return { result: { session: summary } }
      case "session.answerQuestion":
        return { result: {} }
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
  let fragment = ""
  let destination = ""
  const pending = memoryStorage()
  const ports: SessionClientPorts = {
    openSocket: (url, handlers) => {
      const socket = new FakeSocket(url, handlers, server)
      server.sockets.push(socket)
      queueMicrotask(() => handlers.onOpen())
      return socket
    },
    storage,
    signIn: {
      storage: pending, origin: "http://client.test", fragment: () => fragment,
      clearFragment: () => { fragment = "" }, navigate: (url) => { destination = url },
      randomBytes: () => new Uint8Array(32).fill(7),
    },
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
  return { ports, storage, pending, setFragment: (value: string) => { fragment = value }, fragment: () => fragment, destination: () => destination, fire, timers: () => timers.size }
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
  const { ports, storage, fire, timers, pending, setFragment } = fakePorts(server)
  const client = new SessionClient(ports)
  await client.signIn("ws://server.test/")
  setFragment("#signIn=code")
  client.resume()
  await until("models", () => client.store.getState().models.length > 0)
  return { server, client, storage, fire, timers }
}

const view = (client: SessionClient): SessionView => client.store.getState().views[SESSION]!

const created: SessionEventBody = {
  type: "SESSION_CREATED",
  sessionDir: "/state/sessions/s1",
  agent: null,
  model: "alpha",
  reasoningEffort: null,
  forkedFrom: null,
}
const sender = principal

/** Events 1-6: a turn that streams "Hello" and asks a permission. */
const firstTurn: Array<[number, SessionEventBody]> = [
  [1, created],
  [2, { type: "INPUT_RECEIVED", inputId: "i1", text: "greet me", mode: "steer", sender }],
  [3, { type: "RUN_STARTED", threadId: SESSION, runId: "r1", model: "alpha", cause: "user", userMessageIds: ["i1"] }],
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
  current.items.map((item) => {
    switch (item.kind) {
      case "user":
        return `user:${item.text}`
      case "assistant":
        return `assistant:${item.parts.map((part) => (part.type === "tool" ? part.name : part.text)).join("|")}:${item.status}`
      case "notice":
      case "error":
        return `${item.kind}:${item.text}`
      case "entry":
        return `entry:#${item.entry.number} ${item.entry.kind}${item.resolvedBy === null ? "" : ` resolved by #${item.resolvedBy}`}`
      case "developer":
        return `developer:${item.components.map((component) => component.heading).join(",")}`
      case "mark":
        return `mark:${item.mark}`
      case "questions":
        return `questions:${item.open ? "open" : item.answers === null ? "ended" : "answered"}`
    }
  })

describe("session client", () => {
  test("sign-in keeps the refresh token, remembers the server, and takes model choices from models.list", async () => {
    const { server, client, storage } = await signedIn()
    const state = client.store.getState()
    expect(state.status).toBe("connected")
    expect(state.models.map((model) => model.id)).toEqual(["alpha", "beta"])
    expect(storage.entries.get(storageKeys.serverUrl)).toBe("ws://server.test/")
    expect(storage.entries.get(storageKeys.refreshToken)).toBe("refresh-1")
    expect([...storage.entries.values()]).not.toContain("access-1")
    expect(server.last().methods()).toEqual(["auth.exchange", "models.list", "agents.list", "session.list"])
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
    socket.push(10, { type: "RUN_STARTED", threadId: SESSION, runId: "r2", model: "alpha", cause: "user", userMessageIds: ["i2"] })
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

  test("context events build entries, marks, windows, questions, errors, and pending messages that rewinds keep exact", async () => {
    const { server, client } = await signedIn()
    await client.open(SESSION)
    const socket = server.last()
    const developer = (runId: string, heading: string) => ({
      type: "DEVELOPER_MESSAGE" as const,
      runId,
      components: [{ type: "notification" as const, heading, text: `# ${heading}\n\nText.` }],
    })
    const entry = (number: number, kind: "open" | "done" | "compaction" | "answer", fields: Record<string, string>, resolves: Array<number> = []) => ({
      type: "TIMELINE_ENTRY" as const,
      runId: "r1",
      entry: { number, kind, fields, resolves },
    })
    const question = { id: "q1", header: "Store", question: "Where?", options: [{ label: "SQLite", description: "a file" }, { label: "Files", description: "plain" }] }
    const pending = () => view(client).pending.map((input) => input.text)
    const events: Array<SessionEventBody> = [
      created,
      { type: "CHECKPOINT_WINDOW_SEEDED", runId: null, window: 1, components: [] },
      { type: "INPUT_RECEIVED", inputId: "i1", text: "start", mode: "steer", sender },
      { type: "RUN_STARTED", threadId: SESSION, runId: "r1", model: "alpha", cause: "user", userMessageIds: ["i1"] },
      entry(1, "open", { Text: "Write the parser" }),
      entry(2, "compaction", { Text: "Requests:\n- old" }),
      { type: "TIMELINE_ENTRY_REPLACED", runId: "r1", number: 2, text: "Requests:\n- new" },
      { type: "TOOL_CALL_START", toolCallId: "tq", toolCallName: "context_ask_question" },
      { type: "QUESTIONS_ASKED", runId: "r1", toolCallId: "tq", questionSetId: "qs1", feedback: "Noted.", questions: [question] },
    ]
    events.forEach((event, index) => socket.push(index + 1, event))
    expect(texts(view(client))).toEqual(["user:start", "entry:#1 open", "entry:#2 compaction", "assistant:context_ask_question:running", "questions:open"])
    expect(view(client).items.find((item) => item.kind === "entry" && item.entry.number === 2)).toMatchObject({ entry: { fields: { Text: "Requests:\n- new" } } })
    expect(view(client).items.at(-1)).toMatchObject({ kind: "questions", feedback: "Noted.", questions: [question] })

    await client.answerQuestion("qs1", [{ id: "q1", selection: "SQLite", note: "Keep it local." }])
    expect(socket.requests.at(-1)).toMatchObject({
      method: "session.answerQuestion",
      params: { sessionId: SESSION, questionSetId: "qs1", answers: [{ id: "q1", selection: "SQLite", note: "Keep it local." }] },
    })
    const later: Array<SessionEventBody> = [
      { type: "QUESTIONS_ANSWERED", questionSetId: "qs1", answers: [{ id: "q1", selection: "SQLite", note: "Keep it local." }], sender },
      entry(3, "answer", { Question: "Where?", Selection: "SQLite: a file", UserNote: "Keep it local." }),
      { type: "TOOL_CALL_RESULT", messageId: "rq", toolCallId: "tq", content: "[ANSWER #3]", role: "tool", outcome: "success" },
      entry(4, "done", { Text: "Parser written" }, [1]),
      { type: "SESSION_ERROR", code: "user_instructions_unreadable", message: "AGENTS.md cannot be read; the known user instructions stay", runId: "r1" },
      { type: "INPUT_WAITING", inputId: "i2", text: "held one", mode: "steer", sender },
      { type: "CONTEXT_TURN_STARTED", runId: "r1", trigger: "threshold" },
      developer("r1", "Context Turn"),
      { type: "TOOL_RESULTS_CLEARED", runId: "r1", attempt: 1, tokensFreed: 5_000 },
      { type: "INPUT_WAITING", inputId: "i3", text: "held two", mode: "steer", sender },
    ]
    later.forEach((event, index) => socket.push(events.length + index + 1, event))
    expect(view(client).items.find((item) => item.kind === "questions")).toMatchObject({ open: false, answers: [{ id: "q1", selection: "SQLite" }] })
    expect(pending()).toEqual(["held one", "held two"])
    expect(texts(view(client))).toEqual([
      "user:start",
      "entry:#1 open resolved by #4",
      "entry:#2 compaction",
      "assistant:context_ask_question:running",
      "questions:answered",
      "entry:#3 answer",
      "entry:#4 done",
      "error:AGENTS.md cannot be read; the known user instructions stay",
      "mark:context_turn",
      "developer:Context Turn",
      "mark:clearing",
    ])

    // The context turn builds the next checkpoint window; its continuation turn takes both held messages.
    let seq = events.length + later.length
    const push = (...bodies: Array<SessionEventBody>) => {
      for (const body of bodies) socket.push(++seq, body)
    }
    push(
      { type: "CHECKPOINT_WINDOW_SEEDED", runId: "r1", window: 2, components: [] },
      { type: "RUN_FINISHED", threadId: SESSION, runId: "r1", outcome: { type: "success" } },
    )
    const continuationStart = seq + 1
    push(
      developer("r2", "Continuation"),
      { type: "INPUT_RECEIVED", inputId: "i2", text: "held one", mode: "steer", sender },
      { type: "INPUT_RECEIVED", inputId: "i3", text: "held two", mode: "steer", sender },
      { type: "RUN_STARTED", threadId: SESSION, runId: "r2", model: "alpha", cause: "continuation", userMessageIds: ["i2", "i3"] },
      { type: "RUN_FINISHED", threadId: SESSION, runId: "r2", outcome: { type: "success" } },
    )
    expect(pending()).toEqual([])
    expect(texts(view(client)).slice(11)).toEqual(["mark:window", "developer:Continuation", "user:held one", "user:held two", "mark:continuation"])

    // A rerun without an edit holds both messages again, under new ids, until both are received.
    push({ type: "SESSION_REWOUND", runId: "r2", firstRemovedSeq: continuationStart })
    push({ type: "INPUT_WAITING", inputId: "i4", text: "held one", mode: "steer", sender }, { type: "INPUT_WAITING", inputId: "i5", text: "held two", mode: "steer", sender })
    expect(view(client).pending.map((input) => input.inputId)).toEqual(["i4", "i5"])
    expect(texts(view(client)).slice(11)).toEqual(["mark:window"])
    const rerunStart = seq + 1
    push({ type: "INPUT_RECEIVED", inputId: "i4", text: "held one", mode: "steer", sender })
    expect(view(client).pending.map((input) => input.inputId)).toEqual(["i5"])
    push(
      { type: "INPUT_RECEIVED", inputId: "i5", text: "held two", mode: "steer", sender },
      { type: "RUN_STARTED", threadId: SESSION, runId: "r3", model: "alpha", cause: "continuation", userMessageIds: ["i4", "i5"] },
      { type: "RUN_FINISHED", threadId: SESSION, runId: "r3", outcome: { type: "success" } },
    )
    expect(pending()).toEqual([])

    // An edit at the continuation turn leaves only the edit pending, and no message an earlier rewind removed returns.
    push({ type: "SESSION_REWOUND", runId: "r3", firstRemovedSeq: rerunStart })
    push({ type: "INPUT_WAITING", inputId: "i6", text: "edited", mode: "steer", sender })
    expect(view(client).pending.map((input) => input.inputId)).toEqual(["i6"])
    expect(texts(view(client)).slice(0, 11).at(-1)).toBe("mark:clearing")
  })
})

describe("GitHub browser sign-in", () => {
  test("start keeps a tab verifier and callback removes its fragment before connecting and exchanging", async () => {
    const server = new FakeServer()
    const h = fakePorts(server)
    const client = new SessionClient(h.ports)
    await client.signIn("wss://server.test/v1/ws")
    const verifier = h.pending.getItem(storageKeys.verifier)!
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(h.pending.getItem(storageKeys.signInServer)).toBe("wss://server.test/v1/ws")
    const start = new URL(h.destination())
    expect(start.origin).toBe("https://server.test")
    expect(start.pathname).toBe("/v1/auth/github/start")
    expect(start.searchParams.get("origin")).toBe("http://client.test")
    expect(start.searchParams.get("challenge")).toBe(Buffer.from(new Bun.CryptoHasher("sha256").update(verifier).digest()).toString("base64url"))
    expect(server.sockets).toHaveLength(0)
    h.setFragment("#signIn=once")
    const returned = new SessionClient({ ...h.ports, openSocket: (url, handlers) => {
      expect(h.fragment()).toBe("")
      expect(h.pending.getItem(storageKeys.verifier)).toBeNull()
      return h.ports.openSocket(url, handlers)
    } })
    returned.resume()
    await until("signed in", () => returned.store.getState().status === "connected")
    expect(server.last().requests[0]).toMatchObject({ method: "auth.exchange", params: { code: "once", verifier, protocolVersion: 1 } })
    expect(h.storage.getItem(storageKeys.refreshToken)).toBe("refresh-1")
    expect(h.pending.getItem(storageKeys.signInServer)).toBeNull()
    returned.signOut()
  })

  test("a return missing either tab value sends no exchange and removes its fragment", () => {
    for (const missing of [storageKeys.verifier, storageKeys.signInServer]) {
      const server = new FakeServer()
      const h = fakePorts(server)
      h.pending.setItem(storageKeys.verifier, "verifier")
      h.pending.setItem(storageKeys.signInServer, "ws://server.test")
      h.pending.removeItem(missing)
      h.setFragment("#signIn=once")
      const client = new SessionClient(h.ports)
      client.resume()
      expect(h.fragment()).toBe("")
      expect(server.sockets).toHaveLength(0)
      expect(client.store.getState().error).toContain("no pending sign-in")
    }
  })

  test("denied, non-owner, and GitHub failures show messages and discard tab secrets", () => {
    for (const error of ["denied", "not_owner", "github_failed"]) {
      const server = new FakeServer()
      const h = fakePorts(server)
      h.pending.setItem(storageKeys.verifier, "verifier")
      h.pending.setItem(storageKeys.signInServer, "ws://server.test")
      h.setFragment(`#signInError=${error}`)
      const client = new SessionClient(h.ports)
      client.resume()
      expect(client.store.getState().error).toBeTruthy()
      expect(client.store.getState().status).toBe("signedOut")
      expect(server.sockets).toHaveLength(0)
      expect(h.fragment()).toBe("")
      expect(h.pending.entries.size).toBe(0)
    }
  })

  test("a failed exchange shows its error and forgets the verifier", async () => {
    const server = new FakeServer()
    const h = fakePorts(server)
    server.answer = () => ({ error: { code: ErrorCode.authenticationFailed, message: "invalid sign-in code" } })
    h.pending.setItem(storageKeys.verifier, "verifier")
    h.pending.setItem(storageKeys.signInServer, "ws://server.test")
    h.setFragment("#signIn=once")
    const client = new SessionClient(h.ports)
    client.resume()
    await until("failed exchange", () => client.store.getState().error !== null)
    expect(client.store.getState().error).toBe("invalid sign-in code")
    expect(h.pending.entries.size).toBe(0)
    expect(h.storage.getItem(storageKeys.refreshToken)).toBeNull()
  })
})

import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Model, SessionEvent, SessionEventBody } from "@ashe-agent/protocol"
import { ErrorCode } from "@ashe-agent/protocol"
import { REFRESH_MARGIN_MS, SessionClient, storageKeys } from "../src/session/client.ts"
import type { KeyValueStorage, SessionClientPorts, SocketHandlers } from "../src/session/ports.ts"
import type { SessionView } from "../src/session/projection.ts"
import { splitPending } from "../src/chat/pending-permissions.ts"
import { SelectionReadouts } from "../src/app/selection-readout.ts"
import {
  effortControlValue,
  effortRequestValue,
  modelControlValue,
  titleControlValue,
  titleOptions,
} from "../src/session/selection-controls.ts"

type Request = { readonly id: number; readonly method: string; readonly params: Record<string, unknown> }
type Answer = { readonly result: unknown } | { readonly error: { code: number; message: string } }

const SERVER_URL = "ws://server.test/v1/ws"
const SESSION = "s1"
const START = 1_800_000_000_000
const models: Array<Model> = [
  { id: "alpha", name: "Alpha", contextLimit: 200_000, imageInput: false, pdfInput: false, reasoningEfforts: [], reasoningEffort: null },
  { id: "beta", name: "Beta", contextLimit: 480_000, imageInput: true, pdfInput: true, reasoningEfforts: ["low", "high"], reasoningEffort: "low" },
]
const selection = { agentTitle: "untitled", modelSettings: { modelId: "alpha", reasoningEffort: null } }
const summary = {
  id: SESSION,
  sessionDir: "/state/sessions/s1",
  identity: { sessionId: SESSION, agentTitle: "untitled", modelId: "alpha" },
  selection,
  activeSelection: null,
  activity: "idle" as const,
  createdAt: START,
  lastSeq: 0,
}
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
  pushAction(actionId: string, sessionId: string, name: string, args: unknown) {
    this.handlers.onMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "action.execute", params: { actionId, sessionId, name, arguments: args } }),
    )
  }
  pushActionCancel(actionId: string, sessionId: string, reason: string) {
    this.handlers.onMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "action.cancel", params: { actionId, sessionId, reason } }),
    )
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
  failInput = false
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
      case "actions.list":
        return {
          result: {
            actions: ["questions.answer", "permission.decide"].map((name) => ({
              name,
              description: name,
              input: { type: "object" },
              output: { type: "object" },
            })),
          },
        }
      case "client.setActions":
        return { result: {} }
      case "action.complete":
        return { result: {} }
      case "session.input":
        if (this.failInput) return { error: { code: ErrorCode.conflict, message: "input refused" } }
        {
          const inputId = `input-${this.issued++}`
          return {
            result: {
              inputId,
              submissionId: `sub-${this.issued}`,
              receipt: { submissionId: `sub-${this.issued}`, inputId, disposition: "pending", acceptedAt: START },
            },
          }
        }
      case "session.history.inspect":
        {
          const runId = (request.params.runId as string | undefined) ?? "r1"
          return {
            result: {
              scope: {
                token: "history-scope",
                sessionId: SESSION,
                targetRunId: runId,
                readRevision: "revision",
                activeTurnId: null,
                pendingInputIds: [],
                contextActive: false,
                restorePending: false,
              },
              target: {
                runId,
                position: 1,
                userMessageIds: ["u1"],
                affectedTurnIds: [runId],
                pendingInputIds: [],
                rewindEligible: true,
                forkEligible: true,
              },
            },
          }
        }
      case "session.resume":
      case "session.rewind":
        return { result: {} }
      case "session.fork":
        return { result: { session: { ...summary, id: "forked" } } }
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
const fakePorts = (server: FakeServer, serverUrl = SERVER_URL) => {
  const timers = new Map<number, { readonly callback: () => void; readonly delayMs: number }>()
  let nextTimer = 1
  const storage = memoryStorage()
  let fragment = ""
  let destination = ""
  const pending = memoryStorage()
  const ports: SessionClientPorts = {
    serverUrl,
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
  await client.signIn()
  setFragment("#signIn=code")
  client.resume()
  await until("models", () => client.store.getState().models.length > 0)
  await until("client action support", () => server.last().methods().includes("client.setActions"))
  return { server, client, storage, fire, timers }
}

const view = (client: SessionClient): SessionView => client.store.getState().views[SESSION]!

const created: SessionEventBody = {
  type: "SESSION_CREATED",
  sessionDir: "/state/sessions/s1",
  selection,
  forkedFrom: null,
}
const sender = principal

/** Events 1-6: a turn that streams "Hello" and asks a permission. */
const firstTurn: Array<[number, SessionEventBody]> = [
  [1, created],
  [2, { type: "INPUT_RECEIVED", inputId: "i1", text: "greet me", mode: "steer", sender }],
  [3, { type: "RUN_STARTED", threadId: SESSION, runId: "r1", selection, settingsRevision: "s1", cause: "user", userMessageIds: ["i1"], membership: [{ kind: "system", inputId: "system:1" }, { kind: "user", inputId: "i1" }] }],
  [4, { type: "TEXT_MESSAGE_START", modelCallId: "mc1", messageId: "m1", role: "assistant" }],
  [5, { type: "TEXT_MESSAGE_CONTENT", modelCallId: "mc1", messageId: "m1", delta: "Hel" }],
  [6, { type: "TEXT_MESSAGE_CONTENT", modelCallId: "mc1", messageId: "m1", delta: "lo" }],
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
        return `user:${item.messages.map((message) => message.text).join("|")}`
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
  test("sign-in keeps the endpoint-bound refresh token and takes model choices from models.list", async () => {
    const { server, client, storage } = await signedIn()
    const state = client.store.getState()
    expect(state.status).toBe("connected")
    expect(state.models.map((model) => model.id)).toEqual(["alpha", "beta"])
    expect(state.serverUrl).toBe(SERVER_URL)
    expect(storage.entries.get(storageKeys.refreshToken(SERVER_URL))).toBe("refresh-1")
    expect([...storage.entries.values()]).not.toContain("access-1")
    expect(server.last().methods()).toEqual([
      "auth.exchange",
      "models.list",
      "agents.list",
      "session.list",
      "actions.list",
      "client.setActions",
    ])
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

  test("directed actions are owned only by this connection and explicit controls use their protocol methods", async () => {
    const { server, client } = await signedIn()
    await client.open(SESSION)
    const socket = server.last()
    socket.pushAction("a-p", SESSION, "permission.decide", {
      requestId: "p1",
      permission: "shell",
      subjects: ["ls"],
      patterns: ["ls"],
    })
    expect(client.store.getState().owned.permissions).toEqual(["p1"])
    socket.pushActionCancel("a-p", SESSION, "the turn ended")
    expect(client.store.getState().owned.permissions).toEqual([])

    socket.pushAction("a-q", SESSION, "questions.answer", {
      questionSetId: "q1",
      questions: [
        {
          id: "one",
          header: "One",
          question: "Pick?",
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
          ],
        },
      ],
    })
    expect(client.store.getState().owned.questions).toEqual(["q1"])
    await client.answerQuestion("q1", [{ id: "one", selection: "A" }])
    expect(socket.requests.at(-1)).toMatchObject({ method: "action.complete", params: { actionId: "a-q" } })
    expect(client.store.getState().owned.questions).toEqual([])

    await client.resumeSession()
    expect(socket.requests.at(-1)).toMatchObject({ method: "session.resume", params: { sessionId: SESSION } })
    await client.rewind("r1")
    expect(socket.requests.at(-1)).toMatchObject({ method: "session.rewind", params: { sessionId: SESSION, runId: "r1" } })
  })

  test("selection changes stay local until input or rewind submission", async () => {
    const { server, client } = await signedIn()
    await client.open(SESSION)
    const socket = server.last()
    const before = socket.requests.length

    await client.setModel("beta", "high")
    expect(socket.requests).toHaveLength(before)
    expect(client.store.getState().requestedSelections[SESSION]).toEqual({
      modelSettings: { modelId: "beta", reasoningEffort: "high" },
    })

    await client.send("use the new model")
    expect(socket.requests.at(-1)).toMatchObject({
      method: "session.input",
      params: {
        sessionId: SESSION,
        text: "use the new model",
        selection: { modelSettings: { modelId: "beta", reasoningEffort: "high" } },
      },
    })
    expect(client.store.getState().requestedSelections[SESSION]).toBeUndefined()

    const applied = { agentTitle: "untitled", modelSettings: { modelId: "beta", reasoningEffort: "high" } }
    socket.push(1, { type: "SELECTION_CHANGED", selection: applied, settingsRevisionId: "s2", sender })
    socket.push(2, {
      type: "RUN_STARTED",
      threadId: SESSION,
      runId: "r2",
      selection: applied,
      settingsRevision: "s2",
      cause: "user",
      userMessageIds: [],
      membership: [],
    })
    expect(view(client).model).toBe("beta")
    expect(view(client).activeSelection).toEqual(applied)

    await client.setModel("alpha")
    await client.rewind("r1")
    expect(socket.requests.at(-1)).toMatchObject({
      method: "session.rewind",
      params: {
        sessionId: SESSION,
        runId: "r1",
        selection: { modelSettings: { modelId: "alpha", reasoningEffort: null } },
      },
    })
  })

  test("requested title, model, and effort changes accumulate with explicit nulls", async () => {
    const { server, client } = await signedIn()
    await client.open(SESSION)
    const socket = server.last()

    await client.setAgentTitle("writer")
    expect(client.store.getState().requestedSelections[SESSION]).toEqual({ agentTitle: "writer" })
    await client.setSelection({ modelSettings: { modelId: "beta" } })
    await client.setReasoningEffort("high")
    expect(client.store.getState().requestedSelections[SESSION]).toEqual({
      agentTitle: "writer",
      modelSettings: { modelId: "beta", reasoningEffort: "high" },
    })
    await client.setReasoningEffort(null)
    expect(client.store.getState().requestedSelections[SESSION]?.modelSettings).toEqual({
      modelId: "beta",
      reasoningEffort: null,
    })
    await client.send("use these settings")
    expect(socket.requests.at(-1)?.params.selection).toEqual({
      agentTitle: "writer",
      modelSettings: { modelId: "beta", reasoningEffort: null },
    })
    expect(client.store.getState().requestedSelections[SESSION]).toBeUndefined()

    await client.clearModel()
    expect(client.store.getState().requestedSelections[SESSION]).toEqual({
      modelSettings: { modelId: null, reasoningEffort: null },
    })
  })

  test("selection controls follow requested values, preserve default effort, and represent no model", () => {
    expect(modelControlValue({ modelSettings: { modelId: "beta" } }, "alpha")).toBe("beta")
    expect(modelControlValue({ modelSettings: { modelId: null } }, "alpha")).toBeNull()
    expect(effortControlValue({ modelSettings: { reasoningEffort: null } }, "high", "low")).toBe("low")
    expect(effortControlValue({ modelSettings: { modelId: "beta" } }, "high", "low")).toBe("high")
    expect(effortRequestValue("low", "low")).toBeNull()
    expect(effortRequestValue("high", "low")).toBe("high")
    const agents = [
      {
        key: "code-reviewer",
        title: "Code Reviewer",
        description: null,
        model: null,
        reasoningEfforts: {},
        titleFile: { state: "absent" as const },
      },
    ]
    expect(titleOptions(agents)).toEqual([
      { value: "code-reviewer", label: "Code Reviewer" },
      { value: "untitled", label: "untitled" },
    ])
    expect(titleControlValue(undefined, "code-reviewer")).toBe("code-reviewer")
    const active = { agentTitle: "untitled", modelSettings: { modelId: "alpha", reasoningEffort: null } }
    const requested = { agentTitle: "code-reviewer", modelSettings: { modelId: "beta", reasoningEffort: "high" } }
    expect(titleControlValue(requested, "untitled")).toBe("code-reviewer")
    expect(modelControlValue(requested, active.modelSettings.modelId)).toBe("beta")
    const applied = { agentTitle: "untitled", modelSettings: { modelId: null, reasoningEffort: null } }
    const readout = renderToStaticMarkup(SelectionReadouts({ applied, requested, active }))
    expect(readout).toContain("applied: untitled · no model · default effort")
    expect(readout).toContain("requested: code-reviewer · beta · high")
    expect(readout).toContain("active: untitled · alpha · default effort")
  })

  test("a submission clears only the requested patch it submitted", async () => {
    const { server, client } = await signedIn()
    await client.open(SESSION)
    const socket = server.last()
    server.held.add("session.input")
    await client.setModel("alpha")
    const sending = client.send("first")
    for (let turn = 0; turn < 20 && server.pending.length === 0; turn++) await Promise.resolve()
    await client.setModel("beta")
    server.pending.shift()!()
    await sending
    expect(client.store.getState().requestedSelections[SESSION]).toEqual({
      modelSettings: { modelId: "beta", reasoningEffort: null },
    })
    server.held.delete("session.input")
    await client.send("second")
    expect(socket.requests.at(-1)?.params.selection).toEqual({
      modelSettings: { modelId: "beta", reasoningEffort: null },
    })
    expect(client.store.getState().requestedSelections[SESSION]).toBeUndefined()
  })

  test("discarded model output is removed while earlier committed output remains", async () => {
    const { server, client } = await signedIn()
    await client.open(SESSION)
    const socket = server.last()
    socket.push(1, created)
    socket.push(2, {
      type: "RUN_STARTED",
      threadId: SESSION,
      runId: "r1",
      selection,
      settingsRevision: "s1",
      cause: "user",
      userMessageIds: [],
      membership: [],
    })
    socket.push(3, { type: "MODEL_CALL_STARTED", runId: "r1", modelCallId: "mc1", ordinal: 1 })
    socket.push(4, { type: "TEXT_MESSAGE_START", modelCallId: "mc1", messageId: "kept", role: "assistant" })
    socket.push(5, { type: "TEXT_MESSAGE_CONTENT", modelCallId: "mc1", messageId: "kept", delta: "kept" })
    socket.push(6, { type: "MODEL_CALL_COMMITTED", runId: "r1", modelCallId: "mc1", inputBoundaryId: "b1" })
    socket.push(7, { type: "MODEL_CALL_STARTED", runId: "r1", modelCallId: "mc2", ordinal: 2 })
    socket.push(8, { type: "TEXT_MESSAGE_START", modelCallId: "mc2", messageId: "discard", role: "assistant" })
    socket.push(9, { type: "TEXT_MESSAGE_CONTENT", modelCallId: "mc2", messageId: "discard", delta: "discard" })
    socket.push(10, { type: "MODEL_CALL_DISCARDED", runId: "r1", modelCallId: "mc2", reason: "failed" })
    expect(texts(view(client))).toEqual(["assistant:kept:running"])
  })

  test("a repeated provider tool id is scoped to its model call when discarded", async () => {
    const { server, client } = await signedIn()
    await client.open(SESSION)
    const socket = server.last()
    socket.push(1, created)
    socket.push(2, {
      type: "RUN_STARTED",
      threadId: SESSION,
      runId: "r1",
      selection,
      settingsRevision: "s1",
      cause: "user",
      userMessageIds: [],
      membership: [],
    })
    socket.push(3, { type: "MODEL_CALL_STARTED", runId: "r1", modelCallId: "mc1", ordinal: 1 })
    socket.push(4, { type: "TOOL_CALL_START", modelCallId: "mc1", toolCallId: "call_1", toolCallName: "echo" })
    socket.push(5, { type: "TOOL_CALL_ARGS", modelCallId: "mc1", toolCallId: "call_1", delta: '{"text":"kept"}' })
    socket.push(6, { type: "TOOL_CALL_END", modelCallId: "mc1", toolCallId: "call_1" })
    socket.push(7, { type: "MODEL_CALL_COMMITTED", runId: "r1", modelCallId: "mc1", inputBoundaryId: "b1" })
    socket.push(8, {
      type: "TOOL_CALL_RESULT",
      modelCallId: "mc1",
      messageId: "tool-result-1",
      toolCallId: "call_1",
      role: "tool",
      content: "kept result",
      outcome: "success",
    })
    socket.push(9, { type: "MODEL_CALL_STARTED", runId: "r1", modelCallId: "mc2", ordinal: 2 })
    socket.push(10, { type: "TOOL_CALL_START", modelCallId: "mc2", toolCallId: "call_1", toolCallName: "echo" })
    socket.push(11, { type: "TOOL_CALL_ARGS", modelCallId: "mc2", toolCallId: "call_1", delta: '{"text":"discard"}' })
    socket.push(12, { type: "MODEL_CALL_DISCARDED", runId: "r1", modelCallId: "mc2", reason: "failed" })
    const tools = view(client).items.flatMap((item) =>
      item.kind === "assistant" ? item.parts.filter((part) => part.type === "tool") : [],
    )
    expect(tools).toEqual([
      expect.objectContaining({ id: "call_1", modelCallId: "mc1", result: { content: "kept result", outcome: "success" } }),
    ])
  })

  test("an interrupted run discards provisional parts even without a discard event", async () => {
    const { server, client } = await signedIn()
    await client.open(SESSION)
    const socket = server.last()
    socket.push(1, created)
    socket.push(2, {
      type: "RUN_STARTED",
      threadId: SESSION,
      runId: "r1",
      selection,
      settingsRevision: "s1",
      cause: "user",
      userMessageIds: [],
      membership: [],
    })
    socket.push(3, { type: "MODEL_CALL_STARTED", runId: "r1", modelCallId: "mc1", ordinal: 1 })
    socket.push(4, { type: "TEXT_MESSAGE_START", modelCallId: "mc1", messageId: "kept", role: "assistant" })
    socket.push(5, { type: "TEXT_MESSAGE_CONTENT", modelCallId: "mc1", messageId: "kept", delta: "kept" })
    socket.push(6, { type: "MODEL_CALL_COMMITTED", runId: "r1", modelCallId: "mc1", inputBoundaryId: "b1" })
    socket.push(7, { type: "MODEL_CALL_STARTED", runId: "r1", modelCallId: "mc2", ordinal: 2 })
    socket.push(8, { type: "TEXT_MESSAGE_START", modelCallId: "mc2", messageId: "partial", role: "assistant" })
    socket.push(9, { type: "TEXT_MESSAGE_CONTENT", modelCallId: "mc2", messageId: "partial", delta: "discard" })
    socket.push(10, { type: "RUN_INTERRUPTED", threadId: SESSION, runId: "r1" })
    expect(texts(view(client))).toEqual(["assistant:kept:interrupted"])
  })

  test("a failed run discards provisional parts while retaining an earlier committed response", async () => {
    const { server, client } = await signedIn()
    await client.open(SESSION)
    const socket = server.last()
    socket.push(1, created)
    socket.push(2, {
      type: "RUN_STARTED",
      threadId: SESSION,
      runId: "r1",
      selection,
      settingsRevision: "s1",
      cause: "user",
      userMessageIds: [],
      membership: [],
    })
    socket.push(3, { type: "MODEL_CALL_STARTED", runId: "r1", modelCallId: "mc1", ordinal: 1 })
    socket.push(4, { type: "TEXT_MESSAGE_START", modelCallId: "mc1", messageId: "kept", role: "assistant" })
    socket.push(5, { type: "TEXT_MESSAGE_CONTENT", modelCallId: "mc1", messageId: "kept", delta: "kept" })
    socket.push(6, { type: "MODEL_CALL_COMMITTED", runId: "r1", modelCallId: "mc1", inputBoundaryId: "b1" })
    socket.push(7, { type: "MODEL_CALL_STARTED", runId: "r1", modelCallId: "mc2", ordinal: 2 })
    socket.push(8, { type: "TEXT_MESSAGE_START", modelCallId: "mc2", messageId: "partial", role: "assistant" })
    socket.push(9, { type: "TEXT_MESSAGE_CONTENT", modelCallId: "mc2", messageId: "partial", delta: "discard" })
    socket.push(10, { type: "RUN_ERROR", runId: "r1", code: "state_integrity_failed", message: "commit failed" })
    expect(texts(view(client))).toEqual(["assistant:kept:failed"])
  })

  test("a cancelled run discards provisional parts while retaining committed output", async () => {
    const { server, client } = await signedIn()
    await client.open(SESSION)
    const socket = server.last()
    socket.push(1, created)
    socket.push(2, { type: "RUN_STARTED", threadId: SESSION, runId: "r1", selection, settingsRevision: "s1", cause: "user", userMessageIds: [], membership: [] })
    socket.push(3, { type: "MODEL_CALL_STARTED", runId: "r1", modelCallId: "mc1", ordinal: 1 })
    socket.push(4, { type: "TEXT_MESSAGE_START", modelCallId: "mc1", messageId: "kept", role: "assistant" })
    socket.push(5, { type: "TEXT_MESSAGE_CONTENT", modelCallId: "mc1", messageId: "kept", delta: "kept" })
    socket.push(6, { type: "MODEL_CALL_COMMITTED", runId: "r1", modelCallId: "mc1", inputBoundaryId: "b1" })
    socket.push(7, { type: "MODEL_CALL_STARTED", runId: "r1", modelCallId: "mc2", ordinal: 2 })
    socket.push(8, { type: "TEXT_MESSAGE_START", modelCallId: "mc2", messageId: "partial", role: "assistant" })
    socket.push(9, { type: "TEXT_MESSAGE_CONTENT", modelCallId: "mc2", messageId: "partial", delta: "discard" })
    socket.push(10, { type: "RUN_FINISHED", threadId: SESSION, runId: "r1", outcome: { type: "cancelled" } })
    expect(texts(view(client))).toEqual(["assistant:kept:cancelled"])
  })

  test("queued and failed sends leave questions open, reconnect clears ownership, and fork uses its adapter", async () => {
    const { server, client } = await signedIn()
    await client.open(SESSION)
    const socket = server.last()
    const question = {
      questionSetId: "q1",
      questions: [
        {
          id: "one",
          header: "One",
          question: "Pick?",
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
          ],
        },
      ],
    }
    socket.pushAction("a-q1", SESSION, "questions.answer", question)
    await client.send("queued", "queue")
    expect(socket.requests.at(-1)?.method).toBe("session.input")
    expect(client.store.getState().owned.questions).toEqual(["q1"])

    await client.send("steer")
    expect(socket.requests.slice(-2).map((request) => request.method)).toEqual(["session.input", "action.complete"])
    expect(client.store.getState().owned.questions).toEqual([])

    socket.pushAction("a-q3", SESSION, "questions.answer", { ...question, questionSetId: "q3" })
    await client.submit(SESSION, { text: "detached steer", mode: "steer", submissionId: "sub-q3" })
    expect(socket.requests.at(-1)?.method).toBe("action.complete")
    expect(client.store.getState().owned.questions).toEqual([])

    socket.pushAction("a-q4", SESSION, "questions.answer", { ...question, questionSetId: "q4" })
    await client.submit(SESSION, { text: "detached queue", mode: "queue", submissionId: "sub-q4" })
    expect(client.store.getState().owned.questions).toEqual(["q4"])

    socket.pushAction("a-q2", SESSION, "questions.answer", { ...question, questionSetId: "q2" })
    server.failInput = true
    await expect(client.send("refused")).rejects.toThrow()
    expect(client.store.getState().owned.questions).toEqual(["q4", "q2"])
    expect(
      socket.requests.some(
        (request) => request.method === "action.complete" && request.params.actionId === "a-q2",
      ),
    ).toBe(false)
    server.failInput = false

    const forked = await client.fork("r1")
    expect(forked.id).toBe("forked")
    expect(socket.requests.some((request) => request.method === "session.fork" && request.params.runId === "r1")).toBe(true)

    socket.pushAction("a-p1", SESSION, "permission.decide", {
      requestId: "p1",
      permission: "shell",
      subjects: ["ls"],
      patterns: ["ls"],
    })
    socket.drop()
    expect(client.store.getState().owned).toEqual({ questions: [], permissions: [] })
  })

  test("a rewound event applied live removes its range before later events apply", async () => {
    const { server, client } = await signedIn()
    await client.open(SESSION)
    const socket = server.last()
    for (const [seq, event] of firstTurn) socket.push(seq, event)
    socket.push(7, permission)
    socket.push(8, { type: "SESSION_REWOUND", runId: "r1", firstRemovedSeq: 2, clearedInputIds: [] })
    expect(texts(view(client))).toEqual([])
    expect(view(client).permissions).toEqual([])
    expect(view(client).runId).toBeNull()
    expect(view(client).lastSeq).toBe(8)
    socket.push(9, { type: "INPUT_RECEIVED", inputId: "i2", text: "greet me again", mode: "steer", sender })
    socket.push(10, { type: "RUN_STARTED", threadId: SESSION, runId: "r2", selection, settingsRevision: "s2", cause: "user", userMessageIds: ["i2"], membership: [{ kind: "system", inputId: "system:1" }, { kind: "user", inputId: "i2" }] })
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
    expect(second.methods()).toEqual([
      "auth.authenticate",
      "models.list",
      "agents.list",
      "session.list",
      "actions.list",
      "client.setActions",
      "session.subscribe",
    ])
    expect(second.requests.at(-1)!.params).toEqual({ sessionId: SESSION, afterSeq: 4 })
    // The replay after 4: the rest of the first turn, the rewind of 2 on at 7, then a new input.
    for (const [seq, event] of firstTurn.slice(4)) second.push(seq, event)
    second.push(7, { type: "SESSION_REWOUND", runId: "r1", firstRemovedSeq: 2, clearedInputIds: [] })
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
    await until("the new refresh token", () => storage.entries.get(storageKeys.refreshToken(SERVER_URL)) === "refresh-2")
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
    expect(storage.entries.has(storageKeys.refreshToken(SERVER_URL))).toBe(false)
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
      { type: "RUN_STARTED", threadId: SESSION, runId: "r1", selection, settingsRevision: "s1", cause: "user", userMessageIds: ["i1"], membership: [{ kind: "system", inputId: "system:1" }, { kind: "user", inputId: "i1" }] },
      entry(1, "open", { Text: "Write the parser" }),
      entry(2, "compaction", { Text: "Requests:\n- old" }),
      { type: "TIMELINE_ENTRY_REPLACED", runId: "r1", number: 2, text: "Requests:\n- new" },
      { type: "TOOL_CALL_START", modelCallId: "mc1", toolCallId: "tq", toolCallName: "context_ask_question" },
      { type: "QUESTIONS_ASKED", runId: "r1", toolCallId: "tq", questionSetId: "qs1", feedback: "Noted.", questions: [question] },
    ]
    events.forEach((event, index) => socket.push(index + 1, event))
    socket.pushAction("a-q", SESSION, "questions.answer", { questionSetId: "qs1", feedback: "Noted.", questions: [question] })
    expect(texts(view(client))).toEqual(["user:start", "entry:#1 open", "entry:#2 compaction", "assistant:context_ask_question:running", "questions:open"])
    expect(view(client).items.find((item) => item.kind === "entry" && item.entry.number === 2)).toMatchObject({ entry: { fields: { Text: "Requests:\n- new" } } })
    expect(view(client).items.at(-1)).toMatchObject({ kind: "questions", feedback: "Noted.", questions: [question] })

    await client.answerQuestion("qs1", [{ id: "q1", selection: "SQLite", note: "Keep it local." }])
    expect(socket.requests.at(-1)).toMatchObject({
      method: "action.complete",
      params: {
        sessionId: SESSION,
        actionId: "a-q",
        result: { kind: "answered", answers: [{ id: "q1", selection: "SQLite", note: "Keep it local." }] },
      },
    })
    const later: Array<SessionEventBody> = [
      { type: "QUESTIONS_ANSWERED", questionSetId: "qs1", answers: [{ id: "q1", selection: "SQLite", note: "Keep it local." }], sender },
      entry(3, "answer", { Question: "Where?", Selection: "SQLite: a file", UserNote: "Keep it local." }),
      { type: "TOOL_CALL_RESULT", modelCallId: "mc1", messageId: "rq", toolCallId: "tq", content: "[ANSWER #3]", role: "tool", outcome: "success" },
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
      { type: "RUN_STARTED", threadId: SESSION, runId: "r2", selection, settingsRevision: "s2", cause: "continuation", userMessageIds: ["i2", "i3"], membership: [{ kind: "system", inputId: "system:1" }, { kind: "developer", inputId: "d1" }, { kind: "user", inputId: "i2" }, { kind: "user", inputId: "i3" }] },
      { type: "RUN_FINISHED", threadId: SESSION, runId: "r2", outcome: { type: "success" } },
    )
    expect(pending()).toEqual([])
    expect(texts(view(client)).slice(11)).toEqual(["mark:window", "developer:Continuation", "user:held one|held two", "mark:continuation"])

    // A rerun without an edit holds both messages again, under new ids, until both are received.
    push({ type: "SESSION_REWOUND", runId: "r2", firstRemovedSeq: continuationStart, clearedInputIds: [] })
    push({ type: "INPUT_WAITING", inputId: "i4", text: "held one", mode: "steer", sender }, { type: "INPUT_WAITING", inputId: "i5", text: "held two", mode: "steer", sender })
    expect(view(client).pending.map((input) => input.inputId)).toEqual(["i4", "i5"])
    expect(texts(view(client)).slice(11)).toEqual(["mark:window"])
    const rerunStart = seq + 1
    push({ type: "INPUT_RECEIVED", inputId: "i4", text: "held one", mode: "steer", sender })
    expect(view(client).pending.map((input) => input.inputId)).toEqual(["i5"])
    push(
      { type: "INPUT_RECEIVED", inputId: "i5", text: "held two", mode: "steer", sender },
      { type: "RUN_STARTED", threadId: SESSION, runId: "r3", selection, settingsRevision: "s3", cause: "continuation", userMessageIds: ["i4", "i5"], membership: [{ kind: "system", inputId: "system:1" }, { kind: "user", inputId: "i4" }, { kind: "user", inputId: "i5" }] },
      { type: "RUN_FINISHED", threadId: SESSION, runId: "r3", outcome: { type: "success" } },
    )
    expect(pending()).toEqual([])

    // An edit at the continuation turn leaves only the edit pending, and no message an earlier rewind removed returns.
    push({ type: "SESSION_REWOUND", runId: "r3", firstRemovedSeq: rerunStart, clearedInputIds: [] })
    push({ type: "INPUT_WAITING", inputId: "i6", text: "edited", mode: "steer", sender })
    expect(view(client).pending.map((input) => input.inputId)).toEqual(["i6"])
    expect(texts(view(client)).slice(0, 11).at(-1)).toBe("mark:clearing")
  })
})

describe("GitHub browser sign-in", () => {
  test("a later visit refreshes only the configured endpoint's token", async () => {
    const server = new FakeServer()
    const h = fakePorts(server)
    h.storage.setItem(storageKeys.refreshToken(SERVER_URL), "matching-server-token")
    h.storage.setItem(storageKeys.refreshToken("wss://another.example/v1/ws"), "another-server-token")
    const client = new SessionClient(h.ports)
    client.resume()
    await until("resumed", () => client.store.getState().status === "connected")
    expect(server.last().url).toBe(SERVER_URL)
    expect(server.last().requests[0]).toMatchObject({ method: "auth.refresh", params: { refreshToken: "matching-server-token" } })
    client.signOut()
    expect(h.storage.getItem(storageKeys.refreshToken("wss://another.example/v1/ws"))).toBe("another-server-token")
  })

  test("a refresh token for another endpoint is never sent to the configured server", () => {
    const server = new FakeServer()
    const h = fakePorts(server)
    h.storage.setItem(storageKeys.refreshToken("wss://another.example/v1/ws"), "another-server-token")
    const client = new SessionClient(h.ports)
    client.resume()
    expect(client.store.getState().serverUrl).toBe(h.ports.serverUrl)
    expect(client.store.getState().status).toBe("signedOut")
    expect(server.sockets).toHaveLength(0)
  })

  test("a callback for another configured endpoint is discarded without exchanging", () => {
    const server = new FakeServer()
    const h = fakePorts(server)
    h.pending.setItem(storageKeys.verifier, "verifier")
    h.pending.setItem(storageKeys.signInServer, "wss://another.example/v1/ws")
    h.setFragment("#signIn=once")
    const client = new SessionClient(h.ports)
    client.resume()
    expect(h.fragment()).toBe("")
    expect(h.pending.entries.size).toBe(0)
    expect(server.sockets).toHaveLength(0)
    expect(client.store.getState().error).toContain("no pending sign-in")
  })

  test("start keeps a tab verifier and callback removes its fragment before connecting and exchanging", async () => {
    const server = new FakeServer()
    const h = fakePorts(server, "wss://server.test/v1/ws")
    const client = new SessionClient(h.ports)
    await client.signIn()
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
    expect(h.storage.getItem(storageKeys.refreshToken("wss://server.test/v1/ws"))).toBe("refresh-1")
    expect(h.pending.getItem(storageKeys.signInServer)).toBeNull()
    returned.signOut()
  })

  test("a return missing either tab value sends no exchange and removes its fragment", () => {
    for (const missing of [storageKeys.verifier, storageKeys.signInServer]) {
      const server = new FakeServer()
      const h = fakePorts(server)
      h.pending.setItem(storageKeys.verifier, "verifier")
      h.pending.setItem(storageKeys.signInServer, "ws://server.test/v1/ws")
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
      h.pending.setItem(storageKeys.signInServer, "ws://server.test/v1/ws")
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
    h.pending.setItem(storageKeys.signInServer, "ws://server.test/v1/ws")
    h.setFragment("#signIn=once")
    const client = new SessionClient(h.ports)
    client.resume()
    await until("failed exchange", () => client.store.getState().error !== null)
    expect(client.store.getState().error).toBe("invalid sign-in code")
    expect(h.pending.entries.size).toBe(0)
    expect(h.storage.getItem(storageKeys.refreshToken(SERVER_URL))).toBeNull()
  })
})

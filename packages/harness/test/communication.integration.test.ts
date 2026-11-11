import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { agentRunner } from "../src/agent/runner.ts"
import { responsesModelPort } from "../src/agent/model.ts"
import { cancelSession, Client, forkSession, rewindSession, waitFor } from "./support/cli.ts"
import { callTools, configuredModel, failWith, FakeModel, messageText, say, testTools } from "./support/agent.ts"
import { SessionView, TestServer, type TestServerOptions } from "./support/server.ts"

const response = (id: string) => ({
  id,
  object: "response",
  status: "completed",
  model: "m",
  output: [],
  usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
})

const sse = (events: ReadonlyArray<Record<string, unknown>>) =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")

const textReply = (text: string) => [
  { type: "response.created", response: { ...response("text"), status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg", role: "assistant", status: "in_progress", content: [] } },
  { type: "response.output_text.delta", item_id: "msg", output_index: 0, content_index: 0, delta: text },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "message", id: "msg", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] },
  },
  { type: "response.completed", response: response("text") },
]

let calls = 0
const toolReply = (name: string, args: unknown) => {
  const id = `call-${++calls}`
  return [
    { type: "response.created", response: { ...response("tool"), status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id, call_id: id, name, arguments: "" },
    },
    { type: "response.function_call_arguments.delta", item_id: id, output_index: 0, delta: JSON.stringify(args) },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "function_call", id, call_id: id, name, arguments: JSON.stringify(args), status: "completed" },
    },
    { type: "response.completed", response: response("tool") },
  ]
}

const fakeResponsesApi = (reply: (body: Record<string, any>) => ReadonlyArray<Record<string, unknown>>) => {
  const captured: Array<Record<string, any>> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json() as Record<string, any>
      captured.push(body)
      return new Response(sse(reply(body)), { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { captured, baseUrl: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

const planned = configuredModel("test/alpha", { contextLimit: 300_000 })
const realOptions = (baseUrl: string): TestServerOptions => {
  const port = responsesModelPort((id) => id === planned.id
    ? { baseURL: baseUrl, apiKey: "synthetic-key", upstream: id.slice(id.indexOf("/") + 1) }
    : undefined)
  return { models: [planned], modelPort: port, runner: agentRunner({ port, models: [planned] }) }
}

const login = async (url: string, token: string) => {
  const client = await Client.connect(url)
  const auth = await client.request("auth.authenticate", { token, protocolVersion: 1 })
  if (auth.error !== undefined) throw new Error(auth.error.message)
  return client
}

const create = async (client: Client) => {
  const made = await client.request("session.create", {})
  if (made.error !== undefined) throw new Error(made.error.message)
  return made.result.session.id as string
}

const finished = (view: SessionView, count: number) =>
  waitFor(`${count} ended turns`, () =>
    view.events.filter(({ event }) => event.type === "RUN_FINISHED" || event.type === "RUN_ERROR").length >= count
      ? true
      : undefined,
  )

const inputs = (body: Record<string, any>) => body.input as ReadonlyArray<Record<string, any>>
const afterTool = (body: Record<string, any>) => inputs(body).at(-1)?.type === "function_call_output"
const hasText = (body: Record<string, any>, text: string) => JSON.stringify(body.input).includes(text)
const serverSender = { kind: "login" as const, loginId: "owner" }

describe("session communication through a real WebSocket and provider", () => {
  test("session.message without a target creates a session with the caller's effective selection", async () => {
    const api = fakeResponsesApi((body) => {
      if (afterTool(body)) return textReply("source complete")
      if (hasText(body, "create a peer")) return toolReply("session_message", { text: "fresh work" })
      return textReply("fresh complete")
    })
    const server = new TestServer({}, realOptions(api.baseUrl))
    try {
      await server.start()
      const token = server.token("owner")
      const client = await login(server.url, token)
      const source = await create(client)
      const sourceView = await SessionView.open(server.url, token, source)
      const sent = await client.request("session.input", { sessionId: source, text: "create a peer" })
      expect(sent.error).toBeUndefined()
      await finished(sourceView, 1)
      const receipt = sourceView.events
        .filter(({ event }) => event.type === "TOOL_CALL_RESULT")
        .map(({ event }) => event.content as string)
        .map((content) => { try { return JSON.parse(content) } catch { return null } })
        .find((value) => value?.created === true)
      expect(receipt).toMatchObject({ created: true })
      expect(typeof receipt.sessionId).toBe("string")
      const target = receipt.sessionId as string
      const targetView = await SessionView.open(server.url, token, target)
      await finished(targetView, 1)
      const targetListed = (await client.request("session.list")).result.sessions.find((session: any) => session.id === target)
      expect(targetListed.selection).toMatchObject({
        agentTitle: "untitled",
        modelSettings: { modelId: "test/alpha", reasoningEffort: null },
      })
      const db = new Database(server.databasePath, { readonly: true })
      try {
        expect(db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM turns WHERE session_id = ?").get(target)).toEqual({ n: 1 })
        expect(db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM window_items WHERE session_id = ? AND kind = 'user'").get(target)).toEqual({ n: 1 })
      } finally {
        db.close()
      }
      const targetBodies = api.captured.filter((body) =>
        JSON.stringify(body.input).includes(`Session id: \`${target}\``),
      )
      expect(targetBodies.length).toBeGreaterThan(0)
      for (const body of targetBodies) expect(JSON.stringify(body.input)).not.toContain("create a peer")
      client.close()
    } finally {
      await server.cleanup()
      api.stop()
    }
  })

  test("a subscription is future-only and keeps its progress across a server restart", async () => {
    let source = ""
    let observer = ""
    const api = fakeResponsesApi((body) => {
      const forSource = JSON.stringify(body.input).includes(`Session id: \`${source}\``)
      const forObserver = JSON.stringify(body.input).includes(`Session id: \`${observer}\``)
      const calledTool = inputs(body).some((item) => item.type === "function_call")
      if (afterTool(body)) return textReply("tool complete")
      if (forObserver && !calledTool && hasText(body, "subscribe now")) {
        return toolReply("session_subscription", {
          sourceSessionId: source,
          action: "subscribe",
          messages: ["agent_final"],
        })
      }
      if (forSource && hasText(body, "publish after")) return textReply("after reply")
      if (forSource && hasText(body, "publish before")) return textReply("before reply")
      return textReply("done")
    })
    const server = new TestServer({}, realOptions(api.baseUrl))
    try {
      await server.start()
      const token = server.token("owner")
      let client = await login(server.url, token)
      source = await create(client)
      observer = await create(client)
      const sourceView = await SessionView.open(server.url, token, source)
      await client.request("session.input", { sessionId: source, text: "publish before" })
      await finished(sourceView, 1)

      const observerView = await SessionView.open(server.url, token, observer)
      await client.request("session.input", { sessionId: observer, text: "subscribe now" })
      await finished(observerView, 1)
      await client.request("session.input", { sessionId: source, text: "publish after" })
      await finished(sourceView, 2)
      await finished(observerView, 2)
      const beforeRestart = api.captured
        .filter((body) => JSON.stringify(body.input).includes(`Session id: \`${observer}\``))
        .map((body) => JSON.stringify(body.input))
      expect(beforeRestart.some((text) => text.includes("after reply"))).toBe(true)
      expect(beforeRestart.some((text) => text.includes("Session Message") && text.includes("before reply"))).toBe(false)

      client.close()
      await server.restart()
      client = await login(server.url, token)
      const restoredSource = await SessionView.open(server.url, token, source)
      const restoredObserver = await SessionView.open(server.url, token, observer)
      await client.request("session.input", { sessionId: source, text: "publish after restart" })
      await waitFor("the source turn after restart", () =>
        restoredSource.events.filter(({ event }) => event.type === "RUN_FINISHED").length >= 3 ? true : undefined,
      )
      await waitFor("the observer turn after restart", () =>
        restoredObserver.events.filter(({ event }) => event.type === "RUN_FINISHED").length >= 3 ? true : undefined,
      )
      const afterRestart = api.captured
        .filter((body) => JSON.stringify(body.input).includes(`Session id: \`${observer}\``))
        .map((body) => JSON.stringify(body.input))
      expect(afterRestart.some((text) => text.includes("Session Message") && text.includes("after reply"))).toBe(true)
      const db = new Database(server.databasePath, { readonly: true })
      try {
        expect(db.query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM subscription_deliveries WHERE receiver_session_id = ? AND status = 'admitted'",
        ).get(observer)).toEqual({ n: 2 })
      } finally {
        db.close()
      }
      client.close()
    } finally {
      await server.cleanup()
      api.stop()
    }
  })

  test("peer messages retain attachments across source rewind", async () => {
    let target = ""
    const refs: Array<Record<string, string>> = []
    const api = fakeResponsesApi((body) => {
      if (afterTool(body)) return textReply("forwarded")
      if (hasText(body, "forward attachment") && !inputs(body).some((item) => item.type === "function_call")) {
        return toolReply("session_message", { sessionId: target, text: "attached work", attachments: refs })
      }
      return textReply("done")
    })
    const server = new TestServer({}, realOptions(api.baseUrl))
    try {
      await server.start()
      const token = server.token("owner")
      const client = await login(server.url, token)
      const source = await create(client)
      target = await create(client)
      const bytes = Buffer.from("peer attachment")
      const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
      const made = await client.request("upload.create", {
        draftId: "peer-draft",
        name: "peer.txt",
        mediaType: "text/plain",
        size: bytes.byteLength,
      })
      const uploadId = made.result.upload.uploadId as string
      await client.request("upload.append", { uploadId, offset: 0, data: bytes.toString("base64") })
      const finalized = await client.request("upload.finalize", { uploadId, size: bytes.byteLength, digest })
      expect(finalized.error).toBeUndefined()
      const uploadRead = new Database(server.databasePath, { readonly: true })
      const attachmentId = uploadRead.query<{ attachment_id: string }, [string]>(
        "SELECT attachment_id FROM uploads WHERE upload_id = ?",
      ).get(uploadId)!.attachment_id
      uploadRead.close()
      refs.push({ attachmentId, contentId: digest, representationId: digest, name: "peer.txt", mediaType: "text/plain", digest })
      const sourceView = await SessionView.open(server.url, token, source)
      const sent = await client.request("session.input", {
        sessionId: source,
        text: "forward attachment",
        attachments: refs,
      })
      expect(sent.error).toBeUndefined()
      await finished(sourceView, 1)
      const receipt = sourceView.events
        .filter(({ event }) => event.type === "TOOL_CALL_RESULT")
        .map(({ event }) => {
          try { return JSON.parse(event.content as string) } catch { return null }
        })
        .find((value) => value?.sessionId === target)
      expect(receipt).toMatchObject({ sessionId: target, created: false })
      const targetView = await SessionView.open(server.url, token, target)
      await finished(targetView, 1)
      const read = new Database(server.databasePath, { readonly: true })
      try {
        expect(read.query<{ n: number }, [string, string]>(
          "SELECT count(*) AS n FROM attachment_references WHERE session_id = ? AND reference_id = ?",
        ).get(target, receipt.inputId)).toEqual({ n: 1 })
      } finally {
        read.close()
      }
      const content = await client.request("content.get", {
        sessionId: target,
        contentId: digest,
        referenceId: receipt.inputId,
      })
      expect(content.result.content).toMatchObject({ available: true })
      const sourceRun = sourceView.events.find(({ event }) => event.type === "RUN_STARTED")!.event.runId as string
      const rewound = await rewindSession(client, { sessionId: source, runId: sourceRun })
      expect(rewound.error).toBeUndefined()
      const stillThere = await client.request("content.get", {
        sessionId: target,
        contentId: digest,
        referenceId: receipt.inputId,
      })
      expect(stillThere.result.content).toMatchObject({ available: true, sessionId: target })
      client.close()
    } finally {
      await server.cleanup()
      api.stop()
    }
  })

  test("a published user attachment stays recipient-owned after source rewind and expiry", async () => {
    let source = ""
    let observer = ""
    const refs: Array<Record<string, string>> = []
    const api = fakeResponsesApi((body) => {
      const forObserver = JSON.stringify(body.input).includes(`Session id: \`${observer}\``)
      if (afterTool(body)) return textReply("done")
      if (forObserver && hasText(body, "subscribe")) {
        return toolReply("session_subscription", { sourceSessionId: source, action: "subscribe", messages: ["user"] })
      }
      return textReply("published")
    })
    const server = new TestServer({}, realOptions(api.baseUrl))
    try {
      await server.start()
      const token = server.token("owner")
      const client = await login(server.url, token)
      source = await create(client)
      observer = await create(client)
      const observerView = await SessionView.open(server.url, token, observer)
      await client.request("session.input", { sessionId: observer, text: "subscribe" })
      await finished(observerView, 1)

      const bytes = Buffer.from("published attachment")
      const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
      const made = await client.request("upload.create", {
        draftId: "published-draft",
        name: "published.txt",
        mediaType: "text/plain",
        size: bytes.byteLength,
      })
      const uploadId = made.result.upload.uploadId as string
      await client.request("upload.append", { uploadId, offset: 0, data: bytes.toString("base64") })
      await client.request("upload.finalize", { uploadId, size: bytes.byteLength, digest })
      const uploadRead = new Database(server.databasePath, { readonly: true })
      const attachmentId = uploadRead.query<{ attachment_id: string }, [string]>(
        "SELECT attachment_id FROM uploads WHERE upload_id = ?",
      ).get(uploadId)!.attachment_id
      uploadRead.close()
      refs.push({ attachmentId, contentId: digest, representationId: digest, name: "published.txt", mediaType: "text/plain", digest })

      const sourceView = await SessionView.open(server.url, token, source)
      await client.request("session.input", {
        sessionId: source,
        text: "publish attached",
        attachments: refs,
      })
      await finished(sourceView, 1)
      await finished(observerView, 2)
      const hub = await server.hub()
      const delivery = hub.store.db.query<{ input_id: string }, [string, string]>(
        `SELECT d.input_id FROM subscription_deliveries d
          JOIN subscription_publications p ON p.publication_id = d.publication_id
          WHERE p.source_session_id = ? AND d.receiver_session_id = ?`,
      ).get(source, observer)!
      const references = () => {
        const db = new Database(server.databasePath, { readonly: true })
        try {
          return db.query<{ n: number }, [string, string]>(
            "SELECT count(*) AS n FROM attachment_references WHERE session_id = ? AND reference_id = ?",
          ).get(observer, delivery.input_id)!.n
        } finally {
          db.close()
        }
      }
      expect(references()).toBe(1)
      const sourceRun = sourceView.events.find(({ event }) => event.type === "RUN_STARTED")!.event.runId
      await rewindSession(client, { sessionId: source, runId: sourceRun })
      hub.attachments.expire(Date.now() + 365 * 24 * 60 * 60 * 1000)
      expect(references()).toBe(1)
      const read = await client.request("content.get", {
        sessionId: observer,
        contentId: digest,
        referenceId: delivery.input_id,
      })
      expect(read.result.content).toMatchObject({ available: true, sessionId: observer })
      client.close()
      await server.restart()
      const restored = await login(server.url, token)
      const after = await restored.request("content.get", {
        sessionId: observer,
        contentId: digest,
        referenceId: delivery.input_id,
      })
      expect(after.result.content).toMatchObject({ available: true, sessionId: observer })
      restored.close()
    } finally {
      await server.cleanup()
      api.stop()
    }
  }, 30_000)

  test("an early readiness failure publishes one abnormal notice over the real server", async () => {
    const main = new FakeModel()
    const server = new TestServer({}, {
      models: [planned],
      modelPort: main,
      runner: agentRunner({ port: main, models: [planned] }),
      tools: () => testTools(),
    })
    try {
      await server.start()
      const token = server.token("owner")
      const client = await login(server.url, token)
      const source = await create(client)
      const observer = await create(client)
      const observerView = await SessionView.open(server.url, token, observer)
      main.next(
        callTools([{ name: "session_subscription", args: { sourceSessionId: source, action: "subscribe" } }]),
        say("subscribed"),
        say("observer saw failure"),
      )
      await client.request("session.input", { sessionId: observer, text: "subscribe" })
      await finished(observerView, 1)
      await client.request("session.input", {
        sessionId: source,
        text: "invalid",
        selection: { modelSettings: { modelId: "test/missing" } },
      })
      await finished(observerView, 2)
      const seen = main.calls.map(({ call }) => call.messages.map(messageText).join("\n"))
        .find((text) => text.includes("Subscribed Session Stopped Abnormally"))
      expect(seen).toContain("the model test/missing is not configured")
      const db = new Database(server.databasePath, { readonly: true })
      try {
        expect(db.query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM subscription_publications WHERE source_session_id = ? AND category = 'abnormal'",
        ).get(source)).toEqual({ n: 1 })
      } finally {
        db.close()
      }
      client.close()
      await server.restart()
      const after = new Database(server.databasePath, { readonly: true })
      try {
        expect(after.query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM subscription_publications WHERE source_session_id = ? AND category = 'abnormal'",
        ).get(source)).toEqual({ n: 1 })
      } finally {
        after.close()
      }
    } finally {
      await server.cleanup()
    }
  }, 30_000)

  test("recipient rewind marks its cleared pending delivery removed across restart", async () => {
    const main = new FakeModel()
    const server = new TestServer({}, {
      models: [planned],
      modelPort: main,
      runner: agentRunner({ port: main, models: [planned] }),
      tools: () => testTools(),
    })
    try {
      await server.start()
      const token = server.token("owner")
      const client = await login(server.url, token)
      const source = await create(client)
      const observer = await create(client)
      const observerView = await SessionView.open(server.url, token, observer)
      main.next(
        callTools([{ name: "session_subscription", args: { sourceSessionId: source, action: "subscribe" } }]),
        say("subscribed"),
      )
      await client.request("session.input", { sessionId: observer, text: "subscribe" })
      await finished(observerView, 1)
      const hub = await server.hub()
      main.next(callTools([{ name: "wait", args: {} }]))
      await client.request("session.input", { sessionId: observer, text: "hold" })
      await waitFor("the held observer", () => hub.isRunning(observer) ? true : undefined)
      main.next(say("pending delivery"))
      await client.request("session.input", { sessionId: source, text: "publish pending" })
      await waitFor("the pending delivery", () =>
        hub.store.conversation.waiting(observer).some((entry) => entry.kind === "notification") ? true : undefined,
      )
      const inputId = hub.store.conversation.waiting(observer).find((entry) => entry.kind === "notification")!.inputId
      const runId = hub.store.turns(observer)[0]!.runId
      const rewound = await rewindSession(client, { sessionId: observer, runId })
      expect(rewound.error).toBeUndefined()
      const status = () => {
        const db = new Database(server.databasePath, { readonly: true })
        try {
          return db.query<{ status: string }, [string, string]>(
            "SELECT status FROM subscription_deliveries WHERE receiver_session_id = ? AND input_id = ?",
          ).get(observer, inputId)
        } finally {
          db.close()
        }
      }
      expect(status()).toEqual({ status: "removed" })
      expect(hub.store.conversation.waiting(observer).some((entry) => entry.inputId === inputId)).toBe(false)
      client.close()
      await server.restart()
      expect(status()).toEqual({ status: "removed" })
    } finally {
      await server.cleanup()
    }
  }, 30_000)

  test("replacement, filter, and unsubscribe effects use real persistence", async () => {
    const main = new FakeModel()
    const server = new TestServer({}, {
      models: [planned],
      modelPort: main,
      runner: agentRunner({ port: main, models: [planned] }),
    })
    try {
      await server.start()
      const token = server.token("owner")
      const client = await login(server.url, token)
      const source = await create(client)
      const observer = await create(client)
      const observerView = await SessionView.open(server.url, token, observer)
      main.next(
        callTools([{ name: "session_subscription", args: { sourceSessionId: source, action: "subscribe", messages: ["user"] } }]),
        say("subscribed user"),
        callTools([{ name: "session_subscription", args: { sourceSessionId: source, action: "subscribe", messages: ["agent_final"] } }]),
        say("subscribed final"),
      )
      await client.request("session.input", { sessionId: observer, text: "subscribe user" })
      await finished(observerView, 1)
      await client.request("session.input", { sessionId: observer, text: "subscribe final" })
      await finished(observerView, 2)
      const hub = await server.hub()
      const db = new Database(server.databasePath, { readonly: true })
      try {
        expect(db.query<{ messages: string }, [string, string]>(
          "SELECT messages FROM session_subscriptions WHERE receiver_session_id = ? AND source_session_id = ?",
        ).all(observer, source)).toEqual([{ messages: '["agent_final"]' }])
      } finally {
        db.close()
      }

      const state = (hub as any).state(observer)
      state.controlled = true
      const sourceView = await SessionView.open(server.url, token, source)
      main.next(say("pending final"))
      await client.request("session.input", { sessionId: source, text: "pending final" })
      await finished(sourceView, 1)
      expect(hub.store.conversation.waiting(observer)).toHaveLength(1)
      const run = (action: "subscribe" | "unsubscribe", messages?: ReadonlyArray<"user" | "agent_intermediate" | "agent_final">) =>
        hub.subscription({
          sessionId: observer,
          runId: hub.store.turns(observer).at(-1)!.runId,
          agentTitle: "untitled",
          modelId: planned.id,
          reasoningEffort: null,
          toolCallId: "test",
          cwd: server.sessionsDir,
          imageInput: false,
          signal: new AbortController().signal,
          deadline: Number.POSITIVE_INFINITY,
          clock: hub.toolPolicy.clock,
          authorize: async () => {},
          started: () => {},
          onCancel: () => {},
          programCall: () => {},
          offered: () => true,
          note: () => undefined,
        } as any, { sourceSessionId: source, action, ...(messages === undefined ? {} : { messages }) })
      const pendingStatus = () => {
        const read = new Database(server.databasePath, { readonly: true })
        try {
          return read.query<{ status: string }, [string]>(
            "SELECT status FROM subscription_deliveries WHERE receiver_session_id = ? ORDER BY created_at DESC LIMIT 1",
          ).get(observer)?.status
        } finally {
          read.close()
        }
      }
      await run("subscribe", ["user"])
      expect(hub.store.conversation.waiting(observer)).toEqual([])
      expect(pendingStatus()).toBe("removed")

      main.next(say("pending unsubscribe"))
      await client.request("session.input", { sessionId: source, text: "pending unsubscribe" })
      await finished(sourceView, 2)
      expect(hub.store.conversation.waiting(observer)).toHaveLength(1)
      await run("unsubscribe")
      expect(hub.store.conversation.waiting(observer)).toEqual([])
      expect(pendingStatus()).toBe("removed")
      expect(hub.communication.filter(observer, source)).toBeNull()

      await run("subscribe", ["agent_intermediate"])
      await client.request("session.input", {
        sessionId: source,
        text: "fail source",
        selection: { modelSettings: { modelId: "test/missing" } },
      })
      await finished(sourceView, 3)
      expect(hub.store.conversation.waiting(observer)).toHaveLength(1)
      await run("unsubscribe")
      expect(hub.store.conversation.waiting(observer)).toEqual([])
      expect(pendingStatus()).toBe("removed")
      state.controlled = false
      client.close()
      await server.restart()
      const restored = await SessionView.open(server.url, token, observer)
      expect(restored.events.some(({ event }) => event.type === "INPUT_RECEIVED" && event.sender.kind === "session")).toBe(false)
    } finally {
      await server.cleanup()
    }
  }, 30_000)

  test("cancel and rewind before a batch settles publish no staged fork", async () => {
    const main = new FakeModel()
    const server = new TestServer({}, {
      models: [planned],
      modelPort: main,
      runner: agentRunner({ port: main, models: [planned] }),
    })
    try {
      await server.start()
      const token = server.token("owner")
      const client = await login(server.url, token)
      const cancelled = await create(client)
      const rewound = await create(client)
      const forkReply = () => callTools([
        { name: "session_wait", args: { timeout_ms: 10_000 } },
        { name: "session_fork", args: {} },
      ])
      for (const session of [cancelled, rewound]) {
        main.next(forkReply())
        const view = await SessionView.open(server.url, token, session)
        await client.request("session.input", { sessionId: session, text: "wait before fork" })
        await waitFor("the pre-fork wait", () =>
          view.events.some(({ event }) => event.type === "TOOL_EXECUTION_STARTED") ? true : undefined,
        )
        if (session === cancelled) {
          await cancelSession(client, session)
          await finished(view, 1)
        } else {
          const runId = view.events.find(({ event }) => event.type === "RUN_STARTED")!.event.runId
          const result = await rewindSession(client, { sessionId: session, runId })
          expect(result.error).toBeUndefined()
        }
      }
      const inspect = () => {
        const db = new Database(server.databasePath, { readonly: true })
        try {
          return {
            intents: db.query<{ n: number }, []>("SELECT count(*) AS n FROM agent_fork_intents").get()!.n,
            continued: db.query<{ n: number }, [string, string]>(
              `SELECT count(*) AS n FROM events
                WHERE session_id IN (?, ?) AND json_extract(body, '$.type') = 'TOOL_CALL_RESULT'
                  AND json_extract(body, '$.content') LIKE '%"continued":true%'`,
            ).get(cancelled, rewound)!.n,
            rewoundHistory: db.query<{ n: number }, [string]>(
              "SELECT count(*) AS n FROM session_entries WHERE session_id = ? AND kind IN ('agent', 'tool')",
            ).get(rewound)!.n,
          }
        } finally {
          db.close()
        }
      }
      expect(inspect()).toEqual({ intents: 0, continued: 0, rewoundHistory: 0 })
      const listed = await client.request("session.list")
      expect(listed.result.sessions.filter((session: any) => session.id === cancelled || session.id === rewound)).toHaveLength(2)
      client.close()
      await server.restart()
      expect(inspect()).toEqual({ intents: 0, continued: 0, rewoundHistory: 0 })
    } finally {
      await server.cleanup()
    }
  }, 30_000)

  test("mixed automatic and explicit origins co-admit and survive fork and restart once", async () => {
    const main = new FakeModel()
    const server = new TestServer({}, {
      models: [planned],
      modelPort: main,
      runner: agentRunner({ port: main, models: [planned] }),
    })
    try {
      await server.start()
      const token = server.token("owner")
      const client = await login(server.url, token)
      const origin = await create(client)
      const target = await create(client)
      const observer = await create(client)
      const observerView = await SessionView.open(server.url, token, observer)
      main.next(callTools([{ name: "session_subscription", args: { sourceSessionId: target, action: "subscribe" } }]), say("subscribed"))
      await client.request("session.input", { sessionId: observer, text: "subscribe" })
      await finished(observerView, 1)

      const hub = await server.hub()
      const automaticId = crypto.randomUUID()
      const explicitId = crypto.randomUUID()
      const sender = { kind: "session" as const, sessionId: origin, agentTitle: "untitled", modelId: planned.id }
      hub.store.db.transaction(() => {
        hub.store.conversation.addWaiting(target, {
          kind: "notification",
          inputId: automaticId,
          component: { type: "notification", name: "test", heading: "Automatic", text: "automatic work", sources: {} },
          trigger: "notification",
          reaction: { publicationId: "origin-failure", rootId: "root", visited: [origin, target], automatic: true },
        }, Date.now())
        hub.store.conversation.addWaiting(target, {
          kind: "user",
          inputId: explicitId,
          text: "explicit work",
          mode: "steer",
          sender,
        }, Date.now() + 1)
        hub.store.appendEvent(target, {
          type: "INPUT_WAITING",
          inputId: automaticId,
          text: "automatic work",
          mode: "steer",
          sender: serverSender,
        }, Date.now())
        hub.store.appendEvent(target, {
          type: "INPUT_WAITING",
          inputId: explicitId,
          text: "explicit work",
          mode: "steer",
          sender,
        }, Date.now() + 1)
      })()

      const routed = async function* (call: any, signal: AbortSignal) {
        const text = call.messages.map(messageText).join("\n")
        if (text.includes("# Fork")) yield* say("branch survived")(call, signal)
        else if (text.includes("Subscribed Session Stopped Abnormally")) yield* say("observer noticed")(call, signal)
        else yield* failWith(new Error("mixed failure"))(call, signal)
      }
      main.next(callTools([{ name: "session_fork", args: {} }]), routed, routed, routed)
      const targetView = await SessionView.open(server.url, token, target)
      const resumed = await client.request("session.resume", { sessionId: target })
      expect(resumed.error).toBeUndefined()
      await finished(targetView, 1)
      const fork = targetView.events.find(({ event }) =>
        event.type === "TOOL_CALL_RESULT" && event.content.includes('"continued":true'),
      )!.event as any
      const branch = JSON.parse(fork.content).sessionId as string
      const branchView = await SessionView.open(server.url, token, branch)
      await finished(branchView, 1)
      await finished(observerView, 2)
      expect(targetView.events.find(({ event }) => event.type === "RUN_STARTED")!.event.userMessageIds)
        .toEqual([explicitId])
      expect(branchView.events.find(({ event }) => event.type === "RUN_STARTED")!.event.userMessageIds)
        .toEqual([explicitId])
      expect(hub.communication.reactions(target, hub.store.turns(target)[0]!.runId).map((reaction) => reaction.rootId))
        .toEqual(["root"])
      expect(hub.communication.reactions(branch, hub.store.turns(branch)[0]!.runId).map((reaction) => reaction.rootId))
        .toEqual(["root"])
      const abnormalCount = () => {
        const db = new Database(server.databasePath, { readonly: true })
        try {
          return db.query<{ n: number }, [string]>(
            "SELECT count(*) AS n FROM subscription_publications WHERE source_session_id = ? AND category = 'abnormal'",
          ).get(target)!.n
        } finally {
          db.close()
        }
      }
      expect(abnormalCount()).toBe(1)
      client.close()
      await server.restart()
      expect(abnormalCount()).toBe(1)
    } finally {
      await server.cleanup()
    }
  }, 30_000)

  test("a batch-end fork continues one copied AgentTurn with independent grants", async () => {
    const api = fakeResponsesApi((body) => {
      if (afterTool(body)) return textReply("continued")
      if (hasText(body, "fork me") && !inputs(body).some((item) => item.type === "function_call")) {
        return toolReply("session_fork", {})
      }
      return textReply("done")
    })
    const server = new TestServer({}, realOptions(api.baseUrl))
    try {
      await server.start()
      const token = server.token("owner")
      const client = await login(server.url, token)
      const source = await create(client)
      const grant = new Database(server.databasePath)
      try {
        grant.query(
          "INSERT INTO session_grants (session_id, title_key, position, permission, pattern) VALUES (?, 'untitled', 1, 'edit', '/tmp/a')",
        ).run(source)
      } finally {
        grant.close()
      }
      const bytes = Buffer.from("fork-owned attachment")
      const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
      const made = await client.request("upload.create", {
        draftId: "fork-draft",
        name: "fork.txt",
        mediaType: "text/plain",
        size: bytes.byteLength,
      })
      const uploadId = made.result.upload.uploadId as string
      await client.request("upload.append", { uploadId, offset: 0, data: bytes.toString("base64") })
      await client.request("upload.finalize", { uploadId, size: bytes.byteLength, digest })
      const uploadRead = new Database(server.databasePath, { readonly: true })
      const attachmentId = uploadRead.query<{ attachment_id: string }, [string]>(
        "SELECT attachment_id FROM uploads WHERE upload_id = ?",
      ).get(uploadId)!.attachment_id
      uploadRead.close()
      const refs = [{
        attachmentId,
        contentId: digest,
        representationId: digest,
        name: "fork.txt",
        mediaType: "text/plain",
        digest,
      }]
      const sourceView = await SessionView.open(server.url, token, source)
      await client.request("session.input", { sessionId: source, text: "fork me", attachments: refs })
      await finished(sourceView, 1)
      const result = sourceView.events
        .filter(({ event }) => event.type === "TOOL_CALL_RESULT" && typeof event.content === "string" && event.content.includes('"continued":true'))
        .at(-1)!.event
      const receipt = JSON.parse(result.content as string)
      const branch = receipt.sessionId as string
      expect(receipt).toMatchObject({ sourceSessionId: source, continued: true })
      const branchView = await SessionView.open(server.url, token, branch)
      await finished(branchView, 1)
      const sourceRun = sourceView.events.find(({ event }) => event.type === "RUN_STARTED")!.event
      const branchRun = branchView.events.find(({ event }) => event.type === "RUN_STARTED")!.event
      expect(branchRun.runId).toBe(sourceRun.runId)
      const branchFork = branchView.events.find(
        ({ event }) => event.type === "TOOL_CALL_RESULT" && event.content === result.content,
      )
      expect(branchFork?.event).toMatchObject({ invocationId: result.invocationId })
      const db = new Database(server.databasePath, { readonly: true })
      try {
        expect(db.query<{ status: string }, [string]>("SELECT status FROM turns WHERE session_id = ?").all(branch)).toEqual([{ status: "finished" }])
        expect(db.query<{ user_message_ids: string }, [string]>(
          "SELECT user_message_ids FROM turns WHERE session_id = ?",
        ).get(branch)?.user_message_ids).toBe(JSON.stringify(sourceRun.userMessageIds))
        expect(db.query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM waiting_input WHERE session_id = ?",
        ).get(branch)).toEqual({ n: 0 })
        expect(db.query<{ pattern: string }, [string]>(
          "SELECT pattern FROM session_grants WHERE session_id = ? AND title_key = 'untitled'",
        ).all(branch)).toEqual([{ pattern: "/tmp/a" }])
        expect(db.query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM session_subscriptions WHERE receiver_session_id = ?",
        ).get(branch)).toEqual({ n: 0 })
        expect(db.query<{ ordinal: number }, [string]>(
          "SELECT ordinal FROM model_calls WHERE session_id = ? ORDER BY ordinal",
        ).all(branch).map((row) => row.ordinal)).toEqual([1, 2])
        expect(db.query<{ n: number }, [string, string]>(
          "SELECT count(*) AS n FROM attachment_references WHERE session_id = ? AND reference_id = ?",
        ).get(branch, sourceRun.userMessageIds[0])).toEqual({ n: 1 })
      } finally {
        db.close()
      }
      const rewound = await rewindSession(client, { sessionId: source, runId: sourceRun.runId })
      expect(rewound.error).toBeUndefined()
      const retained = await client.request("content.get", {
        sessionId: branch,
        contentId: digest,
        referenceId: sourceRun.userMessageIds[0],
      })
      expect(retained.result.content).toMatchObject({ available: true, sessionId: branch })
      const branchStill = await client.request("session.list")
      expect(branchStill.result.sessions.some((session: any) => session.id === branch)).toBe(true)
      client.close()
    } finally {
      await server.cleanup()
      api.stop()
    }
  })
})

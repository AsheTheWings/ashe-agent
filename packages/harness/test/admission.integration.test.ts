import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentRegistry } from "../src/agents/agents.ts"
import { fileSetup } from "../src/agents/setup.ts"
import { REQUEST_INSTRUCTIONS } from "../src/agent/blocks.ts"
import { agentRunner } from "../src/agent/runner.ts"
import { responsesModelPort } from "../src/agent/model.ts"
import type { Agents } from "../src/inputs/shapes.ts"
import { noAgents } from "../src/sessions/setup.ts"
import { Client, waitFor } from "./support/cli.ts"
import { filler } from "./support/context.ts"
import { configuredModel } from "./support/agent.ts"
import { SessionView, TestServer, type TestServerOptions } from "./support/server.ts"

type Captured = { readonly body: Record<string, any> }

const sse = (events: ReadonlyArray<Record<string, unknown>>) =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")

const response = (id: string) => ({
  id,
  object: "response",
  status: "completed",
  model: "m",
  output: [],
  usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
})

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

const toolReply = (name: string, args: unknown) => [
  { type: "response.created", response: { ...response("tool"), status: "in_progress" } },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", id: "fc", call_id: "call", name, arguments: "" },
  },
  { type: "response.function_call_arguments.delta", item_id: "fc", output_index: 0, delta: JSON.stringify(args) },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "function_call", id: "fc", call_id: "call", name, arguments: JSON.stringify(args), status: "completed" },
  },
  { type: "response.completed", response: response("tool") },
]

/** A loopback Responses API whose replies cycle through the script, then repeat a text reply. */
const fakeResponsesApi = (replies: ReadonlyArray<ReadonlyArray<Record<string, unknown>>> = []) => {
  const captured: Array<Captured> = []
  const queue = [...replies]
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      captured.push({ body: (await request.json()) as Record<string, any> })
      const events = queue.shift() ?? textReply("done")
      return new Response(sse(events), { headers: { "content-type": "text/event-stream" } })
    },
  })
  return {
    captured,
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    stop: () => server.stop(true),
  }
}

const realOptions = (
  baseUrl: string,
  models: NonNullable<TestServerOptions["models"]>,
  extra: Omit<TestServerOptions, "models" | "modelPort" | "runner"> = {},
): TestServerOptions => {
  const port = responsesModelPort((id) =>
    models.some((model) => model.id === id)
      ? { baseURL: baseUrl, apiKey: "synthetic-key", upstream: id.slice(id.indexOf("/") + 1) }
      : undefined,
  )
  return { ...extra, models, modelPort: port, runner: agentRunner({ port, models }) }
}

const setup = (dir: string, agents: Agents = {}) =>
  fileSetup({
    agents: new AgentRegistry(agents, null, join(dir, "titles")),
    instructionsFile: join(dir, "AGENTS.md"),
    skillRoots: [],
  })

const temporaryDir = () => mkdtempSync(join(tmpdir(), "ashe-agent-admission-"))

const login = async (url: string, token: string) => {
  const client = await Client.connect(url)
  const response = await client.request("auth.authenticate", { token, protocolVersion: 1 })
  if (response.error !== undefined) throw new Error(response.error.message)
  return client
}

const ended = (view: SessionView, count: number) =>
  waitFor(
    `${count} ended turns`,
    () => view.events.map((event) => event.event).filter((event) => event.type === "RUN_FINISHED" || event.type === "RUN_ERROR").length >= count ? true : undefined,
  )

const errors = (view: SessionView) =>
  view.events.map((event) => event.event).filter((event) => event.type === "RUN_ERROR") as Array<any>

describe("admission through a real WebSocket and loopback provider", () => {
  test("a null final model fails before configured compaction work reaches the provider", async () => {
    const api = fakeResponsesApi()
    const planned = configuredModel("test/planned", { settings: { checkpointWindowSize: 120_000 } })
    const server = new TestServer({}, realOptions(api.baseUrl, [planned], { auxiliaryModels: { compaction: planned.id } }))
    try {
      await server.start()
      const token = server.token("owner")
      const owner = await login(server.url, token)
      const created = await owner.request("session.create", { selection: { modelSettings: { modelId: null } } })
      const id = created.result.session.id as string
      const view = await SessionView.open(server.url, token, id)
      const accepted = await view.client.request("session.input", { sessionId: id, text: filler(61_000) })
      expect(accepted.error).toBeUndefined()
      await ended(view, 1)
      expect(errors(view)).toMatchObject([{ code: "model_unavailable" }])
      expect(api.captured).toHaveLength(0)
      view.client.close()
      owner.close()
    } finally {
      api.stop()
      await server.cleanup()
    }
  })

  test("restart reloads title temperature and checkpoint window while the selected model and effort persist", async () => {
    const api = fakeResponsesApi()
    const planned = configuredModel("test/planned", {
      temperatureCapable: true,
      efforts: ["low", "high"],
      settings: { temperature: 0.1, checkpointWindowSize: 120_000 },
    })
    const firstAgents: Agents = {
      planner: {
        model: planned.id,
        models: { [planned.id]: { temperature: 0.2, checkpointWindowSize: 120_000, reasoningEffort: "high" } },
      },
    }
    const secondAgents: Agents = {
      planner: {
        model: planned.id,
        models: { [planned.id]: { temperature: 0.7, checkpointWindowSize: 60_000, reasoningEffort: "high" } },
      },
    }
    const dir = temporaryDir()
    const first = new TestServer({}, realOptions(api.baseUrl, [planned], { dir, setup: setup(dir, firstAgents) }))
    const token = first.token("owner")
    let second: TestServer | null = null
    try {
      await first.start()
      const owner = await login(first.url, token)
      const created = await owner.request("session.create", { selection: { agentTitle: "planner" } })
      const id = created.result.session.id as string
      const firstView = await SessionView.open(first.url, token, id)
      await firstView.client.request("session.input", { sessionId: id, text: "first" })
      await ended(firstView, 1)
      const firstTurn = api.captured.find(({ body }) => body.instructions === REQUEST_INSTRUCTIONS)!
      expect(firstTurn.body).toMatchObject({ temperature: 0.2, reasoning: { effort: "high" } })
      firstView.client.close()
      owner.close()
      await first.stop()

      second = new TestServer({}, realOptions(api.baseUrl, [planned], {
        dir,
        setup: setup(dir, secondAgents),
        auxiliaryModels: { compaction: planned.id },
      }))
      await second.start()
      const view = await SessionView.open(second.url, token, id)
      const before = api.captured.length
      await view.client.request("session.input", { sessionId: id, text: `restart marker ${filler(30_000)}` })
      await waitFor("the reloaded checkpoint window", () =>
        view.events.some((event) => event.event.type === "CONTEXT_TURN_STARTED") ? true : undefined,
      )
      const turn = await waitFor("the restarted UserTurn request", () =>
        api.captured.slice(before).find(({ body }) => body.instructions === REQUEST_INSTRUCTIONS),
      )
      await ended(view, 2)
      expect(turn.body).toMatchObject({
        model: "planned",
        temperature: 0.7,
        reasoning: { effort: "high" },
      })
      view.client.close()
    } finally {
      api.stop()
      await second?.cleanup()
      if (second === null) await first.cleanup()
    }
  })

  test("unknown models and a removed title fail after admission without reaching the provider", async () => {
    const api = fakeResponsesApi()
    const planned = configuredModel("test/planned")
    const title: Agents = { planner: { model: planned.id } }
    const dir = temporaryDir()
    const first = new TestServer({}, realOptions(api.baseUrl, [planned], { dir, setup: setup(dir, title) }))
    const token = first.token("owner")
    let second: TestServer | null = null
    try {
      await first.start()
      const owner = await login(first.url, token)
      const created = await owner.request("session.create", { selection: { agentTitle: "planner" } })
      const id = created.result.session.id as string
      const firstView = await SessionView.open(first.url, token, id)
      await firstView.client.request("session.input", { sessionId: id, text: "first" })
      await ended(firstView, 1)
      const calls = api.captured.length
      await firstView.client.request("session.input", {
        sessionId: id,
        text: "unknown model",
        selection: { modelSettings: { modelId: "test/unknown" } },
      })
      await ended(firstView, 2)
      expect(errors(firstView).at(-1)).toMatchObject({ code: "model_unavailable" })
      expect(api.captured).toHaveLength(calls)
      firstView.client.close()
      owner.close()
      await first.stop()

      second = new TestServer({}, realOptions(api.baseUrl, [planned], { dir, setup: noAgents }))
      await second.start()
      const view = await SessionView.open(second.url, token, id)
      await view.client.request("session.input", { sessionId: id, text: "removed title" })
      await ended(view, 3)
      expect(errors(view).at(-1)).toMatchObject({ code: "title_unavailable" })
      expect(api.captured).toHaveLength(calls)
      view.client.close()
    } finally {
      api.stop()
      await second?.cleanup()
      if (second === null) await first.cleanup()
    }
  })

  test("a title file and deny policy loaded at startup govern the first provider call and tool offer", async () => {
    const api = fakeResponsesApi([toolReply("touch", { paths: ["a"] }), textReply("policy")])
    const planned = configuredModel("test/planned")
    const dir = temporaryDir()
    const agents: Agents = { writer: { model: planned.id, permission: { edit: "deny" } } }
    mkdirSync(join(dir, "titles"), { recursive: true })
    writeFileSync(join(dir, "titles", "writer.md"), "---\ndescription: Writes\n---\nWRITER POLICY")
    const server = new TestServer({}, realOptions(api.baseUrl, [planned], { dir, setup: setup(dir, agents) }))
    try {
      await server.start()
      const token = server.token("owner")
      const owner = await login(server.url, token)
      const created = await owner.request("session.create", { selection: { agentTitle: "writer" } })
      const id = created.result.session.id as string
      const view = await SessionView.open(server.url, token, id)
      await view.client.request("session.input", { sessionId: id, text: "apply the title policy" })
      await ended(view, 1)
      const firstCall = api.captured[0]!.body
      expect(JSON.stringify(firstCall.input)).toContain("WRITER POLICY")
      expect((firstCall.tools as Array<any>).map((tool) => tool.name)).not.toContain("touch")
      const result = view.events.map((event) => event.event).find((event) => event.type === "TOOL_CALL_RESULT") as any
      expect(result).toMatchObject({ outcome: "failed" })
      expect(result.content).toContain("not offered")
      view.client.close()
      owner.close()
    } finally {
      api.stop()
      await server.cleanup()
    }
  })
})

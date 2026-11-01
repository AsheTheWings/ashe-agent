import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import { Redacted } from "effect"
import { ModelCallError } from "../src/agent/model.ts"
import type { Tool } from "../src/agent/tools.ts"
import { AgentRegistry } from "../src/agents/agents.ts"
import { fileSetup, InstructionsUnreadable } from "../src/agents/setup.ts"
import type { UserInstructions } from "../src/sessions/hub.ts"
import { noAgents } from "../src/sessions/setup.ts"
import { mcpLogEvents } from "../src/telemetry/mcp-events.ts"
import { builtinTools } from "../src/tools/builtin.ts"
import { executeTool } from "../src/tools/codemode/execute.ts"
import { McpRegistry } from "../src/tools/mcp/servers.ts"
import { ShellProcesses } from "../src/tools/shell/index.ts"
import { AgentHarness, callTools, failWith, hold, say, testTools, type Reply } from "./support/agent.ts"
import { Client, waitFor } from "./support/cli.ts"
import { contextHarness, publishMemory, windowModel } from "./support/context.ts"
import { TestServer } from "./support/server.ts"
import { exportedText, memoryTelemetry, offCatalog } from "./support/telemetry.ts"

const telemetry = memoryTelemetry()
afterAll(() => telemetry.stop())

/** Synthetic content that no signal may carry. */
const marker = {
  prompt: "PROMPT-MARKER-7f3a",
  output: "OUTPUT-MARKER-7f3a",
  command: "COMMAND-MARKER-7f3a",
  commandOutput: "COMMAND-OUTPUT-MARKER-7f3a",
  file: "FILE-MARKER-7f3a",
  query: "QUERY-MARKER-7f3a",
  url: "URL-MARKER-7f3a",
  program: "PROGRAM-MARKER-7f3a",
  password: "PASSWORD-MARKER-7f3a",
  exaKey: "EXA-KEY-MARKER-7f3a",
  input: "INPUT-MARKER-7f3a",
} as const

const json = (body: unknown) => () => Response.json(body)

/** The test tools in namespace `srv`, each call authorized under `srv_<name>`, as an MCP server's are. */
const inventory: ReadonlyArray<Tool> = testTools().map((tool) => ({
  ...tool,
  namespace: "srv",
  spec: { ...tool.spec, name: `srv_${tool.name}` },
  run: async (args, run) => {
    await run.authorize({ permission: `srv_${tool.name}`, subjects: ["*"], patterns: ["*"] })
    return tool.run(args, run)
  },
}))

const runTurnWithTools = async () => {
  const replies: Array<() => Response> = [
    json({ results: [{ title: "T", url: "https://example.test/a", text: `found ${marker.query}` }] }),
    json({ results: [{ title: "P", url: `https://example.test/${marker.url}`, text: "page" }], statuses: [{ id: `https://example.test/${marker.url}`, status: "success" }] }),
  ]
  const exa = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => (replies.shift() ?? (() => new Response("none", { status: 500 })))() })
  const processes = new ShellProcesses({ shell: "/bin/sh", envFile: null, env: { PATH: process.env.PATH }, maxProcesses: 2 })
  const builtin = builtinTools(
    { shellYieldMs: 10_000, shellMaxOutputTokens: 10_000, exaBaseUrl: `http://127.0.0.1:${exa.port}`, exaApiKey: Redacted.make(marker.exaKey), skillRoots: [] },
    processes,
  )
  const h = new AgentHarness({ tools: [...builtin, executeTool(() => inventory, {})] })
  try {
    const id = h.create()
    writeFileSync(join(h.sessionDir(id), "notes.md"), `${marker.file}\n`)
    h.model.next(
      callTools([
        { name: "shell_exec_command", args: { cmd: `echo ${marker.commandOutput} # ${marker.command}` } },
        { name: "file_read", args: { path: "notes.md" } },
        { name: "web_search", args: { query: marker.query } },
        { name: "web_fetch", args: { urls: [`https://example.test/${marker.url}`] } },
        { name: "execute", args: { code: `return await tools.srv.echo({ text: "${marker.program}" })` } },
      ]),
      say(marker.output),
    )
    h.input(id, marker.prompt)
    await h.turnsEnded(id, 1)
    const results = h.events(id).flatMap(({ event }) => (event.type === "TOOL_CALL_RESULT" ? [event] : []))
    // Each call ran, so its content passed through the instrumented paths.
    expect(results.map((result) => result.outcome)).toEqual(["success", "success", "success", "success", "success"])
    expect(JSON.stringify(results)).toContain(marker.commandOutput)
    expect(JSON.stringify(results)).toContain(marker.file)
  } finally {
    await h.cleanup()
    processes.stopAll()
    exa.stop(true)
  }
}

const runProtocolRequests = async () => {
  const server = new TestServer({})
  const token = server.token("telemetry")
  await server.start()
  try {
    const wrong = await Client.connect(server.url)
    expect((await wrong.request("auth.exchange", { code: marker.password, verifier: "wrong", protocolVersion: 1 })).error).toBeDefined()
    const owner = await Client.connect(server.url)
    expect((await owner.request("auth.authenticate", { token, protocolVersion: 1 })).error).toBeUndefined()
    const tokenClient = await Client.connect(server.url)
    expect((await tokenClient.request("auth.authenticate", { token, protocolVersion: 1 })).error).toBeUndefined()
    const created = await tokenClient.request("session.create", {})
    const sessionId = created.result.session.id as string
    expect((await tokenClient.request("session.input", { sessionId, text: marker.input })).error).toBeUndefined()
    server.script.release(marker.input)
    expect((await tokenClient.request("session.input", { sessionId: `missing-${marker.input}`, text: marker.input })).error).toBeDefined()
    expect((await tokenClient.request(`no.such.${marker.input}`)).error).toBeDefined()
    owner.close()
    tokenClient.close()
  } finally {
    await server.cleanup()
  }
  return token
}

const runFailingMcpServer = async () => {
  const mcp = new McpRegistry({ broken: { type: "stdio", command: `/nonexistent/${marker.command}` } }, { env: {}, version: "test", events: mcpLogEvents })
  await mcp.start()
  await mcp.stop()
}

/** How many model calls the duration metric has recorded so far. */
const modelCallsTimed = async () =>
  (await telemetry.metrics()).scopeMetrics
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === "ashe_agent.model_call.duration")
    .flatMap((metric) => metric.dataPoints as Array<{ value: { count: number } }>)
    .reduce((total, point) => total + point.value.count, 0)

describe("telemetry", () => {
  test("requests, turns, model calls, and tool calls are traced and timed, and no signal carries content or credentials", async () => {
    const token = await runProtocolRequests()
    await runTurnWithTools()
    await runFailingMcpServer()

    const spans = telemetry.spans()
    const methods = spans.filter((span) => span.name === "ashe_agent.request").map((span) => span.attributes["rpc.method"])
    expect(methods).toEqual(expect.arrayContaining(["auth.exchange", "auth.authenticate", "session.create", "session.input", "unknown"]))
    expect(spans.some((span) => span.attributes["rpc.method"] === "auth.exchange" && span.attributes["error.type"] === "authentication_failed")).toBe(true)
    const missing = spans.find((span) => span.name === "ashe_agent.request" && span.attributes["error.type"] === "not_found")
    expect(missing).toBeDefined()

    const turn = spans.find((span) => span.name === "ashe_agent.turn" && span.attributes["ashe_agent.model"] === "test/alpha")!
    expect(turn.attributes["ashe_agent.turn.status"]).toBe("finished")
    const modelCalls = spans.filter((span) => span.name === "ashe_agent.model_call" && span.spanContext().traceId === turn.spanContext().traceId)
    expect(modelCalls).toHaveLength(2)
    for (const call of modelCalls) expect(call.parentSpanContext?.spanId).toBe(turn.spanContext().spanId)

    const toolCalls = spans.filter((span) => span.name === "ashe_agent.tool_call")
    const direct = toolCalls.filter((span) => span.attributes["ashe_agent.tool.in_program"] === false)
    expect(direct.map((span) => span.attributes["ashe_agent.tool"]).sort()).toEqual(["execute", "file_read", "shell_exec_command", "web_fetch", "web_search"])
    for (const span of direct) {
      expect(span.parentSpanContext?.spanId).toBe(turn.spanContext().spanId)
      expect(span.attributes["ashe_agent.tool.outcome"]).toBe("success")
    }
    const execute = direct.find((span) => span.attributes["ashe_agent.tool"] === "execute")!
    const inProgram = toolCalls.filter((span) => span.attributes["ashe_agent.tool.in_program"] === true)
    expect(inProgram.map((span) => [span.attributes["ashe_agent.tool"], span.parentSpanContext?.spanId])).toEqual([["srv_echo", execute.spanContext().spanId]])

    const metrics = (await telemetry.metrics()).scopeMetrics.flatMap((scope) => scope.metrics.map((metric) => metric.descriptor.name))
    expect(metrics).toEqual(expect.arrayContaining(["ashe_agent.turn.duration", "ashe_agent.model_call.duration", "ashe_agent.tool_call.duration"]))

    expect(telemetry.logs().map((record) => [record.eventName, record.attributes])).toEqual([
      ["ashe_agent.mcp.unavailable", { "ashe_agent.mcp.server": "broken", "error.type": "mcp_connect_failed" }],
    ])

    expect(await offCatalog(telemetry)).toEqual([])
    const exported = await exportedText(telemetry)
    for (const value of [...Object.values(marker), token]) expect(exported).not.toContain(value)
  }, 60_000)

  test("an MCP name collision's log record names both servers, both tools, and the shared name", async () => {
    const before = telemetry.logs().length
    mcpLogEvents.collision!({
      name: "x_a_b",
      tools: [
        { server: "x", tool: "a.b" },
        { server: "y", tool: "a_b" },
      ],
    })
    expect(telemetry.logs().slice(before).map((record) => [record.eventName, record.attributes])).toEqual([
      [
        "ashe_agent.mcp.collision",
        { "ashe_agent.tool": "x_a_b", "ashe_agent.mcp.collision.servers": ["x", "y"], "ashe_agent.mcp.collision.tools": ["a.b", "a_b"] },
      ],
    ])
    expect(await offCatalog(telemetry)).toEqual([])
  })

  test("context work is traced and measured, and no signal carries entries, files, prompts, questions, or answers", async () => {
    const marker = {
      entry: "ENTRY-MARKER-9c1e",
      memory: "MEMORY-MARKER-9c1e",
      research: "RESEARCH-MARKER-9c1e",
      compaction: "COMPACTION-INPUT-MARKER-9c1e",
      handoff: "HANDOFF-MARKER-9c1e",
      title: "TITLE-MARKER-9c1e",
      instructions: "INSTRUCTIONS-MARKER-9c1e",
      question: "QUESTION-MARKER-9c1e",
      note: "NOTE-MARKER-9c1e",
      feedback: "FEEDBACK-MARKER-9c1e",
    } as const
    const before = new Set(telemetry.spans())
    const mid = windowModel("test/mid", 120_000)
    const config = mkdtempSync(join(tmpdir(), "ashe-agent-telemetry-"))
    mkdirSync(join(config, "titles"))
    writeFileSync(join(config, "titles", "helper.md"), `---\ndescription: Helps ${marker.title}\n---\n${marker.instructions}\n`)
    const { h, aux } = contextHarness({
      models: [mid],
      setup: fileSetup({ agents: new AgentRegistry({ helper: { model: mid.id } }, null, join(config, "titles")), instructionsFile: join(config, "AGENTS.md"), skillRoots: [] }),
    })
    const blob = (tokens: number) => callTools([{ name: "blob", args: { tokens } }])
    const option = (label: string) => ({ label, description: `${label} described` })
    const ask = (extra: Record<string, unknown> = {}) =>
      callTools([{ name: "context_ask_question", args: { questions: [{ id: "q", header: "Pick", question: marker.question, options: [option("A"), option("B")] }], ...extra } }])
    const asked = (id: string, count: number) =>
      waitFor(`${count} QUESTIONS_ASKED`, () => h.events(id).flatMap(({ event }) => (event.type === "QUESTIONS_ASKED" ? [event] : []))[count - 1], 10_000)
    const ended = (id: string, type: string, count = 1) =>
      waitFor(`${count} ${type}`, () => (h.types(id).filter((candidate) => candidate === type).length >= count ? true : undefined), 10_000)
    const doing =
      (act: () => void, then: Reply): Reply =>
      (call, signal) => {
        act()
        return then(call, signal)
      }
    try {
      // A session with questions, an entry, memory, research, a compaction call, and a context turn whose second validation passes.
      const id = h.create({ agent: "helper" })
      publishMemory(h, id, { "notes.md": `---\ndescription: Notes ${marker.memory}\n---\n` })
      const research = join(h.sessionDir(id), "research", "topic.md")
      writeFileSync(research, `# Topic\n\n${marker.research}\n`)
      h.model.next(
        callTools([{ name: "context_append", args: { entries: [{ kind: "open", Text: marker.entry }] } }]),
        ask(),
        ask({ feedback: marker.feedback }),
        blob(76_000),
        say("first done"),
      )
      h.input(id, marker.compaction)
      const first = await asked(id, 1)
      h.hub.answerQuestion(id, first.questionSetId, [{ id: "q", selection: "A", note: marker.note }], h.sender)
      const second = await asked(id, 2)
      h.hub.answerQuestion(id, second.questionSetId, [{ id: "q" }], h.sender)
      await h.turnsEnded(id, 1)
      await ended(id, "TIMELINE_ENTRY", 2)
      const fix = () => writeFileSync(research, `---\ndescription: Topic\n---\n${marker.research}\n`)
      h.model.next(blob(5_000), say("in order"), doing(fix, say("fixed")), say("continuing"))
      h.input(id, "second")
      await h.turnsEnded(id, 3)
      expect(h.types(id).filter((type) => type === "VALIDATION_FAILED")).toHaveLength(1)
      expect(h.types(id).filter((type) => type === "CHECKPOINT_WINDOW_SEEDED")).toHaveLength(2)

      // A session that reaches the context limit three times and hands off, then a rewind that restores its files.
      const limited = h.create({ agent: "helper" })
      const overflow = () => failWith(new ModelCallError("context_length_exceeded", true))
      h.model.next(blob(50_000), blob(70_000), overflow(), overflow(), overflow(), say("continued"))
      h.input(limited, `go ${marker.handoff}`)
      await h.turnsEnded(limited, 2)
      expect(aux.calls("handoff")).toHaveLength(1)
      const [rewound] = h.events(limited).flatMap(({ event }) => (event.type === "RUN_STARTED" ? [event.runId] : []))
      h.model.next(say("again"))
      h.hub.rewind(limited, rewound!, "again", h.sender)
      await h.turnsEnded(limited, 1)
    } finally {
      await h.cleanup()
      rmSync(config, { recursive: true, force: true })
    }

    const spans = telemetry.spans().filter((span) => !before.has(span))
    const names = new Set(spans.map((span) => span.name))
    for (const name of [
      "ashe_agent.context_turn",
      "ashe_agent.clearing",
      "ashe_agent.compaction_call",
      "ashe_agent.research_call",
      "ashe_agent.handoff_call",
      "ashe_agent.question_wait",
      "ashe_agent.checkpoint_window_construction",
      "ashe_agent.reconciliation",
      "ashe_agent.validation",
      "ashe_agent.memory_check",
      "ashe_agent.memory_publish",
      "ashe_agent.snapshot",
      "ashe_agent.restore",
    ]) {
      expect(names).toContain(name)
    }
    const turns = new Set(spans.filter((span) => span.name === "ashe_agent.turn").map((span) => span.spanContext().spanId))
    for (const span of spans.filter((candidate) => candidate.name === "ashe_agent.context_turn")) expect(turns).toContain(span.parentSpanContext!.spanId)
    expect(spans.filter((span) => span.name === "ashe_agent.clearing").map((span) => span.attributes["ashe_agent.clearing.attempt"])).toEqual([1, 2, 3])
    expect(spans.filter((span) => span.name === "ashe_agent.validation").map((span) => span.attributes["ashe_agent.validation.result"])).toEqual(
      expect.arrayContaining(["failed", "passed"]),
    )
    expect(spans.filter((span) => span.name === "ashe_agent.question_wait").map((span) => span.attributes["ashe_agent.question.outcome"])).toEqual([
      "answered",
      "answered",
    ])
    const metrics = (await telemetry.metrics()).scopeMetrics.flatMap((scope) => scope.metrics.map((metric) => metric.descriptor.name))
    expect(metrics).toEqual(expect.arrayContaining(["ashe_agent.clearing.freed", "ashe_agent.checkpoint_window.size", "ashe_agent.validation.failures"]))

    expect(await offCatalog(telemetry)).toEqual([])
    const exported = await exportedText(telemetry)
    for (const value of Object.values(marker)) expect(exported).not.toContain(value)
  }, 60_000)

  test("a research call with no text is marked failed, and a context turn a restart interrupts still exports its span", async () => {
    const before = new Set(telemetry.spans())
    const fresh = () => telemetry.spans().filter((span) => !before.has(span))
    const mid = windowModel("test/mid", 120_000)
    const { h, aux } = contextHarness({ models: [mid] })
    try {
      const id = h.create({ model: mid.id })
      writeFileSync(join(h.sessionDir(id), "research", "topic.md"), "---\ndescription: Topic\n---\nA finding.\n")
      aux.next("research", say(""))
      const blob = (tokens: number) => callTools([{ name: "blob", args: { tokens } }])
      h.model.next(blob(76_000), say("first done"))
      h.input(id, "first")
      await h.turnsEnded(id, 1)
      await waitFor("the compaction entry", () => (h.types(id).includes("TIMELINE_ENTRY") ? true : undefined), 10_000)
      // The second turn's tool result passes the reserve, so its next model call is in a context turn.
      h.model.next(blob(5_000), hold(new Promise(() => {})))
      h.input(id, "second")
      const research = await waitFor("a research call span", () => fresh().find((span) => span.name === "ashe_agent.research_call"), 10_000)
      expect(research.attributes["error.type"]).toBe("research_failed")
      await h.calls(4)
      await h.restart()
      const turn = await waitFor("the context turn span", () => fresh().find((span) => span.name === "ashe_agent.context_turn"), 10_000)
      expect(turn.attributes["error.type"]).toBe("interrupted")
      expect(turn.attributes["ashe_agent.context_turn.constructed"]).toBe(false)
    } finally {
      await h.cleanup()
    }
  }, 60_000)

  test("a creation that cannot read the user instructions ends its construction span as unreadable instructions, and one over allowance as failed", async () => {
    const before = new Set(telemetry.spans())
    let read = (): UserInstructions => {
      throw new InstructionsUnreadable("/config/AGENTS.md", "permission denied")
    }
    const h = new AgentHarness({ setup: { ...noAgents, userInstructions: () => read() } })
    try {
      expect(() => h.create()).toThrow("/config/AGENTS.md")
      read = () => {
        const text = "x".repeat(60_000)
        return { source: "global", path: "/config/AGENTS.md", text, sha256: String(Bun.hash(text)), metadata: { dev: 0, ino: 0, size: text.length, mtimeMs: 0, ctimeMs: 0 } }
      }
      expect(() => h.create()).toThrow("cannot be built")
    } finally {
      await h.cleanup()
    }
    const classes = telemetry
      .spans()
      .filter((span) => !before.has(span) && span.name === "ashe_agent.checkpoint_window_construction")
      .map((span) => span.attributes["error.type"])
    expect(classes).toEqual(["user_instructions_unreadable", "checkpoint_window_failed"])
  })
})

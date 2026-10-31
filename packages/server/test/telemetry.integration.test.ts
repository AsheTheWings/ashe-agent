import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import { Redacted } from "effect"
import type { Tool } from "../src/agent/tools.ts"
import { setOwnerPassword } from "../src/auth/credentials.ts"
import { openDatabase } from "../src/store/database.ts"
import { mcpLogEvents } from "../src/telemetry/mcp-events.ts"
import { builtinTools } from "../src/tools/builtin.ts"
import { executeTool } from "../src/tools/codemode/execute.ts"
import { McpRegistry } from "../src/tools/mcp/servers.ts"
import { ShellProcesses } from "../src/tools/shell/index.ts"
import { AgentHarness, callTools, say, testTools } from "./support/agent.ts"
import { Client } from "./support/cli.ts"
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
  const db = openDatabase(server.databasePath)
  await setOwnerPassword(db, marker.password, Date.now())
  db.close()
  const token = server.token("telemetry")
  await server.start()
  try {
    const wrong = await Client.connect(server.url)
    expect((await wrong.request("auth.login", { password: `${marker.password}-wrong`, protocolVersion: 1 })).error).toBeDefined()
    const owner = await Client.connect(server.url)
    expect((await owner.request("auth.login", { password: marker.password, protocolVersion: 1 })).error).toBeUndefined()
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
    expect(methods).toEqual(expect.arrayContaining(["auth.login", "auth.authenticate", "session.create", "session.input", "unknown"]))
    expect(spans.some((span) => span.attributes["rpc.method"] === "auth.login" && span.attributes["error.type"] === "authentication_failed")).toBe(true)
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
})

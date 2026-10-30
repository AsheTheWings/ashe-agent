import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Tool, ToolRun } from "../src/agent/tools.ts"
import type { McpServers } from "../src/inputs/shapes.ts"
import { McpRegistry, type Collision } from "../src/tools/mcp/servers.ts"
import { mcpHandler } from "./fixtures/mcp-server.ts"
import { AgentHarness, callTools, say } from "./support/agent.ts"
import { waitFor } from "./support/cli.ts"

const fixture = join(import.meta.dir, "fixtures", "mcp-server.ts")
const stdio = (name: string, tools: ReadonlyArray<string>, extra: { envFile?: string; codemode?: false } = { codemode: false }) => ({
  type: "stdio" as const,
  command: process.execPath,
  args: [fixture, "stdio", name, ...tools],
  ...extra,
})

/** A Streamable HTTP MCP server on a loopback port that records each request's Authorization header. */
const httpServer = (name: string, tools: ReadonlyArray<string>, modernOnly = false) => {
  const handler = mcpHandler(name, tools, modernOnly)
  const authorizations: Array<string | null> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      authorizations.push(request.headers.get("authorization"))
      return handler.fetch(request)
    },
  })
  return { url: `http://127.0.0.1:${server.port}/mcp`, authorizations, stop: () => server.stop(true) }
}

const withRegistry = async (servers: McpServers, body: (registry: McpRegistry, collisions: Array<Collision>) => Promise<void>) => {
  const collisions: Array<Collision> = []
  const registry = new McpRegistry(servers, { env: { PATH: process.env.PATH }, version: "test", events: { collision: (collision) => collisions.push(collision) } })
  try {
    await registry.start()
    await body(registry, collisions)
  } finally {
    await registry.stop()
  }
}

const names = (tools: ReadonlyArray<Tool>) => tools.map((tool) => tool.spec.name).sort()

const run: ToolRun = {
  sessionId: "s",
  runId: "r",
  toolCallId: "c",
  cwd: "/",
  imageInput: false,
  signal: new AbortController().signal,
  authorize: async () => {},
  started: () => {},
  onCancel: () => {},
  programCall: () => {},
}

/** Whether the process `pid` is still alive. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const privateFile = (dir: string, name: string, text: string) => {
  const path = join(dir, name)
  writeFileSync(path, text)
  chmodSync(path, 0o600)
  return path
}

describe("MCP servers", () => {
  test("stdio and HTTP tools are registered with prefixed names, take credentials from their files, and return results", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ashe-agent-mcp-"))
    const remote = httpServer("remote", ["search"])
    try {
      const envFile = privateFile(dir, "local.env", "# test\nASHE_TEST_SECRET=synthetic=value\n")
      const headersFile = privateFile(dir, "remote.headers", "Authorization: Bearer synthetic-token\n")
      await withRegistry(
        {
          local: stdio("local", ["echo", "with.dot", "env"], { envFile, codemode: false }),
          remote: { type: "http", url: remote.url, headersFile, codemode: false },
          coded: stdio("coded", ["hidden"], {}),
        },
        async (registry) => {
          expect(names(registry.tools(true))).toEqual(["local_echo", "local_env", "local_with_dot", "remote_search"])
          expect(names(registry.tools(false))).toEqual(["coded_hidden"])
          const tool = (name: string) => registry.tools(true).find((candidate) => candidate.spec.name === name)!
          expect(await tool("local_with_dot").run({ text: "hi" }, run)).toEqual({ outcome: "success", content: [{ type: "text", text: 'local:with.dot:{"text":"hi"}' }] })
          expect(await tool("local_env").run({}, run)).toEqual({ outcome: "success", content: [{ type: "text", text: "synthetic=value" }] })
          expect(await tool("remote_search").run({ text: "q" }, run)).toEqual({ outcome: "success", content: [{ type: "text", text: 'remote:search:{"text":"q"}' }] })
          expect(remote.authorizations.length).toBeGreaterThan(0)
          expect(remote.authorizations.every((value) => value === "Bearer synthetic-token")).toBe(true)
        },
      )
    } finally {
      remote.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test("a call is decided under its registered name by `*`", async () => {
    await withRegistry({ local: stdio("local", ["echo"]) }, async (registry) => {
      const checks: Array<unknown> = []
      await registry.tools(true)[0]!.run({}, { ...run, authorize: async (check) => void checks.push(check) })
      expect(checks).toEqual([{ permission: "local_echo", subjects: ["*"], patterns: ["*"] }])
    })
  }, 30_000)

  test("a server that stops takes its tools out of the model's tool list, and the others stay", async () => {
    await withRegistry({ local: stdio("local", ["echo", "quit"]), other: stdio("other", ["echo"]) }, async (registry) => {
      const h = new AgentHarness({ tools: () => registry.tools(true) })
      try {
        const id = h.create()
        h.model.next(callTools([{ name: "local_quit", args: {} }]), say("quit"))
        h.input(id, "stop it")
        await h.turnsEnded(id, 1)
        expect(h.model.calls[0]!.call.tools.map((spec) => spec.name).sort()).toEqual(["local_echo", "local_quit", "other_echo"])
        await waitFor("the stopped server's tools to leave", () => (names(registry.tools(true)).length === 1 ? true : undefined))
        h.model.next(say("after"))
        h.input(id, "next")
        await h.turnsEnded(id, 2)
        expect(h.model.last().tools.map((spec) => spec.name)).toEqual(["other_echo"])
      } finally {
        await h.cleanup()
      }
    })
  }, 30_000)

  test("a server that fails to connect is reported unavailable without its credentials, and the others register", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("gone", { status: 404 }) })
    const url = `http://127.0.0.1:${closed.port}/mcp`
    closed.stop(true)
    const dir = mkdtempSync(join(tmpdir(), "ashe-agent-mcp-"))
    const unavailable: Array<[string, string]> = []
    const registry = new McpRegistry(
      {
        down: { type: "http", url, headersFile: privateFile(dir, "down.headers", "Authorization: Bearer never-shown\n"), codemode: false },
        badfile: { type: "http", url, headersFile: privateFile(dir, "bad.headers", "not a header line\n"), codemode: false },
        local: stdio("local", ["echo"]),
      },
      { env: { PATH: process.env.PATH }, version: "test", events: { unavailable: (server, reason) => unavailable.push([server, reason]) } },
    )
    try {
      await registry.start()
      expect(names(registry.tools(true))).toEqual(["local_echo"])
      expect(unavailable.map(([server]) => server).sort()).toEqual(["badfile", "down"])
      expect(unavailable.find(([server]) => server === "badfile")![1]).toBe(`failed to connect: its headers file ${join(dir, "bad.headers")}: line 1 is not Name: value`)
      expect(JSON.stringify(unavailable)).not.toContain("never-shown")
    } finally {
      await registry.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test("a 2026-07-28-only HTTP server is reached by negotiation, beside a server that takes only the 2025 handshake", async () => {
    const modern = httpServer("modern", ["echo"], true)
    try {
      await withRegistry(
        { modern: { type: "http", url: modern.url, codemode: false }, legacy: stdio("legacy", ["echo"]) },
        async (registry) => {
          expect(names(registry.tools(true))).toEqual(["legacy_echo", "modern_echo"])
          const tool = registry.tools(true).find((candidate) => candidate.spec.name === "modern_echo")!
          expect(await tool.run({ text: "hi" }, run)).toEqual({ outcome: "success", content: [{ type: "text", text: 'modern:echo:{"text":"hi"}' }] })
        },
      )
    } finally {
      modern.stop()
    }
  }, 30_000)

  test("results map images to images, other parts and structured content to JSON, and error results to failures", async () => {
    await withRegistry({ local: stdio("local", ["parts", "structured", "fail"]) }, async (registry) => {
      const tool = (name: string) => registry.tools(true).find((candidate) => candidate.spec.name === name)!
      expect(await tool("local_parts").run({}, run)).toEqual({
        outcome: "success",
        content: [
          { type: "image", path: "mcp:local/parts", mimeType: "image/png", data: "aW1n" },
          { type: "text", text: JSON.stringify({ type: "resource", resource: { uri: "file:///r.txt", text: "r" } }) },
          { type: "text", text: "done" },
        ],
      })
      expect(await tool("local_structured").run({}, run)).toEqual({ outcome: "success", content: [{ type: "text", text: '{"answer":42}' }] })
      expect(await tool("local_fail").run({}, run)).toEqual({ outcome: "failed", content: [{ type: "text", text: "it broke" }] })
    })
  }, 30_000)

  test("a denied MCP call fails in the turn without reaching its server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ashe-agent-mcp-"))
    const remote = httpServer("remote", ["search"])
    try {
      await withRegistry({ remote: { type: "http", url: remote.url, codemode: false } }, async (registry) => {
        const h = new AgentHarness({ tools: () => registry.tools(true), permission: { remote_search: "deny" } })
        try {
          const id = h.create()
          const before = remote.authorizations.length
          h.model.next(callTools([{ name: "remote_search", args: { text: "q" } }]), say("denied"))
          h.input(id, "search")
          await h.turnsEnded(id, 1)
          const results = h.events(id).map((event) => event.event as Record<string, unknown>).filter((event) => event.type === "TOOL_CALL_RESULT")
          expect(results.map((result) => result.content)).toEqual(["This tool call was denied by configuration and did not run."])
          expect(remote.authorizations.length).toBe(before)
        } finally {
          await h.cleanup()
        }
      })
    } finally {
      remote.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test("an HTTP server that goes away loses its tools, and later model calls offer only the others", async () => {
    const remote = httpServer("remote", ["echo"])
    const unavailable: Array<[string, string]> = []
    const registry = new McpRegistry(
      { remote: { type: "http", url: remote.url, codemode: false }, local: stdio("local", ["echo"]) },
      { env: { PATH: process.env.PATH }, version: "test", events: { unavailable: (server, reason) => unavailable.push([server, reason]) } },
    )
    const h = new AgentHarness({ tools: () => registry.tools(true) })
    try {
      await registry.start()
      expect(names(registry.tools(true))).toEqual(["local_echo", "remote_echo"])
      remote.stop()
      const id = h.create()
      h.model.next(callTools([{ name: "remote_echo", args: {} }]), say("gone"))
      h.input(id, "call it")
      await h.turnsEnded(id, 1)
      const [, reason] = await waitFor("the unavailable event", () => unavailable.find(([server]) => server === "remote"))
      // The probe reached no server: the connection was refused, not answered.
      expect(reason).toStartWith("stopped answering: ")
      expect(reason).not.toContain("not supported")
      h.model.next(say("after"))
      h.input(id, "next")
      await h.turnsEnded(id, 2)
      expect(h.model.last().tools.map((spec) => spec.name)).toEqual(["local_echo"])
    } finally {
      await h.cleanup()
      await registry.stop()
    }
  }, 30_000)

  /**
   * A live 2026-07-28 server whose `flaky` tool fails with an error
   * response, after which it answers the liveness probe's `tools/list`
   * as `probe` says: normally, with a method-not-found error, or never.
   */
  const flakyServer = (probe: "lists" | "refuses" | "hangs") => {
    const handler = mcpHandler("live", ["flaky", "echo"], true)
    let failed = false
    return Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const body = request.method === "POST" ? ((await request.clone().json()) as Record<string, any>) : null
        if (body?.method === "tools/call" && body.params?.name === "flaky") {
          failed = true
          return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "flaky failed" } })
        }
        if (failed && body?.method === "tools/list" && probe === "refuses") {
          return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } })
        }
        if (failed && body?.method === "tools/list" && probe === "hangs") return new Promise<Response>(() => {})
        return handler.fetch(request)
      },
    })
  }

  const flakyRegistry = (port: number, unavailable: Array<string>) =>
    new McpRegistry(
      { live: { type: "http", url: `http://127.0.0.1:${port}/mcp`, codemode: false } },
      { env: { PATH: process.env.PATH }, version: "test", events: { unavailable: (name, reason) => unavailable.push(`${name}: ${reason}`) } },
    )

  for (const probe of ["lists", "refuses"] as const) {
    test(`a live 2026-07-28 server that fails one request keeps its tools when it ${probe === "lists" ? "lists its tools" : "answers the probe with an error"}`, async () => {
      const server = flakyServer(probe)
      const unavailable: Array<string> = []
      const registry = flakyRegistry(server.port!, unavailable)
      try {
        await registry.start()
        const tool = (name: string) => registry.tools(true).find((candidate) => candidate.spec.name === name)!
        expect(await tool("live_flaky").run({}, run)).toMatchObject({ outcome: "failed", content: expect.stringContaining("flaky failed") })
        expect(unavailable).toEqual([])
        expect(names(registry.tools(true))).toEqual(["live_echo", "live_flaky"])
        expect(await tool("live_echo").run({}, run)).toMatchObject({ outcome: "success" })
      } finally {
        await registry.stop()
        server.stop(true)
      }
    }, 30_000)
  }

  test("a server that does not answer the probe within 5 seconds loses its tools", async () => {
    const server = flakyServer("hangs")
    const unavailable: Array<string> = []
    const registry = flakyRegistry(server.port!, unavailable)
    try {
      await registry.start()
      const flaky = registry.tools(true).find((candidate) => candidate.spec.name === "live_flaky")!
      const before = performance.now()
      expect(await flaky.run({}, run)).toMatchObject({ outcome: "failed" })
      // The probe times out at 5 seconds; the margins absorb scheduling.
      const waited = performance.now() - before
      expect(waited).toBeGreaterThanOrEqual(4_900)
      expect(waited).toBeLessThan(6_500)
      expect(unavailable).toEqual([expect.stringMatching(/^live: stopped answering: .*timed out/i)])
      expect(names(registry.tools(true))).toEqual([])
    } finally {
      await registry.stop()
      server.stop(true)
    }
  }, 30_000)

  test("stopping while a server is still connecting closes it and ends its process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ashe-agent-mcp-"))
    const pidFile = join(dir, "pids")
    const registry = new McpRegistry(
      { hang: { type: "stdio", command: process.execPath, args: [fixture, "hang", pidFile], codemode: false } },
      { env: { PATH: process.env.PATH }, version: "test" },
    )
    try {
      const started = registry.start()
      const pids = await waitFor("the hanging server to start", () =>
        existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "" ? readFileSync(pidFile, "utf8").trim().split("\n").map(Number) : undefined,
      )
      await registry.stop()
      await started
      await waitFor("the hanging server to end", () => (readFileSync(pidFile, "utf8").trim().split("\n").map(Number).every((pid) => !alive(pid)) ? true : undefined))
      expect(pids.length).toBeGreaterThan(0)
      expect(names(registry.tools(true))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test("stopping while an HTTP server has not answered the handshake settles the connection", async () => {
    let requests = 0
    const silent = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        requests++
        return new Promise<Response>(() => {})
      },
    })
    const registry = new McpRegistry(
      { silent: { type: "http", url: `http://127.0.0.1:${silent.port}/mcp`, codemode: false } },
      { env: { PATH: process.env.PATH }, version: "test" },
    )
    try {
      const started = registry.start()
      await waitFor("the handshake request", () => (requests > 0 ? true : undefined))
      await registry.stop()
      await started
      expect(names(registry.tools(true))).toEqual([])
    } finally {
      silent.stop(true)
    }
  }, 30_000)

  test("names colliding after normalization, within one server and across two, register none of them", async () => {
    await withRegistry(
      { x: stdio("x", ["a.b", "a_b", "y_z", "keep"]), x_y: stdio("x_y", ["z", "fine"]) },
      async (registry, collisions) => {
        expect(names(registry.tools(true))).toEqual(["x_keep", "x_y_fine"])
        expect(collisions.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
          { name: "x_a_b", tools: [{ server: "x", tool: "a.b" }, { server: "x", tool: "a_b" }] },
          { name: "x_y_z", tools: [{ server: "x", tool: "y_z" }, { server: "x_y", tool: "z" }] },
        ])
      },
    )
  }, 30_000)
})

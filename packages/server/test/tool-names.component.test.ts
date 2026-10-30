import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { Redacted, Schema } from "effect"
import type { Tool, ToolRun } from "../src/agent/tools.ts"
import { McpServers } from "../src/inputs/shapes.ts"
import { PermissionDenied, type PermissionCheck } from "../src/permissions/rules.ts"
import type { RequestContext } from "../src/server/websocket.ts"
import { sessionHandlers } from "../src/sessions/handlers.ts"
import { builtinTools } from "../src/tools/builtin.ts"
import { executeTool } from "../src/tools/codemode/execute.ts"
import { ShellProcesses } from "../src/tools/shell/index.ts"
import { AgentHarness, agentModels, say, testTools } from "./support/agent.ts"

const processes = () => new ShellProcesses({ shell: "/bin/sh", envFile: null, env: {}, maxProcesses: 4 })

const builtin = (shell: ShellProcesses) =>
  builtinTools(
    { shellYieldMs: 1_000, shellMaxOutputTokens: 1_000, exaBaseUrl: "http://127.0.0.1:9/", exaApiKey: Redacted.make("synthetic"), skillRoots: [] },
    shell,
    (() => Promise.reject(new Error("no network in this test"))) as unknown as typeof fetch,
  )

/** A tool run whose `authorize` records the check and refuses it, so no tool acts. */
const refusingRun = (checks: Array<PermissionCheck>): ToolRun => ({
  sessionId: "s",
  runId: "r",
  toolCallId: "c",
  // An existing directory, since `shell_exec_command` checks its directory before authorizing.
  cwd: tmpdir(),
  imageInput: false,
  signal: new AbortController().signal,
  authorize: async (check) => {
    checks.push(check)
    throw new PermissionDenied(check.subjects)
  },
  started: () => {},
  onCancel: () => {},
  programCall: () => {},
})

/** One valid call of each built-in tool, by the name models receive. */
const sampleArgs: Record<string, unknown> = {
  file_read: { path: "notes.md" },
  file_patch: { patch: "*** Begin Patch\n*** Add File: notes.md\n+x\n*** End Patch" },
  skill: { name: "demo" },
  shell_exec_command: { cmd: "true" },
  shell_write_stdin: { process_id: 1 },
  web_search: { query: "q" },
  web_fetch: { urls: ["https://example.com/"] },
  execute: { code: "1" },
}

const permissionOf = async (tool: Tool) => {
  const checks: Array<PermissionCheck> = []
  await tool.run(sampleArgs[tool.spec.name], refusingRun(checks)).catch(() => undefined)
  return checks.length === 0 ? null : checks[0]!.permission
}

describe("tool names", () => {
  test("models receive the built-in tools under flat namespaced names", async () => {
    const shell = processes()
    const tools = [...builtin(shell), executeTool(() => testTools(), {})]
    const h = new AgentHarness({ tools })
    try {
      const id = h.create()
      h.model.next(say("hello"))
      h.input(id, "go")
      await h.turnsEnded(id, 1)
      expect(h.model.last().tools.map((tool) => tool.name)).toEqual([
        "file_read",
        "file_patch",
        "skill",
        "shell_exec_command",
        "shell_write_stdin",
        "web_search",
        "web_fetch",
        "execute",
      ])
    } finally {
      await h.cleanup()
      shell.stopAll()
    }
  })

  test("each built-in tool is decided under its permission name", async () => {
    const shell = processes()
    try {
      const tools = [...builtin(shell), executeTool(() => testTools(), {})]
      const permissions: Record<string, string | null> = {}
      for (const tool of tools) permissions[tool.spec.name] = await permissionOf(tool)
      expect(permissions).toEqual({
        file_read: "read",
        file_patch: "edit",
        skill: "skill",
        shell_exec_command: "shell",
        shell_write_stdin: null,
        web_search: "web",
        web_fetch: "web",
        execute: "execute",
      })
    } finally {
      shell.stopAll()
    }
  })

  test("shell_exec_command offers no shell argument and refuses a call naming one", async () => {
    const shell = processes()
    try {
      const exec = builtin(shell).find((tool) => tool.spec.name === "shell_exec_command")!
      const parameters = exec.spec.parameters as { properties: Record<string, unknown>; additionalProperties?: unknown }
      expect(Object.keys(parameters.properties).sort()).toEqual(["cmd", "login", "max_output_tokens", "tty", "workdir", "yield_time_ms"])
      expect(parameters.additionalProperties).toBe(false)
      const checks: Array<PermissionCheck> = []
      const refused = await exec.run({ cmd: "true", shell: "/bin/bash" }, refusingRun(checks))
      expect(refused).toMatchObject({ outcome: "failed", content: expect.stringContaining("shell") })
      expect(checks).toEqual([])
    } finally {
      shell.stopAll()
    }
  })

  test("models.list returns the configured models", async () => {
    const h = new AgentHarness()
    try {
      const { handlers } = sessionHandlers(h.hub)
      expect(await handlers["models.list"]!({}, {} as RequestContext)).toEqual({ models: [...agentModels] })
    } finally {
      await h.cleanup()
    }
  })

  test("an MCP server named after a reserved namespace is refused", () => {
    const decode = Schema.decodeUnknownExit(McpServers)
    for (const name of ["web", "file", "shell", "context"]) {
      expect(decode({ [name]: { type: "stdio", command: "server" } })._tag).toBe("Failure")
    }
    expect(decode({ docs: { type: "stdio", command: "server" } })._tag).toBe("Success")
  })
})

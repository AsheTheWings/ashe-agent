import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import type { SessionEvent } from "@ashe-agent/protocol"
import { executeTool } from "../src/tools/codemode/execute.ts"
import { McpRegistry } from "../src/tools/mcp/servers.ts"
import { waitFor } from "./support/cli.ts"
import { AgentHarness, callTools } from "./support/agent.ts"

const fixture = join(import.meta.dir, "fixtures", "mcp-server.ts")

const ofType = (events: ReadonlyArray<SessionEvent>, type: string) =>
  (events.map((event) => event.event) as Array<any>).filter((event) => event.type === type)

describe("code mode across a restart", () => {
  test("a restart during a program gives its execute call an interrupted result listing the calls it had finished", async () => {
    const mcp = new McpRegistry(
      { srv: { type: "stdio", command: process.execPath, args: [fixture, "stdio", "srv", "echo", "fail", "stall"] } },
      { env: { PATH: process.env.PATH }, version: "test" },
    )
    await mcp.start()
    const h = new AgentHarness({ tools: [executeTool(() => mcp.tools(false), {})] })
    try {
      expect(mcp.tools(false).map((tool) => tool.spec.name).sort()).toEqual(["srv_echo", "srv_fail", "srv_stall"])
      const id = h.create()
      const code = 'await tools.srv.echo({ text: "a" }); try { await tools.srv.fail({}) } catch {}; return await tools.srv.stall({})'
      h.model.next(callTools([{ name: "execute", args: { code }, id: "call_program" }]))
      h.input(id, "go")
      await waitFor("two finished program calls", () => (ofType(h.events(id), "PROGRAM_CALL_FINISHED").length >= 2 ? true : undefined), 10_000)
      await h.restart()
      const results = ofType(h.events(id), "TOOL_CALL_RESULT")
      expect(results.map((result) => [result.toolCallId, result.outcome])).toEqual([["call_program", "interrupted"]])
      expect(results[0].content).toContain("Its program had finished these tool calls, in order: srv_echo (success), srv_fail (failed).")
      expect(ofType(h.events(id), "RUN_INTERRUPTED")).toHaveLength(1)
    } finally {
      await h.cleanup()
      await mcp.stop()
    }
  }, 30_000)
})

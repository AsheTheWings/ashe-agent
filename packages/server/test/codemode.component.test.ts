import { existsSync } from "node:fs"
import { Schema } from "effect"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import type { SessionEvent } from "@ashe-agent/protocol"
import type { Tool } from "../src/agent/tools.ts"
import type { Permission } from "../src/inputs/shapes.ts"
import { builtinTool } from "../src/agent/tools.ts"
import { catalogTools, executeTool, type CodeModeLimits } from "../src/tools/codemode/execute.ts"
import { waitFor } from "./support/cli.ts"
import { AgentHarness, callTools, say, testTools } from "./support/agent.ts"

/**
 * The test tools in the namespace `srv` as an MCP server's would be: named
 * `srv_<name>`, each call authorized under that name by `*`.
 */
const inventory: ReadonlyArray<Tool> = testTools().map((tool) => ({
  ...tool,
  namespace: "srv",
  spec: { ...tool.spec, name: `srv_${tool.name}` },
  run: async (args, run) => {
    await run.authorize({ permission: `srv_${tool.name}`, subjects: ["*"], patterns: ["*"] })
    return tool.run(args, run)
  },
}))

/** A tool returning one image whose data is `data`, after `wait` when given. */
const imageTool = (name: string, data: string, wait?: () => Promise<void>): Tool => ({
  ...builtinTool({
    name,
    description: `Returns the image ${name}.`,
    args: Schema.Struct({}),
    run: async () => {
      await wait?.()
      return { outcome: "success", content: [{ type: "text", text: name }, { type: "image", path: `${name}.png`, mimeType: "image/png", data }] }
    },
  }),
  namespace: "srv",
})

const withHarness = async (
  options: { permission?: Permission; limits?: CodeModeLimits; inventory?: ReadonlyArray<Tool> },
  body: (harness: AgentHarness) => Promise<void>,
) => {
  const harness = new AgentHarness({
    tools: [executeTool(() => options.inventory ?? inventory, options.limits ?? {})],
    ...(options.permission === undefined ? {} : { permission: options.permission }),
  })
  try {
    await body(harness)
  } finally {
    await harness.cleanup()
  }
}

const ofType = (events: ReadonlyArray<SessionEvent>, type: string) =>
  (events.map((event) => event.event) as Array<any>).filter((event) => event.type === type)
const results = (h: AgentHarness, id: string) => ofType(h.events(id), "TOOL_CALL_RESULT")

/** Runs one turn whose model calls `execute` with `code`, then says "done". */
const program = (h: AgentHarness, code: string) => {
  const id = h.create()
  h.model.next(callTools([{ name: "execute", args: { code } }]), say("done"))
  h.input(id, "go")
  return id
}

describe("code mode programs", () => {
  test("call the inventory's tools by namespace and report each finished call", async () => {
    await withHarness({}, async (h) => {
      const id = program(h, 'const a = await tools.srv.echo({ text: "a" }); const b = await tools.srv.echo({ text: "b" }); return [a, b]')
      await h.turnsEnded(id, 1)
      const [result] = results(h, id)
      expect(result.outcome).toBe("success")
      expect(JSON.parse(result.content)).toEqual(["echoed a", "echoed b"])
      expect(ofType(h.events(id), "PROGRAM_CALL_FINISHED")).toEqual([
        { type: "PROGRAM_CALL_FINISHED", toolCallId: result.toolCallId, tool: "srv_echo", outcome: "success" },
        { type: "PROGRAM_CALL_FINISHED", toolCallId: result.toolCallId, tool: "srv_echo", outcome: "success" },
      ])
    })
  })

  test("names such as __proto__ and constructor are ordinary paths and leave Object.prototype unchanged", async () => {
    const echo = inventory.find((tool) => tool.name === "echo")!
    const named = [
      { ...echo, namespace: "__proto__", name: "echo" },
      { ...echo, namespace: "srv", name: "constructor" },
      { ...echo, namespace: "srv", name: "__proto__" },
    ]
    expect(catalogTools(named).map((tool) => tool.path).sort()).toEqual(["__proto__.echo", "srv.__proto__", "srv.constructor"])
    expect(Object.hasOwn(Object.prototype, "echo")).toBe(false)
    await withHarness({ inventory: named }, async (h) => {
      const id = program(h, 'return [await tools["__proto__"].echo({ text: "a" }), await tools.srv.constructor({ text: "b" }), await tools.srv["__proto__"]({ text: "c" })]')
      await h.turnsEnded(id, 1)
      const [result] = results(h, id)
      expect(result.outcome).toBe("success")
      expect(JSON.parse(result.content)).toEqual(["echoed a", "echoed b", "echoed c"])
    })
    expect(Object.hasOwn(Object.prototype, "echo")).toBe(false)
  })

  test("images of concurrent calls follow the program's calls in the order they started", async () => {
    let fastDone = () => {}
    const fastFinished = new Promise<void>((resolve) => (fastDone = resolve))
    const slow = imageTool("slow", "c2xvdw", () => fastFinished)
    const fast = imageTool("fast", "ZmFzdA", async () => queueMicrotask(fastDone))
    await withHarness({ inventory: [slow, fast] }, async (h) => {
      const id = program(h, "return await Promise.all([tools.srv.slow({}), tools.srv.fast({})])")
      await h.turnsEnded(id, 1)
      const [result] = results(h, id)
      expect(result.outcome).toBe("success")
      expect(h.model.calls.length).toBe(2)
      const sent = JSON.stringify(h.model.last().messages.at(-1))
      expect(sent.indexOf("slow.png")).toBeGreaterThan(-1)
      expect(sent.indexOf("slow.png")).toBeLessThan(sent.indexOf("fast.png"))
    })
  })

  test("get no fetch, timer, process, or module globals and cause no host effect", async () => {
    let requests = 0
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => (requests++, new Response("reached")) })
    try {
      await withHarness({}, async (h) => {
        const marker = join(h.dir, "written")
        const code = `
          const types = [typeof fetch, typeof setTimeout, typeof setInterval, typeof process, typeof Bun, typeof require, typeof search]
          const attempts = []
          for (const attempt of [
            () => fetch("http://127.0.0.1:${server.port}/"),
            () => setTimeout(() => {}, 1),
            () => process.exit(1),
            () => Bun.write(${JSON.stringify(marker)}, "x"),
            () => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"),
          ]) {
            try { await attempt(); attempts.push("ran") } catch (error) { attempts.push("failed") }
          }
          return { types, attempts }`
        const id = program(h, code)
        await h.turnsEnded(id, 1)
        const [result] = results(h, id)
        expect(result.outcome).toBe("success")
        expect(JSON.parse(result.content)).toEqual({
          types: ["undefined", "undefined", "undefined", "undefined", "undefined", "undefined", "function"],
          attempts: ["failed", "failed", "failed", "failed", "failed"],
        })
        expect(requests).toBe(0)
        expect(existsSync(marker)).toBe(false)
      })
    } finally {
      server.stop(true)
    }
  })
})

describe("permissions and limits inside programs", () => {
  test("a denied call fails inside the program, which goes on", async () => {
    await withHarness({ permission: { srv_echo: "deny" } }, async (h) => {
      const id = program(h, 'try { await tools.srv.echo({ text: "a" }); return "ran" } catch (error) { return `caught: ${error.message}` }')
      await h.turnsEnded(id, 1)
      const [result] = results(h, id)
      expect(result.outcome).toBe("success")
      expect(result.content).toStartWith("caught: ")
      expect(result.content).toContain("denied by configuration")
      expect(ofType(h.events(id), "PROGRAM_CALL_FINISHED").map((event) => [event.tool, event.outcome])).toEqual([["srv_echo", "failed"]])
    })
  })

  test("an ask waits for its answer without using the program's time", async () => {
    const limit = 300
    await withHarness({ permission: { srv_echo: "ask" }, limits: { wallClockMs: limit } }, async (h) => {
      const id = program(h, 'return await tools.srv.echo({ text: "a" })')
      const [request] = await waitFor("the ask", () => {
        const asked = ofType(h.events(id), "PERMISSION_REQUESTED")
        return asked.length > 0 ? asked : undefined
      }, 10_000)
      const asked = performance.now()
      // The wait outlasts the program's whole time limit before the answer comes.
      await waitFor("the time limit to pass", () => (performance.now() - asked > limit * 2 ? true : undefined), 10_000)
      expect(results(h, id)).toEqual([])
      h.answer(id, request.requestId, "once")
      await h.turnsEnded(id, 1)
      expect(results(h, id).map((result) => [result.outcome, result.content])).toEqual([["success", "echoed a"]])
    })
  })

  test("the time limit still ends a program that runs without waiting", async () => {
    await withHarness({ limits: { wallClockMs: 100 } }, async (h) => {
      const id = program(h, "for (;;) {}")
      await h.turnsEnded(id, 1)
      const [result] = results(h, id)
      expect(result.outcome).toBe("failed")
      expect(result.content).toMatch(/time/i)
    })
  })

  test("the tool call and output limits bound a program", async () => {
    await withHarness({ limits: { toolCalls: 1, outputBytes: 16 } }, async (h) => {
      // The fake model's replies are one queue, so the sessions run one after the other.
      const calls = program(h, 'await tools.srv.echo({ text: "a" }); return await tools.srv.echo({ text: "b" })')
      await h.turnsEnded(calls, 1)
      const long = program(h, 'return "x".repeat(1000)')
      await h.turnsEnded(long, 1)
      const [limited] = results(h, calls)
      expect(limited.outcome).toBe("failed")
      expect(ofType(h.events(calls), "PROGRAM_CALL_FINISHED")).toHaveLength(1)
      const [truncated] = results(h, long)
      expect(truncated.outcome).toBe("success")
      expect(truncated.content).not.toContain("x".repeat(17))
    })
  })

  test("images count toward the output limit", async () => {
    await withHarness({ inventory: [imageTool("big", "x".repeat(1_000))], limits: { outputBytes: 64 } }, async (h) => {
      const id = program(h, "return await tools.srv.big({})")
      await h.turnsEnded(id, 1)
      const [result] = results(h, id)
      expect(result.outcome).toBe("success")
      expect(typeof result.content).toBe("string")
      expect(result.content).toContain("1 image was left out: the output limit was reached.")
      expect(result.content).not.toContain("x".repeat(100))
    })
  })

  test("long text and an image keep the program's output within the limit, notices beyond it", async () => {
    const limit = 64
    await withHarness({ inventory: [imageTool("big", "x".repeat(1_000))], limits: { outputBytes: limit } }, async (h) => {
      const id = program(h, 'await tools.srv.big({}); return "y".repeat(60)')
      await h.turnsEnded(id, 1)
      const [result] = results(h, id)
      const note = "\n\n1 image was left out: the output limit was reached."
      expect(typeof result.content).toBe("string")
      expect(result.content.endsWith(note)).toBe(true)
      expect(Buffer.byteLength(result.content.slice(0, -note.length))).toBeLessThanOrEqual(limit)
    })
  })

  test("a plain reject keeps the images of the calls before it", async () => {
    const refuse = inventory.find((tool) => tool.name === "refuse")!
    await withHarness({ inventory: [imageTool("shot", "c2hvdA"), refuse] }, async (h) => {
      const id = h.create()
      h.model.next(callTools([{ name: "execute", args: { code: "await tools.srv.shot({}); await tools.srv.refuse({})" } }]))
      h.input(id, "go")
      await h.turnsEnded(id, 1)
      const [result] = results(h, id)
      expect(result.outcome).toBe("declined")
      expect(JSON.stringify(result.content)).toContain("srv_refuse")
      expect(h.events(id).some(({ event }) => event.type === "TOOL_CALL_RESULT" && JSON.stringify(event).includes("shot.png"))).toBe(true)
    })
  })

  test("cancel interrupts a program waiting on an ask and withdraws the ask", async () => {
    await withHarness({ permission: { srv_echo: "ask" } }, async (h) => {
      const id = program(h, 'return await tools.srv.echo({ text: "a" })')
      const [request] = await waitFor("the ask", () => {
        const asked = ofType(h.events(id), "PERMISSION_REQUESTED")
        return asked.length > 0 ? asked : undefined
      }, 10_000)
      h.hub.cancel(id)
      await h.turnsEnded(id, 1)
      expect(ofType(h.events(id), "PERMISSION_WITHDRAWN")).toEqual([{ type: "PERMISSION_WITHDRAWN", requestId: request.requestId, reason: "canceled" }])
      expect(results(h, id).map((result) => result.outcome)).toEqual(["canceled"])
      expect(ofType(h.events(id), "PROGRAM_CALL_FINISHED")).toEqual([])
    })
  })

  test("cancel interrupts a program's running call", async () => {
    await withHarness({}, async (h) => {
      const id = program(h, "return await tools.srv.wait({})")
      await waitFor("the program to start", () => (ofType(h.events(id), "TOOL_EXECUTION_STARTED").length > 0 ? true : undefined), 10_000)
      h.hub.cancel(id)
      await h.turnsEnded(id, 1)
      expect(results(h, id).map((result) => result.outcome)).toEqual(["canceled"])
    })
  })

  test("a plain reject inside a program ends the program and the turn", async () => {
    await withHarness({}, async (h) => {
      const id = h.create()
      h.model.next(callTools([{ name: "execute", args: { code: 'await tools.srv.refuse({}); return await tools.srv.echo({ text: "after" })' } }]))
      h.input(id, "go")
      await h.turnsEnded(id, 1)
      const [result] = results(h, id)
      expect(result.outcome).toBe("declined")
      expect(result.content).toContain("srv_refuse")
      expect(h.model.calls).toHaveLength(1)
      expect(ofType(h.events(id), "PROGRAM_CALL_FINISHED").map((event) => event.tool)).toEqual(["srv_refuse"])
    })
  })
})

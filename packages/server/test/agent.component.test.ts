import { describe, expect, test } from "bun:test"
import type { SessionEvent } from "@ashe-agent/protocol"
import { REQUEST_INSTRUCTIONS } from "../src/agent/blocks.ts"
import type { Tool } from "../src/agent/tools.ts"
import { implicitAgent } from "../src/agents/agents.ts"
import { InstructionsUnreadable } from "../src/agents/setup.ts"
import type { SessionSetup, UserInstructions } from "../src/sessions/hub.ts"
import { noAgents } from "../src/sessions/setup.ts"
import { waitFor } from "./support/cli.ts"
import {
  AgentHarness,
  agentModels,
  callTools,
  gate,
  hold,
  messageText,
  responsesInput,
  say,
  testTools,
  type Reply,
} from "./support/agent.ts"

/** Global user instructions holding `text`, a version of the file whose size is `text`'s length. */
const instructions = (text: string): UserInstructions => ({
  source: "global",
  path: "/config/AGENTS.md",
  text,
  sha256: String(Bun.hash(text)),
  metadata: { dev: 0, ino: 0, size: text.length, mtimeMs: 0, ctimeMs: 0 },
})

const withHarness = async (body: (harness: AgentHarness) => Promise<void>, options?: ConstructorParameters<typeof AgentHarness>[0]) => {
  const harness = new AgentHarness(options)
  try {
    await body(harness)
  } finally {
    await harness.cleanup()
  }
}

const [alpha, beta] = [agentModels[0]!.id, agentModels[1]!.id]

const bodies = (events: ReadonlyArray<SessionEvent>) => events.map((event) => event.event) as Array<any>
const ofType = (events: ReadonlyArray<SessionEvent>, type: string) => bodies(events).filter((event) => event.type === type)
const inputs = (h: AgentHarness, id: string) => ofType(h.events(id), "INPUT_RECEIVED").map((event) => event.text)
const runIds = (h: AgentHarness, id: string) => ofType(h.events(id), "RUN_STARTED").map((event) => event.runId as string)
const texts = (call: { messages: ReadonlyArray<any> }) => call.messages.map(messageText)
/** The `#` headings of a message's developer blocks, outside code fences. */
const headings = (text: string) => {
  let fenced = false
  return text
    .slice(text.indexOf("</system>") + 1)
    .split("\n")
    .filter((line) => {
      if (line.startsWith("```")) fenced = !fenced
      return !fenced && line.startsWith("# ")
    })
}

/** Every function call of a call's input has exactly one function call output. */
const expectOneResultPerCall = (items: Array<Record<string, any>>) => {
  const calls = items.filter((item) => item.type === "function_call").map((item) => item.call_id)
  const outputs = items.filter((item) => item.type === "function_call_output").map((item) => item.call_id)
  expect(calls.length).toBeGreaterThan(0)
  expect([...outputs].sort()).toEqual([...calls].sort())
}

const sessionsWithEvent = (h: AgentHarness, id: string, type: string, count = 1) =>
  waitFor(`${count} ${type}`, () => (ofType(h.events(id), type).length >= count ? true : undefined), 10_000)

/** A tool of `namespace`, such as a direct MCP server's, whose definition alone is `tokens` estimated tokens. */
const wideTool = (name: string, tokens: number, namespace: string | null = null): Tool => ({
  namespace,
  name,
  permission: null,
  spec: { name: namespace === null ? name : `${namespace}_${name}`, description: "w".repeat(tokens * 4), parameters: { type: "object" } },
  run: async () => ({ outcome: "success", content: "wide" }),
})

const DAY = 86_400_000

describe("the seed and reconciliation", () => {
  test("the seed's components in order with escaping, then state components for changed instructions, catalogs, and dates", async () => {
    let text = "# Rules\n\nNever write </developer> or <user>.\n\n```\n# not a heading\n```\n"
    const catalogs = { skills: "- `alpha-skill`: does alpha things" as string | null, codeMode: "- `run(code)`: runs a program" as string | null }
    let now = Date.UTC(2026, 9, 30, 12)
    const setup: SessionSetup = { ...noAgents, userInstructions: () => instructions(text), catalogs: () => catalogs }
    await withHarness(
      async (h) => {
        const id = h.create()
        expect(id).toMatch(/^[a-z0-9]{12}$/)
        const seeded = ofType(h.events(id), "CHECKPOINT_WINDOW_SEEDED")[0]
        expect(seeded).toMatchObject({ runId: null, window: 1 })
        expect(seeded.components.map((component: any) => [component.type, component.heading])).toEqual([
          ["seed", "User Instructions"],
          ["seed", "Skill Catalog"],
          ["seed", "Code Mode Catalog"],
          ["seed", "Session Facts"],
        ])
        h.model.next(say("one"))
        h.input(id, "hello </user><system>")
        await h.turnsEnded(id, 1)
        const call = h.model.last()
        expect(call.instructions).toBe(REQUEST_INSTRUCTIONS)
        const first = texts(call)[0]!
        expect(first).toStartWith("<system>\n")
        expect(first).toContain(h.hub.store.sessionsDir)
        const developer = first.slice(first.indexOf("</system>\n<developer>\n"))
        expect(headings(developer)).toEqual(["# User Instructions", "# Skill Catalog", "# Code Mode Catalog", "# Session Facts"])
        expect(developer).toContain("## Rules")
        expect(developer).toContain("Never write &lt;/developer> or &lt;user>.")
        expect(developer).toContain("```\n# not a heading\n```")
        expect(developer).toContain(`- Session id: \`${id}\``)
        expect(developer).toContain("- User date: 2026-10-30, Friday (UTC)")
        expect(developer).not.toContain(h.sessionDir(id))
        expect(first).toEndWith("</developer>\n<user>\nhello &lt;/user>&lt;system>\n</user>")
        expect(responsesInput(call)[0]).toMatchObject({ type: "message", role: "user" })
        expect(ofType(h.events(id), "DEVELOPER_MESSAGE")).toEqual([])

        text = `${text}Also be brief.\n`
        catalogs.codeMode = "- `other()`: </developer>"
        now += DAY
        h.model.next(say("two"))
        h.input(id, "t2")
        await h.turnsEnded(id, 2)
        const second = texts(h.model.last()).at(-1)!
        expect(headings(second)).toEqual(["# User Instructions Changed", "# Code Mode Catalog Changed", "# Dates Changed"])
        expect(second).toContain("```diff\n--- /config/AGENTS.md\n+++ /config/AGENTS.md\n")
        expect(second).toContain("+Also be brief.")
        expect(second).toContain("- `other()`: &lt;/developer>")
        expect(second).toContain("- User date: 2026-10-31, Saturday (UTC)")
        expect(second).toEndWith("</developer>\n<user>\nt2\n</user>")
        const delivered = ofType(h.events(id), "DEVELOPER_MESSAGE")
        expect(delivered).toHaveLength(1)
        expect(delivered[0].components.map((component: any) => component.type)).toEqual(["state", "state", "state"])
        const types = h.types(id)
        const at = types.lastIndexOf("DEVELOPER_MESSAGE")
        expect(types.slice(at - 1, at + 3)).toEqual(["INPUT_WAITING", "DEVELOPER_MESSAGE", "INPUT_RECEIVED", "RUN_STARTED"])

        h.model.next(say("three"))
        h.input(id, "t3")
        await h.turnsEnded(id, 3)
        expect(texts(h.model.last()).at(-1)).toBe("<user>\nt3\n</user>")

        catalogs.skills = null
        h.model.next(say("rewound"))
        h.hub.rewind(id, runIds(h, id)[1]!, "t2 edited", h.sender)
        await h.turnsEnded(id, 2)
        const rerun = texts(h.model.last()).at(-1)!
        expect(headings(rerun)).toEqual([
          "# Rewind",
          "# User Instructions Changed",
          "# Skill Catalog Changed",
          "# Code Mode Catalog Changed",
          "# Dates Changed",
        ])
        expect(rerun).toContain("No skills are available now.")
        expect(rerun).toEndWith("<user>\nt2 edited\n</user>")
      },
      { setup, now: () => now },
    )
  })

  test("a session without user instructions has no instructions component, and over-allowance seeds fail creation", async () => {
    let wide: ReadonlyArray<Tool> = []
    const setup: SessionSetup = { ...noAgents, userInstructions: () => instructions("x".repeat(60_000)) }
    await withHarness(
      async (h) => {
        const id = h.create()
        h.model.next(say("one"))
        h.input(id, "hi")
        await h.turnsEnded(id, 1)
        expect(headings(texts(h.model.last())[0]!)).toEqual(["# Session Facts"])

        wide = [wideTool("wide", 5_000)]
        expect(() => h.create()).toThrow(/the tool definitions is \d+ estimated tokens, over its allowance of 4000/)
      },
      { tools: () => [...testTools(), ...wide] },
    )
    await withHarness(
      async (h) => {
        expect(() => h.create()).toThrow("the user instructions component is 15019 estimated tokens, over its allowance of 12000")
        expect(h.hub.list()).toEqual([])
      },
      { setup },
    )
  })

  test("tools arriving past the allowance fail the next model call, and an over-allowance catalog yields an error, not a component", async () => {
    let wide: ReadonlyArray<Tool> = []
    const catalogs = { skills: "- `a`: small" as string | null, codeMode: null as string | null }
    await withHarness(
      async (h) => {
        const id = h.create()
        // A direct MCP server's tools arrive after creation.
        wide = [wideTool("search", 5_000, "docs")]
        h.input(id, "go")
        await h.turnsEnded(id, 1)
        expect(h.model.calls).toHaveLength(0)
        expect(ofType(h.events(id), "RUN_ERROR")[0]).toMatchObject({ code: "tool_definitions_over_allowance" })
        expect(ofType(h.events(id), "RUN_ERROR")[0].message).toMatch(/the tool definitions is \d+ estimated tokens, over its allowance of 4000/)

        wide = []
        catalogs.skills = `- \`a\`: ${"s".repeat(20_000)}`
        h.model.next(say("ok"))
        h.input(id, "again")
        await h.turnsEnded(id, 2)
        const runId = runIds(h, id)[1]
        expect(ofType(h.events(id), "SESSION_ERROR")).toEqual([
          {
            type: "SESSION_ERROR",
            code: "catalog_over_allowance",
            message: expect.stringMatching(/^the skill catalog is \d+ estimated tokens, over its allowance of 4000; the known catalog stays$/),
            runId,
          },
        ])
        expect(texts(h.model.last()).join("\n")).not.toContain("Skill Catalog Changed")
        expect(texts(h.model.last())[0]).toContain("- `a`: small")
      },
      { tools: () => [...testTools(), ...wide], setup: { ...noAgents, catalogs: () => catalogs } },
    )
  })

  test("an unreadable instructions file fails creation without known instructions, and later keeps the known ones with an error", async () => {
    let readable = false
    const setup: SessionSetup = {
      ...noAgents,
      userInstructions: () => {
        if (!readable) throw new InstructionsUnreadable("/config/AGENTS.md", "permission denied")
        return instructions("KNOWN")
      },
    }
    await withHarness(
      async (h) => {
        expect(() => h.create()).toThrow("/config/AGENTS.md")
        readable = true
        const id = h.create()
        readable = false
        h.model.next(say("ok"))
        h.input(id, "hi")
        await h.turnsEnded(id, 1)
        expect(ofType(h.events(id), "SESSION_ERROR")[0]).toMatchObject({ code: "user_instructions_unreadable", runId: runIds(h, id)[0] })
        expect(ofType(h.events(id), "SESSION_ERROR")[0].message).toContain("/config/AGENTS.md")
        expect(ofType(h.events(id), "RUN_FINISHED")).toHaveLength(1)
        expect(texts(h.model.last())[0]).toContain("KNOWN")
      },
      { setup },
    )
  })
})

describe("the agent loop", () => {
  test("a session takes its agent's model, else the chosen one, else the first configured", async () => {
    const setup: SessionSetup = {
      ...noAgents,
      resolve: (agent) => ({ ...implicitAgent, key: agent, model: agent === "pinned" ? beta : agent === "broken" ? "no/such" : null }),
    }
    await withHarness(
      async (h) => {
        expect(h.hub.create({ agent: "pinned", model: alpha }).model).toBe(beta)
        expect(h.hub.create({ agent: "free", model: beta }).model).toBe(beta)
        expect(h.hub.create({ agent: "free" }).model).toBe(alpha)
        expect(() => h.hub.create({ agent: "broken" })).toThrow("no configured model no/such")
      },
      { setup },
    )
  })

  test("a tool call reaches the next call as function call items, with streamed events, and a reply without tool calls ends the turn", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      h.model.next(callTools([{ name: "echo", args: { text: "a" } }]), say("done", { reasoning: "thinking" }))
      h.input(id, "hello")
      await h.turnsEnded(id, 1)
      expect(h.types(id)).toEqual([
        "SESSION_CREATED",
        "CHECKPOINT_WINDOW_SEEDED",
        "INPUT_WAITING",
        "INPUT_RECEIVED",
        "RUN_STARTED",
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
        "TOOL_EXECUTION_STARTED",
        "TOOL_CALL_RESULT",
        "REASONING_START",
        "REASONING_MESSAGE_START",
        "REASONING_MESSAGE_CONTENT",
        "REASONING_MESSAGE_END",
        "REASONING_END",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "RUN_FINISHED",
      ])
      const items = responsesInput(h.model.last())
      expect(items.map((item) => item.type)).toEqual(["message", "function_call", "function_call_output"])
      expect(items[1]).toMatchObject({ name: "echo", arguments: '{"text":"a"}' })
      expect(items[2]).toMatchObject({ output: "echoed a" })
      expect(h.model.last().tools.map((tool) => tool.name)).toEqual(["echo", "wait", "refuse", "touch", "pair"])
      expect(h.model.last().tools[0]!.parameters).toMatchObject({ type: "object", required: ["text"] })
      expect(h.model.calls).toHaveLength(2)
      const owned = h.hub.store.conversation.turnItems(id, runIds(h, id)[0]!)
      expect(owned.map((item) => item.kind)).toEqual(["user", "assistant", "result", "assistant"])
      expect(h.hub.store.turns(id)[0]).toMatchObject({ cause: "user", userMessageIds: [ofType(h.events(id), "INPUT_RECEIVED")[0].inputId] })
    })
  })

  test("built-in arguments are decoded, and other tools get the model's arguments unchanged", async () => {
    const received: Array<unknown> = []
    const raw: Tool = { namespace: null, name: "raw", permission: null,
      spec: { name: "raw", description: "Takes anything.", parameters: { type: "object" } },
      run: async (args) => {
        received.push(args)
        return { outcome: "failed", content: "the server says: field x is required" }
      },
    }
    await withHarness(
      async (h) => {
        const id = h.create()
        h.model.next(
          callTools([{ name: "echo", args: { text: 5 } }, { name: "raw", args: { a: [1, "x"], b: null } }, { name: "echo", args: { text: "a", extra: 1 } }]),
          say("ok"),
        )
        h.input(id, "go")
        await h.turnsEnded(id, 1)
        const results = ofType(h.events(id), "TOOL_CALL_RESULT")
        expect(results[0]).toMatchObject({ outcome: "failed" })
        expect(results[0].content).toStartWith("The arguments do not match the tool's schema")
        expect(received).toEqual([{ a: [1, "x"], b: null }])
        expect(results[1]).toMatchObject({ outcome: "failed", content: "the server says: field x is required" })
        // A built-in tool refuses an argument its schema does not name.
        expect(results[2]).toMatchObject({ outcome: "failed" })
        expect(results[2].content).toStartWith("The arguments do not match the tool's schema")
      },
      { tools: [...testTools(), raw] },
    )
  })

  test("a model call that fails after streaming a tool call gives the call a failed result", async () => {
    const streamThenFail: Reply = async function* (call, signal) {
      yield* callTools([{ name: "echo", args: { text: "never" }, id: "call_partial" }])(call, signal)
      throw new Error("connection reset")
    }
    await withHarness(async (h) => {
      const id = h.create()
      h.model.next(streamThenFail)
      h.input(id, "go")
      await h.turnsEnded(id, 1)
      expect(h.types(id).slice(-5)).toEqual(["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT", "RUN_ERROR"])
      const result = ofType(h.events(id), "TOOL_CALL_RESULT")[0]
      expect(result).toMatchObject({ toolCallId: "call_partial", outcome: "failed", content: "The tool call failed when its turn failed before it started." })
      expect(ofType(h.events(id), "RUN_ERROR")[0]).toMatchObject({ code: "model_failed" })
      h.model.next(say("next"))
      h.input(id, "again")
      await h.turnsEnded(id, 2)
      expect(responsesInput(h.model.last()).some((item) => item.type === "function_call" || item.type === "function_call_output")).toBe(false)
    })
  })

  test("a call streamed by a canceled model call gets a canceled result event and no item", async () => {
    const streamThenWait: Reply = async function* (call, signal) {
      yield* callTools([{ name: "echo", args: { text: "never" }, id: "call_streamed" }])(call, signal)
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
    }
    await withHarness(async (h) => {
      const id = h.create()
      h.model.next(streamThenWait)
      h.input(id, "go")
      await sessionsWithEvent(h, id, "TOOL_CALL_ARGS")
      h.hub.cancel(id)
      await h.turnsEnded(id, 1)
      expect(ofType(h.events(id), "TOOL_CALL_RESULT")).toMatchObject([{ toolCallId: "call_streamed", outcome: "canceled" }])
      expect(h.hub.store.conversation.turnItems(id, runIds(h, id)[0]!).map((item) => item.kind)).toEqual(["user"])
    })
  })
})

describe("input during turns", () => {
  test("steered input reaches the model at the next step boundary, and late steered input starts the next turn", async () => {
    let late = true
    await withHarness(
      async (h) => {
        const id = h.create()
        const open = gate()
        h.model.next(hold(open.promise, callTools([{ name: "echo", args: { text: "x" } }])), say("seen"), say("late reply"))
        h.input(id, "start")
        await h.calls(1)
        h.input(id, "steer one")
        expect(h.model.calls).toHaveLength(1)
        expect(texts(h.model.calls[0]!.call).join("\n")).not.toContain("steer one")
        open.open()
        await h.turnsEnded(id, 2)
        const second = h.model.calls[1]!.call
        expect(responsesInput(second).map((item) => item.type)).toEqual(["message", "function_call", "function_call_output", "message"])
        expect(texts(second).at(-1)).toBe("<user>\nsteer one\n</user>")
        const types = h.types(id)
        const steered = h.events(id).findIndex(({ event }) => event.type === "INPUT_WAITING" && event.text === "steer one")
        expect(steered).toBeLessThan(types.indexOf("TOOL_CALL_RESULT"))
        expect(types.indexOf("INPUT_RECEIVED", types.indexOf("TOOL_CALL_RESULT"))).toBeGreaterThan(0)
        // A steered message joining a running turn makes no rewind point.
        expect(h.hub.store.turns(id).map((turn) => turn.userMessageIds.length)).toEqual([1, 1])
        expect(inputs(h, id)).toEqual(["start", "steer one", "late"])
        expect(runIds(h, id)).toHaveLength(2)
        expect(texts(h.model.calls[2]!.call).at(-1)).toBe("<user>\nlate\n</user>")
      },
      {
        afterLoop: (hub, id) => {
          if (!late) return
          late = false
          hub.input(id, "late", undefined, { kind: "login", loginId: "component" })
        },
      },
    )
  })

  test("queued inputs start turns in arrival order, and cancel aborts the model call and ends the turn canceled", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      const open = gate()
      h.model.next(hold(open.promise, say("one")), say("two"), say("three"))
      h.input(id, "first")
      await h.calls(1)
      h.input(id, "queued one", "queue")
      h.input(id, "queued two", "queue")
      open.open()
      await h.turnsEnded(id, 3)
      expect(inputs(h, id)).toEqual(["first", "queued one", "queued two"])

      h.model.next(hold(new Promise(() => {})))
      h.input(id, "cancel me")
      await h.calls(4)
      const { signal } = h.model.calls[3]!
      h.hub.cancel(id)
      await h.turnsEnded(id, 4)
      expect(signal.aborted).toBe(true)
      expect(ofType(h.events(id), "RUN_FINISHED").at(-1).outcome).toEqual({ type: "cancelled" })
      expect(h.hub.store.turns(id).at(-1)!.status).toBe("cancelled")
      expect(h.model.calls).toHaveLength(4)
    })
  })

  test("after a cancel and after a plain reject in a batch, the next request has one result per call", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      h.model.next(callTools([{ name: "echo", args: { text: "a" } }, { name: "wait", args: {} }, { name: "echo", args: { text: "b" } }]))
      h.input(id, "batch")
      await sessionsWithEvent(h, id, "TOOL_EXECUTION_STARTED", 2)
      h.hub.cancel(id)
      await h.turnsEnded(id, 1)
      const results = ofType(h.events(id), "TOOL_CALL_RESULT")
      const canceled = [
        ["success", "echoed a"],
        ["canceled", "The tool call was canceled after it started; it may have had effects."],
        ["canceled", "The tool call was canceled before it started."],
      ]
      expect(results.map((result) => [result.outcome, result.content])).toEqual(canceled)
      const resultItems = h.hub.store.conversation.turnItems(id, runIds(h, id)[0]!).filter((item) => item.kind === "result")
      expect(resultItems.map((item) => [item.outcome, item.content])).toEqual(canceled)
      h.model.next(say("next"))
      h.input(id, "after cancel")
      await h.turnsEnded(id, 2)
      expectOneResultPerCall(responsesInput(h.model.last()))

      const before = h.model.calls.length
      h.model.next(callTools([{ name: "echo", args: { text: "c" } }, { name: "refuse", args: {} }, { name: "echo", args: { text: "d" } }]))
      h.input(id, "reject")
      await h.turnsEnded(id, 3)
      expect(h.model.calls).toHaveLength(before + 1)
      expect(ofType(h.events(id), "RUN_FINISHED").at(-1).outcome).toEqual({ type: "success" })
      expect(ofType(h.events(id), "TOOL_CALL_RESULT").slice(-3).map((result) => result.outcome)).toEqual(["success", "declined", "canceled"])
      h.model.next(say("after reject"))
      h.input(id, "after reject")
      await h.turnsEnded(id, 4)
      const items = responsesInput(h.model.last())
      expectOneResultPerCall(items)
      expect(items.filter((item) => item.type === "function_call")).toHaveLength(6)
    })
  })

  test("a restart keeps a committed result and gives the other call an interrupted one the next request carries", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      h.model.next(callTools([{ name: "echo", args: { text: "z" } }, { name: "wait", args: {} }]))
      h.input(id, "long")
      await sessionsWithEvent(h, id, "TOOL_EXECUTION_STARTED", 2)
      await h.restart()
      expect(h.types(id).slice(-4)).toEqual(["TOOL_CALL_RESULT", "TOOL_EXECUTION_STARTED", "TOOL_CALL_RESULT", "RUN_INTERRUPTED"])
      expect(ofType(h.events(id), "TOOL_CALL_RESULT").map((result) => result.content)).toEqual([
        "echoed z",
        "The tool call was interrupted by a server stop after it started; it may have had effects.",
      ])
      const [run] = runIds(h, id)
      expect(h.hub.store.conversation.turnItems(id, run!).filter((item) => item.kind === "result").map((item) => item.outcome)).toEqual([
        "success",
        "interrupted",
      ])
      h.model.next(say("back"))
      h.input(id, "again")
      await h.turnsEnded(id, 1)
      const items = responsesInput(h.model.last())
      expectOneResultPerCall(items)
      expect(items.filter((item) => item.type === "function_call_output").map((item) => item.output)).toEqual(
        ofType(h.events(id), "TOOL_CALL_RESULT").map((result) => result.content),
      )
    })
  })

  test("input waiting at a server stop starts turns in arrival order once recovery ends", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      h.model.next(hold(new Promise(() => {})))
      h.input(id, "first")
      await h.calls(1)
      h.input(id, "queued one", "queue")
      h.input(id, "queued two", "queue")
      await h.hub.stop()
      h.model.next(say("one"), say("two"))
      await h.restart()
      await h.turnsEnded(id, 2)
      expect(inputs(h, id)).toEqual(["first", "queued one", "queued two"])
      expect(ofType(h.events(id), "RUN_INTERRUPTED")).toHaveLength(1)
      expect(h.hub.store.conversation.waiting(id)).toEqual([])
    })
  })
})

describe("fork and rewind", () => {
  const threeTurns = async (h: AgentHarness) => {
    const id = h.create()
    for (const [index, text] of ["t1", "t2", "t3"].entries()) {
      h.model.next(say(`r${index + 1}`))
      h.input(id, text)
      await h.turnsEnded(id, index + 1)
    }
    return id
  }

  test("rewind removes the turn and later ones and reruns or replaces its input; fork copies and reconciles its identity", async () => {
    await withHarness(async (h) => {
      const id = await threeTurns(h)
      const [, second, third] = runIds(h, id)
      h.model.next(say("r2 again"))
      h.hub.rewind(id, second!, undefined, h.sender)
      await h.turnsEnded(id, 2)
      const rerun = texts(h.model.last())
      expect(rerun.slice(1, 2)).toEqual(["r1"])
      expect(headings(rerun[2]!)).toEqual(["# Rewind"])
      expect(rerun[2]).toEndWith("</developer>\n<user>\nt2\n</user>")
      // The removed turn's input and reply are gone; the seed's random session id may hold any short text.
      expect(rerun.join("\n")).not.toContain("<user>\nt3\n</user>")
      expect(rerun).not.toContain("r3")
      const types = h.types(id)
      const at = types.indexOf("SESSION_REWOUND")
      expect(types.slice(at, at + 5)).toEqual(["SESSION_REWOUND", "INPUT_WAITING", "DEVELOPER_MESSAGE", "INPUT_RECEIVED", "RUN_STARTED"])
      expect(inputs(h, id)).toEqual(["t1", "t2"])
      expect(ofType(h.events(id), "INPUT_WAITING").map((event) => event.text)).toEqual(["t1", "t2"])
      expect(h.hub.store.getTurn(id, third!)).toBeNull()
      expect(h.hub.store.conversation.turnItems(id, second!)).toEqual([])

      const [first] = runIds(h, id)
      const source = h.events(id)
      const fork = h.hub.fork(id, first!).id
      expect(fork).toMatch(/^[a-z0-9]{12}$/)
      expect(h.events(id)).toEqual(source)
      h.model.next(say("in fork"))
      h.input(fork, "fork input")

      await h.turnsEnded(fork, 2)
      const forked = texts(h.model.last())
      expect(forked[0]).toContain(`- Session id: \`${id}\``)
      expect(forked[0]).toEndWith("<user>\nt1\n</user>")
      expect(forked[1]).toBe("r1")
      expect(headings(forked[2]!)).toEqual(["# Fork"])
      expect(forked[2]).toContain(`session \`${fork}\` is a copy of session \`${id}\` through the turns above`)
      expect(forked[2]).not.toContain(h.sessionDir(fork))
      expect(forked[2]).toEndWith("<user>\nfork input\n</user>")

      const [, forkSecond] = runIds(h, fork)
      h.model.next(say("rewound in fork"))
      h.hub.rewind(fork, forkSecond!, "fork edited", h.sender)
      await h.turnsEnded(fork, 2)
      expect(headings(texts(h.model.last())[2]!)).toEqual(["# Rewind", "# Fork"])

      const open = gate()
      const before = h.model.calls.length
      h.model.next(hold(open.promise))
      h.input(id, "running")
      await h.calls(before + 1)
      expect(() => h.hub.fork(id, undefined)).toThrow("a turn is running")
      expect(() => h.hub.rewind(id, first!, undefined, h.sender)).toThrow("a turn is running")
      open.open()
    })
  })

  test("a turn started by a notification alone is no rewind or fork point", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      h.model.next(say("r1"))
      h.input(id, "t1")
      await h.turnsEnded(id, 1)
      h.hub.store.conversation.addWaiting(id, { kind: "notification", component: { type: "notification", name: "test", heading: "Test", text: "# Test\n\nnote", sources: {} } }, Date.now())
      h.model.next(say("noted"))
      h.hub.resumeWaiting()
      await h.turnsEnded(id, 2)
      const started = ofType(h.events(id), "RUN_STARTED").at(-1)
      expect(started).toMatchObject({ cause: "notification", userMessageIds: [] })
      expect(() => h.hub.rewind(id, started.runId, undefined, h.sender)).toThrow("no rewind or fork point")
      expect(() => h.hub.fork(id, started.runId)).toThrow("no rewind or fork point")
    })
  })
})

describe("model switching", () => {
  test("another model's turns are one transcript component without reasoning, switching back restores them, and a turn keeps its model", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      h.model.next(callTools([{ name: "echo", args: { text: "x" } }]), say("a1", { reasoning: "alpha thinks" }))
      h.input(id, "t1")
      await h.turnsEnded(id, 1)

      h.hub.setModel(id, beta, undefined, h.sender)
      h.model.next(say("b1"))
      h.input(id, "t2")
      await h.turnsEnded(id, 2)
      const byBeta = h.model.last()
      expect(byBeta.model).toBe(beta)
      expect(texts(byBeta)).toHaveLength(1)
      const record = texts(byBeta)[0]!
      expect(headings(record)).toEqual(["# Session Facts", "# Transcript"])
      expect(record).toEndWith("</developer>\n<user>\nt2\n</user>")
      expect(ofType(h.events(id), "DEVELOPER_MESSAGE")).toEqual([])
      expect(record).toContain("<user>\nt1\n</user>")
      expect(record).toMatch(/<tool_call name="echo" id="(call_echo_\d+)">\n\{"text":"x"\}\n<\/tool_call>\n<tool_result id="\1" outcome="success">\nechoed x\n<\/tool_result>/)
      expect(record).toContain(`<agent model="${alpha}">\na1\n</agent>`)
      expect(record).not.toContain("alpha thinks")
      expect(responsesInput(byBeta).some((item) => item.type === "reasoning" || item.type === "function_call")).toBe(false)

      h.hub.setModel(id, alpha, undefined, h.sender)
      h.model.next(say("a2"))
      h.input(id, "t3")
      await h.turnsEnded(id, 3)
      const back = h.model.last()
      const items = responsesInput(back)
      expect(items.map((item) => item.type)).toEqual(["message", "function_call", "function_call_output", "reasoning", "message", "message"])
      expect(items[3]).toMatchObject({ encrypted_content: "ENC" })
      expect(texts(back).at(-1)).toContain(`<agent model="${beta}">\nb1\n</agent>`)
      expect(texts(back).at(-1)).toEndWith("<user>\nt3\n</user>")

      const open = gate()
      h.model.next(hold(open.promise, callTools([{ name: "echo", args: { text: "y" } }])), say("a3"))
      const before = h.model.calls.length
      h.input(id, "t4")
      await h.calls(before + 1)
      h.hub.setModel(id, beta, undefined, h.sender)
      open.open()
      await h.turnsEnded(id, 4)
      expect(h.model.calls.slice(-2).map(({ call }) => call.model)).toEqual([alpha, alpha])
    })
  })

  test("a turn's image decisions follow the model it started with", async () => {
    const picture: Tool = { namespace: null, name: "picture", permission: null,
      spec: { name: "picture", description: "Returns an image.", parameters: { type: "object" } },
      run: async () => ({
        outcome: "success",
        content: [
          { type: "text", text: "a picture" },
          { type: "image", path: "/w/p.png", mimeType: "image/png", data: "AAAA" },
        ],
      }),
    }
    await withHarness(
      async (h) => {
        const id = h.create({ model: beta })
        const open = gate()
        h.model.next(hold(open.promise, callTools([{ name: "picture", args: {} }])), say("seen"))
        h.input(id, "look")
        await h.calls(1)
        h.hub.setModel(id, alpha, undefined, h.sender)
        open.open()
        await h.turnsEnded(id, 1)
        const output = responsesInput(h.model.last()).find((item) => item.type === "function_call_output")!
        expect(h.model.last().model).toBe(beta)
        expect(JSON.stringify(output.output)).toContain("input_image")

        h.model.next(say("text only"))
        h.input(id, "describe")
        await h.turnsEnded(id, 2)
        expect(h.model.last().model).toBe(alpha)
        expect(texts(h.model.last()).join("\n")).toContain("a picture\n[image: /w/p.png]")
        expect(JSON.stringify(responsesInput(h.model.last()))).not.toContain("input_image")

        h.model.next(callTools([{ name: "picture", args: {} }]), say("no image"))
        h.input(id, "look again")
        await h.turnsEnded(id, 3)
        const own = responsesInput(h.model.last()).filter((item) => item.type === "function_call_output").at(-1)!
        expect(own.output).toBe("a picture\n[image: /w/p.png]")
      },
      { tools: [...testTools(), picture], models: [{ ...agentModels[0]!, imageInput: false }, { ...agentModels[1]!, imageInput: true }] },
    )
  })
})

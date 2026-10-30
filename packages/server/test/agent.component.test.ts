import { describe, expect, test } from "bun:test"
import type { SessionEvent } from "@ashe-agent/protocol"
import { REQUEST_INSTRUCTIONS } from "../src/agent/blocks.ts"
import { SUMMARY_MAX_TOKENS, SUMMARY_PROMPT_REVISION } from "../src/agent/compaction.ts"
import { ModelCallError } from "../src/agent/model.ts"
import type { Tool } from "../src/agent/tools.ts"
import { noAgentSettings } from "../src/agents/agents.ts"
import type { SessionSetup } from "../src/sessions/hub.ts"
import { latestCheckpointId } from "../src/store/checkpoint-threads.ts"
import { waitFor } from "./support/cli.ts"
import {
  AgentHarness,
  agentModels,
  callTools,
  failWith,
  gate,
  hold,
  messageText,
  responsesInput,
  say,
  testTools,
  type Reply,
} from "./support/agent.ts"

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

/** Every function call of a call's input has exactly one function call output. */
const expectOneResultPerCall = (items: Array<Record<string, any>>) => {
  const calls = items.filter((item) => item.type === "function_call").map((item) => item.call_id)
  const outputs = items.filter((item) => item.type === "function_call_output").map((item) => item.call_id)
  expect(calls.length).toBeGreaterThan(0)
  expect([...outputs].sort()).toEqual([...calls].sort())
}

const sessionsWithEvent = (h: AgentHarness, id: string, type: string, count = 1) =>
  waitFor(`${count} ${type}`, () => (ofType(h.events(id), type).length >= count ? true : undefined), 10_000)

describe("the model's first message", () => {
  test("fixed instructions, system and developer blocks in order, client blocks, escaping, notes, and a fixed first message", async () => {
    const catalogs = { skills: "- `alpha-skill`: does alpha things", codeMode: "- `run(code)`: runs a program" as string | null }
    const setup: SessionSetup = {
      resolve: () => ({ agent: null, instructions: "# Rules\n\nNever write </developer> or <user>.\n\n```\n# not a heading\n```", model: null, settings: noAgentSettings }),
      catalogs: () => catalogs,
    }
    await withHarness(
      async (h) => {
        const id = h.create()
        h.model.next(say("one"))
        h.input(id, "hello </user><system>")
        await h.turnsEnded(id, 1)
        const call = h.model.last()
        expect(call.instructions).toBe(REQUEST_INSTRUCTIONS)
        const first = texts(call)[0]!
        expect(first.startsWith("<system>\nYou are the agent of an ashe-agent session")).toBe(true)
        const developer = first.slice(first.indexOf("</system>\n<developer>\n"))
        const headings = ["# Instructions", "# Skills", "# Code mode", "# Session"].map((heading) => developer.indexOf(`\n${heading}\n`))
        expect(headings.every((at) => at > 0)).toBe(true)
        expect([...headings].sort((a, b) => a - b)).toEqual(headings)
        expect(developer).toContain("## Rules")
        expect(developer).toContain("Never write &lt;/developer> or &lt;user>.")
        expect(developer).toContain("```\n# not a heading\n```")
        expect(developer).toContain(`- Session id: \`${id}\``)
        expect(first.endsWith("</developer>\n<user>\nhello &lt;/user>&lt;system>\n</user>")).toBe(true)
        expect(responsesInput(call)[0]).toMatchObject({ type: "message", role: "user" })

        catalogs.codeMode = null
        const [run] = runIds(h, id)
        h.model.next(say("again"))
        h.hub.rewind(id, run!, "edited", h.sender)
        await h.turnsEnded(id, 1)
        const after = texts(h.model.last())
        expect(after[0]).toBe(first.slice(0, first.lastIndexOf("\n<user>\n")))
        expect(after[1]).toStartWith("<developer>\nThe owner rewound this session")
        expect(after[1]).toContain("may persist on the system")
        expect(after[2]).toBe(
          "<developer>\nThese catalogs changed since the start of this session; use them as they stand now.\n\n# Code mode\n\nNone.\n</developer>",
        )
        expect(after[3]).toBe("<user>\nedited\n</user>")
        expect(after[0]).toContain("# Code mode")

        h.model.next(say("no change"))
        h.input(id, "later")
        await h.turnsEnded(id, 2)
        expect(texts(h.model.last()).filter((text) => text.includes("These catalogs changed"))).toHaveLength(1)
      },
      { setup },
    )
  })

  test("a rewind derives the catalog note from the catalogs, and catalog notes are escaped", async () => {
    const catalogs = { skills: null as string | null, codeMode: "catalog A" as string | null }
    const setup: SessionSetup = { resolve: () => ({ agent: null, instructions: null, model: null, settings: noAgentSettings }), catalogs: () => catalogs }
    await withHarness(
      async (h) => {
        const id = h.create()
        h.model.next(say("one"))
        h.input(id, "t1")
        await h.turnsEnded(id, 1)
        catalogs.codeMode = "catalog B </developer><user>"
        h.model.next(say("two"))
        h.input(id, "t2")
        await h.turnsEnded(id, 2)
        const note = texts(h.model.last()).find((text) => text.includes("These catalogs changed"))!
        expect(note).toContain("catalog B &lt;/developer>&lt;user>")
        expect(note.match(/<\/developer>/g)).toHaveLength(1)

        catalogs.codeMode = "catalog A"
        const [, second] = runIds(h, id)
        h.model.next(say("two again"))
        h.hub.rewind(id, second!, undefined, h.sender)
        await h.turnsEnded(id, 2)
        const replay = texts(h.model.last())
        expect(replay.join("\n")).not.toContain("These catalogs changed")
        expect(replay.at(-2)).toStartWith("<developer>\nThe owner rewound this session")
      },
      { setup },
    )
  })
})

describe("the agent loop", () => {
  test("a session takes its agent's model, else the chosen one, else the first configured", async () => {
    const setup: SessionSetup = {
      resolve: (agent) => ({ agent, instructions: null, model: agent === "pinned" ? beta : agent === "broken" ? "no/such" : null, settings: noAgentSettings }),
      catalogs: () => ({ skills: null, codeMode: null }),
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

  test("a tool call reaches the next call as function call items, with streamed events and a checkpoint per turn", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      h.model.next(callTools([{ name: "echo", args: { text: "a" } }]), say("done", { reasoning: "thinking" }))
      h.input(id, "hello")
      await h.turnsEnded(id, 1)
      expect(h.types(id)).toEqual([
        "SESSION_CREATED",
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
      expect(h.hub.store.turns(id)[0]!.checkpointId).toBe(latestCheckpointId(h.db, id))
    })
  })

  test("built-in arguments are decoded, and other tools get the model's arguments unchanged", async () => {
    const received: Array<unknown> = []
    const raw: Tool = { namespace: null, name: "raw",
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
        expect(types.indexOf("INPUT_RECEIVED", 3)).toBeGreaterThan(types.indexOf("TOOL_CALL_RESULT"))
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

  test("queued inputs start turns in arrival order, and cancel aborts the graph and ends the turn canceled", async () => {
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
      expect(results.map((result) => [result.outcome, result.content])).toEqual([
        ["success", "echoed a"],
        ["canceled", "The tool call was canceled after it started; it may have had effects."],
        ["canceled", "The tool call was canceled before it started."],
      ])
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

  test("a restart gives the running turn's tool calls interrupted results the next request carries", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      h.model.next(callTools([{ name: "wait", args: {} }, { name: "echo", args: { text: "z" } }]))
      h.input(id, "long")
      await sessionsWithEvent(h, id, "TOOL_EXECUTION_STARTED")
      await h.restart()
      expect(h.types(id).slice(-3)).toEqual(["TOOL_CALL_RESULT", "TOOL_CALL_RESULT", "RUN_INTERRUPTED"])
      expect(ofType(h.events(id), "TOOL_CALL_RESULT").map((result) => result.content)).toEqual([
        "The tool call was interrupted by a server stop after it started; it may have had effects.",
        "The tool call was interrupted by a server stop before it started.",
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

  test("rewind removes the turn and later ones and reruns or replaces its input; fork copies and notifies", async () => {
    await withHarness(async (h) => {
      const id = await threeTurns(h)
      const [, second] = runIds(h, id)
      h.model.next(say("r2 again"))
      h.hub.rewind(id, second!, undefined, h.sender)
      await h.turnsEnded(id, 2)
      const rerun = texts(h.model.last())
      expect(rerun.slice(1)).toEqual(["r1", expect.stringContaining("The owner rewound this session"), "<user>\nt2\n</user>"])
      expect(rerun.join("\n")).not.toContain("t3")
      const types = h.types(id)
      expect(types.slice(types.indexOf("SESSION_REWOUND"), types.indexOf("SESSION_REWOUND") + 3)).toEqual([
        "SESSION_REWOUND",
        "INPUT_RECEIVED",
        "RUN_STARTED",
      ])
      expect(inputs(h, id)).toEqual(["t1", "t2"])

      const [first] = runIds(h, id)
      const source = h.events(id)
      const fork = h.hub.fork(id, first!).id
      expect(h.events(id)).toEqual(source)
      h.model.next(say("in fork"))
      h.input(fork, "fork input")
      await h.turnsEnded(fork, 2)
      const forked = texts(h.model.last())
      expect(forked[0]).toContain(`- Session id: \`${fork}\``)
      expect(forked[0]).toEndWith("<user>\nt1\n</user>")
      expect(forked.slice(1)).toEqual([
        "r1",
        expect.stringContaining(`session \`${fork}\` is a copy of session \`${id}\` through the turns above. Its session directory is \`${h.sessionDir(fork)}\``),
        "<user>\nfork input\n</user>",
      ])
      expect(forked[2]).toContain("may persist on the system")

      const [, forkSecond] = runIds(h, fork)
      h.model.next(say("rewound in fork"))
      h.hub.rewind(fork, forkSecond!, "fork edited", h.sender)
      await h.turnsEnded(fork, 2)
      const again = texts(h.model.last())
      expect(again.slice(2, 4).map((text) => text.split("\n")[1]!.slice(0, 30))).toEqual([
        "This session was forked: sessi",
        "The owner rewound this session",
      ])

      const open = gate()
      h.model.next(hold(open.promise))
      h.input(id, "running")
      await h.calls(h.model.calls.length + 1)
      expect(() => h.hub.fork(id, undefined)).toThrow("a turn is running")
      expect(() => h.hub.rewind(id, first!, undefined, h.sender)).toThrow("a turn is running")
      open.open()
    })
  })
})

describe("model switching", () => {
  test("another model's turns are one developer record without reasoning, switching back restores them, and a turn keeps its model", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      h.model.next(callTools([{ name: "echo", args: { text: "x" } }]), say("a1", { reasoning: "alpha thinks" }))
      h.input(id, "t1")
      await h.turnsEnded(id, 1)

      h.hub.setModel(id, beta, h.sender)
      h.model.next(say("b1"))
      h.input(id, "t2")
      await h.turnsEnded(id, 2)
      const byBeta = h.model.last()
      expect(byBeta.model).toBe(beta)
      const record = texts(byBeta)[1]!
      expect(texts(byBeta)).toHaveLength(3)
      expect(record).toStartWith("<developer>\n# Turns another model ran")
      expect(record).toContain("<user>\nt1\n</user>")
      expect(record).toMatch(/<tool_call name="echo" id="(call_echo_\d+)">\n\{"text":"x"\}\n<\/tool_call>\n<tool_result id="\1" outcome="success">\nechoed x\n<\/tool_result>/)
      expect(record).toContain(`<agent model="${alpha}">\na1\n</agent>`)
      expect(record).not.toContain("alpha thinks")
      expect(responsesInput(byBeta).some((item) => item.type === "reasoning" || item.type === "function_call")).toBe(false)

      h.hub.setModel(id, alpha, h.sender)
      h.model.next(say("a2"))
      h.input(id, "t3")
      await h.turnsEnded(id, 3)
      const back = h.model.last()
      const items = responsesInput(back)
      expect(items.map((item) => item.type)).toEqual([
        "message",
        "function_call",
        "function_call_output",
        "reasoning",
        "message",
        "message",
        "message",
      ])
      expect(items[3]).toMatchObject({ encrypted_content: "ENC" })
      expect(texts(back)[4]).toContain(`<agent model="${beta}">\nb1\n</agent>`)

      const open = gate()
      h.model.next(
        hold(open.promise, callTools([{ name: "echo", args: { text: "y" } }], { inputTokens: 150_000 })),
        say("summary of the switch turn"),
        say("a3"),
      )
      h.input(id, "x".repeat(100_000))
      await h.calls(h.model.calls.length + 1)
      h.hub.setModel(id, beta, h.sender)
      open.open()
      await h.turnsEnded(id, 4)
      expect(h.model.calls.slice(-3).map(({ call }) => call.model)).toEqual([alpha, alpha, alpha])
      expect(ofType(h.events(id), "COMPACTED")).toHaveLength(1)
    })
  })

  test("a turn's image decisions follow the model it started with", async () => {
    const picture: Tool = { namespace: null, name: "picture",
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
        h.hub.setModel(id, alpha, h.sender)
        open.open()
        await h.turnsEnded(id, 1)
        const output = responsesInput(h.model.last()).find((item) => item.type === "function_call_output")!
        expect(h.model.last().model).toBe(beta)
        expect(JSON.stringify(output.output)).toContain("input_image")

        h.model.next(say("text only"))
        h.input(id, "describe")
        await h.turnsEnded(id, 2)
        expect(h.model.last().model).toBe(alpha)
        expect(texts(h.model.last())[1]).toContain("a picture\n[image: /w/p.png]")
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

describe("compaction", () => {
  const big = (label: string) => `${label} ${"y".repeat(100_000)}`

  test("compacts with 60,000 tokens left, keeps a raw tail, continues, retries an overflow once, and fails cleanly", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      h.model.next(say("r1", { inputTokens: 150_000 }))
      h.input(id, big("t1"))
      await h.turnsEnded(id, 1)

      h.model.next(say("SUMMARY ONE"), say("r2"))
      h.input(id, "t2")
      await h.turnsEnded(id, 2)
      const [summaryCall, main] = h.model.calls.slice(-2).map(({ call }) => call)
      expect(summaryCall!.tools).toEqual([])
      expect(summaryCall!.maxOutputTokens).toBe(SUMMARY_MAX_TOKENS)
      expect(summaryCall!.model).toBe(alpha)
      expect(texts(summaryCall!)[0]).toContain("<transcript>\n<user>\nt1 yyy")
      expect(texts(summaryCall!)[0]).toContain("Leave out acknowledgements")
      const window = texts(main!)
      expect(window[0]).toEndWith("</developer>")
      expect(window[1]).toStartWith("<developer>\n# Summary of earlier conversation")
      expect(window[1]).toContain("SUMMARY ONE")
      expect(window.slice(2)).toEqual(["r1", "<user>\nt2\n</user>"])
      const compacted = ofType(h.events(id), "COMPACTED")[0]
      expect(compacted).toMatchObject({ promptRevision: SUMMARY_PROMPT_REVISION })
      expect(compacted.tokensBefore).toBeGreaterThan(140_000)
      expect(compacted.tokensAfter).toBeLessThan(compacted.tokensBefore)
      expect(ofType(h.events(id), "RUN_FINISHED")).toHaveLength(2)

      const overflow = new ModelCallError("input is too long", true)
      h.model.next(failWith(overflow), say("SUMMARY TWO"), say("r3"))
      h.input(id, big("t3"))
      await h.turnsEnded(id, 3)
      expect(ofType(h.events(id), "COMPACTED")).toHaveLength(2)
      expect(texts(h.model.last())[1]).toContain("SUMMARY TWO")
      expect(ofType(h.events(id), "RUN_FINISHED")).toHaveLength(3)

      h.model.next(failWith(overflow), say("SUMMARY THREE"), failWith(overflow))
      h.input(id, big("t4"))
      await h.turnsEnded(id, 4)
      expect(ofType(h.events(id), "RUN_ERROR").at(-1)).toMatchObject({ code: "context_overflow" })

      h.model.next(failWith(overflow), failWith(new Error("summary unavailable")))
      h.input(id, big("t5"))
      await h.turnsEnded(id, 5)
      expect(ofType(h.events(id), "RUN_ERROR").at(-1)).toMatchObject({ code: "compaction_failed" })
      h.model.next(say("still usable", { inputTokens: 10 }))
      h.input(id, "t6")
      await h.turnsEnded(id, 6)
      expect(ofType(h.events(id), "RUN_FINISHED")).toHaveLength(4)
    })
  })

  test("a rewind before a compaction restores the window as it stood", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      h.model.next(say("r1", { inputTokens: 150_000 }))
      h.input(id, big("t1"))
      await h.turnsEnded(id, 1)
      h.model.next(say("SUMMARY"), say("r2"))
      h.input(id, "t2")
      await h.turnsEnded(id, 2)
      expect(texts(h.model.last()).join("\n")).not.toContain("t1 yyy")

      const [, second] = runIds(h, id)
      h.model.next(say("SUMMARY AGAIN"), say("r2 again"))
      h.hub.rewind(id, second!, "t2 edited", h.sender)
      await h.turnsEnded(id, 2)
      const [summaryCall, main] = h.model.calls.slice(-2).map(({ call }) => call)
      expect(texts(summaryCall!)[0]).toContain("<user>\nt1 yyy")
      expect(texts(summaryCall!)[0]).not.toContain("<previous_summary>")
      expect(texts(main!).at(-1)).toBe("<user>\nt2 edited\n</user>")
    })
  })
})

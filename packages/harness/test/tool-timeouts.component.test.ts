import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { SessionEvent } from "@ashe-agent/protocol"
import { IntegrityFailure } from "../src/agent/failure.ts"
import { builtinTool, toolPolicy, toolTimeout } from "../src/agent/tools.ts"
import { executeTool } from "../src/tools/codemode/execute.ts"
import { AgentHarness, callTools, gate, ManualClock, responsesInput, say } from "./support/agent.ts"
import { waitFor } from "./support/cli.ts"

const ofType = <T extends SessionEvent["event"]["type"]>(h: AgentHarness, id: string, type: T) =>
  h.events(id).flatMap((event) =>
    event.event.type === type ? [event.event as Extract<SessionEvent["event"], { type: T }>] : [],
  )

const hanging = (name = "slow") =>
  builtinTool({
    name,
    permission: null,
    description: "Starts and waits for the test gate.",
    args: Schema.Struct({}),
    run: async (_args, run) => {
      run.started()
      run.onCancel("Process handle: synthetic-17.")
      await new Promise<void>((resolve) => setTimeout(resolve, 30_000))
      return { outcome: "success", content: "unexpected" }
    },
  })

describe("shared tool execution budgets", () => {
  test("an exact-name limit times out a started call, keeps its handle, and allows the next model step", async () => {
    const clock = new ManualClock()
    const policy = toolPolicy(1_000, { slow: 100 }, clock)
    const h = new AgentHarness({ tools: [hanging()], toolPolicy: policy })
    try {
      const id = h.create()
      h.model.next(callTools([{ name: "slow", args: {} }]), say("continued"))
      h.input(id, "go")
      await waitFor("the started call", () => (ofType(h, id, "TOOL_EXECUTION_STARTED").length === 1 ? true : undefined))
      await clock.advance(100)
      await h.turnsEnded(id, 1)
      const [result] = ofType(h, id, "TOOL_CALL_RESULT")
      expect(result).toMatchObject({ outcome: "failed" })
      expect(result!.content).toContain("timed out after 100 ms")
      expect(result!.content).toContain("Execution had started")
      expect(result!.content).toContain("Process handle: synthetic-17.")
      expect(h.model.calls).toHaveLength(2)
      expect(
        responsesInput(h.model.last()).some(
          (item) => item.type === "function_call_output" && item.output.includes("timed out"),
        ),
      ).toBe(true)
      expect(ofType(h, id, "TOOL_CALL_RESULT")).toHaveLength(1)
    } finally {
      await h.cleanup()
    }
  })

  test("permission collection spends the same budget, and an expired collection never runs the effect", async () => {
    const clock = new ManualClock()
    const policy = toolPolicy(200, {}, clock)
    let ran = 0
    const ask = builtinTool({
      name: "touch",
      permission: "edit",
      description: "Asks before touching.",
      args: Schema.Struct({}),
      prepare: () => ({ check: { permission: "edit", subjects: ["/tmp/x"], patterns: ["/tmp/x"] }, plan: undefined }),
      run: async () => {
        ran += 1
        return { outcome: "success", content: "touched" }
      },
    })
    const h = new AgentHarness({ tools: [ask], toolPolicy: policy, permission: { edit: "ask" } })
    try {
      const id = h.create()
      h.model.next(callTools([{ name: "touch", args: {} }]), say("continued"))
      h.input(id, "go")
      await waitFor("the permission request", () => (ofType(h, id, "PERMISSION_REQUESTED").length === 1 ? true : undefined))
      await clock.advance(200)
      await h.turnsEnded(id, 1)
      const [result] = ofType(h, id, "TOOL_CALL_RESULT")
      expect(result!.content).toContain("Execution had not started")
      expect(ran).toBe(0)
      expect(ofType(h, id, "TOOL_EXECUTION_STARTED")).toEqual([])
      expect(ofType(h, id, "PERMISSION_WITHDRAWN")).toHaveLength(1)
      expect(ofType(h, id, "ACTION_SETTLED")).toMatchObject([{ outcome: "timedOut" }])
      expect(ofType(h, id, "RUN_FINISHED")).toHaveLength(1)
    } finally {
      await h.cleanup()
    }
  })

  test("a code-mode child inherits the earlier of its own and its parent's deadline", async () => {
    const clock = new ManualClock()
    const policy = toolPolicy(1_000, { nested: 60 }, clock)
    const child = hanging("nested")
    const execute = executeTool(() => [child], {}, policy)
    const h = new AgentHarness({ tools: [execute], toolPolicy: policy })
    try {
      const id = h.create()
      h.model.next(
        callTools([
          {
            name: "execute",
            args: { code: 'try { await tools.tools.nested({}); return "unexpected" } catch (error) { return error.message }' },
          },
        ]),
        say("continued"),
      )
      h.input(id, "go")
      await waitFor("the child start", () => (ofType(h, id, "TOOL_EXECUTION_STARTED").length === 1 ? true : undefined))
      await clock.advance(60)
      await h.turnsEnded(id, 1)
      const [result] = ofType(h, id, "TOOL_CALL_RESULT")
      expect(result!.outcome).toBe("success")
      expect(result!.content).toContain("timed out after 60 ms")
      expect(ofType(h, id, "PROGRAM_CALL_FINISHED")).toMatchObject([{ tool: "nested", outcome: "failed" }])
    } finally {
      await h.cleanup()
    }
  })

  test("null inherits the global limit, while an exact override replaces it", () => {
    const policy = toolPolicy(300_000, { exact: 7, inherited: null })
    expect(toolTimeout(policy, "exact")).toBe(7)
    expect(toolTimeout(policy, "inherited")).toBeNull()
    expect(toolTimeout(policy, "other")).toBe(300_000)
  })

  test("an owned integrity failure stops the turn rather than becoming an external tool result", async () => {
    const failing = builtinTool({
      name: "corrupt",
      permission: null,
      description: "Fails owned state.",
      args: Schema.Struct({}),
      run: async () => {
        throw new IntegrityFailure("the session state transaction failed")
      },
    })
    const h = new AgentHarness({ tools: [failing], clientActions: false })
    try {
      const id = h.create()
      h.model.next(callTools([{ name: "corrupt", args: {} }]), say("must not run"))
      h.input(id, "go")
      await h.turnsEnded(id, 1)
      expect(ofType(h, id, "RUN_ERROR")).toMatchObject([{ code: "state_integrity_failed" }])
      expect(h.model.calls).toHaveLength(1)
      expect(ofType(h, id, "TOOL_CALL_RESULT")).toMatchObject([{ outcome: "failed" }])
    } finally {
      await h.cleanup()
    }
  })

  test("cancel and server stop settle an uncooperative null-limit tool without waiting for it", async () => {
    const stops = [gate(), gate()]
    let attempt = 0
    const stubborn = builtinTool({
      name: "stubborn",
      permission: null,
      description: "Ignores cancellation until the test releases it.",
      args: Schema.Struct({}),
      run: async (_args, run) => {
        run.started()
        await stops[attempt++]!.promise
        return { outcome: "success", content: "late" }
      },
    })
    const clock = new ManualClock()
    const h = new AgentHarness({ tools: [stubborn], toolPolicy: toolPolicy(10_000, { stubborn: null }, clock) })
    try {
      const id = h.create()
      h.model.next(callTools([{ name: "stubborn", args: {} }]))
      h.input(id, "cancel")
      await waitFor("the stubborn call", () =>
        ofType(h, id, "TOOL_EXECUTION_STARTED").length === 1 ? true : undefined,
      )
      h.hub.cancel(id)
      await waitFor("the canceled turn", () => (h.hub.isRunning(id) ? undefined : true), 1_500)
      expect(ofType(h, id, "TOOL_CALL_RESULT")).toMatchObject([{ outcome: "canceled" }])
      stops[0]!.open()
      await Bun.sleep(0)
      expect(ofType(h, id, "TOOL_CALL_RESULT")).toHaveLength(1)

      h.model.next(callTools([{ name: "stubborn", args: {} }]))
      h.input(id, "stop")
      await waitFor("the second stubborn call", () =>
        ofType(h, id, "TOOL_EXECUTION_STARTED").length === 2 ? true : undefined,
      )
      await Promise.race([
        h.hub.stop(),
        Bun.sleep(1_500).then(() => {
          throw new Error("server stop waited for the uncooperative tool")
        }),
      ])
    } finally {
      await h.cleanup()
    }
  })
})

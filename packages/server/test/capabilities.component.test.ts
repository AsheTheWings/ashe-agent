import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { SessionEvent } from "@ashe-agent/protocol"
import { builtinTool } from "../src/agent/tools.ts"
import { AgentHarness, callTools, gate, say } from "./support/agent.ts"

const ofType = <T extends SessionEvent["event"]["type"]>(h: AgentHarness, id: string, type: T) =>
  h.events(id).flatMap((event) =>
    event.event.type === type ? [event.event as Extract<SessionEvent["event"], { type: T }>] : [],
  )

const questions = [
  {
    id: "store",
    header: "Storage",
    question: "Where?",
    options: [
      { label: "SQLite (Recommended)", description: "One file." },
      { label: "Files", description: "Plain files." },
    ],
  },
]

describe("client capability offering", () => {
  test("questions are offered only after a capable subscriber exists, and support changes do not wake idle execution", async () => {
    const h = new AgentHarness({ clientActions: false })
    try {
      const id = h.create()
      h.model.next(callTools([{ name: "context_ask_question", args: { questions } }]), say("continued"))
      h.input(id, "go")
      await h.turnsEnded(id, 1)
      const [refused] = ofType(h, id, "TOOL_CALL_RESULT")
      expect(refused).toMatchObject({ outcome: "failed" })
      expect(refused!.content).toContain("is not offered in this request")
      expect(ofType(h, id, "ACTION_ASSIGNED")).toEqual([])
      expect(ofType(h, id, "QUESTIONS_ASKED")).toEqual([])

      const calls = h.model.calls.length
      h.attachClient(id)
      expect(h.model.calls).toHaveLength(calls)
      expect(h.hub.isRunning(id)).toBe(false)
    } finally {
      await h.cleanup()
    }
  })

  test("an ask without an executor fails safely and leaves server tools offered", async () => {
    const h = new AgentHarness({ clientActions: false, permission: { edit: "ask" } })
    try {
      const id = h.create()
      h.model.next(callTools([{ name: "touch", args: { paths: ["a"] } }]), say("continued"))
      h.input(id, "go")
      await h.turnsEnded(id, 1)
      const [result] = ofType(h, id, "TOOL_CALL_RESULT")
      expect(result).toMatchObject({ outcome: "failed" })
      expect(result!.content).toContain("unavailable")
      expect(ofType(h, id, "TOOL_EXECUTION_STARTED")).toEqual([])
      expect(ofType(h, id, "PERMISSION_WITHDRAWN")).toHaveLength(1)
      expect(h.model.calls).toHaveLength(2)
    } finally {
      await h.cleanup()
    }
  })

  test("support lost between model offering and dispatch yields an unavailable result", async () => {
    const pause = gate()
    const waiting = builtinTool({
      name: "pause",
      permission: null,
      description: "Waits until the test releases it.",
      args: Schema.Struct({}),
      run: async () => {
        await pause.promise
        return { outcome: "success", content: "released" }
      },
    })
    const h = new AgentHarness({ tools: [waiting] })
    try {
      const id = h.create()
      h.model.next(
        callTools([
          { name: "pause", args: {} },
          { name: "context_ask_question", args: { questions } },
        ]),
        say("continued"),
      )
      h.input(id, "go")
      await h.calls(1)
      h.withdrawActionSupport(id)
      pause.open()
      await h.turnsEnded(id, 1)
      const results = ofType(h, id, "TOOL_CALL_RESULT")
      expect(results.map((result) => result.outcome)).toEqual(["success", "failed"])
      expect(results[1]!.content).toContain("unavailable")
      expect(ofType(h, id, "ACTION_ASSIGNED")).toEqual([])
      expect(ofType(h, id, "QUESTIONS_ASKED")).toEqual([])
    } finally {
      await h.cleanup()
    }
  })
})

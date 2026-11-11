import { describe, expect, test } from "bun:test"
import type { SessionEvent } from "@ashe-agent/protocol"
import { implicitAgent } from "../src/agents/agents.ts"
import type { Permission } from "../src/inputs/shapes.ts"
import type { SessionSetup } from "../src/sessions/hub.ts"
import { contextHarness, filler } from "./support/context.ts"
import { callTools, configuredModel, say } from "./support/agent.ts"
import { waitFor } from "./support/cli.ts"

const ofType = (events: ReadonlyArray<SessionEvent>, type: string) =>
  events.map((event) => event.event).filter((event) => event.type === type) as Array<any>

const titleSetup = (
  modelId: string,
  settings: {
    readonly temperature: () => number
    readonly window: () => number
    readonly permission: () => Permission | null
    readonly configured: () => boolean
  },
): SessionSetup => ({
  resolve: (agent) => {
    if (agent === null) return implicitAgent
    if (agent !== "planner" || !settings.configured()) throw new Error(`no agent ${agent}`)
    return {
      ...implicitAgent,
      key: "planner",
      model: modelId,
      overrides: { [modelId]: { temperature: settings.temperature(), checkpointWindowSize: settings.window() } },
      permission: settings.permission(),
    }
  },
  userInstructions: () => null,
  catalogs: () => ({ skills: null, codeMode: null }),
  agents: () => ({
    agents: settings.configured()
      ? [
          {
            key: "planner",
            title: "Planner",
            description: null,
            model: modelId,
            reasoningEfforts: { [modelId]: "high" },
            titleFile: { state: "absent" as const },
          },
        ]
      : [],
    defaultAgent: null,
  }),
})

describe("configuration readiness on real persistence", () => {
  test("a null model records a failed turn before boundary auxiliary work", async () => {
    const mid = configuredModel("test/mid", { contextLimit: 400_000, settings: { checkpointWindowSize: 120_000 } })
    const { h, aux } = contextHarness({ auxiliaryModels: { compaction: mid.id } })
    try {
      const id = h.create({ model: null })
      h.input(id, filler(61_000))
      await h.turnsEnded(id, 1)
      expect(ofType(h.events(id), "RUN_ERROR")).toMatchObject([{ code: "model_unavailable" }])
      expect(h.model.calls).toEqual([])
      expect(aux.calls("compaction")).toEqual([])
      expect(h.hub.store.turns(id)).toMatchObject([{ model: null, status: "failed" }])
    } finally {
      await h.cleanup()
    }
  })

  test("restart preserves selected model and effort while title temperature and window reload at the next UserTurn", async () => {
    const model = configuredModel("test/planned", {
      contextLimit: 400_000,
      temperatureCapable: true,
      efforts: ["low", "high"],
      settings: { temperature: 0.1, checkpointWindowSize: 120_000 },
    })
    let temperature = 0.2
    let window = 120_000
    const setup = titleSetup(model.id, {
      temperature: () => temperature,
      window: () => window,
      permission: () => null,
      configured: () => true,
    })
    const { h } = contextHarness({ models: [model], setup })
    try {
      const id = h.create({ agent: "planner" })
      h.model.next(say("first"))
      h.input(id, "first")
      await h.turnsEnded(id, 1)
      expect(h.model.last()).toMatchObject({ model: model.id, temperature: 0.2, reasoning: { effort: "high" } })

      temperature = 0.7
      window = 60_000
      await h.restart()
      expect(h.hub.summary(id).selection.modelSettings).toEqual({
        modelId: model.id,
        reasoningEffort: "high",
      })
      const before = h.model.calls.length
      h.model.next(
        callTools([{ name: "blob", args: { tokens: 30_000 } }]),
        say("unused"),
      )
      h.input(id, filler(8_000))
      await waitFor("the reloaded context window", () =>
        ofType(h.events(id), "CONTEXT_TURN_STARTED").length > 0 ? true : undefined,
      )
      expect(h.model.calls[before]!.call).toMatchObject({
        model: model.id,
        temperature: 0.7,
        reasoning: { effort: "high" },
      })
    } finally {
      await h.cleanup()
    }
  })

  test("removed or unknown selection fails after admission without a provider call, and startup title policy applies", async () => {
    const model = configuredModel("test/policy", { efforts: ["low", "high"], settings: { reasoningEffort: "low" } })
    let configured = true
    let policy: Permission | null = null
    const setup = titleSetup(model.id, {
      temperature: () => 0,
      window: () => 120_000,
      permission: () => policy,
      configured: () => configured,
    })
    const { h } = contextHarness({ models: [model], setup })
    try {
      const id = h.create({ agent: "planner" })
      h.model.next(say("first"))
      h.input(id, "first")
      await h.turnsEnded(id, 1)

      policy = { edit: "deny" }
      await h.restart()
      h.model.next(callTools([{ name: "touch", args: { paths: ["a"] } }]), say("policy"))
      h.input(id, "policy")
      await h.turnsEnded(id, 2)
      const result = ofType(h.events(id), "TOOL_CALL_RESULT").at(-1)
      expect(result?.content).toContain("not offered")

      const calls = h.model.calls.length
      h.hub.input(id, "unknown model", "steer", h.sender, {
        selection: { modelSettings: { modelId: "test/unknown" } },
      })
      await h.turnsEnded(id, 3)
      expect(ofType(h.events(id), "RUN_ERROR").at(-1)).toMatchObject({ code: "model_unavailable" })
      expect(h.model.calls).toHaveLength(calls)

      configured = false
      await h.restart()
      h.input(id, "removed title")
      await h.turnsEnded(id, 4)
      expect(ofType(h.events(id), "RUN_ERROR").at(-1)).toMatchObject({ code: "title_unavailable" })
      expect(h.hub.summary(id).selection.agentTitle).toBe("planner")
      expect(h.model.calls).toHaveLength(calls)
    } finally {
      await h.cleanup()
    }
  })
})

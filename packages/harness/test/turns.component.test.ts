import { describe, expect, test } from "bun:test"
import type { SessionEvent } from "@ashe-agent/protocol"
import { AgentHarness, agentModels, failWith, gate, hold, say } from "./support/agent.ts"
import { waitFor } from "./support/cli.ts"

const ofType = <T extends SessionEvent["event"]["type"]>(h: AgentHarness, id: string, type: T) =>
  h.events(id).flatMap((event) =>
    event.event.type === type ? [event.event as Extract<SessionEvent["event"], { type: T }>] : [],
  )

describe("turn admission ownership", () => {
  test("steering outranks queued input, and each finite batch becomes one immutable membership", async () => {
    const h = new AgentHarness()
    try {
      const id = h.create()
      const first = gate()
      const steered = gate()
      const queued = gate()
      h.model.next(hold(first.promise), hold(steered.promise), hold(queued.promise), say("done"))
      h.input(id, "first")
      await h.calls(1)
      h.input(id, "queued one", "queue")
      h.input(id, "queued two", "queue")
      h.input(id, "steer one")
      h.input(id, "steer two")
      first.open()
      await h.calls(2)
      expect(ofType(h, id, "RUN_STARTED").at(-1)!.userMessageIds).toHaveLength(2)
      steered.open()
      await h.calls(3)
      expect(ofType(h, id, "RUN_STARTED").at(-1)!.userMessageIds).toHaveLength(2)
      queued.open()
      await h.turnsEnded(id, 3)
      expect(h.hub.store.turns(id).map((turn) => turn.userMessageIds.length)).toEqual([1, 2, 2])
      expect(ofType(h, id, "INPUT_RECEIVED").map((event) => event.text)).toEqual([
        "first",
        "steer one",
        "steer two",
        "queued one",
        "queued two",
      ])
      expect(h.hub.store.turns(id).map((turn) => turn.membership.map((input) => input.kind))).toEqual([
        ["system", "user"],
        ["system", "user", "user"],
        ["system", "user", "user"],
      ])
    } finally {
      await h.cleanup()
    }
  })

  test("settings are captured per AgentTurn: a running turn keeps its model and the steering turn uses the new one", async () => {
    const [alpha, beta] = agentModels
    const h = new AgentHarness()
    try {
      const id = h.create({ model: alpha!.id })
      const first = gate()
      const second = gate()
      h.model.next(hold(first.promise), hold(second.promise), say("done"))
      h.input(id, "first")
      await h.calls(1)
      h.hub.setModel(id, beta!.id, undefined, h.sender)
      h.hub.store.setSettings(id, { agentTitle: "writer", modelSettings: { modelId: beta!.id, reasoningEffort: null } })
      expect(h.hub.summary(id)).toMatchObject({
        selection: { agentTitle: "writer", modelSettings: { modelId: beta!.id } },
        activeSelection: { agentTitle: "untitled", modelSettings: { modelId: alpha!.id } },
      })
      h.hub.store.setSettings(id, { agentTitle: "untitled", modelSettings: { modelId: beta!.id, reasoningEffort: null } })
      h.input(id, "steer")
      first.open()
      await h.calls(2)
      expect(h.model.calls[0]!.call.model).toBe(alpha!.id)
      expect(h.model.calls[1]!.call.model).toBe(beta!.id)
      second.open()
      await h.turnsEnded(id, 2)
      expect(h.hub.summary(id)).toMatchObject({ selection: { modelSettings: { modelId: beta!.id } }, activeSelection: null })
    } finally {
      await h.cleanup()
    }
  })

  test("admission applies requested settings with the input, keeps immutable revisions, and attributes a failed turn", async () => {
    const [alpha, beta] = agentModels
    const h = new AgentHarness()
    try {
      const id = h.create({ model: alpha!.id })
      h.model.next(say("first"), say("second"))
      h.input(id, "first")
      await h.turnsEnded(id, 1)
      h.hub.input(id, "second", "steer", h.sender, {
        selection: { agentTitle: "untitled", modelSettings: { modelId: beta!.id, reasoningEffort: null } },
      })
      await h.turnsEnded(id, 2)
      const turns = h.hub.store.turns(id)
      expect(turns[1]).toMatchObject({ model: beta!.id, agentTitle: "untitled" })
      expect(turns[1]!.settingsRevision).not.toBe(turns[0]!.settingsRevision)
      const revisions = h.hub.store.db
        .query<{ revision: string; model_id: string | null }, [string]>("SELECT revision, model_id FROM session_settings WHERE session_id = ? ORDER BY applied_at")
        .all(id)
      expect(revisions.map((row) => row.model_id)).toEqual([alpha!.id, beta!.id])
      const admissionInputs = h.hub.store.db
        .query<{ input_id: string; applied_settings_revision: string | null }, [string, string]>(
          "SELECT input_id, applied_settings_revision FROM turn_inputs WHERE session_id = ? AND run_id = ? ORDER BY ordinal",
        )
        .all(id, turns[1]!.runId)
      expect(admissionInputs.filter((row) => row.input_id !== "system:1").map((row) => row.applied_settings_revision)).toEqual([
        turns[1]!.settingsRevision,
      ])

      h.hub.input(id, "third", "steer", h.sender, { selection: { modelSettings: { modelId: "test/missing" } } })
      await h.turnsEnded(id, 3)
      const failed = h.hub.store.turns(id)[2]!
      expect(failed).toMatchObject({ model: "test/missing", status: "failed" })
      expect(failed.settingsRevision).not.toBe(turns[1]!.settingsRevision)
      expect(ofType(h, id, "RUN_ERROR").at(-1)).toMatchObject({ code: "model_unavailable" })
    } finally {
      await h.cleanup()
    }
  })

  test("a batch applies requested settings in arrival order and admits one turn with the final profile", async () => {
    const [alpha, beta] = agentModels
    const h = new AgentHarness()
    const first = gate()
    try {
      const id = h.create({ model: alpha!.id })
      h.model.next(hold(first.promise), say("batch"))
      h.input(id, "first")
      await h.calls(1)
      h.hub.input(id, "one", "queue", h.sender, { selection: { modelSettings: { modelId: beta!.id } } })
      h.hub.input(id, "two", "queue", h.sender, { selection: { modelSettings: { modelId: alpha!.id } } })
      first.open()
      await h.turnsEnded(id, 2)
      const turns = h.hub.store.turns(id)
      expect(turns).toHaveLength(2)
      expect(turns[1]).toMatchObject({ model: alpha!.id })
      expect(turns[1]!.userMessageIds).toHaveLength(2)
      expect(ofType(h, id, "RUN_STARTED").at(-1)!.selection).toMatchObject({ modelSettings: { modelId: alpha!.id } })
      const revisions = h.hub.store.db
        .query<{ model_id: string | null }, [string]>("SELECT model_id FROM session_settings WHERE session_id = ? ORDER BY rowid")
        .all(id)
      expect(revisions.map((row) => row.model_id)).toEqual([alpha!.id, beta!.id, alpha!.id])
    } finally {
      first.open()
      await h.cleanup()
    }
  })

  test("a failed admission consumes nothing and a later input retries the same pending batch", async () => {
    const h = new AgentHarness()
    try {
      const id = h.create()
      h.model.next(say("first reply"))
      h.input(id, "before")
      await h.turnsEnded(id, 1)
      const store = h.hub.store as any
      const insert = store.insertTurn
      store.insertTurn = () => {
        throw new Error("injected admission failure")
      }
      h.input(id, "after")
      await waitFor("the admission failure", () =>
        ofType(h, id, "SESSION_ERROR").some((event) => event.code === "turn_start_failed") ? true : undefined,
      )
      expect(ofType(h, id, "RUN_STARTED")).toHaveLength(1)
      expect(h.hub.store.conversation.waiting(id).filter((entry) => entry.kind === "user")).toHaveLength(1)
      expect(h.hub.isRunning(id)).toBe(false)
      store.insertTurn = insert
      h.model.next(say("retried reply"))
      h.input(id, "retry")
      await h.turnsEnded(id, 2)
      expect(ofType(h, id, "RUN_STARTED")).toHaveLength(2)
      expect(ofType(h, id, "RUN_FINISHED")).toHaveLength(2)
      expect(h.hub.store.turns(id)[1]!.userMessageIds).toHaveLength(2)
      expect(ofType(h, id, "INPUT_RECEIVED").map((event) => event.text)).toEqual(["before", "after", "retry"])
    } finally {
      await h.cleanup()
    }
  })

  test("explicit resume rejects active execution and joins exactly one steering batch, leaving queued input for idle", async () => {
    const h = new AgentHarness()
    try {
      const id = h.create()
      const running = gate()
      h.model.next(hold(running.promise, say("running reply")), say("continuation reply"), say("queued reply"))
      h.input(id, "running")
      await h.calls(1)
      expect(() => h.hub.resume(id)).toThrow("already running")
      running.open()
      await h.turnsEnded(id, 1)

      const conversation = h.hub.store.conversation
      conversation.addWaiting(
        id,
        { kind: "user", inputId: "resume-steer", text: "steer", sender: h.sender, mode: "steer" },
        Date.now(),
      )
      conversation.addWaiting(
        id,
        { kind: "user", inputId: "resume-queue", text: "queue", sender: h.sender, mode: "queue" },
        Date.now(),
      )
      h.hub.resume(id)
      await h.turnsEnded(id, 3)
      const starts = ofType(h, id, "RUN_STARTED")
      expect(starts.map((event) => event.cause)).toEqual(["user", "continuation", "user"])
      expect(starts[1]!.userMessageIds).toEqual(["resume-steer"])
      expect(starts[2]!.userMessageIds).toEqual(["resume-queue"])
    } finally {
      await h.cleanup()
    }
  })

  test("idle resume becomes a developer-only turn or joins one queued batch", async () => {
    const h = new AgentHarness()
    try {
      const id = h.create()
      h.model.next(say("developer only"), say("queued continuation"))
      h.hub.resume(id)
      await h.turnsEnded(id, 1)
      expect(ofType(h, id, "RUN_STARTED").at(-1)).toMatchObject({ cause: "continuation", userMessageIds: [] })

      h.hub.store.conversation.addWaiting(
        id,
        { kind: "user", inputId: "queued-resume", text: "queued", sender: h.sender, mode: "queue" },
        Date.now(),
      )
      h.hub.resume(id)
      await h.turnsEnded(id, 2)
      expect(ofType(h, id, "RUN_STARTED").at(-1)).toMatchObject({
        cause: "continuation",
        userMessageIds: ["queued-resume"],
      })
    } finally {
      await h.cleanup()
    }
  })

  test("queued input drains after cancel and failure, and continuation joins queued input left by failed admission", async () => {
    const h = new AgentHarness()
    try {
      const id = h.create()
      h.model.next(hold(new Promise(() => {})), say("cancel drain"), failWith(new Error("boom")), say("failure drain"))
      h.input(id, "cancel me")
      await h.calls(1)
      h.input(id, "after cancel", "queue")
      h.hub.cancel(id)
      await h.turnsEnded(id, 2)
      expect(ofType(h, id, "INPUT_RECEIVED").map((event) => event.text)).toContain("after cancel")

      h.input(id, "fail me")
      h.input(id, "after failure", "queue")
      await h.turnsEnded(id, 4)
      expect(ofType(h, id, "RUN_ERROR")).toHaveLength(1)
      expect(ofType(h, id, "INPUT_RECEIVED").map((event) => event.text)).toContain("after failure")

      const store = h.hub.store as any
      const insert = store.insertTurn
      store.insertTurn = () => {
        throw new Error("injected admission failure")
      }
      h.input(id, "queued admission", "queue")
      await waitFor("the queued admission failure", () =>
        ofType(h, id, "SESSION_ERROR").some((event) => event.code === "turn_start_failed") ? true : undefined,
      )
      store.insertTurn = insert
      h.hub.resume(id)
      await h.turnsEnded(id, 5)
      const continuation = ofType(h, id, "RUN_STARTED").at(-1)!
      expect(continuation.cause).toBe("continuation")
      expect(continuation.userMessageIds).toHaveLength(1)
      expect(
        h.hub.store.turns(id).at(-1)!.membership.some((entry) => entry.inputId === continuation.userMessageIds[0]),
      ).toBe(true)
    } finally {
      await h.cleanup()
    }
  })

  test("fork refuses an unsettled point and an omitted point with no settled pair", async () => {
    const h = new AgentHarness()
    try {
      const id = h.create()
      const running = gate()
      h.model.next(hold(running.promise, say("done")))
      h.input(id, "first")
      await h.calls(1)
      const active = ofType(h, id, "RUN_STARTED")[0]!.runId
      expect(() => h.hub.fork(id, active)).toThrow("has not settled")
      expect(() => h.hub.fork(id, undefined)).toThrow("no settled turn")
      running.open()
      await h.turnsEnded(id, 1)
    } finally {
      await h.cleanup()
    }
  })

  test("a post-admission context failure settles the turn instead of leaving it running", async () => {
    const h = new AgentHarness()
    try {
      const id = h.create()
      const context = (h.hub as unknown as { context: { afterItems: () => void } }).context
      context.afterItems = () => {
        throw new Error("context hook failed")
      }
      h.model.next(say("must not run"))
      h.input(id, "admit then fail")
      await h.turnsEnded(id, 1)
      expect(h.hub.store.turns(id)).toMatchObject([{ status: "failed" }])
      expect(h.hub.store.conversation.waiting(id)).toEqual([])
      expect(h.model.calls).toHaveLength(0)
      expect(h.hub.summary(id)).toMatchObject({ activity: "idle", activeSelection: null })
      expect(ofType(h, id, "RUN_ERROR")).toMatchObject([{ code: "turn_start_failed" }])
    } finally {
      await h.cleanup()
    }
  })
})

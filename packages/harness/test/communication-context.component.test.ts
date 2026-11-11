import { describe, expect, test } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AgentHarness, callTools, gate, hold, messageText, say } from "./support/agent.ts"
import { waitFor } from "./support/cli.ts"
import { contextHarness, windowModel } from "./support/context.ts"

const mid = windowModel("test/mid", 120_000)
const ofType = (h: AgentHarness, id: string, type: string) =>
  h.events(id).flatMap(({ event }) => event.type === type ? [event as any] : [])
const blob = (tokens: number) => callTools([{ name: "blob", args: { tokens, letter: "b" } }])
const doing = (act: () => void, then: ReturnType<typeof hold>) =>
  async function* (call: any, signal: AbortSignal) {
    act()
    yield* then(call, signal)
  }

const fill = async (h: AgentHarness, id: string) => {
  h.model.next(blob(76_000), say("first done"))
  h.input(id, "first")
  await h.turnsEnded(id, 1)
  await waitFor("the compaction entry", () =>
    ofType(h, id, "TIMELINE_ENTRY").length >= 1 ? true : undefined,
  )
}

describe("cross-session input through context workflows", () => {
  test("a held peer message survives restart and is admitted once without entering the context hold", async () => {
    const { h, aux } = contextHarness({ models: [mid] })
    try {
      const id = h.create({ model: mid.id })
      const sender = h.create({ model: mid.id })
      h.model.next(say("sender ready"))
      h.input(sender, "sender ready")
      await h.turnsEnded(sender, 1)
      await fill(h, id)
      const draft = join(h.sessionDir(id), "memory-draft")
      const peerRun = {
        sessionId: sender,
        runId: h.hub.store.turns(sender)[0]!.runId,
        agentTitle: "untitled",
        modelId: mid.id,
        reasoningEffort: null,
      } as any
      h.model.next(
        blob(5_000),
        doing(() => {
          h.hub.message(peerRun, { sessionId: id, text: "peer held" })
          writeFileSync(join(draft, "notes.md"), "---\ndescription: Notes\n---\n")
        }, hold(new Promise(() => {}))),
      )
      h.input(id, "second")
      await h.calls(4)
      await waitFor("the held peer input", () =>
        h.events(id).some(({ event }) => event.type === "INPUT_WAITING" && event.text === "peer held")
          ? true
          : undefined,
      )
      const contextAuxiliary = aux.calls("compaction").map((call) => call.messages.map(messageText).join("\n"))
      expect(contextAuxiliary.some((text) => text.includes("peer held"))).toBe(false)
      h.model.next(say("in order"), say("continued"))
      await h.restart()
      await h.turnsEnded(id, 3)
      expect(ofType(h, id, "INPUT_RECEIVED").filter((event) => event.text === "peer held")).toHaveLength(1)
      expect(h.model.calls.some(({ call }) => call.messages.map(messageText).join("\n").includes("peer held"))).toBe(true)
      expect(ofType(h, id, "RUN_INTERRUPTED")).toHaveLength(1)
      expect(existsSync(draft)).toBe(false)
    } finally {
      await h.cleanup()
    }
  }, 30_000)

  test("context-turn output is absent from ordinary agent publications", async () => {
    const { h } = contextHarness({ models: [mid] })
    try {
      const source = h.create({ model: mid.id })
      const observer = h.create({ model: mid.id })
      h.model.next(say("observer ready"))
      h.input(observer, "ready")
      await h.turnsEnded(observer, 1)
      h.hub.communication.subscribe(
        observer,
        source,
        ["agent_intermediate", "agent_final"],
        observer,
        h.hub.store.turns(observer)[0]!.runId,
        Date.now(),
      )
      await fill(h, source)
      h.model.next(blob(5_000), say("context-only output"))
      h.input(source, "second")
      await h.turnsEnded(source, 2)
      const published = h.hub.store.db.query<{ text: string }, [string]>(
        "SELECT text FROM subscription_publications WHERE source_session_id = ? AND category IN ('agent_intermediate', 'agent_final')",
      ).all(source).map((row) => row.text)
      expect(published).toContain("first done")
      expect(published).not.toContain("context-only output")
    } finally {
      await h.cleanup()
    }
  }, 30_000)
})

import { describe, expect, test } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { callTools, FakeModel, hold, messageText, say, testTools } from "./support/agent.ts"
import { Client, waitFor } from "./support/cli.ts"
import { agentRunner } from "../src/agent/runner.ts"
import { SessionView, TestServer } from "./support/server.ts"
import { blobTool, RoutedModel, windowModel } from "./support/context.ts"

const mid = windowModel("test/mid", 120_000)

describe("cross-session input through a context workflow restart", () => {
  test("a context-held peer message survives a real server restart and is admitted once", async () => {
    const main = new FakeModel()
    const routed = new RoutedModel(main)
    const server = new TestServer({}, {
      models: [mid],
      modelPort: routed,
      runner: agentRunner({ port: routed, models: [mid] }),
      tools: () => [...testTools(), blobTool],
    })
    try {
      await server.start()
      const token = server.token("owner")
      const client = await Client.connect(server.url)
      const auth = await client.request("auth.authenticate", { token, protocolVersion: 1 })
      expect(auth.error).toBeUndefined()
      const create = async () => {
        const made = await client.request("session.create", {})
        if (made.error !== undefined) throw new Error(made.error.message)
        return made.result.session.id as string
      }
      const source = await create()
      const sender = await create()
      const senderView = await SessionView.open(server.url, token, sender)
      main.next(say("sender ready"))
      await client.request("session.input", { sessionId: sender, text: "sender ready" })
      await waitFor("the sender turn", () =>
        senderView.events.some(({ event }) => event.type === "RUN_FINISHED") ? true : undefined,
      )

      const sourceView = await SessionView.open(server.url, token, source)
      main.next(callTools([{ name: "blob", args: { tokens: 76_000, letter: "b" } }]), say("first done"))
      await client.request("session.input", { sessionId: source, text: "first" })
      await waitFor("the first source turn", () =>
        sourceView.events.some(({ event }) => event.type === "RUN_FINISHED") ? true : undefined,
      )
      const hub = await server.hub()
      const peerRun = {
        sessionId: sender,
        runId: hub.store.turns(sender)[0]!.runId,
        agentTitle: "untitled",
        modelId: mid.id,
        reasoningEffort: null,
      } as any
      let sent = false
      main.next(
        callTools([{ name: "blob", args: { tokens: 5_000, letter: "b" } }]),
        async function* (call, signal) {
          if (!sent) {
            sent = true
            await hub.message(peerRun, { sessionId: source, text: "peer held" })
            writeFileSync(join(server.sessionsDir, source, "memory-draft", "notes.md"), "---\ndescription: Notes\n---\n")
          }
          yield* hold(new Promise(() => {}))(call, signal)
        },
      )
      await client.request("session.input", { sessionId: source, text: "second" })
      await waitFor("the held peer input", () =>
        sourceView.events.some(({ event }) => event.type === "INPUT_WAITING" && event.text === "peer held")
          ? true
          : undefined,
      )
      expect(routed.calls("compaction").some((call) => call.messages.map(messageText).join("\n").includes("peer held")))
        .toBe(false)
      main.next(say("in order"), say("continued"))
      client.close()
      await server.restart()
      const restored = await SessionView.open(server.url, token, source)
      await waitFor("the restored peer input", () =>
        restored.events.some(({ event }) => event.type === "INPUT_RECEIVED" && event.text === "peer held")
          ? true
          : undefined,
      )
      expect(restored.events.filter(({ event }) => event.type === "INPUT_RECEIVED" && event.text === "peer held"))
        .toHaveLength(1)
      expect(existsSync(join(server.sessionsDir, source, "memory-draft"))).toBe(false)
    } finally {
      await server.cleanup()
    }
  }, 30_000)


})

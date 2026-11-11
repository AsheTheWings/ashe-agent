import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { SemanticPage } from "@ashe-agent/protocol"
import { agentRunner } from "../src/agent/runner.ts"
import { builtinTool } from "../src/agent/tools.ts"
import { Client, inspectHistory, waitFor } from "./support/cli.ts"
import { callTools, FakeModel, say, testTools } from "./support/agent.ts"
import { models, TestServer } from "./support/server.ts"

const bigTool = builtinTool({
  name: "big",
  permission: null,
  description: "Returns a retained large observation.",
  args: Schema.Struct({}),
  run: async () => ({ outcome: "success", content: "x".repeat(2_000_000) }),
})

const connect = async (url: string, token: string) => {
  const client = await Client.connect(url)
  const auth = await client.request("auth.authenticate", { token, protocolVersion: 1 })
  if (auth.error !== undefined) throw new Error(auth.error.message)
  return client
}

const createSession = async (client: Client) => {
  const response = await client.request("session.create", {})
  if (response.error !== undefined) throw new Error(response.error.message)
  return response.result.session.id as string
}

describe("bounded semantic reads", () => {
  test("pages bodies and boundaries by revision and exposes provider usage and captures", async () => {
    const model = new FakeModel()
    const server = new TestServer({ shell: "deny" }, {
      models,
      runner: agentRunner({ port: model, models }),
      modelPort: model,
      tools: () => [...testTools(), bigTool],
    })
    const token = server.token("semantic-pages")
    try {
      await server.start()
      const client = await connect(server.url, token)
      const sessionId = await createSession(client)
      const large = "context ".repeat(3_000)
      model.next(callTools([{ name: "big", args: {} }]), say("complete", { inputTokens: 1_234 }))
      await client.request("session.input", { sessionId, text: large })
      await waitFor("the turn", async () =>
        (await server.hub()).store.eventsAfter(sessionId, 0).some((event) => event.event.type === "RUN_FINISHED")
          ? true
          : undefined,
      )

      const first = await client.request("session.semantics.page", { sessionId, object: "entries", limit: 10 })
      expect(first.error).toBeUndefined()
      expect(Schema.decodeUnknownExit(SemanticPage)(first.result)._tag).toBe("Success")
      const userEntry = first.result.items.find((item: { entry: { kind: string } }) => item.entry.kind === "user")
      expect(userEntry.body).toMatchObject({ referenceId: userEntry.entry.id })
      expect(userEntry.entry.parts).toEqual([])
      const firstPage = await client.request("session.semantics.page", { sessionId, object: "entries", limit: 2 })
      expect(firstPage.result.nextCursor).toBeString()
      const nextPage = await client.request("session.semantics.page", {
        sessionId,
        object: "entries",
        revision: firstPage.result.revision,
        cursor: firstPage.result.nextCursor,
        limit: 2,
      })
      expect(nextPage.error).toBeUndefined()
      expect(nextPage.result.items[0].entry.position).toBeGreaterThan(firstPage.result.items.at(-1)!.entry.position)

      const body = await client.request("session.semantics.body", {
        sessionId,
        entryId: userEntry.entry.id,
        contentId: userEntry.body.contentId,
      })
      expect(body.error).toBeUndefined()
      expect(body.result.entry.parts[0].text).toBe(large)

      const tool = first.result.items.find((item: { entry: { kind: string } }) => item.entry.kind === "agent-tool")
      expect(tool.entry.tool.captures.length).toBeGreaterThan(0)
      expect(tool.entry.tool.outcome).toBe("success")
      const capture = tool.entry.tool.captures[0]
      expect(capture.captureLossBytes).toBeGreaterThan(0)
      const chunk = await client.request("content.capture", {
        sessionId,
        entryId: tool.entry.id,
        contentId: capture.contentId,
        offset: 0,
        length: 64,
      })
      expect(chunk.error).toBeUndefined()
      expect(chunk.result.capture).toMatchObject({ contentId: capture.contentId, offset: 0 })
      expect(Buffer.from(chunk.result.capture.data, "base64")).toHaveLength(64)
      expect((await client.request("content.capture", {
        sessionId,
        entryId: "foreign-entry",
        contentId: capture.contentId,
        offset: 0,
        length: 1,
      })).error?.code).toBe(-32004)

      const boundaries = await client.request("session.semantics.page", { sessionId, object: "boundaries", limit: 10 })
      expect(boundaries.result.items.length).toBeGreaterThan(0)
      const boundaryPage = await client.request("session.semantics.page", { sessionId, object: "boundaries", limit: 1 })
      const nextBoundaryPage = await client.request("session.semantics.page", {
        sessionId,
        object: "boundaries",
        revision: boundaryPage.result.revision,
        cursor: boundaryPage.result.nextCursor,
        limit: 1,
      })
      expect(nextBoundaryPage.result.items[0].id).not.toBe(boundaryPage.result.items[0].id)
      expect(boundaries.result.latestSuccessfulBoundaryId).toBeString()
      const latest = boundaries.result.items.find(
        (item: { id: string }) => item.id === boundaries.result.latestSuccessfulBoundaryId,
      )
      const full = await client.request("session.semantics.boundary", {
        sessionId,
        manifestId: latest.id,
      })
      expect(full.result.boundary.contributions.length).toBeGreaterThan(0)

      const usage = await client.request("session.modelCalls.usage", {
        sessionId,
        modelCallIds: [full.result.boundary.modelCallId],
      })
      expect(usage.result.usage).toEqual([
        { modelCallId: full.result.boundary.modelCallId, providerUsage: { inputTokens: 1_234, outputTokens: 1, totalTokens: 1_235 } },
      ])

      const inspected = await inspectHistory(client, sessionId)
      const forked = await client.request("session.fork", {
        sessionId,
        historyScope: inspected.scope.token,
        operationId: crypto.randomUUID(),
      })
      const branchId = forked.result.session.id
      expect((await client.request("session.modelCalls.usage", {
        sessionId: branchId,
        modelCallIds: boundaries.result.items.map((item: { modelCallId: string }) => item.modelCallId),
      })).result.usage).toEqual(
        (await client.request("session.modelCalls.usage", {
          sessionId,
          modelCallIds: boundaries.result.items.map((item: { modelCallId: string }) => item.modelCallId),
        })).result.usage,
      )
      expect((await client.request("session.semantics.page", {
        sessionId: branchId,
        object: "entries",
        revision: firstPage.result.revision,
        cursor: firstPage.result.nextCursor,
        limit: 2,
      })).error).toBeUndefined()

      await server.restart()
      const afterRestart = await connect(server.url, server.token("after-restart"))
      expect((await afterRestart.request("session.semantics.page", {
        sessionId,
        object: "entries",
        revision: first.result.revision,
        limit: 1,
      })).error).toBeUndefined()
      expect((await afterRestart.request("session.modelCalls.usage", {
        sessionId,
        modelCallIds: [full.result.boundary.modelCallId],
      })).result.usage).toEqual(usage.result.usage)
      expect((await afterRestart.request("content.capture", {
        sessionId,
        entryId: tool.entry.id,
        contentId: capture.contentId,
        offset: 0,
        length: 16,
      })).error).toBeUndefined()
      expect((await afterRestart.request("content.capture", {
        sessionId: branchId,
        entryId: tool.entry.id,
        contentId: capture.contentId,
        offset: 0,
        length: 16,
      })).error).toBeUndefined()
      const otherSession = await createSession(afterRestart)
      expect((await afterRestart.request("session.semantics.body", {
        sessionId: otherSession,
        entryId: userEntry.entry.id,
        contentId: userEntry.entry.contentId,
      })).error?.code).toBe(-32004)
      expect((await afterRestart.request("content.capture", {
        sessionId,
        entryId: tool.entry.id,
        contentId: "../../ashe-agent.db",
        offset: 0,
        length: 1,
      })).error?.code).toBe(-32004)
      expect((await afterRestart.request("session.semantics.boundary", {
        sessionId: otherSession,
        manifestId: full.result.boundary.id,
      })).error?.code).toBe(-32004)
      const liveDb = new Database(server.databasePath)
      liveDb.run("UPDATE model_calls SET provider_input_tokens = NULL, provider_output_tokens = NULL, provider_total_tokens = NULL WHERE session_id = ? AND model_call_id = ?", [sessionId, full.result.boundary.modelCallId])
      liveDb.close()
      expect((await afterRestart.request("session.modelCalls.usage", {
        sessionId,
        modelCallIds: [full.result.boundary.modelCallId],
      })).result.usage).toEqual([
        { modelCallId: full.result.boundary.modelCallId, providerUsage: { inputTokens: null, outputTokens: null, totalTokens: null } },
      ])
      rmSync(join(server.sessionsDir, branchId, "references", capture.name))
      expect((await afterRestart.request("content.capture", {
        sessionId: branchId,
        entryId: tool.entry.id,
        contentId: capture.contentId,
        offset: 0,
        length: 1,
      })).error?.code).toBe(-32004)

      model.next(say("next"))
      await afterRestart.request("session.input", { sessionId, text: "advance" })
      await waitFor("the next turn", async () =>
        (await server.hub()).store.eventsAfter(sessionId, 0).filter((event) => event.event.type === "RUN_FINISHED").length >= 2
          ? true
          : undefined,
      )
      const survivingCalls = boundaries.result.items.map((item: { modelCallId: string }) => item.modelCallId)
      const usageBeforeRewind = (await afterRestart.request("session.modelCalls.usage", {
        sessionId,
        modelCallIds: survivingCalls,
      })).result.usage
      const started = (await server.hub()).store.eventsAfter(sessionId, 0)
        .filter((event) => event.event.type === "RUN_STARTED")
      const secondRun = started[1]!.event.type === "RUN_STARTED" ? started[1]!.event.runId : ""
      const secondScope = await inspectHistory(afterRestart, sessionId, secondRun)
      await afterRestart.request("session.rewind", {
        sessionId,
        runId: secondRun,
        historyScope: secondScope.scope.token,
        operationId: crypto.randomUUID(),
      })
      expect((await afterRestart.request("session.modelCalls.usage", {
        sessionId,
        modelCallIds: survivingCalls,
      })).result.usage).toEqual(usageBeforeRewind)

      const firstRun = started[0]!.event.type === "RUN_STARTED" ? started[0]!.event.runId : ""
      const firstScope = await inspectHistory(afterRestart, sessionId, firstRun)
      await afterRestart.request("session.rewind", {
        sessionId,
        runId: firstRun,
        historyScope: firstScope.scope.token,
        operationId: crypto.randomUUID(),
      })
      expect((await afterRestart.request("content.capture", {
        sessionId,
        entryId: tool.entry.id,
        contentId: capture.contentId,
        offset: 0,
        length: 1,
      })).error?.code).toBe(-32004)
      expect((await afterRestart.request("session.semantics.body", {
        sessionId,
        entryId: userEntry.entry.id,
        contentId: userEntry.entry.contentId,
      })).error?.code).toBe(-32004)
      expect((await afterRestart.request("session.semantics.page", {
        sessionId,
        object: "entries",
        revision: firstPage.result.revision,
        cursor: firstPage.result.nextCursor,
        limit: 2,
      })).error?.code).toBe(-32005)

      const revokedToken = server.token("revoked-usage")
      const revoked = await connect(server.url, revokedToken)
      const revokedDb = new Database(server.databasePath)
      revokedDb.run("UPDATE api_tokens SET revoked_at = 1 WHERE name = 'revoked-usage'")
      revokedDb.close()
      expect((await revoked.request("session.modelCalls.usage", {
        sessionId,
        modelCallIds: survivingCalls,
      })).error?.code).toBe(-32001)
      await revoked.waitClosed()
      const stale = await afterRestart.request("session.semantics.page", {
        sessionId,
        object: "entries",
        revision: first.result.revision,
        limit: 1,
      })
      expect(stale.error?.code).toBe(-32005)
    } finally {
      await server.cleanup()
    }
  }, 30_000)
})

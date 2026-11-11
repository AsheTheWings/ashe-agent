import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Client, inspectHistory, waitFor } from "./support/cli.ts"
import { TestServer } from "./support/server.ts"

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

const withServer = async (body: (server: TestServer, client: Client) => Promise<void>) => {
  const server = new TestServer()
  try {
    const token = server.token("primary")
    await server.start()
    await body(server, await connect(server.url, token))
  } finally {
    await server.cleanup()
  }
}

const events = async (server: TestServer, sessionId: string) => (await server.hub()).store.eventsAfter(sessionId, 0)

const runs = async (server: TestServer, sessionId: string) =>
  (await events(server, sessionId)).filter((event) => event.event.type === "RUN_STARTED").map((event) => event.event as { runId: string })

const finished = async (server: TestServer, sessionId: string, runId: string) =>
  await waitFor("the run to finish", () =>
    (async () =>
      (await events(server, sessionId)).some((event) => event.event.type === "RUN_FINISHED" && event.event.runId === runId)
        ? true
        : undefined)(),
  )

describe("owner control fencing", () => {
  test("a delayed Stop cannot cancel a newer turn", async () => {
    await withServer(async (server, client) => {
      const sessionId = await createSession(client)
      await client.request("session.input", { sessionId, text: "hold first" })
      const first = (await runs(server, sessionId))[0]!

      const stale = await client.request("session.cancel", { sessionId, expectedTurnId: "another-turn" })
      expect(stale.result).toEqual({ outcome: "no_longer_current", currentTurnId: first.runId })
      expect((await runs(server, sessionId)).length).toBe(1)

      expect((await client.request("session.cancel", { sessionId, expectedTurnId: first.runId })).result)
        .toEqual({ outcome: "cancelled", currentTurnId: first.runId })
      server.script.release("hold first")
      await finished(server, sessionId, first.runId)

      await client.request("session.input", { sessionId, text: "hold second" })
      await waitFor("the second run", async () => ((await runs(server, sessionId)).length === 2 ? true : undefined))
      const second = (await runs(server, sessionId))[1]!
      expect((await client.request("session.cancel", { sessionId, expectedTurnId: first.runId })).result)
        .toEqual({ outcome: "no_longer_current", currentTurnId: second.runId })
      const after = await runs(server, sessionId)
      expect(after).toHaveLength(2)
      expect((await client.request("session.cancel", { sessionId, expectedTurnId: second.runId })).result.outcome)
        .toBe("cancelled")
      server.script.release("hold second")
      await finished(server, sessionId, second.runId)
    })
  }, 30_000)

  test("a confirmation scope follows history and pending membership without provisional chunks", async () => {
    await withServer(async (server, client) => {
      const sessionId = await createSession(client)
      await client.request("session.input", { sessionId, text: "hold scope" })
      const runId = (await runs(server, sessionId))[0]!.runId
      const first = await inspectHistory(client, sessionId, runId)
      const during = await inspectHistory(client, sessionId, runId)
      expect(during.scope.token).toBe(first.scope.token)
      expect(during.target).toMatchObject({ runId, rewindEligible: true, forkEligible: false })

      await client.request("session.input", { sessionId, text: "queued later", mode: "queue" })
      const changed = await inspectHistory(client, sessionId, runId)
      expect(changed.scope.token).not.toBe(first.scope.token)
      expect(changed.scope.pendingInputIds).toHaveLength(1)

      const stale = await client.request("session.rewind", {
        sessionId,
        runId,
        historyScope: first.scope.token,
        operationId: crypto.randomUUID(),
      })
      expect(stale.error?.code).toBe(-32005)
      expect((await runs(server, sessionId))).toHaveLength(1)

      server.script.release("hold scope")
      const fresh = await inspectHistory(client, sessionId, runId)
      server.script.release("hold scope")
      const rewound = await client.request("session.rewind", {
        sessionId,
        runId,
        historyScope: fresh.scope.token,
        operationId: crypto.randomUUID(),
      })
      expect(rewound.error).toBeUndefined()
      await waitFor("the rerun", async () => ((await runs(server, sessionId)).length === 1 ? true : undefined))
      server.script.release("hold scope")
    })
  }, 30_000)

  test("same-key fork and rewind results survive restart without duplicate effects", async () => {
    await withServer(async (server, client) => {
      const sessionId = await createSession(client)
      await client.request("session.input", { sessionId, text: "plain" })
      const runId = (await runs(server, sessionId))[0]!.runId
      server.script.release("plain")
      await finished(server, sessionId, runId)

      const inspected = await inspectHistory(client, sessionId, runId)
      const operationId = crypto.randomUUID()
      const first = await client.request("session.fork", {
        sessionId,
        runId,
        historyScope: inspected.scope.token,
        operationId,
      })
      expect(first.error).toBeUndefined()
      const branchId = first.result.session.id as string
      const duplicate = await client.request("session.fork", {
        sessionId,
        runId,
        historyScope: inspected.scope.token,
        operationId,
      })
      expect(duplicate.result.session.id).toBe(branchId)

      await client.request("session.input", { sessionId, text: "plain two" })
      const second = (await runs(server, sessionId))[1]!.runId
      server.script.release("plain two")
      await finished(server, sessionId, second)
      const changed = await inspectHistory(client, sessionId, runId)
      const otherPayload = await inspectHistory(client, sessionId, second)
      const conflict = await client.request("session.fork", {
        sessionId,
        runId: second,
        historyScope: otherPayload.scope.token,
        operationId,
      })
      expect(conflict.error?.code).toBe(-32005)

      const rewindId = crypto.randomUUID()
      const rewound = await client.request("session.rewind", {
        sessionId,
        runId,
        historyScope: changed.scope.token,
        operationId: rewindId,
      })
      expect(rewound.error).toBeUndefined()
      await waitFor("the rerun", async () => ((await runs(server, sessionId)).length === 1 ? true : undefined))
      const count = (await runs(server, sessionId)).length
      expect((await client.request("session.rewind", {
        sessionId,
        runId,
        historyScope: changed.scope.token,
        operationId: rewindId,
      })).error).toBeUndefined()
      expect((await runs(server, sessionId)).length).toBe(count)

      await server.restart()
      const afterRestart = await connect(server.url, server.token("after-restart"))
      expect(await afterRestart.request("session.history.result", { sessionId, operationId })).toMatchObject({
        result: { kind: "observed", action: "fork", status: "succeeded", result: { sessionId: branchId } },
      })
      expect(await afterRestart.request("session.history.result", { sessionId, operationId: rewindId })).toMatchObject({
        result: { kind: "observed", action: "rewind", status: "succeeded" },
      })
      const missing = crypto.randomUUID()
      expect(await afterRestart.request("session.history.result", { sessionId, operationId: missing })).toEqual({
        jsonrpc: "2.0",
        id: expect.any(Number),
        result: { kind: "not_observed", operationId: missing },
      })
      const unresolved = crypto.randomUUID()
      const hub = await server.hub()
      hub.store.beginHistoryOperation(sessionId, unresolved, "rewind", "fingerprint", Date.now())
      expect((await afterRestart.request("session.history.result", { sessionId, operationId: unresolved })).result)
        .toEqual({ kind: "unresolved", operationId: unresolved, action: "rewind" })
      expect((await afterRestart.request("session.rewind", {
        sessionId,
        runId,
        historyScope: "scope",
        operationId: unresolved,
      })).error?.code).toBe(-32005)
    })
  }, 30_000)

  test("another client's rewind invalidates a confirmation and concurrent same-key forks agree", async () => {
    await withServer(async (server, client) => {
      const token = server.token("secondary")
      const other = await connect(server.url, token)
      const sessionId = await createSession(client)
      await client.request("session.input", { sessionId, text: "first boundary" })
      const first = (await runs(server, sessionId))[0]!.runId
      server.script.release("first boundary")
      await finished(server, sessionId, first)
      await client.request("session.input", { sessionId, text: "second boundary" })
      const second = (await runs(server, sessionId))[1]!.runId
      server.script.release("second boundary")
      await finished(server, sessionId, second)

      const scope = await inspectHistory(client, sessionId, second)
      const branchScope = await inspectHistory(client, sessionId, first)
      const operationId = crypto.randomUUID()
      const [a, b] = await Promise.all([
        other.request("session.fork", {
          sessionId,
          runId: first,
          historyScope: branchScope.scope.token,
          operationId,
        }),
        client.request("session.fork", {
          sessionId,
          runId: first,
          historyScope: branchScope.scope.token,
          operationId,
        }),
      ])
      expect(a.error).toBeUndefined()
      expect(b.error).toBeUndefined()
      expect(a.result.session.id).toBe(b.result.session.id)

      const rewound = await client.request("session.rewind", {
        sessionId,
        runId: second,
        historyScope: scope.scope.token,
        operationId: crypto.randomUUID(),
      })
      expect(rewound.error).toBeUndefined()
      await waitFor("the rerun", async () => ((await runs(server, sessionId)).length === 2 ? true : undefined))
      const stale = await other.request("session.rewind", {
        sessionId,
        runId: second,
        historyScope: scope.scope.token,
        operationId: crypto.randomUUID(),
      })
      expect([-32004, -32005]).toContain(stale.error?.code)
      expect((await runs(server, sessionId))).toHaveLength(2)
      server.script.release("second boundary")
    })
  }, 30_000)

  test("revoked credentials cannot resolve or start history operations", async () => {
    await withServer(async (server, client) => {
      const sessionId = await createSession(client)
      await client.request("session.input", { sessionId, text: "history auth" })
      const runId = (await runs(server, sessionId))[0]!.runId
      server.script.release("history auth")
      await finished(server, sessionId, runId)

      const revokedToken = server.token("revoked-history")
      const revoked = await connect(server.url, revokedToken)
      const db = new Database(server.databasePath)
      db.run("UPDATE api_tokens SET revoked_at = 1 WHERE name = 'revoked-history'")
      db.close()
      expect((await revoked.request("session.history.result", { sessionId, operationId: "any" })).error.code)
        .toBe(-32001)
      await revoked.waitClosed()

      const revokedRewindToken = server.token("revoked-rewind")
      const revokedRewind = await connect(server.url, revokedRewindToken)
      const db2 = new Database(server.databasePath)
      db2.run("UPDATE api_tokens SET revoked_at = 1 WHERE name = 'revoked-rewind'")
      db2.close()
      expect((await revokedRewind.request("session.rewind", {
        sessionId,
        runId,
        historyScope: "scope",
        operationId: "operation",
      })).error.code).toBe(-32001)
      await revokedRewind.waitClosed()

      const revokedForkToken = server.token("revoked-fork")
      const revokedFork = await connect(server.url, revokedForkToken)
      const db3 = new Database(server.databasePath)
      db3.run("UPDATE api_tokens SET revoked_at = 1 WHERE name = 'revoked-fork'")
      db3.close()
      expect((await revokedFork.request("session.fork", {
        sessionId,
        runId,
        historyScope: "scope",
        operationId: "operation",
      })).error.code).toBe(-32001)
      await revokedFork.waitClosed()
    })
  }, 30_000)
})

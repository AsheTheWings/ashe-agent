import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { InputReceiptLookup } from "@ashe-agent/protocol"
import { Client, rewindSession, waitFor } from "./support/cli.ts"
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

const receipt = async (client: Client, sessionId: string, submissionId: string) => {
  const response = await client.request("session.input.receipt", { sessionId, submissionId })
  expect(response.error).toBeUndefined()
  expect(Schema.decodeUnknownExit(InputReceiptLookup)(response.result)._tag).toBe("Success")
  return response.result
}

describe("input receipts", () => {
  test("one submission accepts one input across duplicate requests, rewind and restart", async () => {
    await withServer(async (server, client) => {
      const sessionId = await createSession(client)
      const submissionId = crypto.randomUUID()
      const payload = { sessionId, submissionId, text: "hold receipt" }

      const [first, duplicate] = await Promise.all([
        client.request("session.input", payload),
        client.request("session.input", payload),
      ])
      expect(first.error).toBeUndefined()
      expect(duplicate.error).toBeUndefined()
      expect(duplicate.result.inputId).toBe(first.result.inputId)
      expect(first.result.receipt).toMatchObject({ submissionId, disposition: "admitted" })

      const hub = await server.hub()
      const waitingEvents = hub
        .store.eventsAfter(sessionId, 0)
        .filter((event) => event.event.type === "INPUT_WAITING")
      expect(waitingEvents).toHaveLength(1)
      expect(waitingEvents[0]!.event).toMatchObject({ type: "INPUT_WAITING", submissionId })

      const different = await client.request("session.input", { ...payload, text: "changed payload" })
      expect(different.error?.code).toBe(-32005)
      expect(hub.store.eventsAfter(sessionId, 0).filter((event) => event.event.type === "INPUT_WAITING")).toHaveLength(1)

      const started = hub.store.eventsAfter(sessionId, 0).find((event) => event.event.type === "RUN_STARTED")
      if (started === undefined || started.event.type !== "RUN_STARTED") throw new Error("the turn did not start")
      const runId = started.event.runId
      server.script.release("hold receipt")
      await waitFor("the held turn", () =>
        hub.store.eventsAfter(sessionId, 0).some((event) => event.event.type === "RUN_FINISHED" && event.event.runId === runId),
      )

      await rewindSession(client, { sessionId, runId })
      const removed = await receipt(client, sessionId, submissionId)
      expect(removed).toMatchObject({ kind: "observed", receipt: { submissionId, disposition: "removed" } })
      const acceptedBefore = hub.store.eventsAfter(sessionId, 0).filter((event) => event.event.type === "INPUT_WAITING").length
      const retried = await client.request("session.input", payload)
      expect(retried.error).toBeUndefined()
      expect(retried.result.inputId).toBe(first.result.inputId)
      expect(hub.store.eventsAfter(sessionId, 0).filter((event) => event.event.type === "INPUT_WAITING").length)
        .toBe(acceptedBefore)

      await server.restart()
      const afterRestart = await connect(server.url, server.token("after-restart"))
      const persisted = await receipt(afterRestart, sessionId, submissionId)
      expect(persisted).toMatchObject({ kind: "observed", receipt: { submissionId, inputId: first.result.inputId } })
    })
  }, 30_000)

  test("a missing receipt is not observed and an omitted submission id still gets a durable identity", async () => {
    await withServer(async (_server, client) => {
      const sessionId = await createSession(client)
      expect(await receipt(client, sessionId, crypto.randomUUID())).toEqual({
        kind: "not_observed",
        submissionId: expect.any(String),
      })
      const sent = await client.request("session.input", { sessionId, text: "plain" })
      expect(sent.error).toBeUndefined()
      expect(sent.result.submissionId).toBeString()
      expect(await receipt(client, sessionId, sent.result.submissionId)).toMatchObject({
        kind: "observed",
        receipt: { inputId: sent.result.inputId },
      })
    })
  })

  test("a duplicate submission claims its attachment once and a rewind keeps the receipt removed", async () => {
    await withServer(async (server, client) => {
      const sessionId = await createSession(client)
      const data = Buffer.from("hello")
      const digest = new Bun.CryptoHasher("sha256").update(data).digest("hex")
      const created = await client.request("upload.create", {
        draftId: crypto.randomUUID(),
        name: "receipt.txt",
        mediaType: "text/plain",
        size: data.length,
      })
      const uploadId = created.result.upload.uploadId
      await client.request("upload.append", { uploadId, offset: 0, data: data.toString("base64") })
      await client.request("upload.finalize", { uploadId, size: data.length, digest })
      const stored = new Database(server.databasePath, { readonly: true })
      const attachmentId = stored.query<{ attachment_id: string }, [string]>(
        "SELECT attachment_id FROM uploads WHERE upload_id = ?",
      ).get(uploadId)!.attachment_id
      stored.close()

      const submissionId = crypto.randomUUID()
      const payload = {
        sessionId,
        submissionId,
        text: "hold attached",
        attachments: [
          { attachmentId, contentId: digest, representationId: digest, name: "receipt.txt", mediaType: "text/plain", digest },
        ],
      }
      const first = await client.request("session.input", payload)
      const duplicate = await client.request("session.input", payload)
      expect(duplicate.result.inputId).toBe(first.result.inputId)
      const check = new Database(server.databasePath, { readonly: true })
      expect(check.query("SELECT count(*) AS n FROM attachment_references WHERE session_id = ? AND reference_id = ?").get(
        sessionId,
        first.result.inputId,
      )).toEqual({ n: 1 })
      check.close()

      const hub = await server.hub()
      const started = hub.store.eventsAfter(sessionId, 0).find((event) => event.event.type === "RUN_STARTED")
      if (started === undefined || started.event.type !== "RUN_STARTED") throw new Error("the attached turn did not start")
      const runId = started.event.runId
      server.script.release("hold attached")
      server.script.release("hold attached end")
      await waitFor("the attached turn", () =>
        hub.store.eventsAfter(sessionId, 0).some((event) => event.event.type === "RUN_FINISHED" && event.event.runId === runId)
          ? true
          : undefined,
      )
      await rewindSession(client, { sessionId, runId })
      expect(await receipt(client, sessionId, submissionId)).toMatchObject({
        kind: "observed",
        receipt: { disposition: "removed" },
      })
      const after = new Database(server.databasePath, { readonly: true })
      expect(after.query("SELECT count(*) AS n FROM attachment_references WHERE session_id = ? AND reference_id = ?").get(
        sessionId,
        first.result.inputId,
      )).toEqual({ n: 0 })
      after.close()
      server.script.release("hold attached")
      server.script.release("hold attached end")
    })
  }, 30_000)
})

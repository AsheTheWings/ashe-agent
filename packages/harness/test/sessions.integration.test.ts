import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { statSync } from "node:fs"
import { join } from "node:path"
import { Client, waitFor } from "./support/cli.ts"
import { models, SessionView, TestServer } from "./support/server.ts"

/** Runs `body` against a fresh in-process server and cleans up. */
const withServer = async (body: (server: TestServer, token: string) => Promise<void>, server = new TestServer()) => {
  try {
    const token = server.token("primary")
    await server.start()
    await body(server, token)
  } finally {
    await server.cleanup()
  }
}

const connect = async (url: string, token: string) => {
  const client = await Client.connect(url)
  const auth = await client.request("auth.authenticate", { token, protocolVersion: 1 })
  if (auth.error !== undefined) throw new Error(auth.error.message)
  return client
}

const createSession = async (client: Client, selection?: Record<string, unknown>) => {
  const response = await client.request("session.create", selection === undefined ? {} : { selection })
  if (response.error !== undefined) throw new Error(response.error.message)
  return response.result.session.id as string
}


const runIds = (view: SessionView) =>
  view.events.filter((event) => event.event.type === "RUN_STARTED").map((event) => event.event.runId as string)

const finishedRuns = (view: SessionView) => view.events.filter((event) => event.event.type === "RUN_FINISHED").length

const said = (view: SessionView) =>
  view.events.filter((event) => event.event.type === "TEXT_MESSAGE_CONTENT").map((event) => event.event.delta as string)

/** The session's rows in the events, turns, and sessions tables, read from the database file. */
const snapshot = (server: TestServer, id: string) => {
  const db = new Database(server.databasePath, { readonly: true })
  try {
    return JSON.stringify([
      db.query("SELECT * FROM events WHERE session_id = ? ORDER BY seq").all(id),
      db.query("SELECT * FROM turns WHERE session_id = ? ORDER BY position").all(id),
      db.query("SELECT next_seq FROM sessions WHERE id = ?").get(id),
      db.query("SELECT position, run_id, kind, body FROM window_items WHERE session_id = ? ORDER BY position").all(id),
      db.query("SELECT position, kind, body FROM waiting_input WHERE session_id = ? ORDER BY position").all(id),
    ])
  } finally {
    db.close()
  }
}

/** Runs `sql` on the server's database file through a separate connection. */
const execute = (server: TestServer, sql: string) => {
  const db = new Database(server.databasePath)
  try {
    db.run(sql)
  } finally {
    db.close()
  }
}

const turnStatuses = (server: TestServer, id: string) => {
  const db = new Database(server.databasePath, { readonly: true })
  try {
    return db.query<{ status: string }, [string]>("SELECT status FROM turns WHERE session_id = ? ORDER BY position").all(id)
  } finally {
    db.close()
  }
}

describe("sessions", () => {
  test("an upload survives a server restart, resumes by offset, and its accepted original is referenced by input", async () => {
    await withServer(async (server, token) => {
      let client = await connect(server.url, token)
      const bytes = Buffer.from("hello")
      const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
      const created = await client.request("upload.create", {
        draftId: "draft-1",
        name: "hello.txt",
        mediaType: "text/plain",
        size: bytes.byteLength,
      })
      expect(created.error).toBeUndefined()
      const uploadId = created.result.upload.uploadId
      const first = await client.request("upload.append", {
        uploadId,
        offset: 0,
        data: Buffer.from("hel").toString("base64"),
      })
      expect(first.result.upload.offset).toBe(3)
      client.close()
      await server.restart()

      client = await connect(server.url, token)
      const resumed = await client.request("upload.status", { uploadId })
      expect(resumed.result.upload).toMatchObject({ offset: 3, size: 5, claimed: false })
      await client.request("upload.append", { uploadId, offset: 3, data: Buffer.from("lo").toString("base64") })
      const finalized = await client.request("upload.finalize", { uploadId, size: 5, digest })
      expect(finalized.result.upload).toMatchObject({ offset: 5, digest, claimed: false })
      const stored = new Database(server.databasePath, { readonly: true })
      const row = stored.query<{ attachment_id: string }, [string]>("SELECT attachment_id FROM uploads WHERE upload_id = ?").get(uploadId)!
      stored.close()
      expect(row.attachment_id).not.toBeNull()
      const id = await createSession(client)
      const sent = await client.request("session.input", {
        sessionId: id,
        text: "with attachment",
        attachments: [
          {
            attachmentId: row.attachment_id,
            contentId: digest,
            representationId: digest,
            name: "hello.txt",
            mediaType: "text/plain",
            digest,
          },
        ],
      })
      expect(sent.error).toBeUndefined()
      server.script.release("with attachment")
      const view = await SessionView.open(server.url, token, id)
      await view.waitFor("the attached input turn", (value) => finishedRuns(value) === 1)
      const check = new Database(server.databasePath, { readonly: true })
      try {
        expect(check.query("SELECT count(*) AS n FROM attachment_references WHERE session_id = ? AND reference_id = ?").get(id, sent.result.inputId)).toEqual({ n: 1 })
      } finally {
        check.close()
      }
      const content = await client.request("content.get", { sessionId: id, contentId: digest, referenceId: sent.result.inputId })
      expect(content.result.content).toMatchObject({
        sessionId: id,
        contentId: digest,
        referenceId: sent.result.inputId,
        available: true,
        representations: [{ filename: "hello.txt", mediaType: "text/plain", byteLength: 5 }],
      })
      const committed = view.events.find((event) => event.event.type === "MODEL_CALL_COMMITTED")!.event
      const rendered = { manifestId: committed.inputBoundaryId, contentId: "rendered-provider-input" }
      execute(
        server,
        `INSERT INTO contents (sha256, data, format) VALUES ('${rendered.contentId}', cast('<user>\nhello\n</user>' AS BLOB), 'text/plain')`,
      )
      execute(
        server,
        `INSERT INTO model_calls
          (session_id, model_call_id, turn_id, ordinal, window_position, input_manifest_ref, offered_tools_ref, started_at, ended_at, outcome)
          VALUES ('${id}', '${committed.modelCallId}', '${committed.runId}', 999999, 1, NULL, NULL, 1, 2, 'success')`,
      )
      execute(
        server,
        `INSERT INTO request_manifests (session_id, manifest_id, model_call_id, body_ref, created_at)
          VALUES ('${id}', '${rendered.manifestId}', '${committed.modelCallId}', '${rendered.contentId}', 1)`,
      )
      execute(
        server,
        `INSERT INTO request_manifest_rendered (session_id, manifest_id, content_ref)
          VALUES ('${id}', '${rendered.manifestId}', '${rendered.contentId}')`,
      )
      const renderedContent = await client.request("content.get", {
        sessionId: id,
        contentId: rendered.contentId,
        referenceId: rendered.manifestId,
      })
      expect(renderedContent.result.content).toMatchObject({
        contentId: rendered.contentId,
        referenceId: rendered.manifestId,
        available: true,
        representations: [{ mediaType: "text/plain" }],
      })
      const other = await createSession(client)
      expect(
        (await client.request("content.get", { sessionId: other, contentId: digest, referenceId: sent.result.inputId })).error.code,
      ).toBe(-32004)
      expect(
        (await client.request("content.get", { sessionId: other, contentId: rendered.contentId, referenceId: rendered.manifestId })).error.code,
      ).toBe(-32004)
    })
  })

  test("owners list grants across title scopes and clear one title", async () => {
    await withServer(async (server, token) => {
      const client = await connect(server.url, token)
      const id = await createSession(client)
      execute(
        server,
        `INSERT INTO session_grants (session_id, title_key, position, permission, pattern) VALUES
          ('${id}', 'reviewer', 1, 'edit', '/one'),
          ('${id}', 'reviewer', 2, 'shell', 'git status'),
          ('${id}', 'writer', 1, 'edit', '/two')`,
      )
      const listed = await client.request("session.grants.list", { sessionId: id })
      expect(listed.result.grants).toMatchObject([
        { agentTitle: "reviewer", permission: "edit", pattern: "/one" },
        { agentTitle: "reviewer", permission: "shell", pattern: "git status" },
        { agentTitle: "writer", permission: "edit", pattern: "/two" },
      ])
      expect((await client.request("session.grants.clear", { sessionId: id, agentTitle: "reviewer" })).result).toEqual({ cleared: 2 })
      expect((await client.request("session.grants.list", { sessionId: id })).result.grants).toMatchObject([
        { agentTitle: "writer", permission: "edit", pattern: "/two" },
      ])
    })
  })

  test("selection methods reject unknown top-level and nested settings at the wire", async () => {
    await withServer(async (server, token) => {
      const client = await connect(server.url, token)
      const invalidSelections = [
        { temperature: 0.2 },
        { modelSettings: { modelId: models[0]!.id, temperature: 0.2 } },
      ]
      for (const selection of invalidSelections) {
        expect((await client.request("session.create", { selection })).error.code).toBe(-32602)
      }
      const id = await createSession(client)
      const before = (await client.request("session.list")).result.sessions
      for (const selection of invalidSelections) {
        expect((await client.request("session.input", { sessionId: id, text: "ignored", selection })).error.code).toBe(-32602)
        expect((await client.request("session.rewind", { sessionId: id, runId: "missing", selection })).error.code).toBe(-32602)
      }
      expect((await client.request("session.list")).result.sessions).toEqual(before)
      client.close()
    })
  })

  test("creation refuses a working directory, gives each session its own directory, and sessions and models are listed", async () => {
    await withServer(async (server, token) => {
      const client = await connect(server.url, token)
      expect((await client.request("session.create", { cwd: server.dir })).error.code).toBe(-32602)
      expect((await client.request("session.create", {
        selection: { modelSettings: { modelId: "other/model" } },
      })).error.code).toBe(-32007)
      const id = await createSession(client)
      const sessionDir = join(server.sessionsDir, id)
      expect(statSync(sessionDir).isDirectory()).toBe(true)
      expect(statSync(sessionDir).mode & 0o777).toBe(0o700)
      const listed = (await client.request("session.list")).result.sessions
      expect(listed.map((session: any) => session.id)).toEqual([id])
      expect(listed[0]).toMatchObject({
        sessionDir,
        identity: { agentTitle: "untitled", modelId: models[0]!.id },
        activity: "idle",
        lastSeq: 2,
      })
      const view = await SessionView.open(server.url, token, id)
      await view.waitFor("the created event", (v) => v.types().includes("SESSION_CREATED"))
      expect(view.events[0].event.sessionDir).toBe(sessionDir)
      expect((await client.request("models.list")).result).toEqual({
        models: [
          { id: "test/first", name: "test/first", contextLimit: 400_000, imageInput: false, pdfInput: false, reasoningEfforts: ["low", "high"], reasoningEffort: "low" },
          { id: "test/second", name: "test/second", contextLimit: 300_000, imageInput: true, pdfInput: false, reasoningEfforts: [], reasoningEffort: null },
        ],
        defaultModel: "test/first",
      })
    })
  })

  test("events are numbered from 1 and a subscription resumes after a sequence number", async () => {
    await withServer(async (server, token) => {
      const client = await connect(server.url, token)
      const id = await createSession(client)
      const view = await SessionView.open(server.url, token, id)
      await client.request("session.input", { sessionId: id, text: "one" })
      server.script.release("one")
      await view.waitFor("the turn to finish", (v) => finishedRuns(v) === 1)
      expect(view.events.map((event) => event.seq)).toEqual(view.events.map((_, index) => index + 1))
      const resumed = await SessionView.open(server.url, token, id, 3)
      await resumed.waitFor("the replay", (v) => v.lastSeq === view.lastSeq)
      expect(resumed.events).toEqual(view.events.slice(3))
    })
  })
})

describe("two clients on one session", () => {
  test("both see the same events; a disconnect leaves the turn running; resuming has no gap or duplicate", async () => {
    await withServer(async (server, token) => {
      const control = await connect(server.url, token)
      const id = await createSession(control)
      const a = await SessionView.open(server.url, token, id)
      const b = await SessionView.open(server.url, token, id)
      await a.client.request("session.input", { sessionId: id, text: "long" })
      await a.waitFor("the turn to start", (v) => v.types().includes("RUN_STARTED"))
      const seenByA = a.lastSeq
      a.client.close()
      await a.client.waitClosed()
      await control.request("session.input", { sessionId: id, text: "more" })
      server.script.release("long")
      await b.waitFor("the turn to finish", (v) => finishedRuns(v) === 1)
      expect(b.texts()).toEqual(["echo: long", "echo: more"])
      const again = await SessionView.open(server.url, token, id, seenByA)
      await again.waitFor("the replay", (v) => v.lastSeq === b.lastSeq)
      expect([...a.events, ...again.events]).toEqual(b.events)
      expect(again.received).toEqual(b.events.map((event) => event.seq).filter((seq) => seq > seenByA))
    })
  })
})

describe("input during turns", () => {
  test("input starts a turn, steers it by default, queues in queue mode, and names its sender", async () => {
    await withServer(async (server, token) => {
      const other = server.token("secondary")
      const control = await connect(server.url, token)
      const second = await connect(server.url, other)
      const id = await createSession(control)
      const view = await SessionView.open(server.url, token, id)
      await control.request("session.input", { sessionId: id, text: "first" })
      await view.waitFor("the first turn", (v) => v.texts().includes("echo: first"))
      await second.request("session.input", { sessionId: id, text: "queued one", mode: "queue" })
      await control.request("session.input", { sessionId: id, text: "queued two", mode: "queue" })
      await second.request("session.input", { sessionId: id, text: "steer" })
      await view.waitFor("the steered input", (v) => v.texts().includes("echo: steer"))
      expect(runIds(view)).toHaveLength(2)
      server.script.release("first")
      server.script.release("steer")
      await view.waitFor("the queued turn", (v) => v.texts().includes("echo: queued one"))
      server.script.release("queued one")
      await view.waitFor("three finished turns", (v) => finishedRuns(v) === 3)
      const inputs = view.events.filter((event) => event.event.type === "INPUT_RECEIVED").map((event) => event.event)
      expect(inputs.map((input) => input.text)).toEqual(["first", "steer", "queued one", "queued two"])
      const senders = new Map(inputs.map((input) => [input.text, input.sender]))
      expect(senders.get("first").tokenId).not.toBe(senders.get("steer").tokenId)
      expect(senders.get("steer")).toMatchObject({ kind: "token", name: "secondary" })
    })
  })

  test("steered input arriving after the last step boundary starts the next turn", async () => {
    await withServer(async (server, token) => {
      const control = await connect(server.url, token)
      const id = await createSession(control)
      const view = await SessionView.open(server.url, token, id)
      await control.request("session.input", { sessionId: id, text: "hold" })
      await view.waitFor("the turn", (v) => v.texts().includes("echo: hold"))
      server.script.release("hold")
      await waitFor("the last step boundary", () => (server.script.pastLastBoundary.has("hold") ? true : undefined), 10_000)
      await control.request("session.input", { sessionId: id, text: "late" })
      expect(finishedRuns(view)).toBe(0)
      server.script.release("hold end")
      server.script.release("late")
      await view.waitFor("the late input's turn", (v) => finishedRuns(v) === 2)
      expect(runIds(view)).toHaveLength(2)
      expect(view.texts()).toEqual(["echo: hold", "echo: late"])
    })
  })

  test("an input whose turn cannot start stays waiting and starts the next turn with later input", async () => {
    await withServer(async (server, token) => {
      const control = await connect(server.url, token)
      const id = await createSession(control)
      execute(server, "CREATE TRIGGER fail_turn BEFORE INSERT ON turns BEGIN SELECT RAISE(ABORT, 'injected'); END")
      expect((await control.request("session.input", { sessionId: id, text: "never" })).result.inputId).toBeString()
      execute(server, "DROP TRIGGER fail_turn")
      const view = await SessionView.open(server.url, token, id)
      await view.waitFor("the error", (v) => v.types().includes("SESSION_ERROR"))
      expect(view.events.find((event) => event.event.type === "SESSION_ERROR")!.event).toMatchObject({ code: "turn_start_failed" })
      await control.request("session.input", { sessionId: id, text: "after" })
      server.script.release("never")
      await view.waitFor("the turn", (v) => finishedRuns(v) === 1)
      expect(view.types().slice(0, 4)).toEqual(["SESSION_CREATED", "CHECKPOINT_WINDOW_SEEDED", "INPUT_WAITING", "SESSION_ERROR"])
      expect(view.texts()).toEqual(["echo: never"])
      const started = view.events.find((event) => event.event.type === "RUN_STARTED")!.event
      expect(started).toMatchObject({ cause: "user" })
      expect(started.type === "RUN_STARTED" && started.userMessageIds).toHaveLength(2)
    })
  })

  test("cancel ends the running turn with a cancelled event", async () => {
    await withServer(async (server, token) => {
      const control = await connect(server.url, token)
      const id = await createSession(control)
      const view = await SessionView.open(server.url, token, id)
      await control.request("session.input", { sessionId: id, text: "cancel me" })
      await view.waitFor("the turn", (v) => v.texts().includes("echo: cancel me"))
      expect((await control.request("session.cancel", { sessionId: id })).result).toEqual({})
      await view.waitFor("the cancelled event", (v) =>
        v.events.some((event) => event.event.type === "RUN_FINISHED" && event.event.outcome.type === "cancelled"),
      )
      expect((await control.request("session.cancel", { sessionId: id })).error.code).toBe(-32005)
    })
  })

  test("a withdrawal write failure during cancel leaves a terminal failed turn", async () => {
    await withServer(async (server, token) => {
      const control = await connect(server.url, token)
      const id = await createSession(control)
      const view = await SessionView.open(server.url, token, id)
      await control.request("session.input", { sessionId: id, text: "ask ls withdraw" })
      await view.waitFor("the permission request", (v) => v.types().includes("PERMISSION_REQUESTED"))
      execute(
        server,
        "CREATE TRIGGER fail_withdraw BEFORE INSERT ON events WHEN NEW.body LIKE '%PERMISSION_WITHDRAWN%' BEGIN SELECT RAISE(ABORT, 'injected'); END",
      )
      await control.request("session.cancel", { sessionId: id })
      await view.waitFor("the fallback failure", (v) => v.types().includes("RUN_ERROR"))
      expect(view.events.find((event) => event.event.type === "RUN_ERROR")!.event).toMatchObject({ code: "state_integrity_failed" })
      await waitFor("the failed turn row", () => (turnStatuses(server, id).at(-1)?.status === "failed" ? true : undefined))
      expect((await control.request("session.list")).result.sessions.find((session: any) => session.id === id).activity).toBe("idle")
      execute(server, "DROP TRIGGER fail_withdraw")
    })
  })

  test("an active rewind finishes when its cancelled turn cannot write a withdrawal", async () => {
    await withServer(async (server, token) => {
      const control = await connect(server.url, token)
      const id = await createSession(control)
      const view = await SessionView.open(server.url, token, id)
      await control.request("session.input", { sessionId: id, text: "ask ls rewind" })
      await view.waitFor("the permission request", (v) => v.types().includes("PERMISSION_REQUESTED"))
      const runId = runIds(view)[0]!
      execute(
        server,
        "CREATE TRIGGER fail_withdraw BEFORE INSERT ON events WHEN NEW.body LIKE '%PERMISSION_WITHDRAWN%' BEGIN SELECT RAISE(ABORT, 'injected'); END",
      )
      const response = await Promise.race([
        control.request("session.rewind", { sessionId: id, runId }),
        Bun.sleep(1_000).then(() => {
          throw new Error("the active rewind waited for a settled turn")
        }),
      ])
      execute(server, "DROP TRIGGER fail_withdraw")
      expect(response.error).toBeUndefined()
      await view.waitFor("the rerun", (v) => v.types().includes("SESSION_REWOUND") && runIds(v).length === 1)
    })
  })

  test("a RUN_FINISHED write failure records a failed terminal turn", async () => {
    await withServer(async (server, token) => {
      const control = await connect(server.url, token)
      const id = await createSession(control)
      const view = await SessionView.open(server.url, token, id)
      execute(
        server,
        "CREATE TRIGGER fail_finished BEFORE INSERT ON events WHEN NEW.body LIKE '%RUN_FINISHED%' BEGIN SELECT RAISE(ABORT, 'injected'); END",
      )
      await control.request("session.input", { sessionId: id, text: "finish" })
      server.script.release("finish")
      await view.waitFor("the fallback failure", (v) => v.types().includes("RUN_ERROR"))
      expect(view.events.find((event) => event.event.type === "RUN_ERROR")!.event).toMatchObject({ code: "state_integrity_failed" })
      execute(server, "DROP TRIGGER fail_finished")
      await waitFor("the failed turn row", () => (turnStatuses(server, id).at(-1)?.status === "failed" ? true : undefined))
    })
  })

  test("a RUN_ERROR write failure still settles the turn row and session", async () => {
    await withServer(async (server, token) => {
      const control = await connect(server.url, token)
      const id = await createSession(control)
      execute(
        server,
        "CREATE TRIGGER fail_error BEFORE INSERT ON events WHEN NEW.body LIKE '%RUN_ERROR%' BEGIN SELECT RAISE(ABORT, 'injected'); END",
      )
      await control.request("session.input", { sessionId: id, text: "fail now" })
      await waitFor("the failed turn row", () => (turnStatuses(server, id).at(-1)?.status === "failed" ? true : undefined))
      expect((await control.request("session.list")).result.sessions.find((session: any) => session.id === id).activity).toBe("idle")
      execute(server, "DROP TRIGGER fail_error")
    })
  })
})

describe("restart", () => {
  test("sessions survive, running turns end interrupted, unanswered asks are withdrawn, and input is accepted", async () => {
    await withServer(async (server, token) => {
      const control = await connect(server.url, token)
      const id = await createSession(control)
      const view = await SessionView.open(server.url, token, id)
      await control.request("session.input", { sessionId: id, text: "ask before restart" })
      await view.waitFor("the permission request", (v) => v.types().includes("PERMISSION_REQUESTED"))
      const before = view.lastSeq
      await server.restart()
      const after = await SessionView.open(server.url, token, id, before)
      await after.waitFor("the interrupted event", (v) => v.types().includes("RUN_INTERRUPTED"))
      expect(after.types()).toEqual([
        "ACTION_SETTLED",
        "PERMISSION_WITHDRAWN",
        "MODEL_CALL_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "MODEL_CALL_COMMITTED",
        "RUN_INTERRUPTED",
      ])
      expect(["canceled", "restart"]).toContain(
        after.events.find((event) => event.event.type === "PERMISSION_WITHDRAWN").event.reason,
      )
      const client = await connect(server.url, token)
      const listed = (await client.request("session.list")).result.sessions
      expect(listed[0]).toMatchObject({
        id,
        sessionDir: join(server.sessionsDir, id),
        activity: "idle",
      })
      await client.request("session.input", { sessionId: id, text: "after restart" })
      server.script.release("after restart")
      await after.waitFor("the new turn to finish", (v) => finishedRuns(v) === 1)
    })
  })

  test("an ended turn withdraws its unanswered asks, leaving none for a restart", async () => {
    await withServer(async (server, token) => {
      const control = await connect(server.url, token)
      const id = await createSession(control)
      const view = await SessionView.open(server.url, token, id)
      await control.request("session.input", { sessionId: id, text: "ask then cancel" })
      await view.waitFor("the permission request", (v) => v.types().includes("PERMISSION_REQUESTED"))
      await control.request("session.cancel", { sessionId: id })
      await view.waitFor("the cancelled event", (v) => finishedRuns(v) === 1)
      const requested = view.events.find((event) => event.event.type === "PERMISSION_REQUESTED")
      const withdrawn = view.events.findIndex(
        (event) =>
          event.event.type === "PERMISSION_WITHDRAWN" &&
          event.event.requestId === requested.event.requestId &&
          event.event.reason === "canceled",
      )
      expect(withdrawn).toBeGreaterThan(-1)
      expect(view.events.slice(withdrawn).map((event) => event.event.type)).toContain("RUN_FINISHED")
      await server.restart()
      const after = await SessionView.open(server.url, token, id)
      await after.waitFor("the replay", (v) => v.lastSeq === view.lastSeq)
      expect(after.events).toEqual(view.events)
    })
  })

  test("an always grant still allows its call without an ask, and an ungranted call still follows the rules", async () => {
    await withServer(
      async (server, token) => {
        const control = await connect(server.url, token)
        const id = await createSession(control)
        const view = await SessionView.open(server.url, token, id)
        await control.request("session.input", { sessionId: id, text: "ask ls a" })
        await view.waitFor("the permission request", (v) => v.types().includes("PERMISSION_REQUESTED"))
        const requested = view.events.find((event) => event.event.type === "PERMISSION_REQUESTED")
        expect(await view.answerPermission(requested.event.requestId, "always")).toEqual({})
        await expect(view.answerPermission(requested.event.requestId, "always")).rejects.toThrow("no assigned permission action")
        await view.waitFor("the allowed call", (v) => said(v).includes("permission: allowed"))
        server.script.release("ask ls a")
        await view.waitFor("the turn to finish", (v) => finishedRuns(v) === 1)
        await server.restart()
        const client = await connect(server.url, token)
        const after = await SessionView.open(server.url, token, id, view.lastSeq)
        await client.request("session.input", { sessionId: id, text: "ask ls a" })
        await after.waitFor("the granted call", (v) => said(v).includes("permission: allowed"))
        server.script.release("ask ls a")
        await after.waitFor("the granted turn to finish", (v) => finishedRuns(v) === 1)
        await client.request("session.input", { sessionId: id, text: "ask rm a" })
        await after.waitFor("the denied call", (v) => said(v).includes("permission: denied by configuration"))
        server.script.release("ask rm a")
        await after.waitFor("the denied turn to finish", (v) => finishedRuns(v) === 2)
        await client.request("session.input", { sessionId: id, text: "ask ls b" })
        await after.waitFor("the ungranted request", (v) => v.types().includes("PERMISSION_REQUESTED"))
        await client.request("session.cancel", { sessionId: id })
        await after.waitFor("the cancelled turn", (v) => finishedRuns(v) === 3)
      },
      new TestServer({ shell: { "*": "ask", "rm *": "deny" } }),
    )
  })
})

describe("fork and rewind", () => {
  /** A session with three finished turns, "t1" to "t3", and a view of it. */
  const threeTurns = async (server: TestServer, token: string, model?: string) => {
    const control = await connect(server.url, token)
    const id = await createSession(
      control,
      model === undefined ? undefined : { modelSettings: { modelId: model } },
    )
    const view = await SessionView.open(server.url, token, id)
    for (const [index, text] of ["t1", "t2", "t3"].entries()) {
      await control.request("session.input", { sessionId: id, text })
      server.script.release(text)
      await view.waitFor(`turn ${text}`, (v) => finishedRuns(v) === index + 1)
    }
    return { control, id, view }
  }

  test("fork copies through a settled user turn while the source runs, and active rewind replaces the running tail", async () => {
    await withServer(async (server, token) => {
      const { control, id, view } = await threeTurns(server, token, models[1]!.id)
      const [, second] = runIds(view)
      const sourceBefore = [...view.events]
      const forked = (await control.request("session.fork", { sessionId: id, runId: second })).result.session
      expect(forked).toMatchObject({
        selection: { modelSettings: { modelId: models[1]!.id } },
        sessionDir: join(server.sessionsDir, forked.id),
      })
      expect(forked.sessionDir).not.toBe(sourceBefore[0].event.sessionDir)
      expect(statSync(forked.sessionDir).isDirectory()).toBe(true)
      const copy = await SessionView.open(server.url, token, forked.id)
      await copy.waitFor("the copy", (v) => v.lastSeq === forked.lastSeq)
      expect(copy.texts()).toEqual(["echo: t1", "echo: t2"])
      expect(copy.events[0].event.forkedFrom).toEqual({ sessionId: id, runId: second })
      const replay = await SessionView.open(server.url, token, id)
      await replay.waitFor("the source", (v) => v.lastSeq === view.lastSeq)
      expect(replay.events).toEqual(view.events)

      await control.request("session.input", { sessionId: id, text: "running" })
      await view.waitFor("the running turn", (v) => v.texts().includes("echo: running"))
      const whileRunning = await control.request("session.fork", { sessionId: id })
      expect(whileRunning.error).toBeUndefined()
      expect(whileRunning.result.session).toMatchObject({ activity: "idle" })
      const interrupted = runIds(view).at(-1)
      expect((await control.request("session.rewind", { sessionId: id, runId: second })).result).toEqual({})
      await view.waitFor("the active rewind's rerun", (v) => {
        const ids = runIds(v)
        return ids.length === 2 && ids.at(-1) !== interrupted
      })
      expect(runIds(view)).toHaveLength(2)
      server.script.release("running")
    })
  })

  test("a fork after a rewind copies only its turns' events and the source's settings", async () => {
    await withServer(async (server, token) => {
      const { control, id, view } = await threeTurns(server, token, models[1]!.id)
      const [first, second] = runIds(view)
      await control.request("session.rewind", { sessionId: id, runId: second, text: "t2 again" })
      server.script.release("t2 again")
      await view.waitFor("the rerun turn", (v) => finishedRuns(v) === 2)
      for (const through of [first, undefined]) {
        const forked = (await control.request("session.fork", { sessionId: id, ...(through === undefined ? {} : { runId: through }) }))
          .result.session
        const copy = await SessionView.open(server.url, token, forked.id)
        await copy.waitFor("the copy", (v) => v.lastSeq === forked.lastSeq)
        expect(copy.types()).not.toContain("SESSION_REWOUND")
        expect(copy.types()).not.toContain("SELECTION_CHANGED")
        expect(copy.events[0].event.selection.modelSettings.modelId).toBe(models[1]!.id)
        expect(copy.texts()).toEqual(through === undefined ? ["echo: t1", "echo: t2 again"] : ["echo: t1"])
        expect(runIds(copy)).toEqual(through === undefined ? runIds(view) : [first!])
      }
    })
  })

  test("a rewind reaches a live and a disconnected client, also after a restart, without reused numbers", async () => {
    await withServer(async (server, token) => {
      const { control, id, view } = await threeTurns(server, token)
      const away = await SessionView.open(server.url, token, id)
      await away.waitFor("the history", (v) => v.lastSeq === view.lastSeq)
      const awaySeq = away.lastSeq
      away.client.close()
      await away.client.waitClosed()
      const [, second] = runIds(view)
      const highest = view.lastSeq
      expect((await control.request("session.rewind", { sessionId: id, runId: second, text: "t2 edited" })).result).toEqual({})
      server.script.release("t2 edited")
      await view.waitFor("the rerun turn", (v) => finishedRuns(v) === 2)
      expect(view.texts()).toEqual(["echo: t1", "echo: t2 edited"])
      const rewound = view.events.find((event) => event.event.type === "SESSION_REWOUND")
      expect(rewound.seq).toBe(highest + 1)

      for (const restart of [false, true]) {
        if (restart) await server.restart()
        const back = await SessionView.open(server.url, token, id, awaySeq)
        await back.waitFor("the resume", (v) => v.received.includes(view.lastSeq))
        const merged = [...away.events.filter((event) => event.seq < rewound.event.firstRemovedSeq), ...back.events.slice(1)]
        expect(back.events[0].event.type).toBe("SESSION_REWOUND")
        expect(merged.map((event) => event.seq)).toEqual(view.events.filter((e) => e.event.type !== "SESSION_REWOUND").map((e) => e.seq))
        const fresh = await SessionView.open(server.url, token, id)
        await fresh.waitFor("the full replay", (v) => v.lastSeq === view.lastSeq)
        expect(fresh.texts()).toEqual(["echo: t1", "echo: t2 edited"])
        const seqs = fresh.events.map((event) => event.seq)
        expect(new Set(seqs).size).toBe(seqs.length)
        expect(seqs.filter((seq) => seq > rewound.event.firstRemovedSeq - 1).every((seq) => seq > highest)).toBe(true)
      }
    })
  })

  test("a rewind without input reruns the removed turn's input", async () => {
    await withServer(async (server, token) => {
      const { control, id, view } = await threeTurns(server, token)
      const [, , third] = runIds(view)
      await control.request("session.rewind", { sessionId: id, runId: third })
      await view.waitFor("the rerun", (v) => v.texts().filter((text) => text === "echo: t3").length === 1 && v.types().at(-1) !== "SESSION_REWOUND")
      expect(view.texts()).toEqual(["echo: t1", "echo: t2", "echo: t3"])
      server.script.release("t3")
    })
  })

  test("a rewind whose transaction fails leaves history, counter, and events as before", async () => {
    const server = new TestServer()
    try {
      const token = server.token("primary")
      await server.start()
      const turns = await threeTurns(server, token)
      const { id, view } = turns
      let control = turns.control
      const [, second] = runIds(view)
      const before = snapshot(server, id)
      const faults = [
        // After the deletion: the counter update fails.
        "CREATE TRIGGER fail_rewind BEFORE UPDATE OF next_seq ON sessions BEGIN SELECT RAISE(ABORT, 'injected'); END",
        // After the counter update: inserting the rewound event fails.
        "CREATE TRIGGER fail_rewind BEFORE INSERT ON events WHEN NEW.body LIKE '%SESSION_REWOUND%' BEGIN SELECT RAISE(ABORT, 'injected'); END",
        // After the rewound event: storing the rerun input fails.
        "CREATE TRIGGER fail_rewind BEFORE INSERT ON waiting_input BEGIN SELECT RAISE(ABORT, 'injected'); END",
      ]
      for (const fault of faults) {
        execute(server, fault)
        const response = await control.request("session.rewind", { sessionId: id, runId: second })
        expect(response.error.code).toBe(-32603)
        await server.restart()
        execute(server, "DROP TRIGGER fail_rewind")
        expect(snapshot(server, id)).toBe(before)
        const replay = await SessionView.open(server.url, token, id)
        await replay.waitFor("the replay", (v) => v.lastSeq === view.lastSeq)
        expect(replay.texts()).toEqual(["echo: t1", "echo: t2", "echo: t3"])
        control = await connect(server.url, token)
      }
      // A rewind whose rerun turn cannot start keeps its input waiting, and a restart starts it.
      execute(server, "CREATE TRIGGER fail_turn BEFORE INSERT ON turns BEGIN SELECT RAISE(ABORT, 'injected'); END")
      expect((await control.request("session.rewind", { sessionId: id, runId: second })).result).toEqual({})
      await server.restart()
      execute(server, "DROP TRIGGER fail_turn")
      await server.restart()
      const rerun = await SessionView.open(server.url, token, id)
      await rerun.waitFor("the rerun turn", (v) => v.texts().includes("echo: t2") && v.types().filter((type) => type === "RUN_STARTED").length === 2)
      expect(rerun.texts()).toEqual(["echo: t1", "echo: t2"])
    } finally {
      await server.cleanup()
    }
  })
})

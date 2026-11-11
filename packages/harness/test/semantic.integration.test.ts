import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage, AIMessageChunk, mapChatMessagesToStoredMessages } from "@langchain/core/messages"
import { AttachmentError, AttachmentStore, type UploadLimits } from "../src/content/attachments.ts"
import { SessionStore } from "../src/sessions/store.ts"
import { openDatabase } from "../src/store/database.ts"
import { migrationFiles } from "../src/store/migration-files.ts"
import { applyMigrations, discoverMigrations, readLedger } from "../src/store/migrations.ts"
import { AgentHarness, callTools, failWith, gate, hold, say } from "./support/agent.ts"
import { waitFor } from "./support/cli.ts"

const runDir = mkdtempSync(join(tmpdir(), "ashe-agent-semantic-"))
let counter = 0
const path = (name: string) => join(runDir, `${++counter}-${name}`)
const migrations = discoverMigrations(migrationFiles)

afterAll(() => rmSync(runDir, { recursive: true, force: true }))

const legacyDatabase = () => {
  const db = openDatabase(path("legacy.db"))
  applyMigrations(db, migrations.slice(0, 27))
  db.run("PRAGMA foreign_keys = ON")
  const now = 1_700_000_000_000
  db
    .query(
      `INSERT INTO sessions
        (id, model, forked_from_session, forked_from_run, created_at, next_seq, agent_key,
         model_overrides, permission, reasoning_effort, memory_generation, scratch_generation,
         memory_restore_generation, fork_skipped)
        VALUES ('legacy-session', 'test/alpha', NULL, NULL, ?, 6, 'reviewer', '{}', NULL, 'high', 0, 0, 0, 0)`,
    )
    .run(now)
  db
    .query(
      `INSERT INTO turns
        (session_id, run_id, position, model, status, first_seq, started_at, ended_at,
         reasoning_effort, cause, user_message_ids, input_membership)
        VALUES ('legacy-session', 'run-1', 1, 'test/alpha', 'finished', 1, ?, ?,
          'high', 'user', '[\"input-1\"]', '[{\"kind\":\"user\",\"inputId\":\"input-1\"}]'),
          ('legacy-session', 'run-2', 2, 'test/beta', 'finished', 4, ?, ?,
          NULL, 'user', '[\"input-2\"]', '[{\"kind\":\"user\",\"inputId\":\"input-2\"}]')`,
    )
    .run(now, now + 1, now + 2, now + 3)
  db.query("INSERT INTO checkpoint_windows (session_id, position, run_id, harness_instructions, created_at) VALUES (?, ?, NULL, ?, ?)").run(
    "legacy-session",
    1,
    "LEGACY HARNESS",
    now,
  )
  db.query("INSERT INTO contents (sha256, data) VALUES (?, ?)").run("legacy-instructions", Buffer.from("Legacy instructions"))
  db
    .query("INSERT INTO window_items (session_id, position, window_position, run_id, model, kind, body) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("legacy-session", 1, 1, null, null, "component", "{}")
  db
    .query("INSERT INTO developer_components (session_id, item_position, type, name, heading, text, sources) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(
      "legacy-session",
      1,
      "seed",
      "user_instructions",
      "User Instructions",
      "# User Instructions\n\nLegacy instructions",
      JSON.stringify({
        userInstructions: {
          kind: "global",
          path: "/config/AGENTS.md",
          sha256: "legacy-instructions",
          metadata: { dev: 0, ino: 0, size: 19, mtimeMs: 0, ctimeMs: 0 },
        },
      }),
    )
  const assistant = JSON.stringify(mapChatMessagesToStoredMessages([new AIMessage("legacy reply")])[0])
  const insert = db.query("INSERT INTO window_items (session_id, position, window_position, run_id, model, kind, body) VALUES (?, ?, ?, ?, ?, ?, ?)")
  insert.run(
    "legacy-session",
    2,
    1,
    "run-1",
    "test/alpha",
    "user",
    JSON.stringify({ kind: "user", inputId: "input-1", text: "legacy question", sender: { kind: "login", loginId: "owner" } }),
  )
  insert.run("legacy-session", 3, 1, "run-1", "test/alpha", "assistant", assistant)
  insert.run(
    "legacy-session",
    4,
    1,
    "run-2",
    "test/beta",
    "result",
    JSON.stringify({ kind: "result", callId: "call-1", name: "echo", content: "legacy result", outcome: "success" }),
  )
  db.query("INSERT INTO tool_result_clearings (session_id, item_position, run_id, attempt) VALUES (?, ?, ?, ?)").run(
    "legacy-session",
    4,
    "run-2",
    0,
  )
  db.query("INSERT INTO waiting_input (session_id, position, kind, body, created_at) VALUES (?, ?, ?, ?, ?)").run(
    "legacy-session",
    1,
    "user",
    JSON.stringify({ kind: "user", inputId: "waiting-1", text: "waiting", mode: "queue", sender: { kind: "login", loginId: "owner" } }),
    now,
  )
  db.query("INSERT INTO session_grants (session_id, position, permission, pattern) VALUES (?, ?, ?, ?)").run(
    "legacy-session",
    1,
    "edit",
    "/tmp/a",
  )
  return db
}

describe("semantic history migrations", () => {
  test("a representative pre-semantic database preserves recoverable facts and leaves boundaries explicitly absent", () => {
    const db = legacyDatabase()
    try {
      expect(applyMigrations(db, migrations).map((migration) => migration.name)).toEqual([
        "0028_semantic_history.sql",
        "0029_tool_ownership.sql",
      ])
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
      const store = new SessionStore(db, runDir)
      expect(store.getSession("legacy-session")).toMatchObject({ agent: "reviewer", model: "test/alpha", reasoningEffort: "high" })
      expect(store.turns("legacy-session").map((turn) => [turn.model, turn.settingsRevision])).toEqual([
        ["test/alpha", "turn:1"],
        ["test/beta", "turn:2"],
      ])
      const items = store.conversation.items("legacy-session", 1)
      expect(items.map((item) => item.kind)).toEqual(["component", "user", "assistant", "result"])
      expect(items.map((item) => item.position)).toEqual([1, 2, 3, 4])
      expect(items[2]).toMatchObject({ kind: "assistant", model: "test/alpha" })
      expect(db.query<{ kind: string }, []>("SELECT typeof(body) AS kind FROM window_items LIMIT 1").get()).toEqual({ kind: "text" })
      expect(db.query("SELECT item_position FROM tool_result_clearings").get()).toEqual({ item_position: 4 })
      expect(() =>
        db
          .query("UPDATE agent_tools SET model_call_id = 'missing' WHERE session_id = ? AND entry_id = ?")
          .run("legacy-session", "legacy:4"),
      ).toThrow()
      expect(() =>
        db
          .query("UPDATE agent_tools SET parent_invocation_id = 'legacy:2' WHERE session_id = ? AND entry_id = ?")
          .run("legacy-session", "legacy:4"),
      ).toThrow()
      const pendingCall = store.conversation.appendAssistant(
        "legacy-session",
        1,
        { runId: "run-1", model: "test/alpha", agentTitle: "reviewer" },
        new AIMessage({ content: "", tool_calls: [{ id: "pending", name: "echo", args: {} }] }),
        null,
      )
      expect(
        db
          .query<{ n: number }, [string, string]>(
            `SELECT count(*) AS n FROM window_items w JOIN session_entries e
              ON e.session_id = w.session_id AND e.position = w.position
              WHERE e.session_id = ? AND e.entry_id = ?`,
          )
          .get("legacy-session", pendingCall.toolInvocationIds[0]!),
      ).toEqual({ n: 0 })
      const knownInstructions = store.conversation.knownStates("legacy-session", 1).userInstructions
      expect(knownInstructions?.kind === "none" ? null : knownInstructions?.sha256).toBe("legacy-instructions")
      expect(store.conversation.content("legacy-instructions")).toBe("Legacy instructions")
      const waiting = store.conversation.waiting("legacy-session")[0]
      expect(waiting?.kind === "user" ? waiting.text : null).toBe("waiting")
      expect(store.grants("legacy-session", "reviewer")).toEqual([{ permission: "edit", pattern: "/tmp/a" }])
      expect(db.query("SELECT count(*) AS n FROM request_manifests").get()).toEqual({ n: 0 })
      expect(db.query("SELECT count(*) AS n FROM model_calls").get()).toEqual({ n: 0 })
      expect(() =>
        db.run(
          "INSERT INTO window_items (session_id, position, window_position, run_id, model, kind, body) VALUES ('x', 1, 1, NULL, NULL, 'user', '{}')",
        ),
      ).toThrow()
      expect(readLedger(db).map((entry) => entry.name)).toEqual(migrations.map((migration) => migration.name))
      expect(applyMigrations(db, migrations)).toEqual([])
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
    } finally {
      db.close()
    }
  })

  test("a database at the reviewed migration 28 upgrades through migration 29", () => {
    const db = legacyDatabase()
    try {
      expect(applyMigrations(db, migrations.slice(0, 28)).map((migration) => migration.name)).toEqual([
        "0028_semantic_history.sql",
      ])
      expect(applyMigrations(db, migrations).map((migration) => migration.name)).toEqual(["0029_tool_ownership.sql"])
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
      const columns = db.query<{ name: string }, []>("PRAGMA table_info(agent_tools)").all().map((column) => column.name)
      expect(columns).toContain("model_call_unavailable")
      const foreignTables = db
        .query<{ table: string }, []>("PRAGMA foreign_key_list(agent_tools)")
        .all()
        .map((foreign) => foreign.table)
      expect(foreignTables).toContain("model_calls")
      expect(foreignTables).toContain("agent_tools")
      expect(db.query("SELECT model_call_id, model_call_unavailable FROM agent_tools WHERE entry_id = 'legacy:4'").get()).toEqual({
        model_call_id: null,
        model_call_unavailable: "model call unavailable",
      })
      expect(db.query<{ kind: string }, []>("SELECT typeof(body) AS kind FROM window_items LIMIT 1").get()).toEqual({ kind: "text" })
    } finally {
      db.close()
    }
  })
})

describe("retained attachments and uploads", () => {
  const limits: UploadLimits = {
    maxFileBytes: 64,
    maxImageBytes: 32,
    maxAttachments: 2,
    maxSubmissionBytes: 80,
    quotaBytes: 100,
    expiryMs: 1_000,
    chunkBytes: 3,
  }
  const file = Buffer.from("hello")
  const digest = new Bun.CryptoHasher("sha256").update(file).digest("hex")

  test("uploads resume by offset, verify size and digest, and persist across a database reopen", () => {
    const filePath = path("uploads.db")
    let db = openDatabase(filePath)
    applyMigrations(db, migrations)
    const store = new SessionStore(db, runDir)
    store.createSession(
      { id: "upload-session", agent: null, model: "test/alpha", reasoningEffort: null, modelOverrides: {}, permission: null, createdAt: 1 },
      null,
    )
    const uploads = new AttachmentStore(db, limits)
    const created = uploads.create("owner:test", "draft-1", "hello.txt", "text/plain", file.byteLength, 10)
    expect(created).toMatchObject({ offset: 0, size: 5, claimed: false })
    const first = Buffer.from("hel").toString("base64")
    const second = Buffer.from("lo").toString("base64")
    expect(uploads.append("owner:test", created.uploadId, 0, first, 11).offset).toBe(3)
    expect(uploads.append("owner:test", created.uploadId, 0, first, 12).offset).toBe(3)
    expect(() => uploads.append("owner:test", created.uploadId, 0, second, 13)).toThrow(AttachmentError)
    expect(() => uploads.append("owner:test", created.uploadId, 4, second, 13)).toThrow(AttachmentError)
    uploads.append("owner:test", created.uploadId, 3, second, 14)
    expect(() => uploads.finalize("owner:test", created.uploadId, 5, "0".repeat(64), 15)).toThrow(AttachmentError)
    const finalized = uploads.finalize("owner:test", created.uploadId, 5, digest, 16)
    expect(finalized).toMatchObject({ offset: 5, size: 5, digest, claimed: false })
    db.close()

    db = openDatabase(filePath)
    const reopened = new AttachmentStore(db, limits)
    expect(reopened.statusOf("owner:test", created.uploadId, 17)).toMatchObject({ offset: 5, digest, claimed: false })
    const attachment = db.query<{ attachment_id: string; digest: string }, [string, string]>(
      "SELECT attachment_id, digest FROM uploads WHERE owner_id = ? AND upload_id = ?",
    ).get("owner:test", created.uploadId)!
    expect(reopened.attachment(attachment.attachment_id)).toMatchObject({ contentSha256: digest, size: 5 })
    reopened.claim(
      "owner:test",
      "upload-session",
      "input-1",
      [
        {
          attachmentId: attachment.attachment_id,
          contentId: digest,
          representationId: digest,
          name: "hello.txt",
          mediaType: "text/plain",
          digest,
        },
      ],
      18,
    )
    expect(reopened.statusOf("owner:test", created.uploadId, 19).claimed).toBe(true)
    reopened.expire(10_000)
    expect(reopened.attachment(attachment.attachment_id)).not.toBeNull()
    expect(db.query("SELECT count(*) AS n FROM attachment_references").get()).toEqual({ n: 1 })
    db.close()
  })

  test("an unclaimed upload expires, a claimed original survives, owner quotas and limits fail closed", () => {
    const db = openDatabase(path("expiry.db"))
    try {
      applyMigrations(db, migrations)
      const store = new SessionStore(db, runDir)
      store.createSession(
        { id: "expiry-session", agent: null, model: "test/alpha", reasoningEffort: null, modelOverrides: {}, permission: null, createdAt: 1 },
        null,
      )
      const uploads = new AttachmentStore(db, limits)
      const abandoned = uploads.create("owner:other", "draft", "a.txt", "text/plain", 4, 100)
      uploads.append("owner:other", abandoned.uploadId, 0, Buffer.from("tes").toString("base64"), 101)
      uploads.append("owner:other", abandoned.uploadId, 3, Buffer.from("t").toString("base64"), 101)
      const stagedDigest = new Bun.CryptoHasher("sha256").update("test").digest("hex")
      uploads.finalize("owner:other", abandoned.uploadId, 4, stagedDigest, 102)
      const before = db.query<{ attachment_id: string }, [string, string]>(
        "SELECT attachment_id FROM uploads WHERE owner_id = ? AND upload_id = ?",
      ).get("owner:other", abandoned.uploadId)!.attachment_id
      uploads.expire(1_103)
      expect(uploads.attachment(before)).toBeNull()
      expect(() => uploads.statusOf("owner:other", abandoned.uploadId, 1_103)).toThrow(AttachmentError)
      uploads.create("owner:quota", "d", "first.bin", "application/octet-stream", 60, 2_000)
      expect(() => uploads.create("owner:quota", "d", "second.bin", "application/octet-stream", 60, 2_000)).toThrow(AttachmentError)
      expect(() => uploads.create("owner:image", "d", "large.png", "image/png", 33, 2_000)).toThrow(AttachmentError)
      const other = uploads.create("owner:other", "draft", "b.txt", "text/plain", 1, 2_001)
      expect(() => uploads.statusOf("owner:else", other.uploadId, 2_002)).toThrow(AttachmentError)
    } finally {
      db.close()
    }
  })

  test("input acceptance claims an original atomically before a running turn admits it", async () => {
    const h = new AgentHarness()
    const running = gate()
    try {
      const id = h.create()
      h.model.next(hold(running.promise))
      h.input(id, "running")
      await h.calls(1)
      const uploads = new AttachmentStore(h.db, limits)
      const createdAt = Date.now()
      const created = uploads.create("login:component", "draft", "keep.txt", "text/plain", 5, createdAt)
      uploads.append("login:component", created.uploadId, 0, Buffer.from("hel").toString("base64"), createdAt + 1)
      uploads.append("login:component", created.uploadId, 3, Buffer.from("lo").toString("base64"), createdAt + 2)
      uploads.finalize("login:component", created.uploadId, 5, digest, createdAt + 3)
      const attachment = h.db
        .query<{ attachment_id: string }, [string, string]>("SELECT attachment_id FROM uploads WHERE owner_id = ? AND upload_id = ?")
        .get("login:component", created.uploadId)!.attachment_id
      const inputId = h.hub.input(id, "with file", "steer", h.sender, {
        attachments: [
          {
            attachmentId: attachment,
            contentId: digest,
            representationId: digest,
            name: "keep.txt",
            mediaType: "text/plain",
            digest,
          },
        ],
      })
      expect(h.hub.store.conversation.waiting(id).find((entry) => entry.inputId === inputId)).toMatchObject({ kind: "user" })
      expect(
        h.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM attachment_references WHERE reference_id = ?").get(inputId),
      ).toEqual({ n: 1 })
      uploads.expire(1_000_000)
      expect(uploads.attachment(attachment)).not.toBeNull()
      expect(() =>
        h.hub.input(id, "bad file", "steer", h.sender, {
          attachments: [
            {
              attachmentId: attachment,
              contentId: "wrong",
              representationId: "wrong",
              name: "keep.txt",
              mediaType: "text/plain",
              digest,
            },
          ],
        }),
      ).toThrow()
      expect(h.hub.store.conversation.waiting(id).filter((entry) => entry.kind === "user")).toHaveLength(1)
    } finally {
      running.open()
      await h.cleanup()
    }
  })

  test("a fork keeps a retained attachment reference and the original survives staging expiry", async () => {
    const h = new AgentHarness()
    try {
      const id = h.create()
      const uploads = new AttachmentStore(h.db, limits)
      const now = Date.now()
      const created = uploads.create("login:component", "draft", "fork.txt", "text/plain", 5, now)
      uploads.append("login:component", created.uploadId, 0, Buffer.from("hel").toString("base64"), now + 1)
      uploads.append("login:component", created.uploadId, 3, Buffer.from("lo").toString("base64"), now + 2)
      uploads.finalize("login:component", created.uploadId, 5, digest, now + 3)
      const attachment = h.db
        .query<{ attachment_id: string }, [string]>("SELECT attachment_id FROM uploads WHERE upload_id = ?")
        .get(created.uploadId)!.attachment_id
      h.model.next(say("attached"))
      h.hub.input(id, "fork me", "steer", h.sender, {
        attachments: [
          {
            attachmentId: attachment,
            contentId: digest,
            representationId: digest,
            name: "fork.txt",
            mediaType: "text/plain",
            digest,
          },
        ],
      })
      await h.turnsEnded(id, 1)
      await h.restart()
      const user = h.hub.store.conversation.items(id, 1).find((item) => item.kind === "user")!
      expect(user.kind === "user" ? user.attachments : undefined).toMatchObject([{ attachmentId: attachment, name: "fork.txt" }])
      const manifest = h.hub.store.conversation.successfulManifests(id)[0]!.manifest as any
      expect(
        manifest.contributions.some(
          (part: any) => part.transformation === "attachment-original" && part.representation.contentId === digest,
        ),
      ).toBe(true)
      h.db
        .query("INSERT INTO session_grants (session_id, title_key, position, permission, pattern) VALUES (?, ?, ?, ?, ?)")
        .run(id, "reviewer", 1, "edit", "/a")
      h.db
        .query("INSERT INTO session_grants (session_id, title_key, position, permission, pattern) VALUES (?, ?, ?, ?, ?)")
        .run(id, "writer", 1, "edit", "/b")
      const fork = h.hub.fork(id, undefined)
      expect(h.db.query("SELECT count(*) AS n FROM attachment_references WHERE session_id = ?").get(fork.id)).toEqual({ n: 1 })
      expect(h.hub.store.conversation.successfulManifests(fork.id)).toHaveLength(1)
      expect(h.hub.store.conversation.items(fork.id, 1).every((item) => item.ownershipKind === "inherited")).toBe(true)
      expect(h.hub.store.conversation.items(fork.id, 1).every((item) => item.authorshipSessionId === id)).toBe(true)
      expect(h.hub.store.clearGrants(id, "reviewer")).toBe(1)
      expect(h.hub.store.grantsForSession(id).map((grant) => grant.agentTitle)).toEqual(["writer"])
      expect(h.hub.store.grantsForSession(fork.id).map((grant) => grant.agentTitle)).toEqual(["reviewer", "writer"])
      uploads.expire(now + limits.expiryMs + 1)
      expect(uploads.attachment(attachment)).not.toBeNull()
    } finally {
      await h.cleanup()
    }
  })

  test("rewind edits user text without losing retained attachments through restart reconstruction", async () => {
    let clock = Date.now()
    const h = new AgentHarness({ now: () => clock })
    try {
      const id = h.create()
      const uploads = new AttachmentStore(h.db, limits)
      const now = clock
      const refs = ["alpha.txt", "beta.txt"].map((name, index) => {
        const bytes = Buffer.from(index === 0 ? "a" : "b")
        const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
        const created = uploads.create("login:component", "rewind", name, "text/plain", bytes.byteLength, now + index * 10)
        uploads.append("login:component", created.uploadId, 0, bytes.toString("base64"), now + index * 10 + 1)
        uploads.finalize("login:component", created.uploadId, bytes.byteLength, sha, now + index * 10 + 2)
        const attachmentId = h.db
          .query<{ attachment_id: string }, [string]>("SELECT attachment_id FROM uploads WHERE upload_id = ?")
          .get(created.uploadId)!.attachment_id
        return {
          attachmentId,
          contentId: sha,
          representationId: sha,
          name,
          mediaType: "text/plain",
          digest: sha,
        }
      })
      h.model.next(say("first"))
      h.hub.input(id, "original text", "steer", h.sender, { attachments: refs })
      await h.turnsEnded(id, 1)
      const [original] = h.hub.store.turns(id)

      clock += 2_000
      h.model.next(say("edited"))
      await h.hub.rewind(id, original!.runId, "edited text", h.sender)
      await h.turnsEnded(id, 1)
      const editedTurn = h.hub.store.turns(id).at(-1)!
      const editedUser = h.hub.store.conversation
        .turnItems(id, editedTurn.runId)
        .find((item) => item.kind === "user")
      expect(editedUser).toMatchObject({
        text: "edited text",
        attachments: [{ name: "alpha.txt" }, { name: "beta.txt" }],
      })
      expect(
        h.db
          .query<{ n: number }, [string, string]>("SELECT count(*) AS n FROM attachment_references WHERE session_id = ? AND reference_id = ?")
          .get(id, editedTurn.userMessageIds[0]!),
      ).toEqual({ n: 2 })

      h.model.next(say("again"))
      await h.hub.rewind(id, editedTurn.runId, undefined, h.sender)
      await h.turnsEnded(id, 1)
      await h.restart()
      const rebuiltTurn = h.hub.store.turns(id).at(-1)!
      const rebuiltUser = h.hub.store.conversation
        .turnItems(id, rebuiltTurn.runId)
        .find((item) => item.kind === "user")
      expect(rebuiltUser).toMatchObject({
        text: "edited text",
        attachments: [{ name: "alpha.txt" }, { name: "beta.txt" }],
      })
      for (const ref of refs) {
        expect(h.hub.store.conversation.contentBytes(ref.contentId)).not.toBeNull()
      }
    } finally {
      await h.cleanup()
    }
  })
})

describe("model request boundaries on real persistence", () => {
  test("a failed response after streamed text leaves no retained partial while the committed tool result survives restart", async () => {
    const h = new AgentHarness()
    try {
      const id = h.create()
      const partial = async function* () {
        yield new AIMessageChunk({ content: [{ type: "text", text: "discard this thought", index: 0 }] })
        throw new Error("connection reset")
      }
      h.model.next(callTools([{ name: "echo", args: { text: "keep" }, id: "call-keep" }]), partial)
      h.input(id, "stream then fail")
      await h.turnsEnded(id, 1)
      const events = h.events(id).map((event) => event.event)
      const partialEvent = events.find((event) => event.type === "TEXT_MESSAGE_CONTENT" && event.delta === "discard this thought")
      expect(partialEvent?.type).toBe("TEXT_MESSAGE_CONTENT")
      expect(
        events.some(
          (event) =>
            event.type === "MODEL_CALL_DISCARDED" && event.modelCallId === (partialEvent as { modelCallId?: string } | undefined)?.modelCallId,
        ),
      ).toBe(true)
      await h.restart()
      const turn = h.hub.store.turns(id)[0]!
      const items = h.hub.store.conversation.turnItems(id, turn.runId)
      expect(items.some((item) => item.kind === "assistant" && item.message.content === "discard this thought")).toBe(false)
      expect(items.find((item) => item.kind === "result")).toMatchObject({ callId: "call-keep", outcome: "success", content: "echoed keep" })
      expect(h.hub.store.conversation.successfulManifests(id)).toHaveLength(1)
    } finally {
      await h.cleanup()
    }
  })

  test("every successful request retains ordered contribution references and a failed attempt is not eligible", async () => {
    const h = new AgentHarness()
    try {
      const id = h.create()
      h.model.next(callTools([{ name: "echo", args: { text: "x" } }]), say("done"), failWith(new Error("provider reset")), say("recovered"))
      h.input(id, "first")
      await h.turnsEnded(id, 1)
      const successful = h.hub.store.conversation.successfulManifests(id)
      expect(successful).toHaveLength(2)
      for (const [index, entry] of successful.entries()) {
        const manifest = entry.manifest as { version: number; contributions: Array<Record<string, any>> }
        expect(manifest.version).toBe(1)
        expect(manifest.contributions[0]).toMatchObject({ kind: "instruction", sourceEntryId: null })
        expect(manifest.contributions.some((part) => part.kind === "tool-definition" && part.name === "echo")).toBe(true)
        expect(manifest).not.toHaveProperty("messages")
        for (const part of manifest.contributions) {
          expect(h.hub.store.conversation.contentBytes(part.rendered.contentId)).not.toBeNull()
          expect(part.transformation).not.toBeNull()
        }
        const providerInput = (manifest as any).providerInput
        const renderedProvider = JSON.parse(
          Buffer.from(h.hub.store.conversation.contentBytes(providerInput.contentId)!).toString("utf8"),
        )
        expect(renderedProvider).toMatchObject({
          instructions: h.model.calls[index]!.call.instructions,
          tools: h.model.calls[index]!.call.tools,
          messages: JSON.parse(JSON.stringify(h.model.calls[index]!.call.messages)),
        })
        expect(providerInput.digest).toBe(
          new Bun.CryptoHasher("sha256").update(JSON.stringify(renderedProvider)).digest("hex"),
        )
        const grouped = manifest.contributions.find((part) => (part.sourceEntryIds?.length ?? 0) > 1)
        if (grouped !== undefined) {
          const groupedText = Buffer.from(h.hub.store.conversation.contentBytes(grouped.rendered.contentId)!).toString("utf8")
          expect(JSON.stringify(renderedProvider)).toContain(JSON.stringify(groupedText).slice(1, -1))
        }
      }
      const firstUser = h.hub.store.conversation.items(id, 1).find((item) => item.kind === "user")!
      expect((successful[0]!.manifest as any).contributions.some((part: any) => part.sourceEntryId === firstUser.entryId)).toBe(true)
      const firstUserContribution = (successful[0]!.manifest as any).contributions.find(
        (part: any) => part.sourceEntryId === firstUser.entryId,
      )
      expect(
        Buffer.from(h.hub.store.conversation.contentBytes(firstUserContribution.rendered.contentId)!).toString("utf8"),
      ).toBe("<user>\nfirst\n</user>")
      const boundaries = h.db
        .query<{ manifest_id: string }, [string]>("SELECT manifest_id FROM request_manifests WHERE session_id = ? ORDER BY rowid")
        .all(id)
      const committed = h
        .events(id)
        .map((event) => event.event)
        .filter((event) => event.type === "MODEL_CALL_COMMITTED")
        .map((event) => event.inputBoundaryId)
      expect(committed).toEqual(boundaries.map((boundary) => boundary.manifest_id))

      h.input(id, "failing")
      await h.turnsEnded(id, 2)
      expect(h.hub.store.conversation.successfulManifests(id)).toHaveLength(2)
      const calls = h.db
        .query<{ outcome: string | null; manifests: number }, [string]>(
          `SELECT m.outcome, count(r.manifest_id) AS manifests FROM model_calls m
            LEFT JOIN request_manifests r ON r.session_id = m.session_id AND r.model_call_id = m.model_call_id
            WHERE m.session_id = ? GROUP BY m.model_call_id ORDER BY m.started_at, m.ordinal`,
        )
        .all(id)
      expect(calls.map((call) => call.outcome)).toEqual(["success", "success", "failed"])
      expect(calls.map((call) => call.manifests)).toEqual([1, 1, 1])

      h.input(id, "recover")
      await h.turnsEnded(id, 3)
      expect(h.hub.store.conversation.latestSuccessfulManifest(id)?.modelCallId).toBe(
        h.hub.store.conversation.successfulManifests(id).at(-1)?.modelCallId,
      )
      expect(h.hub.store.conversation.successfulManifests(id)).toHaveLength(3)
    } finally {
      await h.cleanup()
    }
  })

  test("duplicate provider call ids have distinct owned invocations and complete lifecycles", async () => {
    const h = new AgentHarness()
    try {
      const id = h.create()
      h.model.next(
        callTools([
          { name: "echo", args: { text: "one" }, id: "duplicate" },
          { name: "refuse", args: {}, id: "duplicate" },
        ]),
      )
      h.input(id, "run duplicate calls")
      await h.turnsEnded(id, 1)
      const rows = h.db
        .query<{ entry_id: string; name: string; started_at: number | null; settled_at: number | null; result_ref: string }, [string]>(
          `SELECT a.entry_id, a.name, a.started_at, a.settled_at, a.result_ref FROM agent_tools a
            JOIN session_entries e ON e.session_id = a.session_id AND e.entry_id = a.entry_id
            WHERE a.session_id = ? AND a.provider_call_id = 'duplicate' ORDER BY e.position`,
        )
        .all(id)
      expect(rows).toHaveLength(2)
      expect(rows.every((row) => row.started_at !== null && row.settled_at !== null && row.result_ref !== null)).toBe(true)
      expect(new Set(rows.map((row) => row.entry_id)).size).toBe(2)
      expect(new Set(rows.map((row) => row.result_ref)).size).toBe(2)
      expect(rows.map((row) => row.name)).toEqual(["echo", "refuse"])
      expect(
        rows.map((row) => {
          const data = h.hub.store.conversation.content(row.result_ref)!
          return JSON.parse(data) as { name: string }
        }),
      ).toMatchObject([{ name: "echo" }, { name: "refuse" }])
      const results = h
        .events(id)
        .map((event) => event.event)
        .filter((event) => event.type === "TOOL_CALL_RESULT")
      expect(results).toHaveLength(2)
      expect(new Set(results.map((event) => (event as { invocationId?: string }).invocationId)).size).toBe(2)
    } finally {
      await h.cleanup()
    }
  })

  test("duplicate provider call ids settle separately on cancel and restart recovery", async () => {
    const h = new AgentHarness()
    const settled = (id: string) =>
      h.db
        .query<{ entry_id: string; name: string; settled_at: number | null; result_ref: string | null }, [string]>(
          `SELECT a.entry_id, a.name, a.settled_at, a.result_ref FROM agent_tools a
            JOIN session_entries e ON e.session_id = a.session_id AND e.entry_id = a.entry_id
            WHERE a.session_id = ? AND a.provider_call_id = 'duplicate-cancel' ORDER BY e.position`,
        )
        .all(id)
    try {
      const cancelled = h.create()
      h.model.next(
        callTools([
          { name: "wait", args: {}, id: "duplicate-cancel" },
          { name: "echo", args: { text: "cancel" }, id: "duplicate-cancel" },
        ]),
      )
      h.input(cancelled, "cancel duplicate calls")
      await waitFor("duplicate calls to start", () =>
        h.events(cancelled).some((event) => event.event.type === "TOOL_EXECUTION_STARTED") ? true : undefined,
      )
      h.hub.cancel(cancelled)
      await h.turnsEnded(cancelled, 1)
      const cancelledRows = settled(cancelled)
      expect(cancelledRows).toHaveLength(2)
      expect(cancelledRows.map((row) => row.name)).toEqual(["wait", "echo"])
      expect(cancelledRows.every((row) => row.settled_at !== null && row.result_ref !== null)).toBe(true)
      const cancelledPayloads = cancelledRows.map((row) => JSON.parse(h.hub.store.conversation.content(row.result_ref!)!))
      expect(cancelledPayloads).toMatchObject([{ name: "wait", content: expect.stringContaining("after it started") }, { name: "echo", content: expect.stringContaining("before it started") }])
      expect(
        new Set(
          h
            .events(cancelled)
            .map((event) => event.event)
            .filter((event) => event.type === "TOOL_CALL_RESULT")
            .map((event) => event.invocationId),
        ).size,
      ).toBe(2)
      expect(
        h.events(cancelled)
          .map((event) => event.event)
          .filter((event) => event.type === "TOOL_CALL_RESULT")
          .every((event) => event.invocationId !== undefined),
      ).toBe(true)

      const restarted = h.create()
      h.model.next(
        callTools([
          { name: "wait", args: {}, id: "duplicate-cancel" },
          { name: "echo", args: { text: "restart" }, id: "duplicate-cancel" },
        ]),
      )
      h.input(restarted, "restart duplicate calls")
      await waitFor("duplicate calls to start before restart", () =>
        h.events(restarted).some((event) => event.event.type === "TOOL_EXECUTION_STARTED") ? true : undefined,
      )
      await h.restart()
      await waitFor("recovered duplicate calls", () =>
        settled(restarted).every((row) => row.settled_at !== null && row.result_ref !== null) ? true : undefined,
      )
      const restartedRows = settled(restarted)
      expect(restartedRows).toHaveLength(2)
      expect(restartedRows.map((row) => row.name)).toEqual(["wait", "echo"])
      const restartedPayloads = restartedRows.map((row) => JSON.parse(h.hub.store.conversation.content(row.result_ref!)!))
      expect(restartedPayloads).toMatchObject([{ name: "wait", content: expect.stringContaining("after it started") }, { name: "echo", content: expect.stringContaining("before it started") }])
      const restartedResults = h
        .events(restarted)
        .map((event) => event.event)
        .filter((event) => event.type === "TOOL_CALL_RESULT")
      expect(restartedResults).toHaveLength(2)
      expect(new Set(restartedResults.map((event) => event.invocationId)).size).toBe(2)
    } finally {
      await h.cleanup()
    }
  })
})

describe("native history after restart and rewind", () => {
  test("semantic ordering, tool correlation, and historical settings survive a reopened database", () => {
    const filePath = path("history.db")
    let db = openDatabase(filePath)
    applyMigrations(db, migrations)
    let store = new SessionStore(db, runDir)
    store.createSession(
      {
        id: "history-session",
        agent: "helper",
        model: "test/alpha",
        reasoningEffort: null,
        modelOverrides: {},
        permission: null,
        createdAt: 1,
      },
      null,
    )
    const window = store.conversation.insertWindow("history-session", null, "HARNESS", 2)
    const revision = store.setSettings("history-session", {
      agentTitle: "helper",
      modelSettings: { modelId: "test/beta", reasoningEffort: "high" },
    })
    store.insertTurn(
      "history-session",
      {
        runId: "history-run",
        cause: "user",
        settingsRevision: revision,
        membership: [
          { kind: "system", inputId: "system:1" },
          { kind: "user", inputId: "history-input" },
        ],
        userMessageIds: ["history-input"],
        firstSeq: 2,
        contextWorkflowId: null,
        contextStartItem: null,
      },
      3,
    )
    store.conversation.appendItem(
      "history-session",
      window.position,
      { runId: "history-run", model: "test/beta", agentTitle: "helper" },
      {
        kind: "user",
        inputId: "history-input",
        text: "question",
        sender: { kind: "login", loginId: "owner" },
      },
    )
    store.conversation.beginModelCall(
      "history-session",
      "history-run",
      {
        modelCallId: "history-call",
        inputBoundaryId: "history-boundary",
        ordinal: 1,
        windowPosition: window.position,
        request: { version: 1, instructions: "REQUEST", contributions: [] },
        offeredTools: [],
      },
      4,
    )
    const assistantMessage = new AIMessage({
      content: [
        { type: "reasoning", reasoning: "visible thought" },
        { type: "text", text: "answer" },
      ],
      additional_kwargs: { reasoning: { type: "reasoning", encrypted_content: "ENC" } },
      tool_calls: [{ id: "provider-call", name: "echo", args: { text: "x" } }],
    })
    store.conversation.appendAssistant(
      "history-session",
      window.position,
      { runId: "history-run", model: "test/beta", agentTitle: "helper" },
      assistantMessage,
      "history-call",
    )
    store.conversation.appendToolResult(
      "history-session",
      window.position,
      { runId: "history-run", model: "test/beta", agentTitle: "helper" },
      { callId: "provider-call", name: "echo", content: "echoed x", outcome: "success" },
      "history-call",
    )
    store.conversation.commitModelCall("history-session", "history-call", assistantMessage, 5)
    const current = store.setSettings("history-session", {
      agentTitle: "writer",
      modelSettings: { modelId: "test/gamma", reasoningEffort: null },
    })
    store.insertTurn(
      "history-session",
      {
        runId: "failed-run",
        cause: "user",
        settingsRevision: current,
        membership: [{ kind: "system", inputId: "system:1" }],
        userMessageIds: [],
        firstSeq: 6,
        contextWorkflowId: null,
        contextStartItem: null,
      },
      6,
    )
    store.endTurn("history-session", "failed-run", "failed", 7)
    db.close()

    db = openDatabase(filePath)
    store = new SessionStore(db, runDir)
    try {
      expect(store.getSession("history-session")).toMatchObject({ agent: "writer", model: "test/gamma", settingsRevision: current })
      expect(store.turns("history-session").map((turn) => [turn.agentTitle, turn.model, turn.settingsRevision, turn.status])).toEqual([
        ["helper", "test/beta", revision, "running"],
        ["writer", "test/gamma", current, "failed"],
      ])
      const items = store.conversation.items("history-session", window.position)
      expect(items.map((item) => item.kind)).toEqual(["user", "assistant", "result"])
      expect(items.map((item) => [item.agentTitle, item.model])).toEqual([
        ["helper", "test/beta"],
        ["helper", "test/beta"],
        ["helper", "test/beta"],
      ])
      expect(items[1]).toMatchObject({ kind: "assistant", message: { tool_calls: [{ id: "provider-call" }] } })
      expect(items[2]).toMatchObject({ kind: "result", callId: "provider-call", outcome: "success", content: "echoed x" })
      expect(store.conversation.retainedContent("history-session", items[0]!.contentId, items[0]!.entryId)).toMatchObject({
        available: true,
        referenceId: items[0]!.entryId,
      })
      const thought = db
        .query<{ content: Uint8Array; format: string }, [string]>(
          `SELECT c.data AS content, c.format FROM session_entries e JOIN contents c ON c.sha256 = e.content_sha256
            WHERE e.session_id = ? AND e.kind = 'thought'`,
        )
        .get("history-session")!
      expect(JSON.parse(Buffer.from(thought.content).toString("utf8"))).toMatchObject({ kind: "thought", text: "visible thought" })
      const replayRef = db
        .query<{ provider_replay_ref: string }, [string]>(
          "SELECT provider_replay_ref FROM model_calls WHERE session_id = ? AND model_call_id = 'history-call'",
        )
        .get("history-session")!.provider_replay_ref
      expect(Buffer.from(store.conversation.contentBytes(replayRef) ?? []).toString("utf8")).toContain('"encrypted_content":"ENC"')
      expect(store.conversation.successfulManifests("history-session")).toHaveLength(1)
      const before = db.query("SELECT revision FROM session_settings WHERE session_id = ? ORDER BY applied_at").all("history-session")
      store.removeFrom("history-session", store.turns("history-session")[0]!)
      expect(db.query("SELECT revision FROM session_settings WHERE session_id = ? ORDER BY applied_at").all("history-session")).toEqual(before)
      expect(store.conversation.successfulManifests("history-session")).toEqual([])
      expect(store.getSession("history-session")).toMatchObject({ agent: "writer", model: "test/gamma" })
    } finally {
      db.close()
    }
  })
})

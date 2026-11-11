import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import { builtinTool, toolPolicy, withholdingName } from "../src/agent/tools.ts"
import { whollyDenied } from "../src/permissions/rules.ts"
import { databaseGuide, sessionTools } from "../src/tools/session/index.ts"
import { codeModeInventory, executeTool, sessionCodeModeCatalog } from "../src/tools/codemode/execute.ts"
import { AgentHarness, say } from "./support/agent.ts"

const normal = builtinTool({
  namespace: "docs",
  name: "lookup",
  permission: null,
  description: "Look up a document.",
  args: Schema.Struct({ query: Schema.String }),
  run: async () => ({ outcome: "success", content: "found" }),
})

let contextCalls = 0
const context = builtinTool({
  namespace: "context",
  name: "probe",
  permission: null,
  description: "Context probe that code mode must not discover.",
  args: Schema.Record(Schema.String, Schema.Never),
  run: async () => {
    contextCalls++
    return { outcome: "success", content: "must not run" }
  },
})

const run = () => ({
  sessionId: "session",
  runId: "run",
  agentTitle: "untitled",
  modelId: "test/alpha",
  reasoningEffort: null,
  toolCallId: "call",
  cwd: "/tmp",
  imageInput: false,
  signal: new AbortController().signal,
  deadline: Number.POSITIVE_INFINITY,
  clock: toolPolicy().clock,
  authorize: async () => {},
  started: () => {},
  onCancel: () => {},
  programCall: () => {},
  offered: () => true,
  note: () => undefined,
})

describe("direct-only session and context tool inventory", () => {
  test("code mode discovery and executable inventory exclude session and context tools", async () => {
    const direct = sessionTools({} as any)
    expect(direct.map((tool) => tool.spec.name)).toEqual([
      "session_message",
      "session_fork",
      "session_subscription",
      "session_wait",
      "session_list",
    ])
    const all = [...direct, context, normal]
    expect(codeModeInventory(all).map((tool) => tool.spec.name)).toEqual(["docs_lookup"])
    const catalog = sessionCodeModeCatalog(() => all)([])!
    expect(catalog).toContain("docs")
    expect(catalog).not.toContain("session_")
    expect(catalog).not.toContain("context_")
    expect(direct.map((tool) => tool.spec.name)).toContain("session_list")
    const offered = (rules: ReadonlyArray<{ permission: string; pattern: string; action: "deny" }>) =>
      [...direct, context].filter((tool) => !whollyDenied(rules, withholdingName(tool))).map((tool) => tool.spec.name)
    expect(offered([])).toContain("context_probe")
    expect(offered([{ permission: "context_probe", pattern: "*", action: "deny" }])).not.toContain("context_probe")
    const execute = executeTool(() => all, {})
    const search = await execute.run(
      { code: "return await search({ query: 'Context probe' })" },
      run() as any,
    )
    expect(search.outcome).toBe("success")
    expect(String(search.content)).not.toContain("context.probe")
    const attempted = await execute.run(
      { code: "return await tools.context.probe()" },
      run() as any,
    )
    expect(attempted.outcome).toBe("failed")
    expect(contextCalls).toBe(0)
  })

  test("the documented read-only CLI commands match the delivered schema and return bounded rows", async () => {
    const h = new AgentHarness()
    try {
      const id = h.create()
      const emptyRestore = h.create()
      h.model.next(say("hello"))
      h.input(id, "hello")
      await h.turnsEnded(id, 1)
      const turn = h.hub.store.turns(id)[0]!
      const contentId = h.hub.store.db.query<{ content_sha256: string }, [string]>(
        "SELECT content_sha256 FROM session_entries WHERE session_id = ? LIMIT 1",
      ).get(id)!.content_sha256
      h.hub.store.conversation.addWaiting(id, {
        kind: "user",
        inputId: "waiting-inspection",
        text: "held waiting text",
        mode: "queue",
        sender: h.sender,
      }, Date.now())
      h.hub.store.db.transaction(() => {
        h.hub.store.db.query(
          `INSERT INTO context_workflows
            (id, session_id, trigger, start_turn_id, current_turn_id, start_item, clearings, clearable,
             freed, validations, compaction_waited, constructed, created_at, ended_at)
            VALUES ('workflow-inspection', ?, 'threshold', ?, ?, 0, 1, 10, 5, 1, 0, 0, ?, NULL)`,
        ).run(id, turn.runId, turn.runId, Date.now())
        h.hub.store.db.query("INSERT INTO pending_restores (session_id, created_at) VALUES (?, ?)").run(id, Date.now())
        h.hub.store.db.query("INSERT INTO pending_restores (session_id, created_at) VALUES (?, ?)").run(emptyRestore, Date.now())
        h.hub.store.db.query(
          "INSERT INTO pending_restore_files (session_id, area, name, sha256) VALUES (?, 'research', 'notes.md', ?)",
        ).run(id, contentId)
      })()
      const guide = databaseGuide("/usr/bin/sqlite3", h.db.filename)
      expect(guide.readOnly).toBe(true)
      expect(guide.command).toStartWith('"/usr/bin/sqlite3" -readonly ')
      expect(guide.command).toContain("session_settings")
      expect(guide.command).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i)
      expect(guide.queries.map((query) => query.name)).toEqual([
        "current settings",
        "conversation history",
        "historical turns",
        "waiting input",
        "context workflows",
        "pending restores",
      ])
      const rows = new Map<string, ReadonlyArray<Record<string, unknown>>>()
      for (const query of guide.queries) {
        expect(query.sql).toContain("LIMIT 100")
        const result = h.hub.store.db.query(query.sql).all() as ReadonlyArray<Record<string, unknown>>
        rows.set(query.name, result)
        expect(result.length).toBeGreaterThan(0)
        for (const column of query.columns) {
          expect(query.sql).toContain(column)
        }
      }
      expect(rows.get("conversation history")!.some((row) => String(row.preview).includes("hello"))).toBe(true)
      expect(rows.get("waiting input")).toContainEqual(expect.objectContaining({
        body_preview: expect.stringContaining("held waiting text"),
        mode: "queue",
      }))
      expect(rows.get("context workflows")).toContainEqual(expect.objectContaining({ id: "workflow-inspection" }))
      expect(rows.get("pending restores")).toContainEqual(expect.objectContaining({
        area: "research",
        name: "notes.md",
        content_sha256: contentId,
      }))
      expect(rows.get("pending restores")).toContainEqual(expect.objectContaining({
        session_id: emptyRestore,
        area: null,
        name: null,
        content_sha256: null,
      }))
      expect(guide.activityQuery).toContain("LIMIT 100")
      const tables = h.hub.store.db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name)
      expect(tables).toEqual(expect.arrayContaining([
        "turns",
        "context_workflows",
        "pending_restores",
        "waiting_input",
      ]))
      expect(guide.guidance).toContain("turns.status describes historical settlement")
      expect(guide.guidance).toContain("context_workflows")
      expect(guide.guidance).toContain("pending_restores")
      expect(guide.guidance).toContain("sqlite3 -readonly")
      writeFileSync(join(h.dir, "not-executable"), "plain")
      expect(databaseGuide(h.dir, h.db.filename).available).toBe(false)
      expect(databaseGuide(join(h.dir, "not-executable"), h.db.filename).available).toBe(false)
    } finally {
      await h.cleanup()
    }
    const missing = databaseGuide("/definitely/missing/sqlite3", "/tmp/missing.db")
    expect(missing.available).toBe(false)
    expect(missing.guidance).toContain("is unavailable")
  })
})

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { CliRun, Client, waitFor } from "./support/cli.ts"
import { databaseGuide } from "../src/tools/session/index.ts"

/*
 * Qualifies the bundle `bun run test:qualification` names: the binary it
 * holds runs as the server, migrates, creates an API token, and serves a turn
 * that crosses a steering boundary, completes one exclusive permission action,
 * times out a shell call before continuing, and reads a docx, against a fake
 * Responses API.
 */

const bundle = process.env.ASHE_AGENT_QUALIFICATION_BUNDLE
if (bundle === undefined) throw new Error("ASHE_AGENT_QUALIFICATION_BUNDLE names no bundle; run bun run test:qualification")

const dir = mkdtempSync(join(tmpdir(), "ashe-agent-qualification-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const extracted = join(dir, "bundle")
const binary = join(extracted, "bin/ashe-agent")
const docx = join(import.meta.dir, "fixtures/documents/report.docx")

beforeAll(() => {
  mkdirSync(extracted)
  const tar = Bun.spawnSync(["tar", "-xf", bundle, "-C", extracted])
  if (tar.exitCode !== 0) throw new Error(`tar could not extract ${bundle}: ${tar.stderr.toString()}`)
})

const sse = (events: ReadonlyArray<Record<string, unknown>>) =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")

const completed = (id: string) => ({
  id,
  object: "response",
  status: "completed",
  model: "m",
  output: [],
  usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
})

const callReply = (id: string, name: string, args: string) => [
  { type: "response.created", response: { ...completed(id), status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name, arguments: "" } },
  { type: "response.function_call_arguments.delta", item_id: `fc_${id}`, output_index: 0, delta: args },
  { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name, arguments: args, status: "completed" } },
  { type: "response.completed", response: completed(id) },
]

const textReply = (id: string, text: string) => [
  { type: "response.created", response: { ...completed(id), status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: `msg_${id}`, role: "assistant", status: "in_progress", content: [] } },
  { type: "response.output_text.delta", item_id: `msg_${id}`, output_index: 0, content_index: 0, delta: text },
  { type: "response.output_item.done", output_index: 0, item: { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] } },
  { type: "response.completed", response: completed(id) },
]

describe("the bundle", () => {
  test("holds the binary and the web build of one revision", async () => {
    const version = Bun.spawnSync([binary, "--version"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } })
    expect(version.exitCode).toBe(0)
    const [product, revision = ""] = version.stdout.toString().trim().split(" ")
    expect(product).toBe("AsheAgent")
    expect(revision).toMatch(/^[0-9a-f]{40}$/)
    expect(existsSync(join(extracted, "web/index.html"))).toBe(true)
    expect(readFileSync(join(extracted, "web/revision.txt"), "utf8").trim()).toBe(revision)
  })

  test("the official sqlite3 CLI reads the migrated bundle database through the documented bounded queries", async () => {
    const sqlite3 = Bun.which("sqlite3")
    if (sqlite3 === null) throw new Error("the official sqlite3 executable is unavailable on PATH")
    const run = new CliRun({}, [binary])
    try {
      await run.prepare()
      const guide = databaseGuide(sqlite3, run.databasePath)
      expect(guide.available).toBe(true)
      for (const query of guide.queries) {
        expect(query.sql).toContain("LIMIT 100")
        const result = Bun.spawnSync([sqlite3, "-readonly", run.databasePath, query.sql])
        expect(result.exitCode).toBe(0)
        expect(result.stderr.toString()).toBe("")
      }
    } finally {
      await run.cleanup()
    }
  }, 30_000)

  test("its binary migrates, authenticates an API token, routes a permission action, crosses a steering boundary, times out a shell call, and reads a docx", async () => {
    const replies = [
      callReply("1", "shell_exec_command", JSON.stringify({ cmd: "sleep 1; echo qualified-$((6*7))" })),
      callReply("2", "file_read", JSON.stringify({ path: docx, limit: 3 })),
      textReply("3", "steered done"),
    ]
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        const reply = replies.shift()
        if (reply === undefined) return new Response("no reply scripted", { status: 500 })
        return new Response(sse(reply), { headers: { "content-type": "text/event-stream" } })
      },
    })
    const run = new CliRun(
      {
        ASHE_AGENT_PERMISSION: JSON.stringify({ shell: "ask" }),
        ASHE_AGENT_TOOL_TIMEOUT_OVERRIDES: JSON.stringify({ shell_exec_command: 300 }),
      },
      [binary],
      `http://127.0.0.1:${api.port}/v1`,
    )
    try {
      await run.prepare()
      const token = await run.run(["token", "create", "qualification"])
      expect(token.code).toBe(0)
      const url = await run.serve()
      const client = await Client.connect(url)
      const events: Array<any> = []
      const actions: Array<any> = []
      client.onNotification = (message) => events.push(message.params.event)
      client.onActionExecute = (action) => actions.push(action)
      const login = await client.request("auth.authenticate", { token: token.stdout.trim(), protocolVersion: 1 })
      expect(login.result.principal.kind).toBe("token")
      const { result } = await client.request("session.create", {})
      const sessionId = result.session.id
      await client.request("client.setActions", { actions: ["permission.decide"] })
      await client.request("session.subscribe", { sessionId })
      await client.request("session.input", { sessionId, text: "qualify" })
      const action = await waitFor("the permission action", () => actions[0], 60_000)
      expect(action.name).toBe("permission.decide")
      expect(
        (await client.request("action.complete", { sessionId, actionId: action.actionId, result: { answer: "once" } })).error,
      ).toBeUndefined()
      await waitFor("the shell call to start", () =>
        events.some((event) => event.type === "TOOL_EXECUTION_STARTED") ? true : undefined,
      )
      await client.request("session.input", { sessionId, text: "steer" })
      await waitFor(
        "both turns to end",
        () => (events.filter((event) => event.type === "RUN_FINISHED").length >= 2 ? true : undefined),
        60_000,
      )

      const results = events.filter((event) => event.type === "TOOL_CALL_RESULT")
      expect(results.map((event) => event.outcome)).toEqual(["failed", "success"])
      expect(results[0].content).toContain("timed out")
      expect(results[1].content).toContain("Fixture Title")
      expect(events.filter((event) => event.type === "ACTION_ASSIGNED")).toHaveLength(1)
      expect(events.filter((event) => event.type === "ACTION_SETTLED")).toMatchObject([{ outcome: "completed" }])
      const starts = events.filter((event) => event.type === "RUN_STARTED")
      expect(starts.map((event) => event.cause)).toEqual(["user", "user"])
      expect(starts[1]!.userMessageIds).toHaveLength(1)
      for (const event of events.filter((candidate) => candidate.type === "RUN_FINISHED")) {
        expect(event.outcome).toMatchObject({ type: "success" })
      }
      client.close()
    } finally {
      await run.cleanup()
      api.stop(true)
    }
  }, 120_000)
})

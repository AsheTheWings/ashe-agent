import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
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
    const notice = readFileSync(join(extracted, "NOTICE-content"), "utf8")
    expect(notice).toContain("@hyzyla/pdfium 3.0.0")
    expect(notice).toContain("SHA-256 beeaf5bbff216d555fecec7cd486072838c4632a2272d31b52ef1fd05008fe7c")
    expect(readFileSync(join(extracted, "PDFIUM_LICENSE"), "utf8")).toContain("Copyright 2014 The PDFium Authors")
    const thirdParty = readFileSync(join(extracted, "PDFIUM_THIRD_PARTY_NOTICES"), "utf8")
    expect(thirdParty).toContain("PDFium third-party notices")
    const inventory = thirdParty
      .split("Component inventory and mapping\n\n")[1]!
      .split("\n\nThe sections below")[0]!
      .split("\n")
      .filter((line) => line.startsWith("- "))
    const headings = thirdParty.split("\n").filter((line) => line.startsWith("===== "))
    expect(inventory.length).toBeGreaterThan(20)
    for (const component of inventory) {
      const match = component.match(/\(([^()]*?) section(?:s)?\)|:\s*([^:()]+?) section(?:s)?\.$/)
      const marker = match?.[1] ?? match?.[2]
      if (marker === undefined) {
        expect(component).toMatch(/excluded from the Wasm worker|test-only/)
        continue
      }
      expect(headings.some((heading) => heading.includes(marker))).toBe(true)
    }
    expect(thirdParty).not.toContain("FETCH FAILED")
    const shellNotice = readFileSync(join(extracted, "NOTICE-shell"), "utf8")
    expect(shellNotice).toContain("OpenAI Codex")
    expect(shellNotice).toContain("MIT License")
    expect(shellNotice).toContain("The Ratatui Developers")
    expect(readFileSync(join(extracted, "LICENSE-shell"), "utf8")).toContain("Apache License")
    expect(readFileSync(join(extracted, "LICENSE-codemode"), "utf8")).toContain("Copyright (c) 2025 opencode")
    expect(readFileSync(join(extracted, "LICENSE-pngjs"), "utf8")).toContain("Permission is hereby granted")
    expect(readFileSync(join(extracted, "LICENSE-pdfium-wrapper"), "utf8")).toContain("Permission is hereby granted")
  })

  test("the exact artifact conversion worker renders bounded pages and rejects an unbounded launch", async () => {
    const pdf = readFileSync(join(import.meta.dir, "fixtures/documents/orchard.pdf"))
    const request = JSON.stringify({
      pdf: pdf.toString("base64"),
      window: { offset: 1, limit: 1 },
      geometry: { dpi: 144, maxLongEdge: 200, maxPixelsPerPage: 40_000 },
    })
    const expected = JSON.stringify({ dataBytes: 512 * 1024 ** 2, stackBytes: 8 * 1024 ** 2, cpuSeconds: 20 })
    const unbounded = Bun.spawnSync([binary, "conversion-worker", expected], { stdin: Buffer.from(request), stdout: "pipe", stderr: "pipe" })
    expect(unbounded.exitCode).not.toBe(0)
    expect(unbounded.stderr.toString()).toContain("RLIMIT_DATA")
    const bounded = Bun.spawnSync([
      "/usr/bin/prlimit",
      `--data=${512 * 1024 ** 2}`,
      `--stack=${8 * 1024 ** 2}`,
      "--cpu=20",
      "--core=0",
      "--",
      binary,
      "conversion-worker",
      expected,
    ], { stdin: Buffer.from(request), stdout: "pipe", stderr: "pipe" })
    expect(bounded.stderr.toString()).toBe("")
    expect(bounded.exitCode).toBe(0)
    const result = JSON.parse(bounded.stdout.toString()) as { total: number; pages: Array<{ page: number; png: string; width: number; height: number }> }
    expect(result.total).toBe(2)
    expect(result.pages).toHaveLength(1)
    expect(result.pages[0]).toMatchObject({ page: 1 })
    expect(result.pages[0]!.width * result.pages[0]!.height).toBeLessThanOrEqual(40_000)
    expect(Buffer.from(result.pages[0]!.png, "base64").subarray(1, 4).toString()).toBe("PNG")
    const constrained = Bun.spawnSync([
      "/usr/bin/prlimit",
      `--data=${16 * 1024 ** 2}`,
      `--stack=${8 * 1024 ** 2}`,
      "--cpu=20",
      "--core=0",
      "--",
      binary,
      "conversion-worker",
      JSON.stringify({ dataBytes: 16 * 1024 ** 2, stackBytes: 8 * 1024 ** 2, cpuSeconds: 20 }),
    ], { stdin: Buffer.from(request), stdout: "pipe", stderr: "pipe" })
    expect(constrained.exitCode).not.toBe(0)
  }, 60_000)

  test("the exact artifact contains conversion deadline, output, and queue failures, reaps workers, and keeps serving", async () => {
    const pdf = readFileSync(join(import.meta.dir, "fixtures/documents/orchard.pdf"))
    let response = 0
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(sse(textReply(String(++response), "survived")), {
        headers: { "content-type": "text/event-stream" },
      }),
    })
    const runs: Array<{ run: CliRun; client: Client }> = []
    const connect = async (extraEnv: Record<string, string>) => {
      const run = new CliRun(extraEnv, [binary], `http://127.0.0.1:${api.port}/v1`)
      await run.prepare()
      const token = await run.run(["token", "create", "qualification"])
      expect(token.code).toBe(0)
      const url = await run.serve()
      const client = await Client.connect(url)
      const login = await client.request("auth.authenticate", { token: token.stdout.trim(), protocolVersion: 1 })
      expect(login.error).toBeUndefined()
      return { run, client }
    }
    const uploadPdf = async (run: CliRun, client: Client, draftId: string) => {
      const digest = new Bun.CryptoHasher("sha256").update(pdf).digest("hex")
      const made = await client.request("upload.create", {
        draftId,
        name: "orchard.pdf",
        mediaType: "application/pdf",
        size: pdf.byteLength,
      })
      const uploadId = made.result.upload.uploadId
      await client.request("upload.append", { uploadId, offset: 0, data: pdf.toString("base64") })
      await client.request("upload.finalize", { uploadId, size: pdf.byteLength, digest })
      const db = new Database(run.databasePath, { readonly: true })
      try {
        const row = db.query<{ attachment_id: string }, [string]>(
          "SELECT attachment_id FROM uploads WHERE upload_id = ?",
        ).get(uploadId)!
        return {
          attachmentId: row.attachment_id,
          contentId: digest,
          representationId: digest,
          name: "orchard.pdf",
          mediaType: "application/pdf",
          digest,
        }
      } finally {
        db.close()
      }
    }
    const workers = (pid: number) => {
      const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim()
      if (children === "") return []
      return children.split(/\s+/).filter((child) => {
        try {
          return readFileSync(`/proc/${child}/cmdline`, "utf8").includes("conversion-worker")
        } catch {
          return false
        }
      })
    }
    try {
      for (const [env, expected] of [
        [{ ASHE_AGENT_CONVERSION_WALL_MS: "1" }, "wall deadline"],
        [{ ASHE_AGENT_CONVERSION_OUTPUT_BYTES: "1" }, "output exceeded"],
      ] as const) {
        const made = await connect(env)
        runs.push(made)
        const events: Array<any> = []
        made.client.onNotification = (message) => events.push(message.params.event)
        const created = await made.client.request("session.create", {})
        const sessionId = created.result.session.id
        await made.client.request("session.subscribe", { sessionId })
        const ref = await uploadPdf(made.run, made.client, "conversion-failure")
        await made.client.request("session.input", { sessionId, text: "convert", attachments: [ref] })
        const failure = await waitFor(
          `${expected} failure`,
          () => events.find((event) => event.type === "RUN_ERROR"),
          30_000,
        )
        expect(failure.message).toContain(expected)
        expect(failure.code).toBe("attachment_unsupported")
        await waitFor("the failed conversion worker to be reaped", () => {
          const pid = made.run.serverPids[0]!
          return workers(pid).length === 0 ? true : undefined
        }, 10_000)
        await made.client.request("session.input", { sessionId, text: "survive" })
        await waitFor("the harness to serve after a conversion failure", () =>
          events.some((event) => event.type === "RUN_FINISHED" && event.outcome?.type === "success") ? true : undefined,
        30_000)
        made.client.close()
      }

      const queued = await connect({ ASHE_AGENT_CONVERSION_ACTIVE_WORKERS: "1", ASHE_AGENT_CONVERSION_QUEUED_JOBS: "1" })
      runs.push(queued)
      const events: Array<any> = []
      queued.client.onNotification = (message) => events.push(message.params.event)
      const sessions: Array<{ id: string; ref: Awaited<ReturnType<typeof uploadPdf>> }> = []
      for (let index = 0; index < 12; index += 1) {
        const created = await queued.client.request("session.create", {})
        const id = created.result.session.id
        await queued.client.request("session.subscribe", { sessionId: id })
        sessions.push({ id, ref: await uploadPdf(queued.run, queued.client, `queue-${index}`) })
      }
      await Promise.all(sessions.map(({ id, ref }) =>
        queued.client.request("session.input", { sessionId: id, text: "convert", attachments: [ref] }),
      ))
      await waitFor("a full conversion queue to fail explicitly", () =>
        events.some((event) => event.type === "RUN_ERROR" && event.message.includes("queue is full")) ? true : undefined,
      30_000)
      await waitFor("every queued worker to be reaped", () => {
        const pid = queued.run.serverPids[0]!
        return workers(pid).length === 0 ? true : undefined
      }, 30_000)
      await queued.client.request("session.input", { sessionId: sessions[0]!.id, text: "survive" })
      await waitFor("the harness to serve after queue overflow", () =>
        events.some((event) => event.type === "RUN_FINISHED" && event.outcome?.type === "success") ? true : undefined,
      30_000)
      queued.client.close()
    } finally {
      for (const { run, client } of runs) {
        client.close()
        await run.cleanup()
      }
      api.stop(true)
    }
  }, 120_000)

  test("the exact artifact delivers cross-session submission, subscription, and wait activity", async () => {
    let response = 0
    const bodies: Array<Record<string, any>> = []
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as Record<string, any>
        bodies.push(body)
        const input = body.input as ReadonlyArray<Record<string, any>>
        const toolOutputs = input
          .filter((item) => item.type === "function_call_output")
          .map((item) => JSON.stringify(item.output))
        const reply = toolOutputs.some((output) => output.includes("outcome"))
          ? textReply(String(++response), "observed peer")
          : toolOutputs.some((output) => output.includes("sessionId"))
            ? callReply(String(++response), "session_wait", JSON.stringify({ timeout_ms: 30_000 }))
            : JSON.stringify(body.input).includes("peer work") && !JSON.stringify(body.input).includes("qualify peer")
              ? textReply(String(++response), "peer answer")
              : callReply(String(++response), "session_message", JSON.stringify({
                  text: "peer work",
                  subscribe: { messages: ["agent_final"] },
                }))
        return new Response(sse(reply), { headers: { "content-type": "text/event-stream" } })
      },
    })
    const run = new CliRun({}, [binary], `http://127.0.0.1:${api.port}/v1`)
    let client: Client | null = null
    try {
      await run.prepare()
      const token = await run.run(["token", "create", "qualification"])
      expect(token.code).toBe(0)
      const url = await run.serve()
      client = await Client.connect(url)
      const login = await client.request("auth.authenticate", { token: token.stdout.trim(), protocolVersion: 1 })
      expect(login.error).toBeUndefined()
      const events: Array<any> = []
      client.onNotification = (message) => events.push(message.params.event)
      const caller = (await client.request("session.create", {})).result.session.id
      await client.request("session.subscribe", { sessionId: caller })
      await client.request("session.input", { sessionId: caller, text: "qualify peer" })
      const results = await waitFor("message and wait tool results", () => {
        const names = new Map(
          events
            .filter((event) => event.type === "TOOL_CALL_START")
            .map((event) => [event.toolCallId, event.toolCallName]),
        )
        const values = events
          .filter((event) => event.type === "TOOL_CALL_RESULT")
          .map((event) => {
            try {
              return { name: names.get(event.toolCallId), value: JSON.parse(event.content) }
            } catch {
              return { name: names.get(event.toolCallId), value: event.content }
            }
          })
        const message = values.find(({ name, value }) => name === "session_message" && value?.created === true)
        const wait = values.find(({ name, value }) => name === "session_wait" && value?.outcome !== undefined)
        return message !== undefined && wait !== undefined ? { message, wait } : undefined
      }, 15_000).catch((error) => {
        throw new Error(`${error.message}\nEvents: ${JSON.stringify(events).slice(0, 5_000)}\nRequests: ${JSON.stringify(bodies).slice(0, 5_000)}`)
      })
      expect(results.message.value.sessionId).not.toBe(caller)
      expect(["steering", "wake"]).toContain(results.wait.value.outcome)
      await waitFor("the peer and caller turns to settle", () =>
        events.some((event) => event.type === "RUN_FINISHED" && event.outcome?.type === "success") ? true : undefined,
      60_000,
      )
    } finally {
      client?.close()
      await run.cleanup()
      api.stop(true)
    }
  }, 120_000)

  const sqlite3 = Bun.which("sqlite3")
  test.skipIf(sqlite3 === null)("the official sqlite3 CLI reads the migrated bundle database through the documented bounded queries", async () => {
    const run = new CliRun({}, [binary])
    try {
      await run.prepare()
      const guide = databaseGuide(sqlite3!, run.databasePath)
      expect(guide.available).toBe(true)
      for (const query of guide.queries) {
        expect(query.sql).toContain("LIMIT 100")
        const result = Bun.spawnSync([sqlite3!, "-readonly", run.databasePath, query.sql])
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

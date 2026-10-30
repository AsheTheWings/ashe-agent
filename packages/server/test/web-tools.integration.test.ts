import { afterAll, describe, expect, test } from "bun:test"
import { Redacted } from "effect"
import type { Tool, ToolRun } from "../src/agent/tools.ts"
import type { PermissionCheck } from "../src/permissions/rules.ts"
import { builtinTools } from "../src/tools/builtin.ts"
import { ShellProcesses } from "../src/tools/shell/index.ts"

const KEY = "synthetic-exa-key-for-tests"

type Captured = { readonly path: string; readonly key: string | null; readonly body: Record<string, any> }

/** An Exa API on a loopback port answering each request with the next scripted reply. */
const fakeExa = () => {
  const captured: Array<Captured> = []
  const replies: Array<() => Response> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      captured.push({ path: new URL(request.url).pathname, key: request.headers.get("x-api-key"), body: (await request.json()) as Record<string, any> })
      return (replies.shift() ?? (() => new Response("no reply scripted", { status: 500 })))()
    },
  })
  return { captured, replies, baseUrl: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

const exa = fakeExa()
const processes = new ShellProcesses({ shell: "/bin/sh", envFile: null, env: {}, maxProcesses: 1 })
afterAll(() => {
  exa.stop()
  processes.stopAll()
})

const inputs = { shellYieldMs: 10_000, shellMaxOutputTokens: 10_000, exaBaseUrl: exa.baseUrl }
const served = (exaApiKey: Redacted.Redacted<string> | null) => builtinTools({ ...inputs, exaApiKey }, processes)
const tool = (name: string) => served(Redacted.make(KEY)).find((candidate) => candidate.spec.name === name)!

const checks: Array<PermissionCheck> = []
const call = (tool: Tool, args: unknown) => {
  const run: ToolRun = {
    sessionId: "s",
    runId: "r",
    toolCallId: "c",
    cwd: "/",
    imageInput: false,
    signal: new AbortController().signal,
    authorize: async (check) => {
      checks.push(check)
    },
    started: () => {},
    onCancel: () => {},
  }
  return tool.run(args, run)
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("web tools", () => {
  test("both tools are served exactly when an Exa key is delivered", () => {
    const names = (tools: ReadonlyArray<Tool>) => tools.map((candidate) => candidate.spec.name)
    expect(names(served(null))).not.toContain("web_search")
    expect(names(served(null))).not.toContain("web_fetch")
    expect(names(served(Redacted.make(KEY)))).toEqual(expect.arrayContaining(["web_search", "web_fetch"]))
  })

  test("web_search sends the key, lifts a category, and renders each result", async () => {
    exa.replies.push(
      json({
        results: [
          { title: "Orchards", url: "https://example.test/a", publishedDate: "2026-01-02T00:00:00Z", author: "Ann", highlights: ["apples grow", "pears too"] },
          { url: "https://example.test/b", text: "plain text" },
        ],
      }),
    )
    const result = await call(tool("web_search"), { query: "fruit category:Personal Site growers", numResults: 2 })
    expect(exa.captured.at(-1)).toEqual({
      path: "/search",
      key: KEY,
      body: { query: "fruit growers", type: "auto", numResults: 2, category: "personal site", contents: { highlights: true } },
    })
    const query = "fruit category:Personal Site growers"
    expect(checks.at(-1)).toEqual({ permission: "web", subjects: [query], patterns: [query] })
    expect(result).toEqual({
      outcome: "success",
      content:
        "Title: Orchards\nURL: https://example.test/a\nPublished: 2026-01-02T00:00:00Z\nAuthor: Ann\nHighlights:\napples grow\npears too\n\n---\n\nTitle: N/A\nURL: https://example.test/b\nPublished: N/A\nAuthor: N/A\nText: plain text",
    })
  })

  test("web_fetch posts its URLs, renders each page, and lists a per-URL failure", async () => {
    exa.replies.push(
      json({
        results: [{ title: "Page", url: "https://example.test/a", publishedDate: "2026-01-02T00:00:00Z", text: "Body text" }],
        statuses: [
          { id: "https://example.test/a", status: "success" },
          { id: "https://example.test/gone", status: "error", error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 } },
        ],
      }),
    )
    const result = await call(tool("web_fetch"), { urls: ["https://example.test/a", "https://example.test/gone"] })
    expect(exa.captured.at(-1)).toEqual({
      path: "/contents",
      key: KEY,
      body: { urls: ["https://example.test/a", "https://example.test/gone"], text: { maxCharacters: 3000 } },
    })
    const urls = ["https://example.test/a", "https://example.test/gone"]
    expect(checks.at(-1)).toEqual({ permission: "web", subjects: urls, patterns: urls })
    expect(result).toEqual({
      outcome: "success",
      content: "# Page\nURL: https://example.test/a\nPublished: 2026-01-02\n\nBody text\n\nError fetching https://example.test/gone: CRAWL_NOT_FOUND",
    })
  })

  test("an HTTP error reports its status and Exa's tag, never the key or the request", async () => {
    exa.replies.push(json({ requestId: "q", error: `bad key ${KEY}`, tag: "INVALID_API_KEY" }, 401))
    const result = await call(tool("web_search"), { query: "secret query words" })
    expect(result).toEqual({ outcome: "failed", content: "web_search failed: upstream HTTP 401 (INVALID_API_KEY)" })
    exa.replies.push(() => new Response("oops", { status: 503 }))
    expect(await call(tool("web_fetch"), { urls: ["https://example.test/private?token=abc"] })).toEqual({
      outcome: "failed",
      content: "web_fetch failed: upstream HTTP 503",
    })
  })
})

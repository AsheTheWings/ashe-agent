import { describe, expect, test } from "bun:test"
import type { ToolRun } from "../src/agent/tools.ts"
import { exaClient, webTools, type ExaClient } from "../src/tools/web/index.ts"

const run: ToolRun = {
  sessionId: "s",
  runId: "r",
  toolCallId: "c",
  cwd: "/",
  imageInput: false,
  signal: new AbortController().signal,
  authorize: async () => {},
  started: () => {},
  onCancel: () => {},
  programCall: () => {},
  offered: () => true,
}

describe("web tools", () => {
  test("web_fetch refuses anything but absolute http and https URLs before asking Exa", async () => {
    const posted: Array<unknown> = []
    const exa: ExaClient = { post: async (_path, payload) => (posted.push(payload), { results: [] }) }
    const fetchTool = webTools(exa).find((tool) => tool.spec.name === "web_fetch")!
    for (const urls of [["not a URL"], [""], ["ftp://example.test/a"], ["/relative"], ["https://example.test/ok", "mailto:a@b"]]) {
      const result = await fetchTool.run({ urls }, run)
      expect(result.outcome).toBe("failed")
      expect(result.content).toContain("is not an absolute http or https URL")
    }
    expect(posted).toEqual([])
    expect(await fetchTool.run({ urls: ["https://example.test/ok", "http://example.test/b"] }, run)).toMatchObject({ outcome: "success" })
  })

  test("a response body that fails to arrive is a stable failure, never a thrown error", async () => {
    const broken = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("connection reset with key in message"))
          },
        }),
        { status: 200 },
      )
    const tools = webTools(exaClient("https://exa.test", "synthetic-key", broken as unknown as typeof fetch))
    const search = tools.find((tool) => tool.spec.name === "web_search")!
    expect(await search.run({ query: "anything" }, run)).toEqual({ outcome: "failed", content: "web_search failed: upstream unavailable" })
  })
})

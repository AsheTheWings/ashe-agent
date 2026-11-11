/**
 * A run-owned MCP server for tests. `bun mcp-server.ts stdio <name> <tool>...`
 * serves the tools over stdio; `mcpHandler` serves them over Streamable
 * HTTP. Each tool returns `<name>:<tool>:<arguments as JSON>`, except
 * `env`, which returns `ASHE_AGENT_TEST_SECRET`; `quit`, which exits the process
 * just after answering; `parts`, which returns an image, a resource, and
 * text; `structured`, which returns only structured content; `fail`,
 * which returns an error result; and `stall`, which never answers. `bun mcp-server.ts hang <pid-file>` appends
 * its pid to the file and never answers.
 */
import { appendFileSync } from "node:fs"
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"

/** The results of the tools that do not echo. */
const special: Record<string, () => Record<string, unknown>> = {
  parts: () => ({
    content: [
      { type: "image", data: "aW1n", mimeType: "image/png" },
      { type: "resource", resource: { uri: "file:///r.txt", text: "r" } },
      { type: "text", text: "done" },
    ],
  }),
  structured: () => ({ content: [], structuredContent: { answer: 42 } }),
  fail: () => ({ content: [{ type: "text", text: "it broke" }], isError: true }),
}

const anything = fromJsonSchema<Record<string, unknown>>({ type: "object", properties: { text: { type: "string" } } })

export const testServer = (name: string, tools: ReadonlyArray<string>) => {
  const server = new McpServer({ name, version: "0.0.0" })
  for (const tool of tools) {
    server.registerTool(tool, { description: `The ${tool} tool of ${name}.`, inputSchema: anything }, async (args) => {
      if (tool === "quit") setTimeout(() => process.exit(0), 50)
      if (tool === "stall") return await new Promise<never>(() => {})
      if (special[tool] !== undefined) return special[tool]() as never
      const text = tool === "env" ? (process.env.ASHE_AGENT_TEST_SECRET ?? "unset") : `${name}:${tool}:${JSON.stringify(args)}`
      return { content: [{ type: "text", text }] }
    })
  }
  return server
}

/** The tools over Streamable HTTP; `modernOnly` refuses the 2025 handshake, as a 2026-07-28-only server does. */
export const mcpHandler = (name: string, tools: ReadonlyArray<string>, modernOnly = false) =>
  createMcpHandler(() => testServer(name, tools), modernOnly ? { legacy: "reject" } : {})

if (import.meta.main && process.argv[2] === "stdio") {
  const [name, ...tools] = process.argv.slice(3)
  await testServer(name!, tools).connect(new StdioServerTransport())
}

if (import.meta.main && process.argv[2] === "hang") {
  appendFileSync(process.argv[3]!, `${process.pid}\n`)
  setInterval(() => {}, 1 << 30)
}

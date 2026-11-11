import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Redacted, Schema } from "effect"
import { builtinTool, type Tool } from "../src/agent/tools.ts"
import { AgentRegistry } from "../src/agents/agents.ts"
import { fileSetup } from "../src/agents/setup.ts"
import type { Permission } from "../src/inputs/shapes.ts"
import { builtinTools } from "../src/tools/builtin.ts"
import { executeTool, sessionCodeModeCatalog } from "../src/tools/codemode/execute.ts"
import { ShellProcesses } from "../src/tools/shell/index.ts"
import { AgentHarness, messageText, say } from "./support/agent.ts"

/** A tool of the MCP server `server` as the server registry names it: `<server>_<tool>`, withheld by that name. */
const mcpTool = (server: string, name: string): Tool => ({
  ...builtinTool({
    namespace: server,
    name,
    permission: `${server}_${name}`,
    description: `The ${name} tool of ${server}.`,
    args: Schema.Struct({}),
    run: async () => ({ outcome: "success", content: name }),
  }),
})

const skill = (name: string) => `---\nname: ${name}\ndescription: The ${name} skill\n---\nHow to ${name}.\n`

/**
 * A harness offering the built-in tools, a direct MCP server `docs`, and
 * `execute` over the code mode servers `lib` and `vault`, with the skills
 * `open` and `secret`, under the global rules `permission`.
 */
const withTools = async (permission: Permission, body: (h: AgentHarness) => Promise<void>) => {
  const config = mkdtempSync(join(tmpdir(), "ashe-agent-withheld-"))
  for (const name of ["open", "secret"]) {
    mkdirSync(join(config, "skills", name), { recursive: true })
    writeFileSync(join(config, "skills", name, "SKILL.md"), skill(name))
  }
  // No shell process starts, so the registry needs no shutdown.
  const shell = new ShellProcesses({ shell: "/bin/sh", envFile: null, env: {}, maxProcesses: 4 })
  const builtin = builtinTools(
    { shellYieldMs: 1_000, shellMaxOutputTokens: 1_000, exaBaseUrl: "http://127.0.0.1:9/", exaApiKey: Redacted.make("synthetic"), skillRoots: [] },
    shell,
    (() => Promise.reject(new Error("no network in this test"))) as unknown as typeof fetch,
  )
  const codeMode = [mcpTool("lib", "lookup"), mcpTool("vault", "unseal")]
  const h = new AgentHarness({
    tools: [...builtin, mcpTool("docs", "search"), executeTool(() => codeMode, {})],
    permission,
    setup: fileSetup({
      agents: new AgentRegistry({}, null, join(config, "titles")),
      instructionsFile: join(config, "AGENTS.md"),
      skillRoots: [join(config, "skills")],
      codeMode: sessionCodeModeCatalog(() => codeMode),
    }),
  })
  try {
    await body(h)
  } finally {
    await h.cleanup()
    rmSync(config, { recursive: true, force: true })
  }
}

/** The tools and the first message of the session's one model call. */
const firstCall = async (h: AgentHarness) => {
  const id = h.create()
  h.model.next(say("ok"))
  h.input(id, "hi")
  await h.turnsEnded(id, 1)
  const call = h.model.last()
  return { tools: call.tools.map((tool) => tool.name), first: messageText(call.messages[0]!) }
}

describe("withheld tools", () => {
  test("a wholly denied built-in tool, MCP server, and code mode tool are absent from the tools and the catalog", async () => {
    await withTools({ shell: "deny", "docs_*": "deny", vault_unseal: "deny", web: { "*": "deny", "https://docs.example.com/*": "allow" }, skill: { secret: "deny" } }, async (h) => {
      const { tools, first } = await firstCall(h)
      expect(tools).not.toContain("shell_exec_command")
      expect(tools).not.toContain("docs_search")
      // A later narrower allow keeps web tools offered; a tool without a permission is withheld only by its own name.
      expect(tools).toEqual(expect.arrayContaining(["file_read", "file_patch", "shell_write_stdin", "web_search", "web_fetch", "skill", "execute"]))
      expect(first).toContain("lookup")
      expect(first).not.toContain("unseal")
      expect(first).toContain("- open: The open skill")
      expect(first).not.toContain("secret")
    })
  })

  test("a wholly denied execute is absent with its code mode catalog", async () => {
    await withTools({ execute: "deny" }, async (h) => {
      const { tools, first } = await firstCall(h)
      expect(tools).not.toContain("execute")
      expect(tools).toContain("file_read")
      expect(first).not.toContain("lookup")
    })
  })

  test("a rule denying everything keeps context_append and context_get_open_items, and a denied context_ask_question is absent", async () => {
    await withTools({ "*": "deny" }, async (h) => {
      const { tools } = await firstCall(h)
      expect(tools).toEqual(["context_append", "context_get_open_items"])
    })
    await withTools({ context_ask_question: "deny" }, async (h) => {
      const { tools } = await firstCall(h)
      expect(tools).toEqual(expect.arrayContaining(["context_append", "context_get_open_items", "file_read"]))
      expect(tools).not.toContain("context_ask_question")
    })
    await withTools({}, async (h) => {
      expect((await firstCall(h)).tools).toContain("context_ask_question")
    })
  })
})

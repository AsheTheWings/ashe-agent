import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { AgentRegistry } from "../src/agents/agents.ts"
import { fileSetup } from "../src/agents/setup.ts"

const title = (description: string, body: string) => `---\ndescription: ${description}\n---\n${body}`

/** A run-owned config directory holding the global instructions and a titles directory. */
const withConfig = (body: (config: string) => void) => {
  const config = mkdtempSync(join(tmpdir(), "ashe-agent-titles-"))
  mkdirSync(join(config, "titles"))
  writeFileSync(join(config, "AGENTS.md"), "GLOBAL")
  try {
    body(config)
  } finally {
    rmSync(config, { recursive: true, force: true })
  }
}

describe("title files", () => {
  test("agents.list reports present, absent, and refused title files, ignoring files of no agent", () => {
    withConfig((config) => {
      const titles = join(config, "titles")
      writeFileSync(join(titles, "reviewer.md"), title("Reviews code", "REVIEW"))
      writeFileSync(join(titles, "extra.md"), "---\ndescription: Extra\nmodel: test/alpha\n---\nEXTRA")
      writeFileSync(join(config, "target.md"), title("Linked", "LINKED"))
      symlinkSync(join(config, "target.md"), join(titles, "linked.md"))
      writeFileSync(join(titles, "stray.md"), title("No agent", "STRAY"))
      const agents = { reviewer: { model: "test/alpha" }, plain: {}, extra: {}, linked: {} }
      const setup = fileSetup({
        agents: new AgentRegistry(agents, "reviewer", titles),
        instructionsFile: join(config, "AGENTS.md"),
        skillRoots: [],
      })

      const listed = setup.agents()
      expect(listed.defaultAgent).toBe("reviewer")
      expect(listed.agents).toEqual([
        { key: "reviewer", title: "Reviewer", description: "Reviews code", model: "test/alpha", reasoningEfforts: {}, titleFile: { state: "present" } },
        { key: "plain", title: "Plain", description: null, model: null, reasoningEfforts: {}, titleFile: { state: "absent" } },
        {
          key: "extra",
          title: "Extra",
          description: null,
          model: null,
          reasoningEfforts: {},
          titleFile: { state: "refused", reason: 'its frontmatter holds "model", not only description' },
        },
        { key: "linked", title: "Linked", description: null, model: null, reasoningEfforts: {}, titleFile: { state: "refused", reason: "it is a symlink" } },
      ])
      expect(listed.agents.map((agent) => agent.key)).not.toContain("stray")

      expect(setup.userInstructions(setup.resolve("reviewer"))).toMatchObject({ source: "title", path: join(titles, "reviewer.md"), text: "REVIEW" })
      expect(setup.userInstructions(setup.resolve("plain"))).toMatchObject({ source: "global", path: join(config, "AGENTS.md"), text: "GLOBAL" })
      expect(() => setup.userInstructions(setup.resolve("linked"))).toThrow("it is a symlink")
      expect(() => setup.userInstructions(setup.resolve("extra"))).toThrow('its frontmatter holds "model"')
    })
  })

  test("a FIFO at a title file's path is refused without blocking", () => {
    withConfig((config) => {
      const titles = join(config, "titles")
      const made = Bun.spawnSync(["mkfifo", join(titles, "piped.md")])
      expect(made.exitCode).toBe(0)
      const setup = fileSetup({ agents: new AgentRegistry({ piped: {} }, null, titles), instructionsFile: join(config, "AGENTS.md"), skillRoots: [] })
      expect(setup.agents().agents).toEqual([
        { key: "piped", title: "Piped", description: null, model: null, reasoningEfforts: {}, titleFile: { state: "refused", reason: "it is not a regular file" } },
      ])
      expect(() => setup.userInstructions(setup.resolve("piped"))).toThrow("it is not a regular file")
    })
  })
})

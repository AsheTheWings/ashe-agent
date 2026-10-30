import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionEvent } from "@ashe-agent/protocol"
import { SUMMARY_MAX_TOKENS } from "../src/agent/compaction.ts"
import { skillTool } from "../src/agents/skill-tool.ts"
import { fileSetup } from "../src/agents/setup.ts"
import type { Permission } from "../src/inputs/shapes.ts"
import { ModelCallError } from "../src/agent/model.ts"
import { AgentHarness, agentModels, callTools, failWith, messageText, say, testTools } from "./support/agent.ts"

const skillText = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\nallowed-tools: touch\n---\nHow to ${name}.\n`

/** A harness whose setup reads a config directory of its own, outside the session's working directory. */
const withConfig = async (
  files: Record<string, string>,
  body: (h: AgentHarness, config: string) => Promise<void>,
  permission?: Permission,
) => {
  const config = mkdtempSync(join(tmpdir(), "ashe-agent-config-"))
  const write = (path: string, text: string) => {
    mkdirSync(join(config, path, ".."), { recursive: true })
    writeFileSync(join(config, path), text)
  }
  for (const [path, text] of Object.entries(files)) write(path, text)
  const skills = join(config, "skills")
  const h = new AgentHarness({
    tools: [...testTools(), skillTool([skills])],
    setup: fileSetup({
      agentsDir: join(config, "agents"),
      instructionsFile: join(config, "AGENTS.md"),
      skillRoots: [skills],
      modelIds: new Set(agentModels.map((model) => model.id)),
    }),
    ...(permission === undefined ? {} : { permission }),
  })
  try {
    await body(h, config)
  } finally {
    await h.cleanup()
    rmSync(config, { recursive: true, force: true })
  }
}

const bodies = (events: ReadonlyArray<SessionEvent>) => events.map((event) => event.event as Record<string, any>)
const ofType = (events: ReadonlyArray<SessionEvent>, type: string) => bodies(events).filter((event) => event.type === type)
const firstText = (h: AgentHarness, index = -1) => messageText(h.model.calls.at(index)!.call.messages[0]!)

describe("instructions and skills", () => {
  test("a session gets the global instructions and user skills, never its working directory's AGENTS.md or skills", async () => {
    await withConfig({ "AGENTS.md": "Global rule: be brief.", "skills/brew-tea/SKILL.md": skillText("brew-tea", "Brews tea") }, async (h, config) => {
      writeFileSync(join(h.dir, "AGENTS.md"), "PROJECT RULE")
      mkdirSync(join(h.dir, ".agents", "skills", "project-skill"), { recursive: true })
      writeFileSync(join(h.dir, ".agents", "skills", "project-skill", "SKILL.md"), skillText("project-skill", "PROJECT SKILL"))
      const id = h.create()
      h.model.next(say("ok"))
      h.input(id, "hello")
      await h.turnsEnded(id, 1)
      const all = h.model.last().messages.map(messageText).join("\n")
      expect(firstText(h)).toContain("Global rule: be brief.")
      expect(firstText(h)).toContain(`- brew-tea: Brews tea (${join(config, "skills", "brew-tea")})`)
      expect(firstText(h)).not.toContain("How to brew-tea.")
      expect(all).not.toContain("PROJECT RULE")
      expect(all).not.toContain("PROJECT SKILL")
    })
  })

  test("the skill tool returns a skill's body and directory under the skill permission, and allowed-tools grants nothing", async () => {
    await withConfig(
      { "skills/brew-tea/SKILL.md": skillText("brew-tea", "Brews tea"), "skills/secret/SKILL.md": skillText("secret", "Hidden") },
      async (h, config) => {
        const id = h.create()
        h.model.next(
          callTools([
            { name: "skill", args: { name: "brew-tea" } },
            { name: "skill", args: { name: "nope" } },
            { name: "skill", args: { name: "secret" } },
            { name: "touch", args: { paths: ["x"] } },
          ]),
          say("done"),
        )
        h.input(id, "use skills")
        await h.turnsEnded(id, 1)
        const results = ofType(h.events(id), "TOOL_CALL_RESULT")
        expect(results[0]).toMatchObject({ outcome: "success", content: `Skill directory: ${join(config, "skills", "brew-tea")}\n\nHow to brew-tea.\n` })
        expect(results[1]).toMatchObject({ outcome: "failed", content: "There is no skill named nope." })
        expect(results[2]).toMatchObject({ outcome: "failed", content: expect.stringContaining("denied by configuration") })
        expect(results[3]).toMatchObject({ outcome: "failed", content: expect.stringContaining("denied by configuration") })
      },
      { skill: { "*": "allow", secret: "deny" }, edit: "deny" },
    )
  })
})

describe("agents", () => {
  const helper = (frontmatter: string, body: string) => `---\nmode: primary\n${frontmatter}\n---\n${body}`

  test("an agent's body replaces the global instructions, and its temperature, permission, and body stay as created", async () => {
    await withConfig(
      { "AGENTS.md": "GLOBAL", "agents/helper.md": helper("temperature: 0.25\npermission:\n  edit: deny", "HELPER BODY") },
      async (h, config) => {
        const id = h.create({ agent: "helper" })
        writeFileSync(join(config, "agents", "helper.md"), helper("temperature: 1.5\npermission:\n  edit: allow", "EDITED BODY"))
        h.model.next(callTools([{ name: "touch", args: { paths: ["x"] } }]), say("done"))
        h.input(id, "go")
        await h.turnsEnded(id, 1)
        expect(h.model.calls.map((entry) => entry.call.temperature)).toEqual([0.25, 0.25])
        expect(firstText(h)).toContain("HELPER BODY")
        expect(firstText(h)).not.toContain("GLOBAL")
        expect(firstText(h)).not.toContain("EDITED BODY")
        expect(ofType(h.events(id), "TOOL_CALL_RESULT")[0]).toMatchObject({ outcome: "failed", content: expect.stringContaining("denied by configuration") })
        const plain = h.create()
        h.model.next(say("plain"))
        h.input(plain, "hi")
        await h.turnsEnded(plain, 1)
        expect(h.model.last().temperature).toBeUndefined()
        expect(h.hub.agents().agents).toEqual([{ name: "helper", description: null, mode: "primary", model: null }])
        expect(() => h.create({ agent: "missing" })).toThrow("no valid agent missing")
      },
    )
  })

  test("a turn reaching the agent's steps makes one last call without tools, then ends", async () => {
    await withConfig({ "agents/brief.md": helper("steps: 2", "BRIEF") }, async (h) => {
      const id = h.create({ agent: "brief" })
      h.model.next(callTools([{ name: "echo", args: { text: "one" } }]), callTools([{ name: "echo", args: { text: "two" } }]))
      h.input(id, "go")
      await h.turnsEnded(id, 1)
      expect(h.model.calls).toHaveLength(2)
      expect(h.model.calls[0]!.call.tools.length).toBeGreaterThan(0)
      const last = h.model.calls[1]!.call
      expect(last.tools).toEqual([])
      expect(messageText(last.messages.at(-1)!)).toContain("This turn reached its limit of 2 model calls.")
      const results = ofType(h.events(id), "TOOL_CALL_RESULT")
      expect(results.map((result) => result.outcome)).toEqual(["success", "failed"])
      expect(results[1]!.content).toBe("The turn reached its step limit; this tool call did not run.")
      expect(ofType(h.events(id), "RUN_FINISHED")).toHaveLength(1)
    })
  })

  test("compaction's summary call sends the agent's temperature and counts toward its steps", async () => {
    const big = `t1 ${"y".repeat(100_000)}`
    await withConfig({ "agents/brief.md": helper("temperature: 0.25\nsteps: 2", "BRIEF") }, async (h) => {
      const id = h.create({ agent: "brief" })
      h.model.next(say("r1", { inputTokens: 150_000 }))
      h.input(id, big)
      await h.turnsEnded(id, 1)
      h.model.next(say("SUMMARY"), say("r2"))
      h.input(id, "t2")
      await h.turnsEnded(id, 2)
      const [summary, last] = h.model.calls.slice(1).map(({ call }) => call)
      expect(h.model.calls).toHaveLength(3)
      expect(summary!.maxOutputTokens).toBe(SUMMARY_MAX_TOKENS)
      expect([summary!.temperature, last!.temperature]).toEqual([0.25, 0.25])
      expect(last!.tools).toEqual([])
      expect(messageText(last!.messages.at(-1)!)).toContain("This turn reached its limit of 2 model calls.")
    })
    await withConfig({ "agents/single.md": helper("steps: 1", "SINGLE") }, async (h) => {
      const id = h.create({ agent: "single" })
      h.model.next(say("r1", { inputTokens: 150_000 }))
      h.input(id, big)
      await h.turnsEnded(id, 1)
      h.model.next(say("SUMMARY"))
      h.input(id, "t2")
      await h.turnsEnded(id, 2)
      expect(h.model.calls).toHaveLength(2)
      expect(h.model.calls[1]!.call.maxOutputTokens).toBe(SUMMARY_MAX_TOKENS)
      expect(ofType(h.events(id), "COMPACTED")).toHaveLength(1)
      expect(ofType(h.events(id), "RUN_FINISHED")).toHaveLength(2)
    })
  })

  test("a last allowed call that overflows is retried once after its summary, as the last call", async () => {
    const overflow = new ModelCallError("input is too long", true)
    await withConfig({ "agents/single.md": helper("steps: 1", "SINGLE") }, async (h) => {
      const id = h.create({ agent: "single" })
      h.model.next(failWith(overflow), say("SUMMARY"), say("done"))
      h.input(id, `t1 ${"y".repeat(100_000)}`)
      await h.turnsEnded(id, 1)
      expect(h.model.calls).toHaveLength(3)
      const retry = h.model.calls[2]!.call
      expect(retry.tools).toEqual([])
      expect(messageText(retry.messages.at(-1)!)).toContain("This turn reached its limit of 1 model calls.")
      expect(ofType(h.events(id), "COMPACTED")).toHaveLength(1)
      expect(ofType(h.events(id), "RUN_FINISHED")).toHaveLength(1)
    })
    await withConfig({ "agents/brief.md": helper("steps: 2", "BRIEF") }, async (h) => {
      const id = h.create({ agent: "brief" })
      h.model.next(callTools([{ name: "echo", args: { text: "one" } }]), failWith(overflow), say("SUMMARY"), failWith(overflow))
      h.input(id, `t1 ${"y".repeat(100_000)}`)
      await h.turnsEnded(id, 1)
      expect(h.model.calls).toHaveLength(4)
      expect(h.model.calls[3]!.call.tools).toEqual([])
      expect(ofType(h.events(id), "RUN_ERROR").map((event) => event.code)).toEqual(["context_overflow"])
    })
  })
})

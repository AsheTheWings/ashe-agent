import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionEvent } from "@ashe-agent/protocol"
import { SUMMARY_MAX_TOKENS } from "../src/agent/compaction.ts"
import { AgentRegistry } from "../src/agents/agents.ts"
import { skillTool } from "../src/agents/skill-tool.ts"
import { fileSetup } from "../src/agents/setup.ts"
import type { Agents, Permission } from "../src/inputs/shapes.ts"
import type { ConfiguredModel } from "../src/models/registry.ts"
import { AgentHarness, agentModels, callTools, configuredModel, messageText, say, testTools } from "./support/agent.ts"

const skillText = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\nallowed-tools: touch\n---\nHow to ${name}.\n`

/** A harness whose setup reads a config directory of its own, outside the session's working directory. */
const withConfig = async (
  files: Record<string, string>,
  body: (h: AgentHarness, config: string) => Promise<void>,
  permission?: Permission,
  agents: { readonly agents?: Agents; readonly defaultAgent?: string; readonly models?: ReadonlyArray<ConfiguredModel> } = {},
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
      agents: new AgentRegistry(agents.agents ?? {}, agents.defaultAgent ?? null, join(config, "titles")),
      instructionsFile: join(config, "AGENTS.md"),
      skillRoots: [skills],
    }),
    ...(agents.models === undefined ? {} : { models: agents.models }),
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
  test("a session gets the global instructions and user skills, never its directory's AGENTS.md or skills", async () => {
    await withConfig({ "AGENTS.md": "Global rule: be brief.", "skills/brew-tea/SKILL.md": skillText("brew-tea", "Brews tea") }, async (h, config) => {
      const id = h.create()
      const dir = h.sessionDir(id)
      writeFileSync(join(dir, "AGENTS.md"), "PROJECT RULE")
      mkdirSync(join(dir, ".agents", "skills", "project-skill"), { recursive: true })
      writeFileSync(join(dir, ".agents", "skills", "project-skill", "SKILL.md"), skillText("project-skill", "PROJECT SKILL"))
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
        // The rules wholly deny edit, so the skill's allowed-tools cannot bring touch back.
        expect(results[3]).toMatchObject({ outcome: "failed", content: "There is no tool named touch." })
      },
      { skill: { "*": "allow", secret: "deny" }, edit: "deny" },
    )
  })
})

describe("agents", () => {
  const warm = configuredModel("test/warm", { contextLimit: 200_000, temperatureCapable: true, settings: { temperature: 1 } })
  const title = (description: string, body: string) => `---\ndescription: ${description}\n---\n${body}`

  test("an agent's title file replaces the global instructions, and its overrides and permission stay as created", async () => {
    await withConfig(
      { "AGENTS.md": "GLOBAL", "titles/helper.md": title("Helps", "HELPER BODY") },
      async (h, config) => {
        const id = h.create({ agent: "helper" })
        expect(h.hub.summary(id)).toMatchObject({ agent: "helper", model: warm.id })
        writeFileSync(join(config, "titles", "helper.md"), title("Helps", "EDITED BODY"))
        h.model.next(callTools([{ name: "touch", args: { paths: ["x"] } }]), say("done"))
        h.input(id, "go")
        await h.turnsEnded(id, 1)
        expect(h.model.calls.map((entry) => entry.call.temperature)).toEqual([0.25, 0.25])
        expect(firstText(h)).toContain("HELPER BODY")
        expect(firstText(h)).not.toContain("GLOBAL")
        expect(firstText(h)).not.toContain("EDITED BODY")
        expect(ofType(h.events(id), "TOOL_CALL_RESULT")[0]).toMatchObject({ outcome: "failed", content: expect.stringContaining("denied by configuration") })
        expect(() => h.create({ agent: "missing" })).toThrow("no agent missing")
      },
      undefined,
      { agents: { helper: { model: warm.id, models: { [warm.id]: { temperature: 0.25 } }, permission: { edit: { "*": "deny", kept: "allow" } } } }, models: [agentModels[0]!, warm] },
    )
  })

  test("sessions without an agent run as the default agent, else as the implicit agent with the global instructions", async () => {
    await withConfig(
      { "AGENTS.md": "GLOBAL", "titles/writer.md": title("Writes", "WRITER BODY") },
      async (h) => {
        const id = h.create()
        expect(h.hub.summary(id).agent).toBe("writer")
        h.model.next(say("ok"))
        h.input(id, "hi")
        await h.turnsEnded(id, 1)
        expect(firstText(h)).toContain("WRITER BODY")
      },
      undefined,
      { agents: { writer: {} }, defaultAgent: "writer" },
    )
    await withConfig({ "AGENTS.md": "GLOBAL" }, async (h) => {
      const id = h.create()
      expect(h.hub.summary(id)).toMatchObject({ agent: null, model: agentModels[0]!.id })
      h.model.next(say("ok"))
      h.input(id, "hi")
      await h.turnsEnded(id, 1)
      expect(firstText(h)).toContain("GLOBAL")
      expect(h.model.last().temperature).toBeUndefined()
    }, undefined, { agents: { writer: {} } })
  })

  test("an agent without a title file has the global instructions, and a refused title file fails creation", async () => {
    await withConfig(
      { "AGENTS.md": "GLOBAL", "titles/broken.md": "---\nmode: primary\n---\nBROKEN" },
      async (h) => {
        const id = h.create({ agent: "plain" })
        h.model.next(say("ok"))
        h.input(id, "hi")
        await h.turnsEnded(id, 1)
        expect(firstText(h)).toContain("GLOBAL")
        expect(() => h.create({ agent: "broken" })).toThrow('its frontmatter holds "mode", not only description')
      },
      undefined,
      { agents: { plain: {}, broken: {} } },
    )
  })

  test("compaction's summary call sends the agent's temperature override", async () => {
    await withConfig(
      {},
      async (h) => {
        const id = h.create({ agent: "warm" })
        h.model.next(say("r1", { inputTokens: 150_000 }))
        h.input(id, `t1 ${"y".repeat(100_000)}`)
        await h.turnsEnded(id, 1)
        h.model.next(say("SUMMARY"), say("r2"))
        h.input(id, "t2")
        await h.turnsEnded(id, 2)
        const [summary, next] = h.model.calls.slice(1).map(({ call }) => call)
        expect(h.model.calls).toHaveLength(3)
        expect(summary!.maxOutputTokens).toBe(SUMMARY_MAX_TOKENS)
        expect([summary!.temperature, next!.temperature]).toEqual([0.25, 0.25])
      },
      undefined,
      { agents: { warm: { model: warm.id, models: { [warm.id]: { temperature: 0.25 } } } }, models: [warm] },
    )
  })
})

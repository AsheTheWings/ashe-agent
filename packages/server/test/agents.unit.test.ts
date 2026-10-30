import { describe, expect, test } from "bun:test"
import { parseAgent } from "../src/agents/agents.ts"
import type { ConfigFiles } from "../src/agents/files.ts"
import { fileSetup } from "../src/agents/setup.ts"
import { discoverSkills, parseSkill, skillCatalog } from "../src/agents/skills.ts"

const models = new Set(["alpha/one", "beta/two"])

/** Files held in memory: a path maps to its text, and a directory exists when a path lies under it. */
const memoryFiles = (tree: Record<string, string>): ConfigFiles => {
  const isDirectory = (path: string) => Object.keys(tree).some((file) => file.startsWith(`${path}/`))
  return {
    list: (dir) => {
      if (!isDirectory(dir)) return { kind: "absent" }
      const names = new Set(Object.keys(tree).filter((file) => file.startsWith(`${dir}/`)).map((file) => file.slice(dir.length + 1).split("/")[0]!))
      return { kind: "entries", names: [...names] }
    },
    read: (path) => (tree[path] === undefined ? { kind: "absent" } : tree[path] === "\0unreadable" ? { kind: "error", message: "EACCES" } : { kind: "text", text: tree[path]! }),
    isDirectory,
  }
}

const agent = (frontmatter: string, body = "Agent body.") => parseAgent("helper", "/agents/helper.md", `---\n${frontmatter}\n---\n${body}`, models)
const reason = (frontmatter: string) => {
  const result = agent(frontmatter)
  return result.ok ? null : result.reason
}

describe("agent files", () => {
  test("valid frontmatter gives the agent's settings and its body as instructions", () => {
    const result = agent(
      'description: Helps\nmode: primary\nmodel: beta/two\ntemperature: 0.5\npermission:\n  shell: ask\n  edit: { "*.md": allow }',
      "# Helper\n\nDo things.\n",
    )
    expect(result).toEqual({
      ok: true,
      agent: {
        name: "helper",
        path: "/agents/helper.md",
        description: "Helps",
        mode: "primary",
        model: "beta/two",
        settings: { temperature: 0.5, permission: { shell: "ask", edit: { "*.md": "allow" } } },
        body: "# Helper\n\nDo things.\n",
      },
    })
    expect(parseAgent("plain", "/agents/plain.md", "Only a body.", models)).toMatchObject({ ok: true, agent: { mode: "all", model: null, body: "Only a body." } })
  })

  test("mode, model, and permission are validated", () => {
    expect(reason("mode: helper")).toBe("mode is not primary, subagent, or all")
    expect(reason("model: gamma/three")).toBe("model is not a configured model id")
    expect(reason("permission: { shell: maybe }")).toBe("permission is malformed")
    expect(reason("description: [a]")).toBe("description is not a string")
    expect(reason(": : :")).toStartWith("its frontmatter is not valid YAML")
    expect(parseAgent("x", "/x.md", "---\nmode: all\n", models)).toEqual({ ok: false, reason: "its frontmatter has no closing ---" })
  })

  test("temperature must be a finite number from 0 to 2", () => {
    for (const value of ['"0.5"', ".inf", "-.inf", ".nan", "-0.1", "2.1"]) {
      expect(reason(`temperature: ${value}`)).toBe("temperature is not a finite number from 0 to 2")
    }
    expect(reason("temperature: 0")).toBeNull()
    expect(reason("temperature: 2")).toBeNull()
  })

  test("an agent's body replaces the global instructions, and listing reports refused files", () => {
    const setup = fileSetup({
      agentsDir: "/agents",
      instructionsFile: "/config/AGENTS.md",
      skillRoots: [],
      modelIds: models,
      files: memoryFiles({
        "/config/AGENTS.md": "Global rules.",
        "/agents/helper.md": "---\nmode: primary\ntemperature: 1\n---\nHelper rules.",
        "/agents/sub.md": "---\nmode: subagent\n---\nSub rules.",
        "/agents/bad.md": "---\nmode: helper\n---\n",
      }),
    })
    expect(setup.resolve(null)).toMatchObject({ agent: null, instructions: "Global rules." })
    expect(setup.resolve("helper")).toMatchObject({ agent: "helper", instructions: "Helper rules.", settings: { temperature: 1 } })
    expect(() => setup.resolve("sub")).toThrow("the agent sub is a subagent and cannot run a session")
    expect(() => setup.resolve("bad")).toThrow("no valid agent bad")
    expect(setup.agents!()).toEqual({
      agents: [
        { name: "helper", description: null, mode: "primary", model: null },
        { name: "sub", description: null, mode: "subagent", model: null },
      ],
      refused: [{ path: "/agents/bad.md", reason: "mode is not primary, subagent, or all" }],
    })
  })

  test("an absent global instructions file means none; an unreadable one fails creation", () => {
    const setup = (tree: Record<string, string>) =>
      fileSetup({ agentsDir: "/agents", instructionsFile: "/config/AGENTS.md", skillRoots: [], modelIds: models, files: memoryFiles(tree) })
    expect(setup({}).resolve(null).instructions).toBeNull()
    expect(() => setup({ "/config/AGENTS.md": "\0unreadable" }).resolve(null)).toThrow("the global instructions file /config/AGENTS.md is unreadable")
  })
})

describe("skills", () => {
  const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.`

  test("names follow the Agent Skills rules and equal their directory; descriptions hold 1 to 1024 characters", () => {
    expect(parseSkill("pdf-tools", "/r/pdf-tools", skill("pdf-tools", "Reads PDFs"))).toEqual({
      name: "pdf-tools",
      description: "Reads PDFs",
      dir: "/r/pdf-tools",
      body: "Body of pdf-tools.",
    })
    for (const name of ["PDF", "-pdf", "pdf-", "pd--f", "a_b", "x".repeat(65)]) expect(parseSkill(name, `/r/${name}`, skill(name, "d"))).toBeNull()
    expect(parseSkill("x".repeat(64), "/r/x", skill("x".repeat(64), "d"))).not.toBeNull()
    expect(parseSkill("other", "/r/other", skill("pdf-tools", "d"))).toBeNull()
    expect(parseSkill("a", "/r/a", skill("a", '""'))).toBeNull()
    expect(parseSkill("a", "/r/a", skill("a", "d".repeat(1025)))).toBeNull()
    expect(parseSkill("a", "/r/a", skill("a", "d".repeat(1024)))).not.toBeNull()
  })

  test("the first root wins a duplicate name, and the catalog lists names, descriptions, and directories only", () => {
    const files = memoryFiles({
      "/first/shared/SKILL.md": skill("shared", "From the first root"),
      "/second/shared/SKILL.md": skill("shared", "From the second root"),
      "/second/extra/SKILL.md": skill("extra", "Only in the second"),
      "/second/broken/SKILL.md": skill("Broken", "Bad name"),
    })
    const skills = discoverSkills(["/first", "/missing", "/second"], files)
    expect(skills.map((found) => [found.name, found.dir])).toEqual([
      ["shared", "/first/shared"],
      ["extra", "/second/extra"],
    ])
    expect(skillCatalog(skills)).toBe("- shared: From the first root (/first/shared)\n- extra: Only in the second (/second/extra)")
    expect(skillCatalog([])).toBeNull()
  })
})

import { describe, expect, test } from "bun:test"
import { AgentRegistry } from "../src/agents/agents.ts"
import type { ConfigFiles } from "../src/agents/files.ts"
import { fileSetup } from "../src/agents/setup.ts"
import { discoverSkills, parseSkill, skillCatalog } from "../src/agents/skills.ts"
import { compileRules } from "../src/permissions/rules.ts"

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

  test("the skill catalog leaves out skills the session's rules deny under the skill permission", () => {
    const setup = fileSetup({
      agents: new AgentRegistry({}, null, "/titles"),
      instructionsFile: "/config/AGENTS.md",
      skillRoots: ["/skills"],
      files: memoryFiles({ "/skills/open/SKILL.md": skill("open", "Open"), "/skills/secret/SKILL.md": skill("secret", "Secret") }),
    })
    expect(setup.catalogs([]).skills).toBe("- open: Open (/skills/open)\n- secret: Secret (/skills/secret)")
    expect(setup.catalogs(compileRules({ skill: { secret: "deny" } }, "/")).skills).toBe("- open: Open (/skills/open)")
    expect(setup.catalogs(compileRules({ skill: { "*": "deny", open: "allow" } }, "/")).skills).toBe("- open: Open (/skills/open)")
    expect(setup.catalogs(compileRules({ skill: "deny" }, "/")).skills).toBeNull()
  })
})

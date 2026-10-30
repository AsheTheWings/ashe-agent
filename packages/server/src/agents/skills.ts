import { join } from "node:path"
import { diskFiles, type ConfigFiles } from "./files.ts"
import { parseFrontmatter } from "./frontmatter.ts"

export interface Skill {
  readonly name: string
  readonly description: string
  /** The skill's directory. */
  readonly dir: string
  readonly body: string
}

/** The Agent Skills naming rule: 1 to 64 of `a-z`, `0-9`, and `-`, no leading, trailing, or doubled `-`. */
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * Validates one `SKILL.md` against the Agent Skills specification: `name`
 * must follow the naming rule and equal its directory's name, and
 * `description` must hold 1 to 1024 characters. Returns null for a skill
 * to skip.
 */
export const parseSkill = (dirName: string, dir: string, text: string): Skill | null => {
  const parsed = parseFrontmatter(text)
  if (!parsed.ok) return null
  const { name, description } = parsed.data
  if (typeof name !== "string" || name.length > 64 || !NAME.test(name) || name !== dirName) return null
  if (typeof description !== "string" || description.trim() === "" || description.length > 1024) return null
  return { name, description, dir, body: parsed.body }
}

/**
 * Finds every valid `<root>/<name>/SKILL.md` under the roots in order; a
 * name an earlier root holds is skipped in later ones. Absent or
 * unreadable roots and skills are skipped.
 */
export const discoverSkills = (roots: ReadonlyArray<string>, files: ConfigFiles = diskFiles): ReadonlyArray<Skill> => {
  const found = new Map<string, Skill>()
  for (const root of roots) {
    const listed = files.list(root)
    if (listed.kind !== "entries") continue
    for (const entry of listed.names.toSorted()) {
      if (found.has(entry)) continue
      const dir = join(root, entry)
      if (!files.isDirectory(dir)) continue
      const read = files.read(join(dir, "SKILL.md"))
      if (read.kind !== "text") continue
      const skill = parseSkill(entry, dir, read.text)
      if (skill !== null) found.set(skill.name, skill)
    }
  }
  return [...found.values()]
}

/** The catalog the developer message lists: each skill's name, description, and directory, never its body; null without skills. */
export const skillCatalog = (skills: ReadonlyArray<Skill>): string | null =>
  skills.length === 0 ? null : skills.map((skill) => `- ${skill.name}: ${skill.description.replace(/\s+/g, " ").trim()} (${skill.dir})`).join("\n")

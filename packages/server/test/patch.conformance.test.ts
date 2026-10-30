import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { applyHunks, lexicalPaths, locate, type PatchFiles } from "../src/tools/file/apply.ts"
import { parse } from "../src/tools/file/patch.ts"

const scenarios = join(import.meta.dir, "fixtures/codex-apply-patch/scenarios")

/** Every file under `dir`, by path relative to it, as text. */
const tree = (dir: string, prefix = ""): Map<string, string> => {
  const files = new Map<string, string>()
  let names: Array<string>
  try {
    names = readdirSync(dir)
  } catch {
    return files
  }
  for (const name of names) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) for (const [inner, text] of tree(path, `${prefix}${name}/`)) files.set(inner, text)
    else files.set(`${prefix}${name}`, readFileSync(path, "utf8"))
  }
  return files
}

/** Files in memory under `/work`, so a scenario never writes to disk. */
const memoryFiles = (files: Map<string, string>): PatchFiles => {
  const key = (path: string) => path.slice("/work/".length)
  const kind = async (path: string) => {
    if (files.has(key(path))) return "file" as const
    const dir = `${key(path)}/`
    return [...files.keys()].some((name) => name.startsWith(dir)) ? ("directory" as const) : ("absent" as const)
  }
  return {
    kind,
    entryKind: kind,
    read: async (path) => files.get(key(path))!,
    write: async (path, contents) => void files.set(key(path), contents),
    remove: async (path) => void files.delete(key(path)),
  }
}

describe("Codex apply-patch scenarios", () => {
  const names = readdirSync(scenarios).filter((name) => statSync(join(scenarios, name)).isDirectory())

  test("every vendored scenario is run", () => {
    expect(names.length).toBe(25)
  })

  for (const name of names.sort()) {
    test(name, async () => {
      const files = tree(join(scenarios, name, "input"))
      try {
        await applyHunks(locate(parse(readFileSync(join(scenarios, name, "patch.txt"), "utf8")), lexicalPaths("/work")), memoryFiles(files))
      } catch {
        // Scenarios are specified by their final files only, as Codex's own runner checks them.
      }
      expect(Object.fromEntries([...files].sort())).toEqual(Object.fromEntries([...tree(join(scenarios, name, "expected"))].sort()))
    })
  }
})

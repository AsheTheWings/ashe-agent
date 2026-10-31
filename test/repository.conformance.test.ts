import { describe, expect, test } from "bun:test"
import { Glob } from "bun"
import { join } from "node:path"
import { generatedFiles } from "../scripts/generated-files.ts"
import { migrationFiles } from "../packages/server/src/store/migration-files.ts"

const root = join(import.meta.dir, "..")
const read = (path: string) => Bun.file(join(root, path)).text()
const readJson = async (path: string) => JSON.parse(await read(path)) as Record<string, unknown>

const manifests = async () => {
  const paths = ["package.json"]
  for await (const path of new Glob("packages/*/package.json").scan(root)) paths.push(path)
  return paths.sort()
}

describe("generated files", () => {
  for (const file of generatedFiles()) {
    test(`${file.path} matches its source`, async () => {
      expect(await read(file.path)).toBe(file.content)
    })
  }
})

describe("migrations", () => {
  test("the embedded migration list is the migration directory", async () => {
    const directory: Array<string> = []
    for await (const path of new Glob("*").scan(join(root, "packages/server/migrations"))) directory.push(path)
    expect(migrationFiles.map((file) => file.file)).toEqual(directory.sort())
    for (const file of migrationFiles) {
      expect(file.sql).toBe(await read(`packages/server/migrations/${file.file}`))
    }
  })
})

describe("Bun pin", () => {
  const pinned = "1.4.4"

  test(".bun-version pins Bun", async () => {
    expect((await read(".bun-version")).trim()).toBe(pinned)
  })

  test("the root manifest names the pinned Bun", async () => {
    const manifest = await readJson("package.json")
    expect(manifest.packageManager).toBe(`bun@${pinned}`)
    expect((manifest.devDependencies as Record<string, string>)["@types/bun"]).toBe(pinned)
  })

  test("every workflow takes Bun from .bun-version", async () => {
    const count = (text: string, needle: string) => text.split(needle).length - 1
    for await (const path of new Glob(".github/workflows/*.yml").scan({ cwd: root, dot: true })) {
      const workflow = await read(path)
      expect(workflow).not.toMatch(/bun-version:/)
      expect(count(workflow, "bun-version-file:")).toBe(count(workflow, "bun-version-file: .bun-version"))
      expect(count(workflow, "oven-sh/setup-bun@")).toBe(count(workflow, "bun-version-file: .bun-version"))
    }
  })
})

describe("workflows", () => {
  test("every action is pinned to a full commit SHA", async () => {
    const unpinned: Array<string> = []
    for await (const path of new Glob(".github/workflows/*.yml").scan({ cwd: root, dot: true })) {
      for (const use of (await read(path)).matchAll(/uses:\s*([^\s#]+)/g)) {
        const reference = use[1] ?? ""
        if (reference.startsWith("./")) continue
        if (!/@[0-9a-f]{40}$/.test(reference)) unpinned.push(`${path} ${reference}`)
      }
    }
    expect(unpinned).toEqual([])
  })
})

describe("dotenv", () => {
  test("bunfig.toml turns off .env autoloading", async () => {
    const lines = (await read("bunfig.toml")).split("\n")
    const firstTable = lines.findIndex((line) => line.trimStart().startsWith("["))
    const topLevel = firstTable === -1 ? lines : lines.slice(0, firstTable)
    expect(topLevel).toContain("env = false")
  })

  test("every Vite configuration turns off .env loading", async () => {
    const configs: Array<string> = []
    for (const pattern of ["vite*.config.ts", "packages/*/vite*.config.ts"]) {
      for await (const path of new Glob(pattern).scan(root)) configs.push(path)
    }
    expect(configs.sort()).toEqual(["packages/web/vite.config.ts"])
    for (const path of configs) expect(await read(path)).toMatch(/^\s*envDir: false,$/m)
  })
})

describe("tasks", () => {
  test("every package script runs through the version-checking task runner", async () => {
    const direct: Array<string> = []
    for (const path of await manifests()) {
      const scripts = ((await readJson(path)).scripts ?? {}) as Record<string, string>
      for (const [name, command] of Object.entries(scripts)) {
        if (command !== `bun scripts/task.ts ${name}` || path !== "package.json") direct.push(`${path} ${name}`)
      }
    }
    expect(direct).toEqual([])
  })
})

describe("dependencies", () => {
  test("every dependency names an exact version", async () => {
    const loose: Array<string> = []
    for (const path of await manifests()) {
      const manifest = await readJson(path)
      for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        for (const [name, version] of Object.entries((manifest[field] ?? {}) as Record<string, string>)) {
          if (version.startsWith("workspace:")) continue
          if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) loose.push(`${path} ${field} ${name}@${version}`)
        }
      }
    }
    expect(loose).toEqual([])
  })
})

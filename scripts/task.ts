/**
 * Runs the repository's tasks under the pinned Bun, refusing any other
 * version, and runs tests with an explicit environment allowlist.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const root = join(import.meta.dir, "..")
const pinned = (await Bun.file(join(root, ".bun-version")).text()).trim()

if (Bun.version !== pinned) {
  process.stderr.write(`ashe-agent tasks need Bun ${pinned}; this is Bun ${Bun.version}.\n`)
  process.exit(1)
}

const testClasses = ["unit", "component", "integration", "conformance"] as const
type TestClass = (typeof testClasses)[number]

const run = async (command: ReadonlyArray<string>, env?: Record<string, string>) => {
  const child = Bun.spawn([...command], {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
    ...(env === undefined ? {} : { env }),
  })
  return await child.exited
}

/** The only environment a test process receives: no developer or production inputs. */
const testEnvironment = (home: string): Record<string, string> => ({
  PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
  HOME: home,
  TMPDIR: tmpdir(),
  LANG: "C.UTF-8",
  TZ: "UTC",
})

/**
 * The seed of randomized tests: ASHE_AGENT_TEST_SEED when set, else a new
 * one. It reaches tests as a build-time constant, not as process input.
 */
const testSeed = (): string => {
  const given = process.env.ASHE_AGENT_TEST_SEED
  if (given !== undefined && !/^\d+$/.test(given)) {
    process.stderr.write("ASHE_AGENT_TEST_SEED must be a non-negative integer\n")
    process.exit(1)
  }
  return given ?? String(Math.floor(Math.random() * 2 ** 31))
}

const test = async (testClass: TestClass) => {
  const seed = testSeed()
  process.stdout.write(`\n== ${testClass} tests (seed ${seed}) ==\n`)
  const home = mkdtempSync(join(tmpdir(), "ashe-agent-test-home-"))
  try {
    return await run(
      [process.execPath, "test", "--define", `ASHE_AGENT_TEST_SEED=${JSON.stringify(seed)}`, `.${testClass}.test.ts`],
      testEnvironment(home),
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

const typecheck = async () => {
  process.stdout.write("\n== typecheck ==\n")
  return await run([join(root, "node_modules/.bin/tsc"), "-p", "tsconfig.json"])
}

const tasks: Record<string, () => Promise<number>> = {
  typecheck,
  "test:unit": () => test("unit"),
  "test:conformance": () => test("conformance"),
  generate: () => run([process.execPath, join(root, "scripts/generate.ts")]),
  gate: async () => {
    for (const step of [typecheck, () => test("unit"), () => test("conformance")]) {
      const code = await step()
      if (code !== 0) return code
    }
    return 0
  },
}

const name = process.argv[2] ?? ""
const task = tasks[name]
if (task === undefined) {
  process.stderr.write(`unknown task ${JSON.stringify(name)}; tasks: ${Object.keys(tasks).join(", ")}\n`)
  process.exit(1)
}
process.exit(await task())

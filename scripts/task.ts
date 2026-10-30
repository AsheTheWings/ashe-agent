/**
 * Runs the repository's tasks under the pinned Bun, refusing any other
 * version, and runs tests with an explicit environment allowlist.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
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
    const code = await run(
      [
        process.execPath,
        "test",
        "--define",
        `ASHE_AGENT_TEST_SEED=${JSON.stringify(seed)}`,
        // test:test262 runs it over the corpus it fetches.
        "--path-ignore-patterns=packages/codemode/test/test262.integration.test.ts",
        `.${testClass}.test.ts`,
      ],
      testEnvironment(home),
    )
    if (code !== 0 || testClass !== "integration") return code
    process.stdout.write("\n== integration tests under Vitest ==\n")
    return await run([process.execPath, "--bun", "x", "vitest", "run", "--globals"], testEnvironment(home))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/** Typechecks the workspace, then `packages/codemode` under the compiler options it was written for. */
/**
 * Fetches tc39/test262 at the revision packages/codemode pins, copies its selection into a
 * run-owned corpus, and runs code mode's test262 suite over it.
 */
const test262 = async () => {
  const seed = testSeed()
  process.stdout.write(`\n== code mode test262 (seed ${seed}) ==\n`)
  const codemode = join(root, "packages/codemode")
  const manifest = (await Bun.file(join(codemode, "test/test262/manifest.json")).json()) as { revision: string }
  const run262 = mkdtempSync(join(tmpdir(), "ashe-agent-test262-"))
  const checkout = join(run262, "test262")
  const corpus = join(run262, "corpus")
  mkdirSync(join(run262, "home"))
  const env = testEnvironment(join(run262, "home"))
  try {
    for (const command of [
      ["git", "init", "-q", checkout],
      ["git", "-C", checkout, "fetch", "-q", "--depth", "1", "https://github.com/tc39/test262.git", manifest.revision],
      ["git", "-C", checkout, "-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD"],
      [process.execPath, join(codemode, "script/sync-test262.ts"), checkout, corpus],
    ]) {
      const code = await run(command, env)
      if (code !== 0) return code
    }
    return await run(
      [
        process.execPath,
        "test",
        "--define",
        `ASHE_AGENT_TEST_SEED=${JSON.stringify(seed)}`,
        "--define",
        `ASHE_AGENT_TEST262_DIR=${JSON.stringify(corpus)}`,
        "packages/codemode/test/test262.integration.test.ts",
      ],
      env,
    )
  } finally {
    rmSync(run262, { recursive: true, force: true })
  }
}

const typecheck = async () => {
  process.stdout.write("\n== typecheck ==\n")
  return await run([join(root, "node_modules/.bin/tsc"), "-p", "tsconfig.json"])
}

const tasks: Record<string, () => Promise<number>> = {
  typecheck,
  "test:unit": () => test("unit"),
  "test:component": () => test("component"),
  "test:integration": () => test("integration"),
  "test:conformance": () => test("conformance"),
  "test:test262": test262,
  generate: () => run([process.execPath, join(root, "scripts/generate.ts")]),
  gate: async () => {
    for (const step of [typecheck, () => test("unit"), () => test("component"), () => test("conformance")]) {
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

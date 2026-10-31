/**
 * Runs the repository's tasks under the pinned Bun, refusing any other
 * version, and runs tests with an explicit environment allowlist.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"

const root = join(import.meta.dir, "..")
const pinned = (await Bun.file(join(root, ".bun-version")).text()).trim()

if (Bun.version !== pinned) {
  process.stderr.write(`ashe-agent tasks need Bun ${pinned}; this is Bun ${Bun.version}.\n`)
  process.exit(1)
}

const testClasses = ["unit", "component", "integration", "conformance", "qualification"] as const
type TestClass = (typeof testClasses)[number]

const run = async (command: ReadonlyArray<string>, env?: Record<string, string>, cwd = root) => {
  const child = Bun.spawn([...command], {
    cwd,
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

const test = async (testClass: TestClass, inputs: Record<string, string> = {}) => {
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
      { ...testEnvironment(home), ...inputs },
    )
    if (code !== 0 || testClass !== "integration") return code
    process.stdout.write("\n== integration tests under Vitest ==\n")
    return await run([process.execPath, "--bun", "x", "vitest", "run", "--globals"], testEnvironment(home))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

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

/** Checks the workspace, then the web client's browser sources under their own config. */
const typecheck = async () => {
  process.stdout.write("\n== typecheck ==\n")
  const tsc = join(root, "node_modules/.bin/tsc")
  const code = await run([tsc, "-p", "tsconfig.json"])
  return code !== 0 ? code : await run([tsc, "-p", "packages/web/tsconfig.json"])
}

const git = (...args: Array<string>) => Bun.spawnSync(["git", ...args], { cwd: root }).stdout.toString().trim()

/**
 * The checked-out commit, which builds stamp into what they build; a
 * worktree with changes would build something no commit holds, so it is
 * refused.
 */
const cleanRevision = (): string | null => {
  if (git("status", "--porcelain") !== "") {
    process.stderr.write("builds stamp the commit they are built from; commit or set aside the changes first\n")
    return null
  }
  return git("rev-parse", "HEAD")
}

const dist = join(root, "dist")
const bundleName = "ashe-agent-linux-x64.tar"

/** Builds the web client into `packages/web/dist`, stamping its revision. */
const buildWeb = async () => {
  process.stdout.write("\n== web build ==\n")
  const revision = cleanRevision()
  if (revision === null) return 1
  return await run([process.execPath, join(root, "packages/web/scripts/build.ts"), revision])
}

/** Serves the web client for development on 127.0.0.1, on Vite's port. */
const devWeb = () => run([process.execPath, "--bun", "x", "vite", "--host", "127.0.0.1"], undefined, join(root, "packages/web"))

/** Compiles the server and its commands into one linux-x64 executable at `dist/bin/ashe-agent`. */
const buildBinary = async () => {
  process.stdout.write("\n== binary build ==\n")
  const revision = cleanRevision()
  if (revision === null) return 1
  return await run([
    process.execPath,
    "build",
    "--compile",
    "--target=bun-linux-x64",
    "--define",
    `ASHE_AGENT_REVISION=${JSON.stringify(revision)}`,
    join(root, "packages/server/src/main.ts"),
    "--outfile",
    join(dist, "bundle/bin/ashe-agent"),
  ])
}

/**
 * Builds the binary and the web client and packages them, as `bin/ashe-agent`
 * and `web/`, into `dist/ashe-agent-linux-x64.tar`, with entries in name
 * order, owned by root, and dated at the commit.
 */
const bundle = async () => {
  rmSync(dist, { recursive: true, force: true })
  const built = await steps([buildBinary, buildWeb])
  if (built !== 0) return built
  process.stdout.write("\n== bundle ==\n")
  const staging = join(dist, "bundle")
  cpSync(join(root, "packages/web/dist"), join(staging, "web"), { recursive: true })
  const committed = git("log", "-1", "--format=%ct")
  const tar = ["tar", "--sort=name", "--owner=0", "--group=0", "--numeric-owner", `--mtime=@${committed}`]
  return await run([...tar, "-C", staging, "-cf", join(dist, bundleName), "bin", "web"])
}

/** Qualifies the bundle at the given path, by default the one `bundle` wrote. */
const qualification = async () => {
  const given = process.argv[3] ?? join(dist, bundleName)
  const path = isAbsolute(given) ? given : join(process.cwd(), given)
  if (!existsSync(path)) {
    process.stderr.write(`no bundle at ${path}; run bun run bundle first\n`)
    return 1
  }
  return await test("qualification", { ASHE_AGENT_QUALIFICATION_BUNDLE: path })
}

const steps = async (all: ReadonlyArray<() => Promise<number>>) => {
  for (const step of all) {
    const code = await step()
    if (code !== 0) return code
  }
  return 0
}

/** The fast gate: typecheck, then the unit, component, and conformance tests. */
const gate = () => steps([typecheck, () => test("unit"), () => test("component"), () => test("conformance")])

const tasks: Record<string, () => Promise<number>> = {
  typecheck,
  "test:unit": () => test("unit"),
  "test:component": () => test("component"),
  "test:integration": () => test("integration"),
  "test:conformance": () => test("conformance"),
  "test:test262": test262,
  "dev:web": devWeb,
  "build:web": buildWeb,
  "build:binary": buildBinary,
  bundle,
  "test:qualification": qualification,
  generate: () => run([process.execPath, join(root, "scripts/generate.ts")]),
  gate,
  /** The gate a release needs: the fast gate, then the bundle built and qualified. */
  "release-gate": () => steps([gate, bundle, qualification]),
}

const name = process.argv[2] ?? ""
const task = tasks[name]
if (task === undefined) {
  process.stderr.write(`unknown task ${JSON.stringify(name)}; tasks: ${Object.keys(tasks).join(", ")}\n`)
  process.exit(1)
}
process.exit(await task())

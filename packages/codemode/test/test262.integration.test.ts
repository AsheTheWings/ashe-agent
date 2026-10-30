/*
 * Runs the test262 files that `bun run test:test262` copies into its run's corpus directory (see
 * test/test262/README.md) verbatim. Files listed in test/test262/skipped.txt fail on a known
 * interpreter gap and are skipped. Licensed under test/LICENSE.test262.
 */
import { expect, test } from "bun:test"
import { corpus, run, skipped } from "./test262/run.js"

if (corpus === undefined) throw new Error("no test262 corpus; run `bun run test:test262`")
const files = [...new Bun.Glob("**/*.js").scanSync({ cwd: corpus })].sort()

test("the corpus holds the synced test262 files", () => {
  expect(files.length).toBeGreaterThan(10_000)
})

for (const file of files) {
  const define = skipped.has(file) ? test.skip : test
  define(
    file,
    async () => {
      const outcome = await run(file)
      if (outcome.status === "fail") throw new Error(outcome.reason)
    },
    10_000,
  )
}

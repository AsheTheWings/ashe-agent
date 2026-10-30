/**
 * Builds the web client for production into `packages/web/dist`, with the
 * commit revision given as the only argument written to `revision.txt` at
 * the build's root.
 */
import { join } from "node:path"
import { build, type Plugin } from "vite"

const revision = process.argv[2] ?? ""
if (!/^[0-9a-f]{40}$/.test(revision)) {
  process.stderr.write("usage: build.ts <40-character commit revision>\n")
  process.exit(1)
}

const revisionFile: Plugin = {
  name: "ashe-agent-revision",
  apply: "build",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "revision.txt", source: `${revision}\n` })
  },
}

const root = join(import.meta.dir, "..")
await build({ root, configFile: join(root, "vite.config.ts"), plugins: [revisionFile], logLevel: "warn" })

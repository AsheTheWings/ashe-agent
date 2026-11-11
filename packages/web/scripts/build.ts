/**
 * Builds the web client for production into `packages/web/dist`, with the
 * commit revision given as the only argument written to `revision.txt` at
 * the build's root.
 */
import { cpSync, mkdirSync, rmSync } from "node:fs"
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

// The backend and its migrations ship beside the client assets in the same
// revision-stamped directory; neither reads the other's sources.
mkdirSync(join(root, "dist/bin"), { recursive: true })
cpSync(join(root, "migrations"), join(root, "dist/migrations"), { recursive: true })
cpSync(join(root, "NOTICE-t3"), join(root, "dist/NOTICE-t3"))
const compiled = Bun.spawnSync([
  process.execPath,
  "build",
  "--compile",
  "--target=bun-linux-x64",
  "--define",
  `ASHE_AGENT_REVISION=${JSON.stringify(revision)}`,
  join(root, "src/backend/main.ts"),
  "--outfile",
  join(root, "dist/bin/ashe-agent-web"),
], { stdout: "inherit", stderr: "inherit" })
if (compiled.exitCode !== 0) {
  rmSync(join(root, "dist"), { recursive: true, force: true })
  process.exit(compiled.exitCode)
}

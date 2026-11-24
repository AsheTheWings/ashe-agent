/**
 * Builds the browser client assets into `packages/web/dist` for running the
 * web backend directly from a source worktree, without compiling the backend
 * binary or requiring a clean commit.
 */
import { join } from "node:path"
import { build } from "vite"

const root = join(import.meta.dir, "..")
await build({ root, configFile: join(root, "vite.config.ts"), logLevel: "warn" })

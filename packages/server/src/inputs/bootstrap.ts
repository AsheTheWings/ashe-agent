import { readFileSync, statSync } from "node:fs"
import type { Dirs, Process } from "./catalog.ts"
import { resolveInputs, type FileRead, type Inputs, type Sources } from "./resolve.ts"
import type { Profile } from "./shapes.ts"

const readFile = (path: string): FileRead => {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return { kind: "error", message: "not a regular file" }
    return { kind: "ok", text: readFileSync(path, "utf8"), mode: stat.mode & 0o777 }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { kind: "absent" }
    return { kind: "error", message: code ?? "read failed" }
  }
}

const absoluteOr = (value: string | undefined, fallback: string) =>
  value !== undefined && value.startsWith("/") ? value : fallback

/** The XDG base directories, with their fallbacks under the home directory. */
export const platformDirs = (env: Readonly<Record<string, string | undefined>>): Dirs => {
  const home = env.HOME ?? "/"
  return {
    home,
    configHome: absoluteOr(env.XDG_CONFIG_HOME, `${home}/.config`),
    stateHome: absoluteOr(env.XDG_STATE_HOME, `${home}/.local/state`),
  }
}

export const processSources = (): Sources => ({
  env: process.env,
  dirs: platformDirs(process.env),
  readFile,
})

/**
 * The entry point's first step: resolve and validate the process's inputs,
 * or print each problem and exit before any other work.
 */
export const loadInputsOrExit = <P extends Process>(
  name: P,
  sources: Sources = processSources(),
): { readonly profile: Profile; readonly inputs: Inputs<P> } => {
  const resolution = resolveInputs(name, sources)
  if (resolution.ok) return resolution
  const lines = resolution.issues.map((issue) => `  ${issue.input}: ${issue.problem}`)
  process.stderr.write(`ashe-agent: invalid inputs\n${lines.join("\n")}\n`)
  process.exit(2)
}

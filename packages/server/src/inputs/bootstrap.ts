import { readFileSync, statSync } from "node:fs"
import type { Dirs, Process } from "./catalog.ts"
import { resolveInputs, type FileRead, type Inputs, type Sources } from "./resolve.ts"
import type { Profile } from "./shapes.ts"

/** Reads a file with its permission bits, as protected files need. */
export const readDiskFile = (path: string): FileRead => {
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
  readFile: readDiskFile,
})

/** Prefixes of process variables that the model and graph libraries read as their own configuration. */
const dependencyVariable = /^(OPENAI|LANGCHAIN|LANGSMITH|LANGGRAPH|LC)_/

/**
 * Removes from `env` every variable the model and graph libraries would read
 * as configuration, such as `OPENAI_BASE_URL` or `LANGSMITH_TRACING`, so
 * only the declared inputs configure the server. Returns the removed names.
 */
export const removeDependencyVariables = (env: Record<string, string | undefined>): ReadonlyArray<string> => {
  const removed = Object.keys(env).filter((name) => dependencyVariable.test(name))
  for (const name of removed) delete env[name]
  return removed
}

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

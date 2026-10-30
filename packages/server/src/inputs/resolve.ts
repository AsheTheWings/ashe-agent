import { Redacted, Result, Schema } from "effect"
import {
  catalog,
  type Catalog,
  type ConfigurationInput,
  type Dirs,
  type Input,
  type InputKey,
  type Process,
  type ProtectedInput,
} from "./catalog.ts"
import type { Profile } from "./shapes.ts"

/** What reading a file found. `mode` is the file's permission bits. */
export type FileRead =
  | { readonly kind: "absent" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ok"; readonly text: string; readonly mode: number }

/** Everything the resolver reads, so it stays free of the filesystem and process state. */
export interface Sources {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly dirs: Dirs
  readonly readFile: (path: string) => FileRead
}

/** One problem with one input, named by its process input or config key; never its value. */
export interface InputIssue {
  readonly input: string
  readonly problem: string
}

type ValueOf<I> =
  I extends ProtectedInput<Schema.Top>
    ? Redacted.Redacted<string> | null
    : I extends ConfigurationInput<infer S>
      ? S["Type"]
      : never

type UsedBy<P extends Process> = {
  [K in InputKey]: P extends Catalog[K]["processes"][number] ? K : never
}[InputKey]

/** The typed inputs one process receives. */
export type Inputs<P extends Process> = { readonly [K in UsedBy<P>]: ValueOf<Catalog[K]> }

export type Resolution<P extends Process> =
  | { readonly ok: true; readonly profile: Profile; readonly inputs: Inputs<P> }
  | { readonly ok: false; readonly issues: ReadonlyArray<InputIssue> }

const entries = Object.entries(catalog) as ReadonlyArray<[InputKey, Input]>

const decode = (schema: Schema.Top, value: unknown): Result.Result<unknown, string> => {
  const result = Schema.decodeUnknownResult(schema as Schema.Codec<unknown, unknown>)(value, {
    errors: "all",
    onExcessProperty: "error",
  })
  return Result.isSuccess(result) ? Result.succeed(result.success) : Result.fail(result.failure.message)
}

const fromProcessInput = (input: ConfigurationInput<Schema.Top>, raw: string): Result.Result<unknown, string> => {
  if (input.codec === "string") return Result.succeed(raw)
  try {
    return Result.succeed(JSON.parse(raw))
  } catch {
    return Result.fail("must be JSON")
  }
}

/** The input a config file key names, if it is one the file may set. */
const configFileProblem = (key: string): string | undefined => {
  const input = (catalog as Record<string, Input>)[key]
  if (input === undefined) return "is not an input"
  if (input.class === "protected") return "is protected and is read only from its file"
  if (!input.configFile) return "cannot be set by the config file"
  return undefined
}

const readConfigFile = (
  path: string,
  sources: Sources,
  issues: Array<InputIssue>,
): Readonly<Record<string, unknown>> => {
  const read = sources.readFile(path)
  if (read.kind === "absent") return {}
  if (read.kind === "error") {
    issues.push({ input: catalog.configFile.env, problem: `config file is unreadable: ${read.message}` })
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(read.text)
  } catch {
    issues.push({ input: catalog.configFile.env, problem: "config file is not valid JSON" })
    return {}
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    issues.push({ input: catalog.configFile.env, problem: "config file must hold a JSON object" })
    return {}
  }
  const config = parsed as Record<string, unknown>
  for (const key of Object.keys(config)) {
    const problem = configFileProblem(key)
    if (problem !== undefined) issues.push({ input: `config file key ${JSON.stringify(key)}`, problem })
  }
  return config
}

/**
 * Reads a protected file: its bytes, redacted, or the problem that refuses
 * it. A file its group or others can access is refused.
 */
export const readProtectedFile = (
  path: string,
  readFile: Sources["readFile"],
): Result.Result<Redacted.Redacted<string>, string> => {
  const read = readFile(path)
  if (read.kind === "absent") return Result.fail("names a file that does not exist")
  if (read.kind === "error") return Result.fail(`names an unreadable file: ${read.message}`)
  if ((read.mode & 0o077) !== 0) return Result.fail("names a file that its group or others can access")
  return Result.succeed(Redacted.make(read.text))
}

/** The default every profile shares, used when no valid profile selects one. */
const sharedDefault = (input: ConfigurationInput<Schema.Top>, dirs: Dirs): Result.Result<unknown, undefined> => {
  const development = input.defaults.development
  const production = input.defaults.production
  if (development === undefined || production === undefined) return Result.fail(undefined)
  const value = development(dirs)
  return JSON.stringify(value) === JSON.stringify(production(dirs)) ? Result.succeed(value) : Result.fail(undefined)
}

/**
 * Merges schema defaults, the config file, protected files, and process
 * input, lowest first, and validates the inputs the process uses for the
 * selected profile. Every problem is reported, never a value. Without a
 * valid profile, every layer is still validated, but an input falls back
 * only to a default all profiles share, and no input is reported missing.
 */
export const resolveInputs = <P extends Process>(process: P, sources: Sources): Resolution<P> => {
  const issues: Array<InputIssue> = []

  const rawProfile = sources.env[catalog.profile.env]
  const profileResult =
    rawProfile === undefined ? Result.fail("is required") : decode(catalog.profile.schema, rawProfile)
  const profile = Result.isSuccess(profileResult) ? (profileResult.success as Profile) : undefined
  if (Result.isFailure(profileResult)) issues.push({ input: catalog.profile.env, problem: profileResult.failure })

  const values: Record<string, unknown> = { profile }
  const configuration = (key: InputKey, input: ConfigurationInput<Schema.Top>, config: Readonly<Record<string, unknown>>) => {
    const raw = sources.env[input.env]
    let candidate: Result.Result<unknown, string>
    if (raw !== undefined) candidate = fromProcessInput(input, raw)
    else if (input.configFile && Object.hasOwn(config, key)) candidate = Result.succeed(config[key])
    else if (profile === undefined) {
      const shared = sharedDefault(input, sources.dirs)
      if (Result.isFailure(shared)) return
      candidate = Result.succeed(shared.success)
    } else {
      const fallback = input.defaults[profile]
      candidate = fallback === undefined ? Result.fail(`is required in the ${profile} profile`) : Result.succeed(fallback(sources.dirs))
    }
    const decoded = Result.flatMap(candidate, (value) => decode(input.schema, value))
    if (Result.isFailure(decoded)) issues.push({ input: input.env, problem: decoded.failure })
    else values[key] = decoded.success
  }

  configuration("configFile", catalog.configFile, {})
  const configPath = values.configFile
  const config = typeof configPath === "string" ? readConfigFile(configPath, sources, issues) : {}

  for (const [key, input] of entries) {
    if (key === "profile" || key === "configFile") continue
    if (input.class !== "configuration" || !input.processes.includes(process)) continue
    configuration(key, input, config)
  }

  for (const [key, input] of entries) {
    if (input.class !== "protected" || !input.processes.includes(process)) continue
    const fileInput = catalog[input.file as InputKey] as ConfigurationInput<Schema.Top>
    if (!Object.hasOwn(values, input.file)) continue
    const path = values[input.file]
    if (path === null) {
      values[key] = null
      continue
    }
    const read = readProtectedFile(path as string, sources.readFile)
    if (Result.isFailure(read)) issues.push({ input: fileInput.env, problem: read.failure })
    else values[key] = read.success
  }

  if (issues.length > 0 || profile === undefined) return { ok: false, issues }
  return { ok: true, profile, inputs: values as unknown as Inputs<P> }
}

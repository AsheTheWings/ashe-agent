import { Schema } from "effect"
import { catalog, type ConfigurationInput, type Dirs, type Input } from "./catalog.ts"

/** Path defaults shown by the variables they come from, so no machine's paths are written. */
const symbolicDirs: Dirs = {
  home: "$HOME",
  configHome: "$XDG_CONFIG_HOME",
  stateHome: "$XDG_STATE_HOME",
  cacheHome: "$XDG_CACHE_HOME",
}

const encodeForProcessInput = (input: ConfigurationInput<Schema.Top>, value: unknown) =>
  input.codec === "string" && typeof value === "string" ? value : JSON.stringify(value)

const configurationInputs = (): ReadonlyArray<[string, ConfigurationInput<Schema.Top>]> =>
  (Object.entries(catalog) as ReadonlyArray<[string, Input]>).filter(
    (entry): entry is [string, ConfigurationInput<Schema.Top>] => entry[1].class === "configuration",
  )

/**
 * The tracked `.env`: every process input with its development default, for
 * reading only. No process or tool loads it.
 */
export const renderDotEnv = (): string => {
  const lines = [
    "# Generated from packages/server/src/inputs/catalog.ts by `bun run generate`; do not edit.",
    "# Development defaults of every process input, for reading only: no process or tool loads this file.",
    "# An input shown as `# NAME=` has no development default and is required where its process uses it.",
    "# An input shown as `# NAME= (optional)` is unset by default and may stay unset.",
  ]
  for (const [, input] of configurationInputs()) {
    lines.push("")
    lines.push(`# ${input.description} Used by: ${input.processes.join(", ")}.`)
    const fallback = input.defaults.development
    if (fallback === undefined) lines.push(`# ${input.env}=`)
    else {
      const value = fallback(symbolicDirs)
      lines.push(value === null ? `# ${input.env}= (optional)` : `${input.env}=${encodeForProcessInput(input, value)}`)
    }
  }
  const protectedInputs = (Object.values(catalog) as ReadonlyArray<Input>).filter(
    (input) => input.class === "protected",
  )
  lines.push("")
  lines.push("# Protected inputs are read only from the files their path inputs name:")
  for (const input of protectedInputs) {
    if (input.class !== "protected") continue
    const pathInput = (catalog as Record<string, Input>)[input.file] as ConfigurationInput<Schema.Top>
    lines.push(`#   ${input.description} File: ${pathInput.env}.`)
  }
  return `${lines.join("\n")}\n`
}

/** The config file's schema: every input the file may set, as an optional key. */
const configFileInputs = () => configurationInputs().filter(([, input]) => input.configFile)

export const ConfigFile = Schema.Struct(
  Object.fromEntries(
    configFileInputs().map(([key, input]) => [key, Schema.optionalKey(input.schema)]),
  ) as Record<string, Schema.optionalKey<Schema.Top>>,
)

/** The tracked JSON Schema of the config file. */
export const renderConfigJsonSchema = (): string => {
  const document = Schema.toJsonSchemaDocument(ConfigFile, { onExcessProperty: "error" })
  const properties = (document.schema as { properties?: Record<string, Record<string, unknown>> }).properties ?? {}
  for (const [key, input] of configFileInputs()) {
    const property = properties[key]
    if (property !== undefined) property.description = input.description
  }
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "ashe-agent config file",
    ...document.schema,
    ...(Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {}),
  }
  return `${JSON.stringify(schema, null, 2)}\n`
}

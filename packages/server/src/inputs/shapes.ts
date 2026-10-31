import { Schema } from "effect"
import { TITLE_MAX_LENGTH } from "../context/constants.ts"

/** An absolute filesystem path. */
export const AbsolutePath = Schema.String.check(
  Schema.isStartingWith("/", { message: "must be an absolute path" }),
)

/** An `http:` or `https:` URL. */
export const HttpUrl = Schema.String.check(
  Schema.isPattern(/^https?:\/\//, { message: "must be an http or https URL" }),
  Schema.makeFilter((value: string) => {
    if (!URL.canParse(value)) return "must be a URL"
    const { protocol } = new URL(value)
    return protocol === "http:" || protocol === "https:" || "must use http or https"
  }),
)

/** A browser origin such as `https://example.com:8443`, with no path. */
export const Origin = Schema.String.check(
  Schema.isPattern(/^https?:\/\/[^/?#]+$/, { message: "must be an origin" }),
  Schema.makeFilter((value: string) => {
    if (!URL.canParse(value)) return "must be an origin"
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return "must use http or https"
    return url.origin === value || "must be an origin without path, query, or trailing slash"
  }),
)

export const Port = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 }))

export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export const PermissionAction = Schema.Literals(["allow", "ask", "deny"])

/**
 * opencode's permission shape: one action for everything, or a map from
 * permission name to an action or to a map from pattern to action.
 */
export const Permission = Schema.Union([
  PermissionAction,
  Schema.Record(
    Schema.String,
    Schema.Union([PermissionAction, Schema.Record(Schema.String, PermissionAction)]),
  ),
])

export type Permission = typeof Permission.Type

/** Tool namespaces the server's built-in tools own. */
export const RESERVED_NAMESPACES = ["web", "file", "shell", "context"] as const

const McpStdioServer = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: Schema.NonEmptyString,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  envFile: Schema.optionalKey(AbsolutePath),
  codemode: Schema.optionalKey(Schema.Literal(false)),
})

const McpHttpServer = Schema.Struct({
  type: Schema.Literal("http"),
  url: HttpUrl,
  headersFile: Schema.optionalKey(AbsolutePath),
  codemode: Schema.optionalKey(Schema.Literal(false)),
})

export const McpServers = Schema.Record(
  Schema.NonEmptyString,
  Schema.Union([McpStdioServer, McpHttpServer]),
).check(
  Schema.makeFilter((servers: Readonly<Record<string, unknown>>) => {
    const reserved = Object.keys(servers).filter((name) =>
      (RESERVED_NAMESPACES as ReadonlyArray<string>).includes(name),
    )
    return reserved.length === 0 || `uses the reserved name ${JSON.stringify(reserved[0])}`
  }),
)

export type McpServers = typeof McpServers.Type

export const CodeModeLimits = Schema.Struct({
  wallClockMs: Schema.optionalKey(PositiveInt),
  toolCalls: Schema.optionalKey(PositiveInt),
  outputBytes: Schema.optionalKey(PositiveInt),
})

export const Profile = Schema.Literals(["development", "production"])

export type Profile = typeof Profile.Type

export const ExporterSelection = Schema.Literals(["otlp", "console", "none"])

export const OtlpProtocol = Schema.Literals(["http/protobuf", "http/json"])

const unique = (what: string) =>
  Schema.makeFilter((values: ReadonlyArray<string>) => new Set(values).size === values.length || `repeats a ${what}`)

const nonEmpty = Schema.makeFilter((values: ReadonlyArray<unknown>) => values.length > 0 || "must not be empty")

/** A sampling temperature from 0 to 2. */
export const Temperature = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 2 }, { message: "must be a number from 0 to 2" }))

/** A model's own settings, which agents may override. */
const settingsFields = {
  checkpointWindowSize: Schema.optionalKey(PositiveInt),
  temperature: Schema.optionalKey(Temperature),
  reasoningEffort: Schema.optionalKey(Schema.NonEmptyString),
}

/** A model of a provider: its capabilities, an optional display name, and its settings. */
export const ModelEntry = Schema.Struct({
  name: Schema.optionalKey(Schema.NonEmptyString),
  limit: Schema.Struct({ context: PositiveInt }),
  capabilities: Schema.Struct({
    input: Schema.Array(Schema.Literals(["text", "image"])).check(nonEmpty, unique("input kind")),
    temperature: Schema.optionalKey(Schema.Boolean),
    reasoning: Schema.optionalKey(
      Schema.Struct({ efforts: Schema.Array(Schema.NonEmptyString).check(nonEmpty, unique("reasoning effort")) }),
    ),
  }),
  ...settingsFields,
})

export type ModelEntry = typeof ModelEntry.Type

/**
 * A record whose keys must each pass `valid`; a key that fails is named
 * with `rule`. Checking the keys on the whole record names the key and the
 * rule, where a refined key schema reports the key as an excess property.
 */
const keyedRecord = <S extends Schema.Top>(value: S, valid: (key: string) => boolean, rule: string) =>
  Schema.Record(Schema.String, value).check(
    Schema.makeFilter((record: Readonly<Record<string, unknown>>) => {
      const bad = Object.keys(record).find((key) => !valid(key))
      return bad === undefined || `the key ${JSON.stringify(bad)} ${rule}`
    }),
  )

/** Whether `id` is a provider id: one that a model id can name before its first `/`. */
const isProviderId = (id: string) => id.length > 0 && !id.includes("/")

/** One OpenAI Responses endpoint, its protected API key file, and its models by upstream model id. */
export const Provider = Schema.Struct({
  baseURL: HttpUrl,
  apiKeyFile: AbsolutePath,
  models: Schema.Record(Schema.NonEmptyString, ModelEntry),
})

export const Providers = keyedRecord(Provider, isProviderId, "must be a non-empty provider id that does not hold /")

export type Providers = typeof Providers.Type

/** A model id, `<provider>/<model>`. */
export const ModelId = Schema.String.check(
  Schema.isPattern(/^[^/]+\/.+$/, { message: "must be a <provider>/<model> id" }),
)

/** An agent's overrides of one model's settings; its capabilities stay the model entry's. */
export const ModelOverrides = Schema.Struct(settingsFields)

export type ModelOverrides = typeof ModelOverrides.Type

/** An agent, by its title: its starting model, its overrides by model id, and its permission rules. */
export const AgentEntry = Schema.Struct({
  model: Schema.optionalKey(ModelId),
  models: Schema.optionalKey(Schema.Record(ModelId, ModelOverrides)),
  permission: Schema.optionalKey(Permission),
})

export type AgentEntry = typeof AgentEntry.Type

/** The title rule, as skill names have it: words of `a-z` and `0-9` joined by single dashes. */
export const TITLE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** Whether `key` is a title: 1 to 64 characters of `a-z` and `0-9` words joined by single dashes. */
export const isTitle = (key: string) => key.length <= TITLE_MAX_LENGTH && TITLE_PATTERN.test(key)

export const Agents = keyedRecord(
  AgentEntry,
  isTitle,
  `must be a title: 1 to ${TITLE_MAX_LENGTH} characters of a-z and 0-9 words joined by single dashes`,
)

export type Agents = typeof Agents.Type

export const AuxiliaryModels = Schema.Struct({
  handoff: Schema.optionalKey(ModelId),
  compaction: Schema.optionalKey(ModelId),
  research: Schema.optionalKey(ModelId),
})

export type AuxiliaryModels = typeof AuxiliaryModels.Type

/** The tasks an auxiliary model can serve. */
export type AuxiliaryTask = keyof AuxiliaryModels

/** An IANA time zone name the runtime knows. */
export const TimeZone = Schema.NonEmptyString.check(
  Schema.makeFilter((value: string) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value })
      return true
    } catch {
      return "must be an IANA time zone name"
    }
  }),
)

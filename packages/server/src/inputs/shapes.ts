import { Schema } from "effect"

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

/** The smallest context window a configured model may declare. */
export const MIN_CONTEXT_WINDOW = 200_000

/** The most of any model's context window the server uses. */
export const MAX_USABLE_CONTEXT_WINDOW = 480_000

export const Model = Schema.Struct({
  id: Schema.NonEmptyString,
  contextWindow: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(MIN_CONTEXT_WINDOW, {
      message: `must be at least ${MIN_CONTEXT_WINDOW} tokens`,
    }),
  ),
  imageInput: Schema.Boolean,
})

export type Model = typeof Model.Type

export const Models = Schema.Array(Model).check(
  Schema.makeFilter((models: ReadonlyArray<Model>) => {
    if (models.length === 0) return "must list at least one model"
    const seen = new Set<string>()
    for (const model of models) {
      if (seen.has(model.id)) return `repeats the model id ${JSON.stringify(model.id)}`
      seen.add(model.id)
    }
    return true
  }),
)

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

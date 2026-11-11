import { Schema } from "effect"
import { UNTITLED_AGENT_TITLE } from "@ashe-agent/protocol"
import {
  AbsolutePath,
  Agents,
  AuxiliaryModels,
  CodeModeLimits,
  ExporterSelection,
  HttpUrl,
  McpServers,
  ModelId,
  Origin,
  OtlpProtocol,
  Permission,
  Port,
  PositiveInt,
  Profile,
  Providers,
  TimeZone,
  ToolTimeoutOverrides,
  WebSocketUrl,
} from "./shapes.ts"

/** The processes an entry point can start; each validates only its own inputs. */
export type Process = "serve" | "migrate" | "db" | "token" | "devWeb" | "webServe" | "webMigrate" | "webDb"

/** Platform directories that path defaults are built from. */
export interface Dirs {
  readonly home: string
  readonly configHome: string
  readonly stateHome: string
  readonly cacheHome: string
}

interface Base<S extends Schema.Top> {
  readonly description: string
  readonly schema: S
  readonly processes: ReadonlyArray<Process>
}

/** A value an operator chooses; it may be set by every layer it allows. */
export interface ConfigurationInput<S extends Schema.Top> extends Base<S> {
  readonly class: "configuration"
  /** The process input naming this input. */
  readonly env: string
  /** `json` inputs carry JSON in process input; `string` inputs carry raw text. */
  readonly codec: "string" | "json"
  /** Whether the config file may set it. */
  readonly configFile: boolean
  readonly defaults: { readonly [P in Profile]?: (dirs: Dirs) => S["Type"] }
}

/** A value that grants access; it is read only from the file another input names. */
export interface ProtectedInput<S extends Schema.Top> extends Base<S> {
  readonly class: "protected"
  /** Key of the configuration input that holds this value's file path. */
  readonly file: string
}

export type Input = ConfigurationInput<Schema.Top> | ProtectedInput<Schema.Top>

const all: ReadonlyArray<Process> = ["serve", "migrate", "db", "token", "devWeb", "webServe", "webMigrate", "webDb"]
const withState: ReadonlyArray<Process> = ["serve", "migrate", "db", "token"]
const serve: ReadonlyArray<Process> = ["serve"]
const web: ReadonlyArray<Process> = ["webServe"]
const withWebState: ReadonlyArray<Process> = ["webServe", "webMigrate", "webDb"]
const serveAndWeb: ReadonlyArray<Process> = ["serve", "webServe"]

const configuration = <S extends Schema.Top>(
  input: Omit<ConfigurationInput<S>, "class" | "configFile"> & { readonly configFile?: boolean },
): ConfigurationInput<S> => ({ class: "configuration", configFile: true, ...input })

const both = <A>(value: (dirs: Dirs) => A) => ({ development: value, production: value })

const NullablePath = Schema.NullOr(AbsolutePath)
const MiB = 1024 ** 2

/**
 * Every input of every layer. The config file uses the keys; process input
 * uses `env`. Defaults apply per profile, and an input without a default for
 * the selected profile is required.
 */
export const catalog = {
  profile: configuration({
    description: "Profile selecting the defaults: development or production. It has no default.",
    env: "ASHE_AGENT_PROFILE",
    codec: "string",
    schema: Profile,
    configFile: false,
    processes: all,
    defaults: {},
  }),
  configFile: configuration({
    description: "Path of the JSON config file, an overlay layer of these inputs.",
    env: "ASHE_AGENT_CONFIG_FILE",
    codec: "string",
    schema: AbsolutePath,
    configFile: false,
    processes: all,
    defaults: both((dirs) => `${dirs.configHome}/ashe-agent/config.json`),
  }),
  stateDir: configuration({
    description: "Directory holding the server's database and other state.",
    env: "ASHE_AGENT_STATE_DIR",
    codec: "string",
    schema: AbsolutePath,
    processes: withState,
    defaults: both((dirs) => `${dirs.stateHome}/ashe-agent`),
  }),
  listenHost: configuration({
    description: "Address the WebSocket server listens on.",
    env: "ASHE_AGENT_LISTEN_HOST",
    codec: "string",
    schema: Schema.NonEmptyString,
    processes: serve,
    defaults: both(() => "127.0.0.1"),
  }),
  listenPort: configuration({
    description: "Port the WebSocket server listens on; 0 picks a free port.",
    env: "ASHE_AGENT_LISTEN_PORT",
    codec: "json",
    schema: Port,
    processes: serve,
    defaults: { development: () => 7420 },
  }),
  providers: configuration({
    description:
      "OpenAI Responses endpoints by provider id, each with its base URL, the protected file of its API key, and its models by upstream model id.",
    env: "ASHE_AGENT_PROVIDERS",
    codec: "json",
    schema: Providers,
    processes: serve,
    defaults: {},
  }),
  defaultModel: configuration({
    description: "The <provider>/<model> id sessions start with when neither the request nor the agent names a model.",
    env: "ASHE_AGENT_DEFAULT_MODEL",
    codec: "string",
    schema: ModelId,
    processes: serve,
    defaults: {},
  }),
  auxiliaryModels: configuration({
    description: "Optional <provider>/<model> ids for the handoff, compaction, and research tasks.",
    env: "ASHE_AGENT_AUXILIARY_MODELS",
    codec: "json",
    schema: AuxiliaryModels,
    processes: serve,
    defaults: both(() => ({})),
  }),
  origins: configuration({
    description: "Browser origins allowed to open a WebSocket connection.",
    env: "ASHE_AGENT_ORIGINS",
    codec: "json",
    schema: Schema.Array(Origin),
    processes: serve,
    defaults: { development: () => ["http://127.0.0.1:5173"] },
  }),
  githubClientId: configuration({
    description: "Client ID of the GitHub OAuth app the owner signs in through.",
    env: "ASHE_AGENT_GITHUB_CLIENT_ID",
    codec: "string",
    schema: Schema.NonEmptyString,
    processes: serve,
    defaults: {},
  }),
  githubClientSecretFile: configuration({
    description: "Path of the protected file holding the GitHub OAuth app's client secret.",
    env: "ASHE_AGENT_GITHUB_CLIENT_SECRET_FILE",
    codec: "string",
    schema: AbsolutePath,
    processes: serve,
    defaults: {},
  }),
  githubClientSecret: {
    class: "protected",
    description: "Client secret of the GitHub OAuth app.",
    file: "githubClientSecretFile",
    schema: Schema.String,
    processes: serve,
  } satisfies ProtectedInput<typeof Schema.String>,
  githubCallbackUrl: configuration({
    description: "The server's sign-in callback URL, <server origin>/v1/auth/github/callback, as the OAuth app registers it.",
    env: "ASHE_AGENT_GITHUB_CALLBACK_URL",
    codec: "string",
    schema: HttpUrl,
    processes: serve,
    defaults: {},
  }),
  githubOwnerId: configuration({
    description: "Numeric GitHub user ID of the owner, the only account that signs in.",
    env: "ASHE_AGENT_GITHUB_OWNER_ID",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: {},
  }),
  githubUrl: configuration({
    description: "Base URL of GitHub's authorize and token endpoints.",
    env: "ASHE_AGENT_GITHUB_URL",
    codec: "string",
    schema: HttpUrl,
    processes: serve,
    defaults: both(() => "https://github.com"),
  }),
  githubApiUrl: configuration({
    description: "Base URL of GitHub's REST API.",
    env: "ASHE_AGENT_GITHUB_API_URL",
    codec: "string",
    schema: HttpUrl,
    processes: serve,
    defaults: both(() => "https://api.github.com"),
  }),
  devWebAllowedHosts: configuration({
    description: "Host names the development web server answers besides its loopback address.",
    env: "ASHE_AGENT_DEV_WEB_ALLOWED_HOSTS",
    codec: "json",
    schema: Schema.Array(Schema.NonEmptyString),
    processes: ["devWeb"],
    defaults: both(() => []),
  }),
  devWebServerUrl: configuration({
    description: "WebSocket endpoint the development web client connects to.",
    env: "ASHE_AGENT_DEV_WEB_SERVER_URL",
    codec: "string",
    schema: WebSocketUrl,
    processes: ["devWeb"],
    defaults: { development: () => "ws://127.0.0.1:7420/v1/ws" },
  }),
  permission: configuration({
    description: "Permission rules in opencode's shape; a tool call no rule matches is allowed.",
    env: "ASHE_AGENT_PERMISSION",
    codec: "json",
    schema: Permission,
    processes: serve,
    defaults: both(() => ({})),
  }),
  shellEnvFile: configuration({
    description: "Optional script every shell command sources before it runs.",
    env: "ASHE_AGENT_SHELL_ENV_FILE",
    codec: "string",
    schema: NullablePath,
    processes: serve,
    defaults: both(() => null),
  }),
  shellYieldMs: configuration({
    description: "Milliseconds a shell command runs before it yields, unless its call says otherwise.",
    env: "ASHE_AGENT_SHELL_YIELD_MS",
    codec: "json",
    schema: Schema.Int.check(Schema.isBetween({ minimum: 250, maximum: 30_000 })),
    processes: serve,
    defaults: both(() => 10_000),
  }),
  shellMaxOutputTokens: configuration({
    description: "Estimated tokens a shell result holds, unless its call says otherwise.",
    env: "ASHE_AGENT_SHELL_MAX_OUTPUT_TOKENS",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 10_000),
  }),
  shellMaxProcesses: configuration({
    description: "Shell processes a session holds at most.",
    env: "ASHE_AGENT_SHELL_MAX_PROCESSES",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 64),
  }),
  instructionsFile: configuration({
    description: "Global instructions file, the user instructions of sessions whose agent has no title file.",
    env: "ASHE_AGENT_INSTRUCTIONS_FILE",
    codec: "string",
    schema: AbsolutePath,
    processes: serve,
    defaults: both((dirs) => `${dirs.configHome}/ashe-agent/AGENTS.md`),
  }),
  agents: configuration({
    description: "Agents by title, each with an optional starting model, per-model setting overrides, and permission rules; the key untitled is reserved.",
    env: "ASHE_AGENT_AGENTS",
    codec: "json",
    schema: Agents,
    processes: serve,
    defaults: both(() => ({})),
  }),
  defaultAgent: configuration({
    description: "Optional title of the agent sessions created without one run as; the synthetic untitled title is not configurable.",
    env: "ASHE_AGENT_DEFAULT_AGENT",
    codec: "string",
    schema: Schema.NullOr(
      Schema.NonEmptyString.check(
        Schema.makeFilter((value: string) =>
          value === UNTITLED_AGENT_TITLE ? "must not be the reserved untitled title" : true,
        ),
      ),
    ),
    processes: serve,
    defaults: both(() => null),
  }),
  titlesDir: configuration({
    description: "Directory of title files, <title>.md, holding each agent's description and user instructions.",
    env: "ASHE_AGENT_TITLES_DIR",
    codec: "string",
    schema: AbsolutePath,
    processes: serve,
    defaults: both((dirs) => `${dirs.configHome}/ashe-agent/titles`),
  }),
  scratchRoot: configuration({
    description: "Directory holding each session's scratch directory, for reproducible and disposable files.",
    env: "ASHE_AGENT_SCRATCH_ROOT",
    codec: "string",
    schema: AbsolutePath,
    processes: serve,
    defaults: both((dirs) => `${dirs.cacheHome}/ashe-agent/scratch`),
  }),
  userTimeZone: configuration({
    description: "The user's IANA time zone, in which session facts give the user's date.",
    env: "ASHE_AGENT_USER_TIME_ZONE",
    codec: "string",
    schema: TimeZone,
    processes: serve,
    defaults: { development: () => "UTC" },
  }),
  skillRoots: configuration({
    description: "Directories searched for skills, the first winning a duplicate name.",
    env: "ASHE_AGENT_SKILL_ROOTS",
    codec: "json",
    schema: Schema.Array(AbsolutePath),
    processes: serve,
    defaults: both((dirs) => [`${dirs.home}/.agents/skills`, `${dirs.configHome}/ashe-agent/skills`]),
  }),
  mcpServers: configuration({
    description: "MCP servers by name: stdio commands or Streamable HTTP URLs.",
    env: "ASHE_AGENT_MCP_SERVERS",
    codec: "json",
    schema: McpServers,
    processes: serve,
    defaults: both(() => ({})),
  }),
  codeModeLimits: configuration({
    description: "Optional limits on a code mode program's tool calls and output bytes.",
    env: "ASHE_AGENT_CODE_MODE_LIMITS",
    codec: "json",
    schema: CodeModeLimits,
    processes: serve,
    defaults: both(() => ({})),
  }),
  contentMaxOriginalBytes: configuration({
    description: "Largest submitted original file the harness accepts.",
    env: "ASHE_AGENT_CONTENT_MAX_ORIGINAL_BYTES",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 32 * MiB),
  }),
  contentMaxImageBytes: configuration({
    description: "Largest submitted image original the harness accepts.",
    env: "ASHE_AGENT_CONTENT_MAX_IMAGE_BYTES",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 20 * MiB),
  }),
  contentMaxAttachments: configuration({
    description: "Most attachments one submission may hold.",
    env: "ASHE_AGENT_CONTENT_MAX_ATTACHMENTS",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 10),
  }),
  contentMaxSubmissionBytes: configuration({
    description: "Largest combined original bytes one submission may hold.",
    env: "ASHE_AGENT_CONTENT_MAX_SUBMISSION_BYTES",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 128 * MiB),
  }),
  contentCollectionBytes: configuration({
    description: "Bytes a tool producer may collect before recording capture loss.",
    env: "ASHE_AGENT_CONTENT_COLLECTION_BYTES",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => MiB),
  }),
  contentPreviewLines: configuration({
    description: "Lines of oversized retained text a model observation includes.",
    env: "ASHE_AGENT_CONTENT_PREVIEW_LINES",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 2_000),
  }),
  contentPreviewBytes: configuration({
    description: "Bytes of oversized retained text a model observation includes.",
    env: "ASHE_AGENT_CONTENT_PREVIEW_BYTES",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 50 * 1024),
  }),
  contentPdfPagesPerWindow: configuration({
    description: "Most PDF pages one fallback model observation includes.",
    env: "ASHE_AGENT_CONTENT_PDF_PAGES_PER_WINDOW",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 8),
  }),
  contentPdfDpi: configuration({
    description: "Dots per inch used to render fallback PDF pages.",
    env: "ASHE_AGENT_CONTENT_PDF_DPI",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 144),
  }),
  contentPdfMaxLongEdge: configuration({
    description: "Longest pixel edge of one rendered PDF page.",
    env: "ASHE_AGENT_CONTENT_PDF_MAX_LONG_EDGE",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 2_048),
  }),
  contentPdfMaxPixelsPerPage: configuration({
    description: "Most pixels one rendered PDF page may allocate.",
    env: "ASHE_AGENT_CONTENT_PDF_MAX_PIXELS_PER_PAGE",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 4_194_304),
  }),
  contentPdfDocumentTokens: configuration({
    description: "Estimated token allowance for one native PDF contribution.",
    env: "ASHE_AGENT_CONTENT_PDF_DOCUMENT_TOKENS",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 2_000),
  }),
  contentImageTokens: configuration({
    description: "Estimated token allowance for one model-facing image.",
    env: "ASHE_AGENT_CONTENT_IMAGE_TOKENS",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 1_500),
  }),
  contentUploadQuotaBytes: configuration({
    description: "Unclaimed upload staging bytes allowed for one owner.",
    env: "ASHE_AGENT_CONTENT_UPLOAD_QUOTA_BYTES",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 512 * MiB),
  }),
  contentUploadExpiryMs: configuration({
    description: "Milliseconds after creation that unclaimed upload staging expires.",
    env: "ASHE_AGENT_CONTENT_UPLOAD_EXPIRY_MS",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 24 * 60 * 60 * 1_000),
  }),
  contentUploadChunkBytes: configuration({
    description: "Largest bytes one upload append may send.",
    env: "ASHE_AGENT_CONTENT_UPLOAD_CHUNK_BYTES",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => MiB),
  }),
  conversionPrlimitPath: configuration({
    description: "util-linux prlimit executable that launches conversion workers.",
    env: "ASHE_AGENT_CONVERSION_PRLIMIT_PATH",
    codec: "string",
    schema: AbsolutePath,
    processes: serve,
    defaults: both(() => "/usr/bin/prlimit"),
  }),
  conversionDataLimitBytes: configuration({
    description: "RLIMIT_DATA private-allocation ceiling for one conversion worker.",
    env: "ASHE_AGENT_CONVERSION_DATA_LIMIT_BYTES",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 512 * MiB),
  }),
  conversionStackLimitBytes: configuration({
    description: "RLIMIT_STACK ceiling for one conversion worker.",
    env: "ASHE_AGENT_CONVERSION_STACK_LIMIT_BYTES",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 8 * MiB),
  }),
  conversionCpuSeconds: configuration({
    description: "RLIMIT_CPU seconds for one conversion worker.",
    env: "ASHE_AGENT_CONVERSION_CPU_SECONDS",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 20),
  }),
  conversionWallMs: configuration({
    description: "Milliseconds after launch when the parent terminates a conversion worker.",
    env: "ASHE_AGENT_CONVERSION_WALL_MS",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 30_000),
  }),
  conversionOutputBytes: configuration({
    description: "Largest result bytes one conversion worker may return.",
    env: "ASHE_AGENT_CONVERSION_OUTPUT_BYTES",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 128 * MiB),
  }),
  conversionActiveWorkers: configuration({
    description: "Conversion workers the harness runs concurrently.",
    env: "ASHE_AGENT_CONVERSION_ACTIVE_WORKERS",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 2),
  }),
  conversionQueuedJobs: configuration({
    description: "Reference-only conversion jobs the harness queues.",
    env: "ASHE_AGENT_CONVERSION_QUEUED_JOBS",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 16),
  }),
  communicationWaitMinMs: configuration({
    description: "Shortest accepted session wait, in milliseconds; shorter requests clamp.",
    env: "ASHE_AGENT_COMMUNICATION_WAIT_MIN_MS",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 10_000),
  }),
  communicationWaitDefaultMs: configuration({
    description: "session.wait timeout when the call omits one, in milliseconds.",
    env: "ASHE_AGENT_COMMUNICATION_WAIT_DEFAULT_MS",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 30_000),
  }),
  communicationWaitMaxMs: configuration({
    description: "Longest accepted session wait, in milliseconds; longer requests fail.",
    env: "ASHE_AGENT_COMMUNICATION_WAIT_MAX_MS",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 3_600_000),
  }),
  sqlite3Path: configuration({
    description: "Official sqlite3 executable used for bounded read-only session discovery.",
    env: "ASHE_AGENT_SQLITE3_PATH",
    codec: "string",
    schema: AbsolutePath,
    processes: serve,
    defaults: both(() => "/usr/bin/sqlite3"),
  }),
  toolTimeoutMs: configuration({
    description: "Elapsed milliseconds one tool invocation may take, including validation, permission waits, and effects.",
    env: "ASHE_AGENT_TOOL_TIMEOUT_MS",
    codec: "json",
    schema: PositiveInt,
    processes: serve,
    defaults: both(() => 300_000),
  }),
  toolTimeoutOverrides: configuration({
    description: "Elapsed-time limits by exact registered tool name; null disables a tool's local limit.",
    env: "ASHE_AGENT_TOOL_TIMEOUT_OVERRIDES",
    codec: "json",
    schema: ToolTimeoutOverrides,
    processes: serve,
    defaults: both(() => ({})),
  }),
  exaBaseUrl: configuration({
    description: "Base URL of the Exa API behind the web tools.",
    env: "ASHE_AGENT_EXA_BASE_URL",
    codec: "string",
    schema: HttpUrl,
    processes: serve,
    defaults: both(() => "https://api.exa.ai"),
  }),
  exaApiKeyFile: configuration({
    description: "Optional path of the protected file holding the Exa API key; without it the web tools are off.",
    env: "ASHE_AGENT_EXA_API_KEY_FILE",
    codec: "string",
    schema: NullablePath,
    processes: serve,
    defaults: both(() => null),
  }),
  exaApiKey: {
    class: "protected",
    description: "API key sent to Exa as x-api-key.",
    file: "exaApiKeyFile",
    schema: Schema.String,
    processes: serve,
  } satisfies ProtectedInput<typeof Schema.String>,
  tracesExporter: configuration({
    description: "Trace exporter: otlp, console, or none.",
    env: "OTEL_TRACES_EXPORTER",
    codec: "string",
    schema: ExporterSelection,
    processes: serveAndWeb,
    defaults: both(() => "otlp" as const),
  }),
  metricsExporter: configuration({
    description: "Metric exporter: otlp, console, or none.",
    env: "OTEL_METRICS_EXPORTER",
    codec: "string",
    schema: ExporterSelection,
    processes: serveAndWeb,
    defaults: both(() => "otlp" as const),
  }),
  logsExporter: configuration({
    description: "Log exporter: otlp, console, or none.",
    env: "OTEL_LOGS_EXPORTER",
    codec: "string",
    schema: ExporterSelection,
    processes: serveAndWeb,
    defaults: both(() => "otlp" as const),
  }),
  otlpEndpoint: configuration({
    description: "OTLP endpoint the otlp exporters send to.",
    env: "OTEL_EXPORTER_OTLP_ENDPOINT",
    codec: "string",
    schema: HttpUrl,
    processes: serveAndWeb,
    defaults: { development: () => "http://127.0.0.1:4318" },
  }),
  otlpProtocol: configuration({
    description: "OTLP transport protocol.",
    env: "OTEL_EXPORTER_OTLP_PROTOCOL",
    codec: "string",
    schema: OtlpProtocol,
    processes: serveAndWeb,
    defaults: both(() => "http/protobuf" as const),
  }),
  otlpHeadersFile: configuration({
    description: "Optional path of the protected file holding OTLP export headers as key=value pairs.",
    env: "ASHE_AGENT_OTLP_HEADERS_FILE",
    codec: "string",
    schema: NullablePath,
    processes: serveAndWeb,
    defaults: both(() => null),
  }),
  otlpHeaders: {
    class: "protected",
    description: "OTLP export headers, which may carry credentials.",
    file: "otlpHeadersFile",
    schema: Schema.String,
    processes: serveAndWeb,
  } satisfies ProtectedInput<typeof Schema.String>,
  deploymentEnvironment: configuration({
    description: "Value of the deployment.environment.name telemetry attribute.",
    env: "ASHE_AGENT_DEPLOYMENT_ENVIRONMENT",
    codec: "string",
    schema: Schema.NonEmptyString,
    processes: serveAndWeb,
    defaults: { development: () => "development" },
  }),
  webStateDir: configuration({
    description: "Directory holding the built-in web application's SQLite state and dumps.",
    env: "ASHE_AGENT_WEB_STATE_DIR",
    codec: "string",
    schema: AbsolutePath,
    processes: withWebState,
    defaults: both((dirs) => `${dirs.stateHome}/ashe-agent/web`),
  }),
  webListenHost: configuration({
    description: "Address the built-in web backend listens on.",
    env: "ASHE_AGENT_WEB_LISTEN_HOST",
    codec: "string",
    schema: Schema.NonEmptyString,
    processes: web,
    defaults: both(() => "127.0.0.1"),
  }),
  webListenPort: configuration({
    description: "Port the built-in web backend listens on; 0 picks a free port.",
    env: "ASHE_AGENT_WEB_LISTEN_PORT",
    codec: "json",
    schema: Port,
    processes: web,
    defaults: { development: () => 7430 },
  }),
  webHarnessUrl: configuration({
    description: "WebSocket URL of the harness whose sessions the web backend observes and validates credentials against.",
    env: "ASHE_AGENT_WEB_HARNESS_URL",
    codec: "string",
    schema: WebSocketUrl,
    processes: web,
    defaults: { development: () => "ws://127.0.0.1:7420/v1/ws" },
  }),
  webOrigins: configuration({
    description: "Browser origins allowed to use the built-in web backend.",
    env: "ASHE_AGENT_WEB_ORIGINS",
    codec: "json",
    schema: Schema.Array(Origin),
    processes: web,
    defaults: { development: () => ["http://127.0.0.1:5173", "http://127.0.0.1:7430"] },
  }),
  webObserverCredentialFile: configuration({
    description: "Path of the protected file holding the harness credential the web backend observes with.",
    env: "ASHE_AGENT_WEB_OBSERVER_CREDENTIAL_FILE",
    codec: "string",
    schema: NullablePath,
    processes: web,
    defaults: both(() => null),
  }),
  webObserverCredential: {
    class: "protected",
    description: "Harness credential used by the web backend's observer connection.",
    file: "webObserverCredentialFile",
    schema: Schema.String,
    processes: web,
  } satisfies ProtectedInput<typeof Schema.String>,
  webAssetsDir: configuration({
    description: "Root of the immutable built browser assets the web backend serves.",
    env: "ASHE_AGENT_WEB_ASSETS_DIR",
    codec: "string",
    schema: NullablePath,
    processes: web,
    defaults: both(() => null),
  }),
  webMigrationsDir: configuration({
    description: "Directory of the web backend's ordered SQLite migrations.",
    env: "ASHE_AGENT_WEB_MIGRATIONS_DIR",
    codec: "string",
    schema: NullablePath,
    processes: withWebState,
    defaults: both(() => null),
  }),
  webInactivityDays: configuration({
    description: "Days without observed work before the web inbox files an unpinned session; 0 disables filing.",
    env: "ASHE_AGENT_WEB_INACTIVITY_DAYS",
    codec: "json",
    schema: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3650 })),
    processes: web,
    defaults: both(() => 3),
  }),
} as const satisfies Record<string, Input>

export type Catalog = typeof catalog
export type InputKey = keyof Catalog

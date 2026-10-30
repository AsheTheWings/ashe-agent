import { Schema } from "effect"
import {
  AbsolutePath,
  CodeModeLimits,
  ExporterSelection,
  HttpUrl,
  McpServers,
  Models,
  Origin,
  OtlpProtocol,
  Permission,
  Port,
  PositiveInt,
  Profile,
} from "./shapes.ts"

/** The processes an entry point can start; each validates only its own inputs. */
export type Process = "serve" | "migrate" | "db" | "owner" | "token"

/** Platform directories that path defaults are built from. */
export interface Dirs {
  readonly home: string
  readonly configHome: string
  readonly stateHome: string
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

const all: ReadonlyArray<Process> = ["serve", "migrate", "db", "owner", "token"]
const serve: ReadonlyArray<Process> = ["serve"]

const configuration = <S extends Schema.Top>(
  input: Omit<ConfigurationInput<S>, "class" | "configFile"> & { readonly configFile?: boolean },
): ConfigurationInput<S> => ({ class: "configuration", configFile: true, ...input })

const both = <A>(value: (dirs: Dirs) => A) => ({ development: value, production: value })

const NullablePath = Schema.NullOr(AbsolutePath)

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
    processes: all,
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
  modelBaseUrl: configuration({
    description: "Base URL of the OpenAI Responses API the model calls go to.",
    env: "ASHE_AGENT_MODEL_BASE_URL",
    codec: "string",
    schema: HttpUrl,
    processes: serve,
    defaults: { development: () => "http://127.0.0.1:8317/v1" },
  }),
  modelApiKeyFile: configuration({
    description: "Path of the protected file holding the model API key.",
    env: "ASHE_AGENT_MODEL_API_KEY_FILE",
    codec: "string",
    schema: AbsolutePath,
    processes: serve,
    defaults: {},
  }),
  modelApiKey: {
    class: "protected",
    description: "API key sent to the model endpoint.",
    file: "modelApiKeyFile",
    schema: Schema.String,
    processes: serve,
  } satisfies ProtectedInput<typeof Schema.String>,
  models: configuration({
    description:
      "Models sessions may use, the first being the default, each with its id, context window, and image input.",
    env: "ASHE_AGENT_MODELS",
    codec: "json",
    schema: Models,
    processes: serve,
    defaults: {},
  }),
  origins: configuration({
    description: "Browser origins allowed to open a WebSocket connection.",
    env: "ASHE_AGENT_ORIGINS",
    codec: "json",
    schema: Schema.Array(Origin),
    processes: serve,
    defaults: { development: () => ["http://127.0.0.1:5173"] },
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
    description: "Global instructions file recorded into sessions without an agent.",
    env: "ASHE_AGENT_INSTRUCTIONS_FILE",
    codec: "string",
    schema: AbsolutePath,
    processes: serve,
    defaults: both((dirs) => `${dirs.configHome}/ashe-agent/AGENTS.md`),
  }),
  agentsDir: configuration({
    description: "Directory of agent files.",
    env: "ASHE_AGENT_AGENTS_DIR",
    codec: "string",
    schema: AbsolutePath,
    processes: serve,
    defaults: both((dirs) => `${dirs.configHome}/ashe-agent/agents`),
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
    description: "Optional limits on a code mode program's time, tool calls, and output bytes.",
    env: "ASHE_AGENT_CODE_MODE_LIMITS",
    codec: "json",
    schema: CodeModeLimits,
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
    processes: serve,
    defaults: both(() => "otlp" as const),
  }),
  metricsExporter: configuration({
    description: "Metric exporter: otlp, console, or none.",
    env: "OTEL_METRICS_EXPORTER",
    codec: "string",
    schema: ExporterSelection,
    processes: serve,
    defaults: both(() => "otlp" as const),
  }),
  logsExporter: configuration({
    description: "Log exporter: otlp, console, or none.",
    env: "OTEL_LOGS_EXPORTER",
    codec: "string",
    schema: ExporterSelection,
    processes: serve,
    defaults: both(() => "otlp" as const),
  }),
  otlpEndpoint: configuration({
    description: "OTLP endpoint the otlp exporters send to.",
    env: "OTEL_EXPORTER_OTLP_ENDPOINT",
    codec: "string",
    schema: HttpUrl,
    processes: serve,
    defaults: { development: () => "http://127.0.0.1:4318" },
  }),
  otlpProtocol: configuration({
    description: "OTLP transport protocol.",
    env: "OTEL_EXPORTER_OTLP_PROTOCOL",
    codec: "string",
    schema: OtlpProtocol,
    processes: serve,
    defaults: both(() => "http/protobuf" as const),
  }),
  otlpHeadersFile: configuration({
    description: "Optional path of the protected file holding OTLP export headers as key=value pairs.",
    env: "ASHE_AGENT_OTLP_HEADERS_FILE",
    codec: "string",
    schema: NullablePath,
    processes: serve,
    defaults: both(() => null),
  }),
  otlpHeaders: {
    class: "protected",
    description: "OTLP export headers, which may carry credentials.",
    file: "otlpHeadersFile",
    schema: Schema.String,
    processes: serve,
  } satisfies ProtectedInput<typeof Schema.String>,
  deploymentEnvironment: configuration({
    description: "Value of the deployment.environment.name telemetry attribute.",
    env: "ASHE_AGENT_DEPLOYMENT_ENVIRONMENT",
    codec: "string",
    schema: Schema.NonEmptyString,
    processes: serve,
    defaults: { development: () => "development" },
  }),
} as const satisfies Record<string, Input>

export type Catalog = typeof catalog
export type InputKey = keyof Catalog

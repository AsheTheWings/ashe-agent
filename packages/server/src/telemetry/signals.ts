import { context, metrics, trace, SpanStatusCode, type Attributes, type Context, type Span } from "@opentelemetry/api"
import { logs, SeverityNumber } from "@opentelemetry/api-logs"

/**
 * The signal catalog: every span, metric, and log record the server emits,
 * with its attributes, units, and error classes. Bump the version whenever
 * a name, attribute, unit, or error class changes.
 */
export const SIGNAL_CATALOG_VERSION = 1

/** The instrumentation scope of every signal. */
export const SCOPE = "ashe-agent"

/** Stable error classes, carried as `error.type`. */
export const ERROR_CLASSES = [
  "invalid_request",
  "method_not_found",
  "invalid_params",
  "unauthenticated",
  "authentication_failed",
  "rate_limited",
  "not_found",
  "conflict",
  "already_resolved",
  "invalid_input",
  "unsupported_version",
  "internal",
  "model_call_failed",
  "context_overflow",
  "turn_failed",
  "canceled",
  "interrupted",
  "mcp_connect_failed",
  "mcp_disconnected",
  "mcp_not_answering",
] as const

export type ErrorClass = (typeof ERROR_CLASSES)[number]

export const TURN_STATUSES = ["finished", "failed", "canceled", "interrupted"] as const
export const TOOL_OUTCOMES = ["success", "failed", "canceled", "declined", "interrupted"] as const

/** Every attribute a signal may carry, with its type and, when bounded by a list, its values. */
export const ATTRIBUTES = {
  "rpc.method": { type: "string", description: "The protocol method, or `unknown` for a method the protocol does not define." },
  "error.type": { type: "string", values: ERROR_CLASSES, description: "The error class of a failed operation." },
  "ashe_agent.model": { type: "string", description: "A configured model id." },
  "ashe_agent.turn.status": { type: "string", values: TURN_STATUSES, description: "How a turn ended." },
  "ashe_agent.tool": { type: "string", description: "A tool's registered name: a built-in tool's or a configured MCP server's." },
  "ashe_agent.tool.outcome": { type: "string", values: TOOL_OUTCOMES, description: "How a tool call ended." },
  "ashe_agent.tool.in_program": { type: "boolean", description: "Whether a code mode program made the call." },
  "ashe_agent.mcp.server": { type: "string", description: "A configured MCP server's name." },
} as const

export type AttributeName = keyof typeof ATTRIBUTES

export const SPANS = {
  "ashe_agent.request": { description: "One protocol request, authentication included.", attributes: ["rpc.method", "error.type"] },
  "ashe_agent.turn": { description: "One turn, from its start to its end.", attributes: ["ashe_agent.model", "ashe_agent.turn.status", "error.type"] },
  "ashe_agent.model_call": { description: "One model call of a turn.", attributes: ["ashe_agent.model", "error.type"] },
  "ashe_agent.tool_call": {
    description: "One tool call, a code mode program's calls included as children of their execute call.",
    attributes: ["ashe_agent.tool", "ashe_agent.tool.outcome", "ashe_agent.tool.in_program"],
  },
} as const satisfies Record<string, { description: string; attributes: ReadonlyArray<AttributeName> }>

export const METRICS = {
  "ashe_agent.turn.duration": { kind: "histogram", unit: "s", description: "Turn duration.", attributes: ["ashe_agent.model", "ashe_agent.turn.status"] },
  "ashe_agent.model_call.duration": { kind: "histogram", unit: "s", description: "Model call duration.", attributes: ["ashe_agent.model", "error.type"] },
  "ashe_agent.tool_call.duration": {
    kind: "histogram",
    unit: "s",
    description: "Tool call duration.",
    attributes: ["ashe_agent.tool", "ashe_agent.tool.outcome", "ashe_agent.tool.in_program"],
  },
} as const satisfies Record<string, { kind: "histogram"; unit: string; description: string; attributes: ReadonlyArray<AttributeName> }>

export const LOGS = {
  "ashe_agent.request.internal_error": { severity: "ERROR", description: "A protocol request failed with an internal error.", attributes: ["rpc.method", "error.type"] },
  "ashe_agent.mcp.unavailable": { severity: "WARN", description: "An MCP server failed to connect or was lost.", attributes: ["ashe_agent.mcp.server", "error.type"] },
  "ashe_agent.mcp.collision": { severity: "WARN", description: "MCP tools whose registered names collide, none registered.", attributes: ["ashe_agent.tool"] },
} as const satisfies Record<string, { severity: "ERROR" | "WARN"; description: string; attributes: ReadonlyArray<AttributeName> }>

export type SpanName = keyof typeof SPANS
type MetricName = keyof typeof METRICS
type LogName = keyof typeof LOGS

const tracer = () => trace.getTracer(SCOPE)

const histograms = new Map<MetricName, ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]>>()
const histogram = (name: MetricName) => {
  let instrument = histograms.get(name)
  if (instrument === undefined) {
    instrument = metrics.getMeter(SCOPE).createHistogram(name, { unit: METRICS[name].unit, description: METRICS[name].description })
    histograms.set(name, instrument)
  }
  return instrument
}

/** Drops the cached instruments, so the next records use the meter provider registered now. */
export const resetInstruments = () => histograms.clear()

/** Records `seconds` on the duration histogram `name`. */
export const recordDuration = (name: MetricName, seconds: number, attributes: Partial<Record<AttributeName, string | boolean>>) =>
  histogram(name).record(seconds, attributes as Attributes)

/** Starts the span `name`, a child of `parent` or of the active context. */
export const startSpan = (name: SpanName, attributes: Partial<Record<AttributeName, string | boolean>>, parent: Context = context.active()): Span =>
  tracer().startSpan(name, { attributes: attributes as Attributes }, parent)

/** Ends `span`, marking it failed with `errorClass` when one is given. */
export const endSpan = (span: Span, attributes: Partial<Record<AttributeName, string | boolean>> = {}, errorClass?: ErrorClass) => {
  span.setAttributes(attributes as Attributes)
  if (errorClass !== undefined) {
    span.setAttribute("error.type", errorClass)
    span.setStatus({ code: SpanStatusCode.ERROR })
  }
  span.end()
}

/** The context with `span` active under `parent`. */
export const withSpan = (span: Span, parent: Context = context.active()) => trace.setSpan(parent, span)

/** Emits the log record `name`; its body is the catalog's description, never event data. */
export const emitLog = (name: LogName, attributes: Partial<Record<AttributeName, string>>) =>
  logs.getLogger(SCOPE).emit({
    eventName: name,
    body: LOGS[name].description,
    severityNumber: LOGS[name].severity === "ERROR" ? SeverityNumber.ERROR : SeverityNumber.WARN,
    severityText: LOGS[name].severity,
    attributes,
  })

/** The catalog as data, for `schemas/signals.json`. */
export const signalCatalog = () => ({
  version: SIGNAL_CATALOG_VERSION,
  scope: SCOPE,
  attributes: ATTRIBUTES,
  errorClasses: ERROR_CLASSES,
  spans: SPANS,
  metrics: METRICS,
  logs: LOGS,
})

/** `schemas/signals.json`: the signal catalog, rendered. */
export const renderSignalCatalog = () => `${JSON.stringify(signalCatalog(), null, 2)}\n`

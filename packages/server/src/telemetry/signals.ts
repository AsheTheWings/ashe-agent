import { context, metrics, trace, SpanStatusCode, type Attributes, type Context, type Span } from "@opentelemetry/api"
import { logs, SeverityNumber } from "@opentelemetry/api-logs"

/**
 * The signal catalog: every span, metric, and log record the server emits,
 * with its attributes, units, and error classes. Bump the version whenever
 * a name, attribute, unit, or error class changes.
 */
export const SIGNAL_CATALOG_VERSION = 4

/** The instrumentation scope of every signal. */
export const SCOPE = "ashe-agent"

/** Stable error classes, carried as `error.type`. */
export const ERROR_CLASSES = [
  "invalid_request",
  "method_not_found",
  "invalid_params",
  "unauthenticated",
  "authentication_failed",
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
  "compaction_failed",
  "research_failed",
  "handoff_failed",
  "checkpoint_window_failed",
  "memory_check_failed",
  "memory_publish_failed",
  "snapshot_failed",
  "restore_failed",
  "user_instructions_unreadable",
  "sign_in_denied",
  "not_owner",
  "github_failed",
  "sign_in_unknown_state",
] as const

export type ErrorClass = (typeof ERROR_CLASSES)[number]

/** Whether `code`, such as a turn failure's code, is one of the stable error classes. */
export const isErrorClass = (code: string): code is ErrorClass => (ERROR_CLASSES as ReadonlyArray<string>).includes(code)

export const TURN_STATUSES = ["finished", "failed", "canceled", "interrupted"] as const
export const TOOL_OUTCOMES = ["success", "failed", "canceled", "declined", "interrupted"] as const
export const CONTEXT_TRIGGERS = ["threshold", "limit"] as const
export const VALIDATION_RESULTS = ["passed", "failed"] as const
export const QUESTION_OUTCOMES = ["answered", "message", "canceled"] as const
export const CHECKPOINT_WINDOW_CAUSES = ["creation", "context_turn"] as const
export const SIGN_IN_OUTCOMES = ["signed_in", "denied", "not_owner", "github_failed", "unknown_state"] as const

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
  "ashe_agent.mcp.collision.servers": {
    type: "string[]",
    description: "The configured MCP server of each colliding tool, in the order of `ashe_agent.mcp.collision.tools`.",
  },
  "ashe_agent.mcp.collision.tools": { type: "string[]", description: "The colliding tools' names as their MCP servers list them." },
  "ashe_agent.context_turn.trigger": {
    type: "string",
    values: CONTEXT_TRIGGERS,
    description: "What started a context turn: the reserve running short, or the context limit.",
  },
  "ashe_agent.context_turn.constructed": { type: "boolean", description: "Whether a context turn built the next checkpoint window." },
  "ashe_agent.clearing.attempt": { type: "int", description: "Which of a context turn's three clearings ran, from 1." },
  "ashe_agent.validation.attempt": { type: "int", description: "Which of a context turn's validations ran, from 1." },
  "ashe_agent.validation.result": { type: "string", values: VALIDATION_RESULTS, description: "Whether a validation passed." },
  "ashe_agent.question.outcome": {
    type: "string",
    values: QUESTION_OUTCOMES,
    description: "How a question wait ended: answered, ended by a steered user message, or canceled with its turn.",
  },
  "ashe_agent.checkpoint_window.cause": {
    type: "string",
    values: CHECKPOINT_WINDOW_CAUSES,
    description: "Why a checkpoint window was built: session creation or a context turn.",
  },
  "ashe_agent.sign_in.outcome": {
    type: "string",
    values: SIGN_IN_OUTCOMES,
    description:
      "How a GitHub sign-in callback ended: the owner signed in, the user denied access, another GitHub user, a GitHub failure, or an unknown state.",
  },
} as const

export type AttributeName = keyof typeof ATTRIBUTES
type AttributeValue = string | boolean | number
type SignalAttributes = Partial<Record<AttributeName, AttributeValue>>

export const SPANS = {
  "ashe_agent.request": { description: "One protocol request, authentication included.", attributes: ["rpc.method", "error.type"] },
  "ashe_agent.turn": { description: "One turn, from its start to its end.", attributes: ["ashe_agent.model", "ashe_agent.turn.status", "error.type"] },
  "ashe_agent.model_call": { description: "One model call of a turn.", attributes: ["ashe_agent.model", "error.type"] },
  "ashe_agent.tool_call": {
    description: "One tool call, a code mode program's calls included as children of their execute call.",
    attributes: ["ashe_agent.tool", "ashe_agent.tool.outcome", "ashe_agent.tool.in_program"],
  },
  "ashe_agent.context_turn": {
    description: "One context turn, from its context turn component to the end of its turn.",
    attributes: ["ashe_agent.context_turn.trigger", "ashe_agent.context_turn.constructed"],
  },
  "ashe_agent.clearing": { description: "One tool result clearing of a context turn.", attributes: ["ashe_agent.clearing.attempt"] },
  "ashe_agent.compaction_call": { description: "One compaction call for a chat boundary.", attributes: ["ashe_agent.model", "error.type"] },
  "ashe_agent.research_call": { description: "One research call for a research file.", attributes: ["ashe_agent.model", "error.type"] },
  "ashe_agent.handoff_call": { description: "One handoff call of a context turn.", attributes: ["ashe_agent.model", "error.type"] },
  "ashe_agent.question_wait": {
    description: "One `context_ask_question` call waiting for its answer.",
    attributes: ["ashe_agent.question.outcome"],
  },
  "ashe_agent.checkpoint_window_construction": {
    description: "Building one checkpoint window's harness seed.",
    attributes: ["ashe_agent.checkpoint_window.cause", "error.type"],
  },
  "ashe_agent.reconciliation": {
    description: "Comparing a delivery's sources with what the checkpoint window knows.",
    attributes: ["error.type"],
  },
  "ashe_agent.validation": {
    description: "One validation of a context turn's research files and memory draft.",
    attributes: ["ashe_agent.validation.attempt", "ashe_agent.validation.result"],
  },
  "ashe_agent.memory_check": { description: "Checking a session's memory against its current generation.", attributes: ["error.type"] },
  "ashe_agent.memory_publish": { description: "Publishing a session's next memory generation.", attributes: ["error.type"] },
  "ashe_agent.snapshot": { description: "Reading a session's research and memory files for a turn's snapshot.", attributes: ["error.type"] },
  "ashe_agent.restore": { description: "Completing a rewind's pending restore of research and memory files.", attributes: ["error.type"] },
  "ashe_agent.github_sign_in": {
    description: "One GitHub sign-in callback, from GitHub's redirect to the redirect back to the client.",
    attributes: ["ashe_agent.sign_in.outcome", "error.type"],
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
  "ashe_agent.clearing.freed": {
    kind: "histogram",
    unit: "{token}",
    description: "Estimated tokens one clearing freed.",
    attributes: ["ashe_agent.clearing.attempt"],
  },
  "ashe_agent.checkpoint_window.size": {
    kind: "histogram",
    unit: "{token}",
    description: "Estimated size of each built checkpoint window: its harness instructions and seed.",
    attributes: ["ashe_agent.checkpoint_window.cause"],
  },
  "ashe_agent.validation.failures": {
    kind: "counter",
    unit: "{validation}",
    description: "Failed validations of context turns.",
    attributes: ["ashe_agent.validation.attempt"],
  },
} as const satisfies Record<string, { kind: "histogram" | "counter"; unit: string; description: string; attributes: ReadonlyArray<AttributeName> }>

export const LOGS = {
  "ashe_agent.request.internal_error": { severity: "ERROR", description: "A protocol request failed with an internal error.", attributes: ["rpc.method", "error.type"] },
  "ashe_agent.mcp.unavailable": { severity: "WARN", description: "An MCP server failed to connect or was lost.", attributes: ["ashe_agent.mcp.server", "error.type"] },
  "ashe_agent.mcp.collision": {
    severity: "WARN",
    description: "MCP tools whose registered names collide, none registered.",
    attributes: ["ashe_agent.tool", "ashe_agent.mcp.collision.servers", "ashe_agent.mcp.collision.tools"],
  },
  "ashe_agent.github_token_revoke_failed": {
    severity: "WARN",
    description: "Revoking the GitHub token of a sign-in failed; the sign-in's outcome is unchanged.",
    attributes: ["error.type"],
  },
} as const satisfies Record<string, { severity: "ERROR" | "WARN"; description: string; attributes: ReadonlyArray<AttributeName> }>

export type SpanName = keyof typeof SPANS
type MetricName = keyof typeof METRICS
type HistogramName = { [Name in MetricName]: (typeof METRICS)[Name]["kind"] extends "histogram" ? Name : never }[MetricName]
type CounterName = { [Name in MetricName]: (typeof METRICS)[Name]["kind"] extends "counter" ? Name : never }[MetricName]
type LogName = keyof typeof LOGS

const tracer = () => trace.getTracer(SCOPE)

const histograms = new Map<HistogramName, ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]>>()
const histogram = (name: HistogramName) => {
  let instrument = histograms.get(name)
  if (instrument === undefined) {
    instrument = metrics.getMeter(SCOPE).createHistogram(name, { unit: METRICS[name].unit, description: METRICS[name].description })
    histograms.set(name, instrument)
  }
  return instrument
}

const counters = new Map<CounterName, ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>>()
const counter = (name: CounterName) => {
  let instrument = counters.get(name)
  if (instrument === undefined) {
    instrument = metrics.getMeter(SCOPE).createCounter(name, { unit: METRICS[name].unit, description: METRICS[name].description })
    counters.set(name, instrument)
  }
  return instrument
}

/** Drops the cached instruments, so the next records use the meter provider registered now. */
export const resetInstruments = () => {
  histograms.clear()
  counters.clear()
}

/** Records `value`, such as a duration in seconds, on the histogram `name`. */
export const recordDuration = (name: HistogramName, value: number, attributes: SignalAttributes) => histogram(name).record(value, attributes as Attributes)

/** Adds one to the counter `name`. */
export const countOne = (name: CounterName, attributes: SignalAttributes) => counter(name).add(1, attributes as Attributes)

/** Starts the span `name`, a child of `parent` or of the active context. */
export const startSpan = (name: SpanName, attributes: SignalAttributes, parent: Context = context.active()): Span =>
  tracer().startSpan(name, { attributes: attributes as Attributes }, parent)

/** Ends `span`, marking it failed with `errorClass` when one is given. */
export const endSpan = (span: Span, attributes: SignalAttributes = {}, errorClass?: ErrorClass) => {
  span.setAttributes(attributes as Attributes)
  if (errorClass !== undefined) {
    span.setAttribute("error.type", errorClass)
    span.setStatus({ code: SpanStatusCode.ERROR })
  }
  span.end()
}

/** What a traced operation may add to its span before it ends. */
export interface SpanNotes {
  readonly set: (attributes: SignalAttributes) => void
  /** Marks the span failed with `errorClass`, though the operation goes on. */
  readonly fail: (errorClass: ErrorClass) => void
}

const notesOf = (span: Span) => {
  let failed: ErrorClass | undefined
  const notes: SpanNotes = { set: (attributes) => span.setAttributes(attributes as Attributes), fail: (errorClass) => (failed = errorClass) }
  return { notes, failed: () => failed }
}

/**
 * Runs `work` inside the span `name`, a child of `parent`. A throw ends the
 * span as `failure`, or the class `failure` gives the thrown error, or as
 * `canceled` when `signal`, or the abort `work` threw, says the work was
 * canceled, and rethrows.
 */
export const traced = <A>(
  name: SpanName,
  attributes: SignalAttributes,
  parent: Context,
  failure: Failure,
  work: (notes: SpanNotes) => A,
  signal?: AbortSignal,
): A => {
  const span = startSpan(name, attributes, parent)
  const { notes, failed } = notesOf(span)
  try {
    const result = otelContextWith(span, parent, () => work(notes))
    endSpan(span, {}, failed())
    return result
  } catch (error) {
    endSpan(span, {}, canceled(error, signal) ? "canceled" : classOf(failure, error))
    throw error
  }
}

/** `traced` for asynchronous work. */
export const tracedAsync = async <A>(
  name: SpanName,
  attributes: SignalAttributes,
  parent: Context,
  failure: Failure,
  work: (notes: SpanNotes) => Promise<A>,
  signal?: AbortSignal,
): Promise<A> => {
  const span = startSpan(name, attributes, parent)
  const { notes, failed } = notesOf(span)
  try {
    const result = await otelContextWith(span, parent, () => work(notes))
    endSpan(span, {}, failed())
    return result
  } catch (error) {
    endSpan(span, {}, canceled(error, signal) ? "canceled" : classOf(failure, error))
    throw error
  }
}

/** The error class of a traced operation's throw: one class, or one per thrown error. */
export type Failure = ErrorClass | ((error: unknown) => ErrorClass)

const classOf = (failure: Failure, error: unknown) => (typeof failure === "function" ? failure(error) : failure)

const otelContextWith = <A>(span: Span, parent: Context, work: () => A): A => context.with(trace.setSpan(parent, span), work)

const canceled = (error: unknown, signal: AbortSignal | undefined) =>
  signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError")

/** The context with `span` active under `parent`. */
export const withSpan = (span: Span, parent: Context = context.active()) => trace.setSpan(parent, span)

/** Emits the log record `name`; its body is the catalog's description, never event data. */
export const emitLog = (name: LogName, attributes: Partial<Record<AttributeName, string | Array<string>>>) =>
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

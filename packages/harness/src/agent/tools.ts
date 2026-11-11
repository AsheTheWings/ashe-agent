import { JsonSchema, Schema } from "effect"
import { PermissionDenied, PermissionRejected, type PermissionCheck } from "../permissions/rules.ts"
import { IntegrityFailure } from "./failure.ts"
import type { ToolSpec } from "./model.ts"
import type { ToolContent, ToolOutcome } from "./window.ts"

export interface ToolClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ToolExecutionPolicy {
  /** The limit of each invocation without an exact-name override, in milliseconds. */
  readonly globalTimeoutMs: number
  /** Exact registered tool names with a positive limit, or null to disable only their local limit. */
  readonly timeoutOverrides: Readonly<Record<string, number | null>>
  readonly clock: ToolClock
}

export const systemToolClock: ToolClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export const toolPolicy = (
  globalTimeoutMs = 300_000,
  timeoutOverrides: Readonly<Record<string, number | null>> = {},
  clock: ToolClock = systemToolClock,
): ToolExecutionPolicy => ({ globalTimeoutMs, timeoutOverrides, clock })

/** The invocation's local limit: an exact-name override, or the global limit. */
export const toolTimeout = (policy: ToolExecutionPolicy, name: string): number | null =>
  Object.hasOwn(policy.timeoutOverrides, name) ? policy.timeoutOverrides[name]! : policy.globalTimeoutMs

export class ToolTimedOut extends Error {
  constructor(readonly tool: string, readonly timeoutMs: number) {
    super(`the ${tool} call exceeded its ${timeoutMs} ms execution budget`)
  }
}

/** What a running tool call knows about itself. */
export interface ToolRun {
  readonly sessionId: string
  readonly runId: string
  /** The calling AgentTurn's frozen selection, used to attribute peer submissions. */
  readonly agentTitle?: string
  readonly modelId?: string | null
  readonly reasoningEffort?: string | null
  readonly modelCallId?: string
  readonly invocationId?: string
  readonly toolCallId: string
  /** The session directory, where shell commands start and against which relative paths resolve. */
  readonly cwd: string
  /** Whether the turn's model takes images in tool results. */
  readonly imageInput: boolean
  /** Aborted when the turn is canceled or the server stops. */
  readonly signal: AbortSignal
  /** The invocation's absolute deadline on the tool clock; `Infinity` when no limit applies. */
  readonly deadline: number
  /** The clock measuring the deadline and delegated-action timers. */
  readonly clock: ToolClock
  /**
   * Returns when the permission rules let the call run, after an ask if
   * they ask; throws `PermissionDenied` or `PermissionRejected` otherwise.
   * A tool lets those errors propagate, so the tool step turns them into
   * the call's result. An ask is withdrawn when the call's `signal` or the
   * given `signal` aborts.
   */
  readonly authorize: (check: PermissionCheck, signal?: AbortSignal) => Promise<void>
  /**
   * Marks the call as running, emitting `TOOL_EXECUTION_STARTED` once. A
   * tool calls it after authorization and before the call's first effect,
   * so a call that is refused or fails validation never counts as started.
   */
  readonly started: () => void
  /**
   * Sets a note the call's result carries if the turn is canceled while
   * the call runs, such as how to reach a process it leaves running.
   */
  readonly onCancel: (note: string) => void
  /** The note recorded for a canceled or timed-out invocation, such as a process handle. */
  readonly note: () => string | undefined
  /**
   * Records that a tool call the call's code mode program made ended, by
   * the called tool's permission name, emitting `PROGRAM_CALL_FINISHED`.
   */
  readonly programCall: (tool: string, outcome: ToolOutcome) => void
  /** Whether the session's rules leave `tool` offered: false for a tool they wholly deny. */
  readonly offered: (tool: Tool) => boolean
}

/**
 * A tool call's result. A declined result with `endTurn` is a plain
 * reject: the turn makes no further model call.
 */
export type ToolResult =
  | { readonly outcome: "success" | "failed"; readonly content: ToolContent; readonly timedOut?: boolean }
  | { readonly outcome: "declined"; readonly content: ToolContent; readonly endTurn: boolean; readonly timedOut?: boolean }

/**
 * A tool the model can call. `run` receives the model's arguments, parsed
 * from JSON and otherwise unchanged. A tool in a namespace is sent to
 * models as `<namespace>_<name>`. `permission` names the permission its
 * calls are decided under, or null for a tool that asks none.
 */
export interface Tool {
  readonly namespace: string | null
  readonly name: string
  readonly permission: string | null
  /** A tool the turn coordinator runs once after the response's ordinary tools settle. */
  readonly defer?: "fork"
  /** Declared client actions the tool needs to produce a result; it is offered only when a subscriber supports all of them. */
  readonly actions?: ReadonlyArray<string>
  readonly spec: ToolSpec
  readonly run: (args: unknown, run: ToolRun) => Promise<ToolResult>
}

/**
 * The name the rules withhold a tool by: its permission name, or for a
 * tool that asks none, the name the model calls it by.
 */
export const withholdingName = (tool: Tool) => tool.permission ?? tool.spec.name

/** The draft-07 JSON Schema of an Effect Schema, standing alone, its objects closed to other properties. */
export const draft07 = (schema: Schema.Top): Record<string, unknown> => {
  const document = JsonSchema.toDocumentDraft07(Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" }))
  return {
    ...document.schema,
    ...(Object.keys(document.definitions).length > 0 ? { definitions: document.definitions } : {}),
  } as Record<string, unknown>
}

/**
 * A built-in tool: the model is offered the draft-07 JSON Schema of `args`,
 * and its arguments are decoded with `args` before `run`. Arguments that do
 * not decode, an argument `args` does not name included, give a failed
 * result naming the problem, and `run` is not
 * called. With `prepare`, the decoded call is authorized by the check it
 * returns, and `run` receives its plan, so the call acts on exactly what
 * was authorized; a result from `prepare` ends the call without running
 * it. The call is marked started just before `run`.
 */
export const builtinTool = <S extends Schema.Codec<unknown, unknown, never, never>, P = undefined>(definition: {
  readonly namespace?: string
  readonly name: string
  readonly permission: string | null
  readonly description: string
  readonly actions?: ReadonlyArray<string>
  readonly defer?: "fork"
  readonly args: S
  readonly prepare?: (args: S["Type"], run: ToolRun) => Prepared<P> | ToolResult | Promise<Prepared<P> | ToolResult>
  readonly run: (args: S["Type"], run: ToolRun, plan: P) => Promise<ToolResult>
}): Tool => {
  const decode = Schema.decodeUnknownExit(definition.args, { onExcessProperty: "error" })
  const namespace = definition.namespace ?? null
  return {
    namespace,
    name: definition.name,
    permission: definition.permission,
    ...(definition.defer === undefined ? {} : { defer: definition.defer }),
    ...(definition.actions === undefined ? {} : { actions: definition.actions }),
    spec: {
      name: namespace === null ? definition.name : `${namespace}_${definition.name}`,
      description: definition.description,
      parameters: draft07(definition.args),
    },
    run: async (args, run) => {
      const decoded = decode(args)
      if (decoded._tag === "Failure") {
        return { outcome: "failed", content: `The arguments do not match the tool's schema: ${String(decoded.cause)}` }
      }
      let plan = undefined as P
      if (definition.prepare !== undefined) {
        const prepared = await definition.prepare(decoded.value, run)
        if ("outcome" in prepared) return prepared
        await run.authorize(prepared.check)
        plan = prepared.plan
      }
      run.started()
      return definition.run(decoded.value, run, plan)
    },
  }
}

/** What a call is authorized for, and the plan it then carries out. */
export interface Prepared<P> {
  readonly check: PermissionCheck
  readonly plan: P
}

/** The result of a tool call that threw: a denial, a reject, or a failure. */
export const failedResult = (error: unknown): ToolResult => {
  if (error instanceof PermissionDenied) {
    return { outcome: "failed", content: "This tool call was denied by configuration and did not run." }
  }
  if (error instanceof PermissionRejected) {
    return error.reason === undefined
      ? { outcome: "declined", content: "The user declined this tool call.", endTurn: true }
      : { outcome: "failed", content: `The user rejected this tool call: ${error.reason}` }
  }
  return { outcome: "failed", content: `The tool failed: ${error instanceof Error ? error.message : String(error)}` }
}

const timeoutResult = (tool: string, timeoutMs: number, started: boolean, note?: string): ToolResult => ({
  outcome: "failed",
  timedOut: true,
  content:
    `${tool} timed out after ${timeoutMs} ms of elapsed execution. ` +
    (started
      ? `Execution had started, so external effects may be partial; this call cannot claim rollback or guaranteed remote termination. Check its effects before deciding whether to retry.${note === undefined ? "" : ` ${note}`}`
      : "Execution had not started, so this invocation changed nothing."),
})

/**
 * Invokes a tool under the common elapsed-time boundary: validation,
 * permission collection, effects, and settlement share one deadline, and a
 * nested call is bounded by the earlier of its own limit and its parent's
 * deadline.
 */
export const invokeTool = async (
  tool: Tool,
  args: unknown,
  run: ToolRun,
  policy: ToolExecutionPolicy,
): Promise<ToolResult> => {
  const { clock } = policy
  const local = toolTimeout(policy, tool.spec.name)
  const startedAt = clock.now()
  const deadline = local === null ? run.deadline : Math.min(run.deadline, startedAt + local)
  if (deadline !== Number.POSITIVE_INFINITY && deadline <= startedAt) {
    return timeoutResult(tool.spec.name, Math.max(0, deadline - startedAt), false)
  }
  const controller = new AbortController()
  const signal = AbortSignal.any([run.signal, controller.signal])
  let started = false
  let timer: unknown = null
  const budget = deadline === Number.POSITIVE_INFINITY ? null : deadline - startedAt
  const expired =
    budget === null
      ? null
      : new Promise<ToolResult>((resolve) => {
          timer = clock.setTimeout(() => {
            const error = new ToolTimedOut(tool.spec.name, budget)
            controller.abort(error)
            resolve(timeoutResult(tool.spec.name, budget, started, run.note()))
          }, budget)
        })
  const execution = (async () => {
    try {
      const inner: ToolRun = {
        ...run,
        signal,
        deadline,
        started: () => {
          started = true
          run.started()
        },
        authorize: (check, also) => run.authorize(check, also === undefined ? signal : AbortSignal.any([signal, also])),
      }
      const result = await tool.run(args, inner)
      if (deadline !== Number.POSITIVE_INFINITY && clock.now() >= deadline) {
        controller.abort(new ToolTimedOut(tool.spec.name, budget ?? 0))
        return timeoutResult(tool.spec.name, budget ?? 0, started, run.note())
      }
      return result
    } catch (error) {
      if (run.signal.aborted) throw error
      if (error instanceof IntegrityFailure) throw error
      return failedResult(error)
    }
  })()
  let onAbort: (() => void) | null = null
  const cancelled =
    run.signal.aborted
      ? Promise.reject(run.signal.reason)
      : new Promise<ToolResult>((_resolve, reject) => {
          onAbort = () => reject(run.signal.reason)
          run.signal.addEventListener("abort", onAbort, { once: true })
        })
  try {
    return expired === null ? await Promise.race([execution, cancelled]) : await Promise.race([execution, expired, cancelled])
  } finally {
    if (timer !== null) clock.clearTimeout(timer)
    if (onAbort !== null) run.signal.removeEventListener("abort", onAbort)
  }
}

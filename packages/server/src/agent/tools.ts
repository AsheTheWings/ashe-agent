import { JsonSchema, Schema } from "effect"
import { PermissionDenied, PermissionRejected, type PermissionCheck } from "../permissions/rules.ts"
import type { ToolSpec } from "./model.ts"
import type { ToolContent, ToolOutcome } from "./window.ts"

/** What a running tool call knows about itself. */
export interface ToolRun {
  readonly sessionId: string
  readonly runId: string
  readonly toolCallId: string
  /** The session directory, where shell commands start and against which relative paths resolve. */
  readonly cwd: string
  /** Whether the turn's model takes images in tool results. */
  readonly imageInput: boolean
  /** Aborted when the turn is canceled or the server stops. */
  readonly signal: AbortSignal
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
  | { readonly outcome: "success" | "failed"; readonly content: ToolContent }
  | { readonly outcome: "declined"; readonly content: ToolContent; readonly endTurn: boolean }

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

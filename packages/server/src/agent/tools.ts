import { JsonSchema, Schema } from "effect"
import type { PermissionCheck } from "../permissions/rules.ts"
import type { ToolSpec } from "./model.ts"
import type { ToolContent } from "./window.ts"

/** What a running tool call knows about itself. */
export interface ToolRun {
  readonly sessionId: string
  readonly runId: string
  readonly toolCallId: string
  readonly cwd: string
  /** Whether the turn's model takes images in tool results. */
  readonly imageInput: boolean
  /** Aborted when the turn is canceled or the server stops. */
  readonly signal: AbortSignal
  /**
   * Returns when the permission rules let the call run, after an ask if
   * they ask; throws `PermissionDenied` or `PermissionRejected` otherwise.
   * A tool lets those errors propagate, so the tool step turns them into
   * the call's result.
   */
  readonly authorize: (check: PermissionCheck) => Promise<void>
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
 * models as `<namespace>_<name>`.
 */
export interface Tool {
  readonly namespace: string | null
  readonly name: string
  readonly spec: ToolSpec
  readonly run: (args: unknown, run: ToolRun) => Promise<ToolResult>
}

/** The draft-07 JSON Schema of an Effect Schema, standing alone. */
export const draft07 = (schema: Schema.Top): Record<string, unknown> => {
  const document = JsonSchema.toDocumentDraft07(Schema.toJsonSchemaDocument(schema))
  return {
    ...document.schema,
    ...(Object.keys(document.definitions).length > 0 ? { definitions: document.definitions } : {}),
  } as Record<string, unknown>
}

/**
 * A built-in tool: the model is offered the draft-07 JSON Schema of `args`,
 * and its arguments are decoded with `args` before `run`. Arguments that do
 * not decode give a failed result naming the problem, and `run` is not
 * called. With `prepare`, the decoded call is authorized by the check it
 * returns, and `run` receives its plan, so the call acts on exactly what
 * was authorized; a result from `prepare` ends the call without running
 * it. The call is marked started just before `run`.
 */
export const builtinTool = <S extends Schema.Codec<unknown, unknown, never, never>, P = undefined>(definition: {
  readonly namespace?: string
  readonly name: string
  readonly description: string
  readonly args: S
  readonly prepare?: (args: S["Type"], run: ToolRun) => Prepared<P> | ToolResult | Promise<Prepared<P> | ToolResult>
  readonly run: (args: S["Type"], run: ToolRun, plan: P) => Promise<ToolResult>
}): Tool => {
  const decode = Schema.decodeUnknownExit(definition.args)
  const namespace = definition.namespace ?? null
  return {
    namespace,
    name: definition.name,
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

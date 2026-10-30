import { JsonSchema, Schema } from "effect"
import type { ToolSpec } from "./model.ts"
import type { ToolContent } from "./window.ts"

/** What a running tool call knows about itself. */
export interface ToolRun {
  readonly sessionId: string
  readonly runId: string
  readonly toolCallId: string
  readonly cwd: string
  /** Aborted when the turn is canceled or the server stops. */
  readonly signal: AbortSignal
}

/**
 * A tool call's result. A declined result with `endTurn` is a plain
 * reject: the turn makes no further model call.
 */
export type ToolResult =
  | { readonly outcome: "success" | "failed"; readonly content: ToolContent }
  | { readonly outcome: "declined"; readonly content: ToolContent; readonly endTurn: boolean }

/** A tool the model can call. `run` receives the model's arguments, parsed from JSON and otherwise unchanged. */
export interface Tool {
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
 * not decode give a failed result naming the problem, and `run` is not called.
 */
export const builtinTool = <S extends Schema.Codec<unknown, unknown, never, never>>(definition: {
  readonly name: string
  readonly description: string
  readonly args: S
  readonly run: (args: S["Type"], run: ToolRun) => Promise<ToolResult>
}): Tool => {
  const decode = Schema.decodeUnknownExit(definition.args)
  return {
    spec: { name: definition.name, description: definition.description, parameters: draft07(definition.args) },
    run: async (args, run) => {
      const decoded = decode(args)
      if (decoded._tag === "Failure") {
        return { outcome: "failed", content: `The arguments do not match the tool's schema: ${String(decoded.cause)}` }
      }
      return definition.run(decoded.value, run)
    },
  }
}

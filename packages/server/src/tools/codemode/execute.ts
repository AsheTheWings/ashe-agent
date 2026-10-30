/*
 * The execute tool's description and result formatting are ported from
 * opencode v2.2.1, packages/core/src/codemode/tool.ts, under the MIT notice
 * in catalog.ts beside this file.
 */

import { CodeMode, Tool as CodeModeTool, toolError, type ToolError } from "@ashe-agent/codemode"
import { context as otelContext, type Context as TraceContext } from "@opentelemetry/api"
import { Deferred, Effect, Option, Schema } from "effect"
import { builtinTool, failedResult, type Tool, type ToolResult, type ToolRun } from "../../agent/tools.ts"
import type { ToolContentPart, ToolOutcome } from "../../agent/window.ts"
import { endSpan, recordDuration, startSpan } from "../../telemetry/signals.ts"
import type { CatalogTool } from "./catalog.ts"

/** Limits on each program, as the code mode limits input names them. */
export interface CodeModeLimits {
  readonly wallClockMs?: number
  readonly toolCalls?: number
  readonly outputBytes?: number
}

const description = [
  "Run JavaScript in a confined Code Mode runtime to script tool calls and compose their results.",
  "Imports, network and filesystem access, and timers are unavailable: there is no `fetch`, `setTimeout`, or sleep. All external access goes through `tools`.",
  "Within `{ code }`, the only callable tools are those explicitly listed in the Code Mode catalog instructions or returned by the `search` function. Inside `{ code }`, ignore tools shown outside the Code Mode catalog. They are not available in the Code Mode runtime.",
  'Call tools through `tools` using only exact paths and signatures from the catalog. Do not infer or normalize tool names; preserve bracket notation such as `tools.<namespace>["tool-name"](input)`.',
  "Prefer an explicit `return`; if omitted, the final top-level expression becomes the result.",
  "Await every call whose completion matters; pending calls are interrupted when execution ends. Run independent calls concurrently with `Promise.allSettled`.",
].join("\n")

/** A program call's path segment: the tool's name with the characters a registered name refuses replaced. */
const segment = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_")

/** What one execution of a program reports back from its tool calls. */
interface Execution {
  readonly run: ToolRun
  /** Image parts of the program's call results, by the order in which the calls started. */
  readonly images: Array<ReadonlyArray<ToolContentPart>>
  /** How many calls the program has started. */
  calls: number
  /** Completed when a call is declined by a plain reject, which ends the program and the turn. */
  readonly declined: Deferred.Deferred<string>
  /** The trace context of the `execute` call, the parent of its program's call spans. */
  readonly trace: TraceContext
}

/**
 * The code mode tools record over `inventory`, namespaced by MCP server.
 * Each call runs the tool as a direct call would, under the tool's own
 * permission, with the program's clock paused while it is authorized.
 */
const programTools = (inventory: ReadonlyArray<Tool>, execution: Execution | null) => {
  // Records without a prototype, so a name such as `__proto__` or `constructor` is an ordinary key.
  const tools: Record<string, Record<string, CodeModeTool.Tool>> = Object.create(null)
  for (const tool of inventory) {
    const namespace = segment(tool.namespace ?? "tools")
    if (!Object.hasOwn(tools, namespace)) tools[namespace] = Object.create(null)
    tools[namespace]![segment(tool.name)] = CodeModeTool.make({
      description: tool.spec.description,
      input: tool.spec.parameters as CodeModeTool.JsonSchema,
      output: Schema.NullOr(Schema.String),
      execute: (input) => (execution === null ? Effect.die("not executable") : call(tool, input, execution)),
    })
  }
  return tools
}

/** One program call, traced as a child span of the `execute` call. */
const call = (tool: Tool, input: unknown, execution: Execution): Effect.Effect<string | null, ToolError> =>
  Effect.suspend(() => {
    const attributes = { "ashe_agent.tool": tool.spec.name, "ashe_agent.tool.in_program": true }
    const span = startSpan("ashe_agent.tool_call", attributes, execution.trace)
    const startedAt = performance.now()
    let outcome: ToolOutcome = "canceled"
    return Effect.ensuring(
      runCall(tool, input, execution, (ended) => (outcome = ended)),
      Effect.sync(() => {
        endSpan(span, { "ashe_agent.tool.outcome": outcome }, outcome === "canceled" ? "canceled" : undefined)
        recordDuration("ashe_agent.tool_call.duration", (performance.now() - startedAt) / 1000, { ...attributes, "ashe_agent.tool.outcome": outcome })
      }),
    )
  })

const runCall = (tool: Tool, input: unknown, execution: Execution, ended: (outcome: ToolOutcome) => void): Effect.Effect<string | null, ToolError> =>
  Effect.gen(function* () {
    const index = execution.calls++
    const clock = yield* Effect.serviceOption(CodeMode.ActiveTime)
    const outer = execution.run
    const result = yield* Effect.promise((signal) => {
      const inner: ToolRun = {
        ...outer,
        signal: AbortSignal.any([outer.signal, signal]),
        authorize: async (check) => {
          const resume = Option.isSome(clock) ? clock.value.pause() : () => {}
          try {
            await outer.authorize(check, signal)
          } finally {
            resume()
          }
        },
        started: () => {},
        onCancel: () => {},
        programCall: () => {},
      }
      return tool.run(input, inner).catch((error: unknown): ToolResult => failedResult(error))
    })
    ended(result.outcome)
    outer.programCall(tool.spec.name, result.outcome)
    const parts = typeof result.content === "string" ? [{ type: "text" as const, text: result.content }] : result.content
    const text = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
    if (result.outcome === "declined" && result.endTurn) {
      yield* Deferred.succeed(execution.declined, tool.spec.name)
      return yield* Effect.never
    }
    if (result.outcome !== "success") return yield* Effect.fail(toolError(text))
    execution.images[index] = parts.filter((part) => part.type === "image")
    return text === "" ? null : text
  })

/** The callable signatures of `inventory` for the code mode catalog. */
export const catalogTools = (inventory: ReadonlyArray<Tool>): ReadonlyArray<CatalogTool> =>
  CodeMode.make({ tools: programTools(inventory, null) }).catalog

/**
 * `execute`: runs a code mode program over the tools `inventory` gives at
 * the call, under the `execute` permission by `*` and `limits`.
 */
export const executeTool = (inventory: () => ReadonlyArray<Tool>, limits: CodeModeLimits): Tool =>
  builtinTool({
    name: "execute",
    description,
    args: CodeMode.Input,
    prepare: () => ({ check: { permission: "execute", subjects: ["*"], patterns: ["*"] }, plan: undefined }),
    run: async ({ code }, run) => {
      const trace = otelContext.active()
      const program = Effect.gen(function* () {
        const execution: Execution = { run, images: [], calls: 0, declined: yield* Deferred.make<string>(), trace }
        const runtime = CodeMode.make({
          tools: programTools(inventory(), execution),
          limits: {
            ...(limits.wallClockMs === undefined ? {} : { timeoutMs: limits.wallClockMs }),
            ...(limits.toolCalls === undefined ? {} : { maxToolCalls: limits.toolCalls }),
            ...(limits.outputBytes === undefined ? {} : { maxOutputBytes: limits.outputBytes }),
          },
        })
        const ended = yield* Effect.raceFirst(
          Effect.map(runtime.execute(code), (result) => ({ result })),
          Effect.map(Deferred.await(execution.declined), (tool) => ({ declined: tool })),
        )
        return { ended, images: execution.images.flatMap((parts) => parts ?? []) }
      })
      const { ended, images } = await Effect.runPromise(program, { signal: run.signal })
      const declined = "declined" in ended
      const output = declined ? `The user declined the program's call to ${ended.declined}, which ended the program.` : formatResult(ended.result)
      const { text, kept } = boundImages(output, images, limits.outputBytes)
      const content = kept.length === 0 ? text : [{ type: "text" as const, text }, ...kept]
      if (declined) return { outcome: "declined", content, endTurn: true }
      return { outcome: ended.result.ok ? "success" : "failed", content }
    },
  })

/**
 * Keeps the images, in order, while the text and their data fit in
 * `outputBytes`; the text then says how many were left out. That note is
 * host formatting, which the limit does not cover, like the interpreter's
 * own truncation notice.
 */
const boundImages = (text: string, images: ReadonlyArray<ToolContentPart>, outputBytes: number | undefined) => {
  if (outputBytes === undefined || images.length === 0) return { text, kept: images }
  let remaining = outputBytes - Buffer.byteLength(text)
  const kept: Array<ToolContentPart> = []
  for (const image of images) {
    const size = image.type === "image" ? Buffer.byteLength(image.data) : 0
    if (size > remaining) break
    kept.push(image)
    remaining -= size
  }
  const omitted = images.length - kept.length
  if (omitted === 0) return { text, kept }
  return { text: `${text}\n\n${omitted === 1 ? "1 image was" : `${omitted} images were`} left out: the output limit was reached.`, kept }
}

const formatResult = (result: CodeMode.Result) => {
  const output = result.ok
    ? formatValue(result.value)
    : [result.error.message, ...(result.error.suggestions ?? []).filter((hint) => !result.error.message.includes(hint))].join("\n").trim()
  const warnings =
    result.ok && result.warnings !== undefined && result.warnings.length > 0
      ? `Warnings:\n${result.warnings.map((item) => `- [${item.kind}] ${item.message}`).join("\n")}`
      : undefined
  const logs = result.logs !== undefined && result.logs.length > 0 ? `Logs:\n${result.logs.join("\n")}` : undefined
  return [output, warnings, logs].filter((part) => part !== undefined && part !== "").join("\n\n")
}

const formatValue = (value: CodeMode.DataValue) => (typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value)))

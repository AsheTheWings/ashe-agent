import { AIMessage, type AIMessageChunk } from "@langchain/core/messages"
import type { SessionEventBody } from "@ashe-agent/protocol"
import { context as otelContext } from "@opentelemetry/api"
import { Effect } from "effect"
import { allowanceMessage, toolDefinitionsIssue } from "../context/seed.ts"
import { callSettings, type ConfiguredModel } from "../models/registry.ts"
import type { TurnContext, TurnOutcome, TurnRunner } from "../sessions/hub.ts"
import { endSpan, recordDuration, startSpan, withSpan, type ErrorClass } from "../telemetry/signals.ts"
import { REQUEST_INSTRUCTIONS } from "./blocks.ts"
import { ModelCallError, type ModelPort } from "./model.ts"
import { unfinishedResult } from "./notes.ts"
import { failedResult, type Tool, type ToolResult } from "./tools.ts"
import { renderWindow, toolContentText, type ToolContent, type ToolOutcome } from "./window.ts"

export interface AgentOptions {
  readonly port: ModelPort
  readonly models: ReadonlyArray<ConfiguredModel>
}

/** A turn that cannot go on; its message becomes the turn's error event. */
class TurnFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

interface Call {
  readonly name: string
  started: boolean
  answered: boolean
  /** Whether a committed assistant item holds the call, so its result is an item too. */
  committed: boolean
  cancelNote?: string
}

/**
 * Streams a model call's events as they arrive and tracks what a cancel
 * must close: open text and reasoning messages, and tool calls without a
 * result. After `close`, nothing more is emitted or committed.
 */
class TurnEvents {
  private text: string | null = null
  private reasoning: string | null = null
  private readonly streaming = new Map<number, string>()
  /** The turn's tool calls, by id. */
  readonly calls = new Map<string, Call>()
  private closed = false

  constructor(private readonly context: TurnContext) {}

  emit(body: SessionEventBody) {
    if (!this.closed) this.context.emit(body)
  }

  private endText(into: Array<SessionEventBody>) {
    if (this.text !== null) into.push({ type: "TEXT_MESSAGE_END", messageId: this.text })
    this.text = null
  }

  private endReasoning(into: Array<SessionEventBody>) {
    if (this.reasoning === null) return
    into.push({ type: "REASONING_MESSAGE_END", messageId: this.reasoning })
    into.push({ type: "REASONING_END", messageId: this.reasoning })
    this.reasoning = null
  }

  private emitAll(bodies: ReadonlyArray<SessionEventBody>) {
    for (const body of bodies) this.emit(body)
  }

  chunk(chunk: AIMessageChunk) {
    const parts = typeof chunk.content === "string" ? [{ type: "text", text: chunk.content }] : chunk.content
    for (const part of parts) {
      if (part.type === "reasoning" && typeof part.reasoning === "string" && part.reasoning !== "") {
        const ended: Array<SessionEventBody> = []
        this.endText(ended)
        this.emitAll(ended)
        if (this.reasoning === null) {
          this.reasoning = crypto.randomUUID()
          this.emit({ type: "REASONING_START", messageId: this.reasoning })
          this.emit({ type: "REASONING_MESSAGE_START", messageId: this.reasoning, role: "reasoning" })
        }
        this.emit({ type: "REASONING_MESSAGE_CONTENT", messageId: this.reasoning, delta: part.reasoning })
      } else if (part.type === "text" && typeof part.text === "string" && part.text !== "") {
        const ended: Array<SessionEventBody> = []
        this.endReasoning(ended)
        this.emitAll(ended)
        if (this.text === null) {
          this.text = crypto.randomUUID()
          this.emit({ type: "TEXT_MESSAGE_START", messageId: this.text, role: "assistant" })
        }
        this.emit({ type: "TEXT_MESSAGE_CONTENT", messageId: this.text, delta: part.text })
      }
    }
    for (const call of chunk.tool_call_chunks ?? []) {
      const index = call.index ?? 0
      let id = this.streaming.get(index)
      if (id === undefined && call.id !== undefined && call.name !== undefined) {
        const ended: Array<SessionEventBody> = []
        this.endText(ended)
        this.endReasoning(ended)
        this.emitAll(ended)
        id = call.id
        this.streaming.set(index, id)
        this.calls.set(id, { name: call.name, started: false, answered: false, committed: false })
        this.emit({ type: "TOOL_CALL_START", toolCallId: id, toolCallName: call.name })
      }
      if (id !== undefined && call.args !== undefined && call.args !== "") this.emit({ type: "TOOL_CALL_ARGS", toolCallId: id, delta: call.args })
    }
  }

  /** The events that end the open messages and tool call streams of a model call, which the caller commits. */
  endEvents(): Array<SessionEventBody> {
    const ended: Array<SessionEventBody> = []
    this.endText(ended)
    this.endReasoning(ended)
    for (const id of this.streaming.values()) ended.push({ type: "TOOL_CALL_END", toolCallId: id })
    this.streaming.clear()
    return ended
  }

  /** Ends the open messages and tool call streams of a model call that produced no message. */
  endCall() {
    this.emitAll(this.endEvents())
  }

  /**
   * Commits the model call's message as an item with the events that end
   * its streams, and the start of each call the message holds that
   * streamed none, such as one with unparsable arguments.
   */
  commitMessage(message: AIMessage) {
    const events = this.endEvents()
    for (const call of message.tool_calls ?? []) {
      const known = this.calls.get(call.id!)
      if (known !== undefined) {
        known.committed = true
        continue
      }
      this.calls.set(call.id!, { name: call.name, started: false, answered: false, committed: true })
      events.push({ type: "TOOL_CALL_START", toolCallId: call.id!, toolCallName: call.name }, { type: "TOOL_CALL_END", toolCallId: call.id! })
    }
    if (!this.closed) this.context.commitAssistant(message, events)
  }

  started(id: string) {
    const call = this.calls.get(id)
    if (call === undefined || call.started) return
    call.started = true
    this.emit({ type: "TOOL_EXECUTION_STARTED", toolCallId: id })
  }

  /** Sets the note a canceled result of the call carries. */
  cancelNote(id: string, note: string) {
    const call = this.calls.get(id)
    if (call !== undefined) call.cancelNote = note
  }

  /** Records the call's result: an item with its event for a committed call, else the event alone. */
  result(id: string, content: ToolContent, outcome: ToolOutcome) {
    const call = this.calls.get(id)
    if (call === undefined || this.closed) return
    call.answered = true
    const event: SessionEventBody = {
      type: "TOOL_CALL_RESULT",
      messageId: crypto.randomUUID(),
      toolCallId: id,
      role: "tool",
      content: toolContentText(content),
      outcome,
    }
    if (call.committed) this.context.commitResult({ callId: id, name: call.name, content, outcome }, event)
    else this.emit(event)
  }

  /** Ends open streams and gives each of the turn's calls without a result a failed result of `outcome`. */
  settle(outcome: "canceled" | "failed") {
    this.endCall()
    for (const [id, call] of this.calls) {
      if (call.answered) continue
      const content = unfinishedResult(outcome, call.started)
      this.result(id, outcome === "canceled" && call.cancelNote !== undefined ? `${content} ${call.cancelNote}` : content, outcome)
    }
  }

  /** On an interruption: settles the turn's calls as canceled when a cancel ended it, then stops emitting. */
  close(cancelled: boolean) {
    if (cancelled) this.settle("canceled")
    else this.endCall()
    this.closed = true
  }
}

/** The final message of a model call, with calls whose arguments did not parse given empty arguments. */
const finalMessage = (chunks: ReadonlyArray<AIMessageChunk>): { message: AIMessage; invalid: Map<string, string> } => {
  const merged = chunks.reduce<AIMessageChunk | null>((all, chunk) => (all === null ? chunk : all.concat(chunk)), null)
  const invalid = new Map<string, string>()
  if (merged === null) return { message: new AIMessage({ content: "" }), invalid }
  const calls = [...(merged.tool_calls ?? [])]
  for (const call of merged.invalid_tool_calls ?? []) {
    const id = call.id ?? crypto.randomUUID()
    invalid.set(id, call.args ?? "")
    calls.push({ id, name: call.name ?? "", args: {}, type: "tool_call" })
  }
  const message = new AIMessage({
    content: merged.content,
    tool_calls: calls,
    additional_kwargs: merged.additional_kwargs,
    response_metadata: merged.response_metadata,
    ...(merged.usage_metadata === undefined ? {} : { usage_metadata: merged.usage_metadata }),
    ...(merged.id === undefined ? {} : { id: merged.id }),
  })
  return { message, invalid }
}

/**
 * The turn runner: a loop of model calls, their tool calls in order, and
 * step boundaries, over the session's current checkpoint window. It runs
 * under `Effect.promise`, whose `AbortSignal` it receives, so interrupting
 * the turn's fiber aborts the running model call and tool calls.
 */
export const agentRunner =
  (options: AgentOptions): TurnRunner =>
  (context) => {
    const events = new TurnEvents(context)
    let running: Promise<TurnOutcome> | null = null
    return Effect.promise((signal) => (running = runTurn(options, context, events, signal))).pipe(
      Effect.onInterrupt(() =>
        Effect.promise(async () => {
          await running?.catch(() => undefined)
          events.close(context.isCancelled())
        }),
      ),
    )
  }

const runTurn = async (options: AgentOptions, context: TurnContext, events: TurnEvents, signal: AbortSignal): Promise<TurnOutcome> => {
  try {
    return await loop(options, context, events, signal)
  } catch (error) {
    if (signal.aborted) throw error
    events.settle("failed")
    if (error instanceof TurnFailure) return { status: "failed", message: error.message, code: error.code }
    return { status: "failed", message: error instanceof Error ? error.message : String(error), code: "internal" }
  }
}

/** The model port with every call traced as an `ashe_agent.model_call` span of the turn and timed. */
const tracedPort = (port: ModelPort, context: TurnContext): ModelPort => ({
  stream: async function* (call, callSignal) {
    const span = startSpan("ashe_agent.model_call", { "ashe_agent.model": call.model }, context.trace)
    const startedAt = performance.now()
    let failure: ErrorClass | undefined
    try {
      yield* port.stream(call, callSignal)
    } catch (error) {
      failure = callSignal.aborted ? "canceled" : error instanceof ModelCallError && error.overflow ? "context_overflow" : "model_call_failed"
      throw error
    } finally {
      // Also reached when the consumer stops reading early.
      endSpan(span, {}, failure)
      recordDuration("ashe_agent.model_call.duration", (performance.now() - startedAt) / 1000, {
        "ashe_agent.model": call.model,
        ...(failure === undefined ? {} : { "error.type": failure }),
      })
    }
  },
})

const loop = async (options: AgentOptions, context: TurnContext, events: TurnEvents, signal: AbortSignal): Promise<TurnOutcome> => {
  const { session, turn } = context
  const model = options.models.find((candidate) => candidate.id === turn.model)
  if (model === undefined) throw new TurnFailure(`the model ${turn.model} is not configured`, "model_unavailable")
  const settings = callSettings(model, session.modelOverrides[model.id], turn.reasoningEffort)
  const port = tracedPort(options.port, context)

  for (;;) {
    signal.throwIfAborted()
    // The tools of this model call, which its tool calls run against.
    const offered = context.tools()
    const tools = new Map(offered.map((tool) => [tool.spec.name, tool]))
    const specs = offered.map((tool) => tool.spec)
    const issue = toolDefinitionsIssue(specs)
    if (issue !== null) throw new TurnFailure(`the model call was not sent: ${allowanceMessage(issue)}`, "tool_definitions_over_allowance")

    const window = context.window()
    const chunks: Array<AIMessageChunk> = []
    try {
      const call = {
        model: turn.model,
        instructions: REQUEST_INSTRUCTIONS,
        messages: renderWindow(window.harness, window.items, turn.model, model.imageInput),
        tools: specs,
        ...settings,
      }
      for await (const chunk of port.stream(call, signal)) {
        chunks.push(chunk)
        events.chunk(chunk)
      }
    } catch (error) {
      if (signal.aborted) throw error
      if (error instanceof ModelCallError && error.overflow) {
        throw new TurnFailure("the conversation exceeds the model's context window", "context_overflow")
      }
      throw new TurnFailure(`the model call failed: ${error instanceof Error ? error.message : String(error)}`, "model_failed")
    }
    const { message, invalid } = finalMessage(chunks)
    events.commitMessage(message)
    for (const [id, raw] of invalid) events.result(id, `The arguments were not valid JSON: ${raw}`, "failed")

    const calls = (message.tool_calls ?? []).filter((call) => !invalid.has(call.id!))
    if (calls.length === 0 && invalid.size === 0) {
      // A step boundary after a reply without tool calls: the turn ends unless input joins it.
      if (!context.deliver()) return { status: "finished" }
      continue
    }
    let stopped = false
    for (const call of calls) {
      const callId = call.id!
      if (stopped) {
        events.result(callId, unfinishedResult("canceled", false), "canceled")
        continue
      }
      const result = await runTool(tools.get(call.name), call.name, call.args, callId, context, events, signal, model.imageInput)
      signal.throwIfAborted()
      if (result.outcome === "declined" && result.endTurn) stopped = true
      events.result(callId, result.content, result.outcome)
    }
    if (stopped) return { status: "finished" }
    // A step boundary after the tool results.
    context.deliver()
  }
}

const runTool = async (
  tool: Tool | undefined,
  name: string,
  args: unknown,
  callId: string,
  context: TurnContext,
  events: TurnEvents,
  signal: AbortSignal,
  imageInput: boolean,
): Promise<ToolResult> => {
  // A name no offered tool has is the model's text, so it is not recorded.
  const toolName = tool === undefined ? "unknown" : name
  const span = startSpan("ashe_agent.tool_call", { "ashe_agent.tool": toolName, "ashe_agent.tool.in_program": false }, context.trace)
  const startedAt = performance.now()
  const ended = (outcome: ToolOutcome) => {
    endSpan(span, { "ashe_agent.tool.outcome": outcome }, outcome === "canceled" ? "canceled" : undefined)
    recordDuration("ashe_agent.tool_call.duration", (performance.now() - startedAt) / 1000, {
      "ashe_agent.tool": toolName,
      "ashe_agent.tool.outcome": outcome,
      "ashe_agent.tool.in_program": false,
    })
  }
  let result: ToolResult
  if (tool === undefined) {
    result = { outcome: "failed", content: `There is no tool named ${name}.` }
  } else {
    try {
      result = await otelContext.with(withSpan(span, context.trace), () =>
        tool.run(args, {
          sessionId: context.session.id,
          runId: context.turn.runId,
          toolCallId: callId,
          cwd: context.session.sessionDir,
          imageInput,
          signal,
          authorize: (check, also) => context.authorize(callId, check, also === undefined ? signal : AbortSignal.any([signal, also])),
          started: () => events.started(callId),
          onCancel: (note) => events.cancelNote(callId, note),
          programCall: (program, outcome) => events.emit({ type: "PROGRAM_CALL_FINISHED", toolCallId: callId, tool: program, outcome }),
          offered: context.offered,
        }),
      )
    } catch (error) {
      if (signal.aborted) {
        ended("canceled")
        throw error
      }
      result = failedResult(error)
    }
  }
  ended(result.outcome)
  return result
}

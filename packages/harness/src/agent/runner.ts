import { AIMessage, type AIMessageChunk } from "@langchain/core/messages"
import type { SessionEventBody } from "@ashe-agent/protocol"
import { context as otelContext } from "@opentelemetry/api"
import { Effect } from "effect"
import { RESERVE } from "../context/constants.ts"
import { allowanceMessage, toolDefinitionsIssue } from "../context/seed.ts"
import { callSettings, type ConfiguredModel } from "../models/registry.ts"
import type { TurnContext, TurnOutcome, TurnRunner } from "../sessions/hub.ts"
import { endSpan, recordDuration, startSpan, withSpan, type ErrorClass } from "../telemetry/signals.ts"
import { REQUEST_INSTRUCTIONS } from "./blocks.ts"
import { IntegrityFailure, TurnFailure } from "./failure.ts"
import { ModelCallError, type ModelPort } from "./model.ts"
import { unfinishedResult } from "./notes.ts"
import { failedResult, invokeTool, type Tool, type ToolResult } from "./tools.ts"
import { estimateCall, renderWindow, toolContentText, type ToolContent, type ToolOutcome } from "./window.ts"

export interface AgentOptions {
  readonly port: ModelPort
  readonly models: ReadonlyArray<ConfiguredModel>
}

interface Call {
  readonly name: string
  readonly modelCallId: string
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
  /** The turn's tool calls, keyed by model call and provider call id. */
  readonly calls = new Map<string, Call>()
  private modelCallId: string | null = null
  private committed = false
  private closed = false

  constructor(private readonly context: TurnContext) {}

  emit(body: SessionEventBody) {
    if (!this.closed) this.context.emit(body)
  }

  private endText(into: Array<SessionEventBody>) {
    if (this.text !== null && this.modelCallId !== null) {
      into.push({ type: "TEXT_MESSAGE_END", modelCallId: this.modelCallId, messageId: this.text })
    }
    this.text = null
  }

  private endReasoning(into: Array<SessionEventBody>) {
    if (this.reasoning === null || this.modelCallId === null) return
    into.push({ type: "REASONING_MESSAGE_END", modelCallId: this.modelCallId, messageId: this.reasoning })
    into.push({ type: "REASONING_END", modelCallId: this.modelCallId, messageId: this.reasoning })
    this.reasoning = null
  }

  private emitAll(bodies: ReadonlyArray<SessionEventBody>) {
    for (const body of bodies) this.emit(body)
  }

  startCall(modelCallId: string, ordinal: number) {
    this.modelCallId = modelCallId
    this.committed = false
    this.streaming.clear()
    this.emit({ type: "MODEL_CALL_STARTED", runId: this.context.turn.runId, modelCallId, ordinal })
  }

  private callKey(id: string) {
    return `${this.modelCallId}:${id}`
  }

  chunk(chunk: AIMessageChunk) {
    if (this.modelCallId === null) throw new IntegrityFailure("a model chunk arrived outside a model call")
    const parts = typeof chunk.content === "string" ? [{ type: "text", text: chunk.content }] : chunk.content
    for (const part of parts) {
      if (part.type === "reasoning" && typeof part.reasoning === "string" && part.reasoning !== "") {
        const ended: Array<SessionEventBody> = []
        this.endText(ended)
        this.emitAll(ended)
        if (this.reasoning === null) {
          this.reasoning = crypto.randomUUID()
          this.emit({ type: "REASONING_START", modelCallId: this.modelCallId, messageId: this.reasoning })
          this.emit({ type: "REASONING_MESSAGE_START", modelCallId: this.modelCallId, messageId: this.reasoning, role: "reasoning" })
        }
        this.emit({ type: "REASONING_MESSAGE_CONTENT", modelCallId: this.modelCallId, messageId: this.reasoning, delta: part.reasoning })
      } else if (part.type === "text" && typeof part.text === "string" && part.text !== "") {
        const ended: Array<SessionEventBody> = []
        this.endReasoning(ended)
        this.emitAll(ended)
        if (this.text === null) {
          this.text = crypto.randomUUID()
          this.emit({ type: "TEXT_MESSAGE_START", modelCallId: this.modelCallId, messageId: this.text, role: "assistant" })
        }
        this.emit({ type: "TEXT_MESSAGE_CONTENT", modelCallId: this.modelCallId, messageId: this.text, delta: part.text })
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
        this.calls.set(this.callKey(id), {
          name: call.name,
          modelCallId: this.modelCallId,
          started: false,
          answered: false,
          committed: false,
        })
        this.emit({ type: "TOOL_CALL_START", modelCallId: this.modelCallId, toolCallId: id, toolCallName: call.name })
      }
      if (id !== undefined && call.args !== undefined && call.args !== "") {
        this.emit({ type: "TOOL_CALL_ARGS", modelCallId: this.modelCallId, toolCallId: id, delta: call.args })
      }
    }
  }

  /** The events that end the open messages and tool call streams of a model call, which the caller commits. */
  endEvents(): Array<SessionEventBody> {
    const ended: Array<SessionEventBody> = []
    this.endText(ended)
    this.endReasoning(ended)
    for (const id of this.streaming.values()) {
      ended.push({ type: "TOOL_CALL_END", modelCallId: this.modelCallId!, toolCallId: id })
    }
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
  commitMessage(message: AIMessage, inputBoundaryId: string) {
    const events = this.endEvents()
    for (const call of message.tool_calls ?? []) {
      const known = this.calls.get(this.callKey(call.id!))
      if (known !== undefined) {
        known.committed = true
        continue
      }
      this.calls.set(this.callKey(call.id!), {
        name: call.name,
        modelCallId: this.modelCallId!,
        started: false,
        answered: false,
        committed: true,
      })
      events.push(
        { type: "TOOL_CALL_START", modelCallId: this.modelCallId!, toolCallId: call.id!, toolCallName: call.name },
        { type: "TOOL_CALL_END", modelCallId: this.modelCallId!, toolCallId: call.id! },
      )
    }
    events.push({ type: "MODEL_CALL_COMMITTED", runId: this.context.turn.runId, modelCallId: this.modelCallId!, inputBoundaryId })
    if (!this.closed) {
      this.context.commitAssistant(message, events)
      this.committed = true
      this.context.afterCommit()
    }
  }

  started(id: string) {
    const call = this.calls.get(this.callKey(id))
    if (call === undefined || call.started) return
    call.started = true
    this.emit({ type: "TOOL_EXECUTION_STARTED", modelCallId: call.modelCallId, toolCallId: id })
  }

  /** Sets the note a canceled result of the call carries. */
  cancelNote(id: string, note: string) {
    const call = this.calls.get(this.callKey(id))
    if (call !== undefined) call.cancelNote = note
  }

  note(id: string): string | undefined {
    return this.calls.get(this.callKey(id))?.cancelNote
  }

  /** Records the call's result: an item with its event for a committed call, else the event alone. */
  result(id: string, content: ToolContent, outcome: ToolOutcome) {
    const call = this.calls.get(this.callKey(id))
    if (call === undefined || this.closed) return
    call.answered = true
    const event: SessionEventBody = {
      type: "TOOL_CALL_RESULT",
      modelCallId: call.modelCallId,
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
    for (const [key, call] of this.calls) {
      if (call.answered) continue
      const id = key.slice(key.indexOf(":") + 1)
      const content = unfinishedResult(outcome, call.started)
      this.result(id, outcome === "canceled" && call.cancelNote !== undefined ? `${content} ${call.cancelNote}` : content, outcome)
    }
  }

  /** On an interruption: settles the turn's calls as canceled when a cancel ended it, then stops emitting. */
  close(cancelled: boolean) {
    if (cancelled) this.settle("canceled")
    else this.endCall()
    if (this.modelCallId !== null && !this.committed) {
      this.emit({ type: "MODEL_CALL_DISCARDED", runId: this.context.turn.runId, modelCallId: this.modelCallId, reason: cancelled ? "cancelled" : "interrupted" })
    }
    this.closed = true
  }

  discard(reason: "failed" | "cancelled" | "interrupted") {
    if (this.modelCallId !== null) {
      this.emit({ type: "MODEL_CALL_DISCARDED", runId: this.context.turn.runId, modelCallId: this.modelCallId, reason })
    }
    this.text = null
    this.reasoning = null
    this.streaming.clear()
    const modelCallId = this.modelCallId
    for (const [key, call] of this.calls) if (call.modelCallId === modelCallId) this.calls.delete(key)
    this.modelCallId = null
    this.committed = false
  }

  /** A terminal failure: discard the uncommitted current call, then settle committed calls. */
  fail() {
    if (this.modelCallId !== null && !this.committed) this.discard("failed")
    this.settle("failed")
  }

  currentModelCallId() {
    return this.modelCallId
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
    events.fail()
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
  let modelCallOrdinal = 1

  for (;;) {
    signal.throwIfAborted()
    // The tools of this model call, which its tool calls run against.
    const offered = context.tools()
    const tools = new Map(offered.map((tool) => [tool.spec.name, tool]))
    const specs = offered.map((tool) => tool.spec)
    const issue = toolDefinitionsIssue(specs)
    if (issue !== null) throw new TurnFailure(`the model call was not sent: ${allowanceMessage(issue)}`, "tool_definitions_over_allowance")

    const window = context.window()
    const messages = renderWindow(window.harness, window.items, turn.model, model.imageInput)
    // The context limit, checked before each model call: an estimate reaching the checkpoint window size.
    const estimate = estimateCall(REQUEST_INSTRUCTIONS, messages, specs)
    if (estimate >= context.checkpointWindowSize) {
      if ((await context.limitReached(signal)) !== "retry") return { status: "finished" }
      continue
    }
    if (!context.isContextTurn() && context.checkpointWindowSize - estimate < RESERVE) {
      context.reserveReached(signal)
      return { status: "finished" }
    }
    const chunks: Array<AIMessageChunk> = []
    const modelCallId = crypto.randomUUID()
    events.startCall(modelCallId, modelCallOrdinal++)
    try {
      const call = { model: turn.model, instructions: REQUEST_INSTRUCTIONS, messages, tools: specs, ...settings }
      for await (const chunk of port.stream(call, signal)) {
        chunks.push(chunk)
        events.chunk(chunk)
      }
    } catch (error) {
      if (signal.aborted) throw error
      if (error instanceof ModelCallError && error.overflow) {
        // A provider failing the call as over its context window is the context limit too.
        events.discard("failed")
        if ((await context.limitReached(signal)) !== "retry") return { status: "finished" }
        continue
      }
      events.discard("failed")
      throw new TurnFailure(`the model call failed: ${error instanceof Error ? error.message : String(error)}`, "model_failed")
    }
    const { message, invalid } = finalMessage(chunks)
    events.commitMessage(message, crypto.randomUUID())
    for (const [id, raw] of invalid) events.result(id, `The arguments were not valid JSON: ${raw}`, "failed")

    const calls = (message.tool_calls ?? []).filter((call) => !invalid.has(call.id!))
    if (calls.length === 0 && invalid.size === 0) {
      // A step boundary after a reply without tool calls: eligible input ends the turn; a context turn's idle may go on.
      if (context.deliver()) return { status: "finished" }
      if (!context.isContextTurn()) return { status: "finished" }
      await context.idle(signal)
      return { status: "finished" }
    }
    let stopped = false
    for (const call of calls) {
      const callId = call.id!
      if (stopped) {
        events.result(callId, unfinishedResult("canceled", false), "canceled")
        continue
      }
      const result = await runTool(
        tools.get(call.name),
        call.name,
        call.args,
        callId,
        modelCallId,
        context,
        events,
        signal,
        model.imageInput,
        specs,
      )
      signal.throwIfAborted()
      if (result.outcome === "declined" && result.endTurn) stopped = true
      events.result(callId, result.content, result.outcome)
    }
    if (stopped) return { status: "finished" }
    // A step boundary after the tool results: eligible input ends this AgentTurn.
    if (context.deliver()) return { status: "finished" }
  }
}

const runTool = async (
  tool: Tool | undefined,
  name: string,
  args: unknown,
  callId: string,
  modelCallId: string,
  context: TurnContext,
  events: TurnEvents,
  signal: AbortSignal,
  imageInput: boolean,
  offered: ReadonlyArray<{ readonly name: string }>,
): Promise<ToolResult> => {
  // A name no offered tool has is the model's text, so it is not recorded.
  const toolName = tool === undefined ? "unknown" : name
  const span = startSpan("ashe_agent.tool_call", { "ashe_agent.tool": toolName, "ashe_agent.tool.in_program": false }, context.trace)
  const startedAt = performance.now()
  const ended = (outcome: ToolOutcome, timedOut = false) => {
    endSpan(
      span,
      { "ashe_agent.tool.outcome": outcome, "ashe_agent.tool.timed_out": timedOut },
      outcome === "canceled" ? "canceled" : undefined,
    )
    recordDuration("ashe_agent.tool_call.duration", (performance.now() - startedAt) / 1000, {
      "ashe_agent.tool": toolName,
      "ashe_agent.tool.outcome": outcome,
      "ashe_agent.tool.in_program": false,
      "ashe_agent.tool.timed_out": timedOut,
    })
  }
  let result: ToolResult
  if (tool === undefined) {
    result = {
      outcome: "failed",
      content: `\`${name}\` is not offered in this request, so the call did not run.\nOffered tools: ${offered.map((spec) => spec.name).join(", ")}.`,
    }
  } else {
    try {
      result = await otelContext.with(withSpan(span, context.trace), () =>
        invokeTool(tool, args, {
          sessionId: context.session.id,
          runId: context.turn.runId,
          toolCallId: callId,
          cwd: context.session.sessionDir,
          imageInput,
          signal,
          deadline: Number.POSITIVE_INFINITY,
          clock: context.toolPolicy.clock,
          authorize: (check, also) => context.authorize(callId, check, also === undefined ? signal : AbortSignal.any([signal, also])),
          started: () => events.started(callId),
          onCancel: (note) => events.cancelNote(callId, note),
          note: () => events.note(callId),
          programCall: (program, outcome) => events.emit({
            type: "PROGRAM_CALL_FINISHED",
            modelCallId,
            toolCallId: callId,
            tool: program,
            outcome,
          }),
          offered: context.offered,
        }, context.toolPolicy),
      )
    } catch (error) {
      if (signal.aborted || error instanceof IntegrityFailure) {
        ended("canceled")
        throw error
      }
      result = failedResult(error)
    }
  }
  ended(result.outcome, result.timedOut === true)
  return result
}

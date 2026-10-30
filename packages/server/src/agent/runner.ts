import { AIMessage, type AIMessageChunk } from "@langchain/core/messages"
import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import type { Model, SessionEventBody } from "@ashe-agent/protocol"
import { Effect } from "effect"
import { MAX_USABLE_CONTEXT_WINDOW } from "../inputs/shapes.ts"
import type { TurnContext, TurnOutcome, TurnRunner } from "../sessions/hub.ts"
import { REQUEST_INSTRUCTIONS } from "./blocks.ts"
import { compact, needsCompaction, SUMMARY_PROMPT_REVISION } from "./compaction.ts"
import { ModelCallError, type ModelPort } from "./model.ts"
import { unfinishedResult } from "./notes.ts"
import { failedResult, type Tool, type ToolResult } from "./tools.ts"
import { emptyWindow, renderWindow, unansweredCalls, type Entry, type ToolContent, type ToolOutcome, type Window } from "./window.ts"

export interface AgentOptions {
  readonly port: ModelPort
  /** The tools, or a function giving the tools available now, read at every model call. */
  readonly tools: ReadonlyArray<Tool> | (() => ReadonlyArray<Tool>)
  readonly saver: BaseCheckpointSaver
  readonly models: ReadonlyArray<Model>
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

const State = Annotation.Root({
  window: Annotation<Window>({ reducer: (_, next) => next, default: () => emptyWindow }),
  /** Set by a model call that overflowed, so the next step compacts. */
  overflowed: Annotation<boolean>({ reducer: (_, next) => next, default: () => false }),
  /** Set once the step's overflow was compacted, so a second overflow fails the turn. */
  retried: Annotation<boolean>({ reducer: (_, next) => next, default: () => false }),
  /** Set by a plain reject, which ends the turn. */
  stopped: Annotation<boolean>({ reducer: (_, next) => next, default: () => false }),
})

type StateValue = typeof State.State

const contentText = (content: ToolContent) =>
  typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : `[image: ${part.path}]`)).join("\n")

/**
 * Streams a model call's events as they arrive and tracks what a cancel
 * must close: open text and reasoning messages, and tool calls without a
 * result. After `close`, nothing more is emitted.
 */
class TurnEvents {
  private text: string | null = null
  private reasoning: string | null = null
  private readonly streaming = new Map<number, string>()
  /** Tool calls of the turn the model made, by id, with whether they started and got a result. */
  readonly calls = new Map<string, { started: boolean; answered: boolean; cancelNote?: string }>()
  private closed = false

  constructor(private readonly context: TurnContext) {}

  emit(body: SessionEventBody) {
    if (!this.closed) this.context.emit(body)
  }

  private endText() {
    if (this.text !== null) this.emit({ type: "TEXT_MESSAGE_END", messageId: this.text })
    this.text = null
  }

  private endReasoning() {
    if (this.reasoning === null) return
    this.emit({ type: "REASONING_MESSAGE_END", messageId: this.reasoning })
    this.emit({ type: "REASONING_END", messageId: this.reasoning })
    this.reasoning = null
  }

  chunk(chunk: AIMessageChunk) {
    const parts = typeof chunk.content === "string" ? [{ type: "text", text: chunk.content }] : chunk.content
    for (const part of parts) {
      if (part.type === "reasoning" && typeof part.reasoning === "string" && part.reasoning !== "") {
        this.endText()
        if (this.reasoning === null) {
          this.reasoning = crypto.randomUUID()
          this.emit({ type: "REASONING_START", messageId: this.reasoning })
          this.emit({ type: "REASONING_MESSAGE_START", messageId: this.reasoning, role: "reasoning" })
        }
        this.emit({ type: "REASONING_MESSAGE_CONTENT", messageId: this.reasoning, delta: part.reasoning })
      } else if (part.type === "text" && typeof part.text === "string" && part.text !== "") {
        this.endReasoning()
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
        this.endText()
        this.endReasoning()
        id = call.id
        this.streaming.set(index, id)
        this.calls.set(id, { started: false, answered: false })
        this.emit({ type: "TOOL_CALL_START", toolCallId: id, toolCallName: call.name })
      }
      if (id !== undefined && call.args !== undefined && call.args !== "") this.emit({ type: "TOOL_CALL_ARGS", toolCallId: id, delta: call.args })
    }
  }

  /** Ends the open messages and tool call streams of a model call. */
  endCall() {
    this.endText()
    this.endReasoning()
    for (const id of this.streaming.values()) this.emit({ type: "TOOL_CALL_END", toolCallId: id })
    this.streaming.clear()
  }

  /** Announces a call the final message holds that streamed no start, such as one with unparsable arguments. */
  ensureCall(id: string, name: string) {
    if (this.calls.has(id)) return
    this.calls.set(id, { started: false, answered: false })
    this.emit({ type: "TOOL_CALL_START", toolCallId: id, toolCallName: name })
    this.emit({ type: "TOOL_CALL_END", toolCallId: id })
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

  result(id: string, content: ToolContent, outcome: ToolOutcome) {
    const call = this.calls.get(id)
    if (call !== undefined) call.answered = true
    this.emit({ type: "TOOL_CALL_RESULT", messageId: crypto.randomUUID(), toolCallId: id, role: "tool", content: contentText(content), outcome })
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
 * The turn runner over a LangGraph `StateGraph` with compaction, model, tool,
 * and steering steps, checkpointed per step in the session's thread. The
 * graph runs under `Effect.promise`, whose `AbortSignal` it receives, so
 * interrupting the turn's fiber aborts it.
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
    return await runGraph(options, context, events, signal)
  } catch (error) {
    if (signal.aborted) throw error
    events.settle("failed")
    if (error instanceof TurnFailure) return { status: "failed", message: error.message, code: error.code }
    return { status: "failed", message: error instanceof Error ? error.message : String(error), code: "internal" }
  }
}

const runGraph = async (options: AgentOptions, context: TurnContext, events: TurnEvents, signal: AbortSignal): Promise<TurnOutcome> => {
  const { session, turn } = context
  const own = { runId: turn.runId, model: turn.model }
  const model = options.models.find((candidate) => candidate.id === turn.model)
  if (model === undefined) throw new TurnFailure(`the model ${turn.model} is not configured`, "model_unavailable")
  const usable = Math.min(model.contextWindow, MAX_USABLE_CONTEXT_WINDOW)
  const first = session.firstMessage
  const available = () => (typeof options.tools === "function" ? options.tools() : options.tools)
  // The tools of the latest model call, which its tool calls run against.
  let tools = new Map(available().map((tool) => [tool.spec.name, tool]))

  const steer = async (state: StateValue) => {
    const steered = context.takeSteered()
    if (steered.length === 0) return {}
    const inputs: Array<Entry> = steered.map((input) => ({ ...own, kind: "input", text: input.text }))
    return { window: { ...state.window, entries: [...state.window.entries, ...inputs] } }
  }

  const { temperature } = session.agentSettings
  const compactStep = async (state: StateValue) => {
    if (!state.overflowed && !needsCompaction(state.window, first, turn.model, usable)) return {}
    let compaction
    try {
      compaction = await compact(options.port, state.window, first, turn.model, signal, temperature)
    } catch (error) {
      if (signal.aborted) throw error
      throw new TurnFailure(`compaction failed: ${error instanceof Error ? error.message : String(error)}`, "compaction_failed")
    }
    if (compaction === null) {
      if (state.overflowed) throw new TurnFailure("the conversation exceeds the model's context window and cannot be compacted", "context_overflow")
      return {}
    }
    events.emit({
      type: "COMPACTED",
      runId: turn.runId,
      tokensBefore: compaction.tokensBefore,
      tokensAfter: compaction.tokensAfter,
      promptRevision: SUMMARY_PROMPT_REVISION,
    })
    return { window: compaction.window, overflowed: false, retried: state.overflowed }
  }

  const modelStep = async (state: StateValue) => {
    tools = new Map(available().map((tool) => [tool.spec.name, tool]))
    const chunks: Array<AIMessageChunk> = []
    const window = state.window
    try {
      const call = {
        model: turn.model,
        instructions: REQUEST_INSTRUCTIONS,
        messages: renderWindow(window, first, turn.model, model.imageInput),
        tools: [...tools.values()].map((tool) => tool.spec),
        ...(temperature === null ? {} : { temperature }),
      }
      for await (const chunk of options.port.stream(call, signal)) {
        chunks.push(chunk)
        events.chunk(chunk)
      }
    } catch (error) {
      if (signal.aborted) throw error
      // Calls the failed model call streamed never reach the window; their events get failed results.
      events.settle("failed")
      if (error instanceof ModelCallError && error.overflow) {
        if (state.retried) throw new TurnFailure("the conversation exceeds the model's context window after compaction", "context_overflow")
        return { overflowed: true }
      }
      throw new TurnFailure(`the model call failed: ${error instanceof Error ? error.message : String(error)}`, "model_failed")
    }
    events.endCall()
    const { message, invalid } = finalMessage(chunks)
    const entries: Array<Entry> = [...window.entries, { ...own, kind: "assistant", message }]
    for (const call of message.tool_calls ?? []) events.ensureCall(call.id!, call.name)
    for (const [id, raw] of invalid) {
      const name = message.tool_calls!.find((call) => call.id === id)!.name
      const content = `The arguments were not valid JSON: ${raw}`
      events.result(id, content, "failed")
      entries.push({ ...own, kind: "result", callId: id, name, content, outcome: "failed" })
    }
    const inputTokens = (message.usage_metadata as { input_tokens?: number } | undefined)?.input_tokens
    const usage = inputTokens === undefined ? null : { model: turn.model, inputTokens, entries: state.window.entries.length }
    return { window: { summary: state.window.summary, entries, usage }, retried: false }
  }

  const toolStep = async (state: StateValue) => {
    const entries = [...state.window.entries]
    let stopped = false
    for (const { callId, name, entry } of unansweredCalls(entries)) {
      if (entry.runId !== turn.runId) continue
      const call = (entry as Entry & { kind: "assistant" }).message.tool_calls!.find((candidate) => candidate.id === callId)!
      let result: ToolResult
      if (stopped) {
        result = { outcome: "failed", content: unfinishedResult("canceled", false) }
        events.result(callId, result.content, "canceled")
        entries.push({ ...own, kind: "result", callId, name, content: result.content, outcome: "canceled" })
        continue
      }
      const tool = tools.get(name)
      if (tool === undefined) {
        result = { outcome: "failed", content: `There is no tool named ${name}.` }
      } else {
        try {
          result = await tool.run(call.args, {
            sessionId: session.id,
            runId: turn.runId,
            toolCallId: callId,
            cwd: session.sessionDir,
            imageInput: model.imageInput,
            signal,
            authorize: (check, also) => context.authorize(callId, check, also === undefined ? signal : AbortSignal.any([signal, also])),
            started: () => events.started(callId),
            onCancel: (note) => events.cancelNote(callId, note),
            programCall: (tool, outcome) => events.emit({ type: "PROGRAM_CALL_FINISHED", toolCallId: callId, tool, outcome }),
          })
        } catch (error) {
          if (signal.aborted) throw error
          result = failedResult(error)
        }
      }
      if (result.outcome === "declined" && result.endTurn) stopped = true
      events.result(callId, result.content, result.outcome)
      entries.push({ ...own, kind: "result", callId, name, content: result.content, outcome: result.outcome })
    }
    return { window: { ...state.window, entries }, stopped }
  }

  const afterModel = (state: StateValue) => {
    if (state.overflowed) return "compact"
    if (state.stopped) return END
    return unansweredCalls(state.window.entries).some((call) => call.entry.runId === turn.runId) ? "tools" : "steer"
  }
  const afterTools = (state: StateValue) => (state.stopped ? END : "steer")
  const afterSteer = (state: StateValue) => (state.window.entries.at(-1)?.kind === "assistant" ? END : "compact")

  const graph = new StateGraph(State)
    .addNode("compact", compactStep)
    .addNode("model", modelStep)
    .addNode("tools", toolStep)
    .addNode("steer", steer)
    .addEdge(START, "compact")
    .addEdge("compact", "model")
    .addConditionalEdges("model", afterModel, ["compact", "tools", "steer", END])
    .addConditionalEdges("tools", afterTools, ["steer", END])
    .addConditionalEdges("steer", afterSteer, ["compact", END])
    .compile({ checkpointer: options.saver })

  const config = { configurable: { thread_id: session.id }, signal, recursionLimit: 100_000, durability: "sync" as const }
  const previous = (await graph.getState(config)).values as Partial<StateValue>
  const window = previous.window ?? emptyWindow
  const entries: Array<Entry> = [...window.entries]
  // Calls an earlier turn left without a result get the result its events recorded, else an interrupted one.
  for (const { callId, name, entry } of unansweredCalls(window.entries)) {
    const recorded = context.toolResult(callId)
    const content = recorded?.content ?? unfinishedResult("interrupted", false)
    const outcome = recorded?.outcome ?? "interrupted"
    if (recorded === null) events.result(callId, content, outcome)
    entries.push({ runId: entry.runId, model: entry.model, kind: "result", callId, name, content, outcome })
  }
  for (const note of context.notes) entries.push({ ...own, kind: "note", text: note })
  entries.push({ ...own, kind: "input", text: context.input.text })
  await graph.invoke({ window: { ...window, entries }, overflowed: false, retried: false, stopped: false }, config)
  return { status: "finished" }
}

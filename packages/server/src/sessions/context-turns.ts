import { ErrorCode, type Sender, type SessionEvent, type SessionEventBody } from "@ashe-agent/protocol"
import { TurnFailure } from "../agent/failure.ts"
import type { ModelPort } from "../agent/model.ts"
import type { Tool, ToolResult, ToolRun } from "../agent/tools.ts"
import { messageText } from "../agent/window.ts"
import {
  auxiliaryCall,
  COMPACTION_PROMPT,
  compactionInput,
  HANDOFF_PROMPT,
  handoffInput,
  handoffTranscript,
  RESEARCH_PROMPT,
  researchInput,
  type BoundaryMessage,
} from "../context/auxiliary.ts"
import { checkpointComponent, recentTranscript, trimPlan, type SecondaryTimeline } from "../context/checkpoint.ts"
import {
  continuationComponent,
  contextTurnComponent,
  timelinesTrimmed,
  validationFailed,
  type Component,
  type ContextTrigger,
} from "../context/components.ts"
import {
  CLEARING_SHARES,
  estimateTokens,
  MEMORY_FILES_MAX,
  RESERVE,
  SUMMARY_MAX_OUTPUT_TOKENS,
  VALIDATION_ATTEMPTS,
} from "../context/constants.ts"
import {
  entryRenderer,
  frontmatterDescription,
  openItems,
  renderEntry,
  researchSummary,
  resolvedNumbers,
  validateAppend,
  type AppendInput,
  type Entry,
  type NewEntry,
} from "../context/entries.ts"
import { allowanceMessage, renderSeed, unifiedDiff, type SeedSources } from "../context/seed.ts"
import { boundaryCloses, clearingPlan, countsInBoundary, resultTokens } from "../context/sizes.ts"
import { answerEntries, questionProblems, type Answer } from "../context/questions.ts"
import { CONTEXT_TOOLS, contextTools, type AskArgs } from "../context/tools.ts"
import { memoryViolations, overCount, validateFiles, violationCount, type AreaEntry } from "../context/validation.ts"
import type { AuxiliaryModels, AuxiliaryTask } from "../inputs/shapes.ts"
import { callSettings, checkpointWindowSize, type CallSettings, type ConfiguredModel } from "../models/registry.ts"
import { ProtocolError } from "../server/websocket.ts"
import type { Item } from "./conversation.ts"
import { sha256, type SessionFiles, type StoredFile } from "./files.ts"
import type { SessionRecord, SessionStore, TurnRecord } from "./store.ts"
import type { Boundary } from "./timeline.ts"

type Append = (body: SessionEventBody) => SessionEvent

/** What the context turns need of the session hub. */
export interface ContextHost {
  readonly store: SessionStore
  readonly files: SessionFiles
  readonly now: () => number
  /** Runs `write` in one transaction and sends the events it appended once it commits. */
  readonly commit: <A>(sessionId: string, write: (append: Append) => A) => A
  /** Publishes `files`, whose bytes are stored, as the session's next memory generation. */
  readonly publish: (sessionId: string, files: ReadonlyArray<StoredFile>) => void
  /**
   * The seed sources of a construction after a context turn in the
   * checkpoint window `window`, the session checkpoint aside, and the
   * errors of sources it could not read, which keep what `window` knows.
   */
  readonly seedSources: (
    session: SessionRecord,
    window: number,
  ) => {
    readonly sources: Omit<SeedSources, "tools" | "checkpoint">
    readonly errors: ReadonlyArray<{ readonly code: string; readonly message: string }>
  }
}

export interface ContextOptions {
  /** The model port auxiliary calls go to. */
  readonly port: ModelPort
  readonly models: ReadonlyArray<ConfiguredModel>
  /** The model of each auxiliary task; a task without one uses the model of the session's latest turn. */
  readonly auxiliaryModels: AuxiliaryModels
}

interface ResearchCall {
  readonly name: string
  readonly sha256: string
  readonly change: "created" | "changed"
  readonly input: string
  readonly promise: Promise<string | null>
}

/** What a running context turn holds in memory; a server stop ends the context turn, which needs none of it then. */
interface ContextTurn {
  readonly sessionId: string
  readonly runId: string
  clearings: number
  /** The estimated tokens of the clearable results before the first clearing. */
  clearable: number
  freed: number
  validations: number
  compactionWaited: boolean
  /** Whether the context turn constructed the next checkpoint window. */
  constructed: boolean
  /** The research calls since the last idle, by file name. */
  readonly research: Map<string, ResearchCall>
  /** Aborted when the context turn ends, discarding its research calls. */
  readonly controller: AbortController
}

/** A question set waiting for its answer, in memory only. */
interface PendingQuestions {
  readonly sessionId: string
  readonly runId: string
  readonly questions: AskArgs["questions"]
  readonly settle: (outcome: AskOutcome) => void
}

type AskOutcome =
  | { readonly kind: "answered"; readonly entries: ReadonlyArray<Entry>; readonly skipped: ReadonlyArray<string> }
  | { readonly kind: "message" }

const wire = (component: Component) => ({ type: component.type, heading: component.heading, text: component.text })

const invalid = (message: string) => new ProtocolError({ code: ErrorCode.invalidInput, message })

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const failed = (content: string): ToolResult => ({ outcome: "failed", content })

const seedComponent = (item: Item) => item.kind === "component" && item.component.type === "seed"

const toEvent = (entry: Entry) => ({ number: entry.number, kind: entry.kind, fields: { ...entry.fields }, resolves: [...entry.resolves] })

/** Settles as `promise` does, or rejects with the signal's reason once it aborts. */
const untilAborted = <A>(promise: Promise<A>, signal: AbortSignal): Promise<A> => {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<A>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

/**
 * The context management of every session: the `context` tools, chat
 * boundaries and their compaction calls, context turns with their
 * clearings, research calls, trims, validations, handoffs, and the
 * construction of the next checkpoint window, and questions waiting for
 * their answers.
 */
export class ContextTurns {
  private readonly turns = new Map<string, ContextTurn>()
  private readonly questions = new Map<string, PendingQuestions>()
  /** Running compaction calls, by session and boundary. */
  private readonly compactions = new Map<string, Promise<boolean>>()
  /** Each session's history version, raised by every rewind and fork; a summary call whose version changed is discarded. */
  private readonly versions = new Map<string, number>()
  /** Aborted when the server stops, ending the compaction calls that run outside turns. */
  private readonly background = new AbortController()
  /** The `context` namespace's tools. */
  readonly tools: ReadonlyArray<Tool>

  constructor(
    private readonly host: ContextHost,
    private readonly options: ContextOptions,
  ) {
    this.tools = contextTools({
      append: (run, entries) => this.append(run, entries),
      openItems: (run) => this.openItems(run),
      refuseAsk: (run, args) => this.refuseAsk(run, args),
      ask: (run, args) => this.ask(run, args),
    })
  }

  private get store() {
    return this.host.store
  }

  private get timeline() {
    return this.host.store.timeline
  }

  private get conversation() {
    return this.host.store.conversation
  }

  /** Whether the turn `runId` is a context turn now. */
  isContextTurn(runId: string) {
    return this.turns.has(runId)
  }

  /** How many clearings the context turn `runId` made. */
  clearings(runId: string) {
    return this.turns.get(runId)?.clearings ?? 0
  }

  /** Stops the compaction calls that run outside turns. */
  stop() {
    this.background.abort()
  }

  /** Discards the session's running summary calls, after a rewind or fork changed its history. */
  historyChanged(sessionId: string) {
    this.versions.set(sessionId, (this.versions.get(sessionId) ?? 0) + 1)
  }

  private version(sessionId: string) {
    return this.versions.get(sessionId) ?? 0
  }

  private render(entries: ReadonlyArray<Entry>) {
    return entryRenderer(entries)
  }

  // The timeline tools.

  private owner(sessionId: string, runId: string) {
    return { runId, windowPosition: this.conversation.currentWindow(sessionId)!.position }
  }

  /** Records entries owned by `runId` with their events, in a transaction the caller holds. */
  private record(sessionId: string, runId: string, entries: ReadonlyArray<NewEntry>, revision: string | null, append: Append) {
    const owner = this.owner(sessionId, runId)
    return entries.map((entry) => {
      const recorded = this.timeline.append(sessionId, owner, entry, revision, this.host.now())
      append({ type: "TIMELINE_ENTRY", runId, entry: toEvent(recorded) })
      return recorded
    })
  }

  private append(run: ToolRun, inputs: ReadonlyArray<AppendInput>): ToolResult {
    const existing = this.timeline.entries(run.sessionId)
    const byNumber = new Map(existing.map((entry) => [entry.number, entry]))
    const resolved = resolvedNumbers(existing)
    const checked = validateAppend(inputs, (number) => byNumber.get(number), (number) => resolved.has(number))
    if (!checked.ok) return failed(`No entry was appended: ${checked.problems.join("; ")}.`)
    const recorded = this.host.commit(run.sessionId, (append) => this.record(run.sessionId, run.runId, checked.entries, null, append))
    const render = this.render([...existing, ...recorded])
    return { outcome: "success", content: recorded.map(render).join("\n\n") }
  }

  private openItems(run: ToolRun): ToolResult {
    const entries = this.timeline.entries(run.sessionId)
    const open = openItems(entries)
    if (open.length === 0) return { outcome: "success", content: "No open items." }
    const render = this.render(entries)
    return {
      outcome: "success",
      content: open.map((entry) => `${render(entry)}\n(${entry.trimmed ? "trimmed" : "in the primary timeline"})`).join("\n\n"),
    }
  }

  // Questions.

  private refuseAsk(run: ToolRun, args: AskArgs): ToolResult | null {
    if (this.turns.has(run.runId)) return failed("`context_ask_question` is not available in a context turn. Finish the context turn first.")
    const problems = questionProblems(args)
    if (problems.length > 0) return failed(`The questions were not asked: ${problems.join("; ")}.`)
    if (args.feedback !== undefined && !this.store.hasEvent(run.sessionId, "QUESTIONS_ASKED")) {
      return failed("`feedback` responds to earlier questions, and this session has asked none. Call again without it.")
    }
    return null
  }

  private ask(run: ToolRun, args: AskArgs): Promise<ToolResult> {
    run.signal.throwIfAborted()
    const questionSetId = crypto.randomUUID()
    this.host.commit(run.sessionId, (append) =>
      append({
        type: "QUESTIONS_ASKED",
        runId: run.runId,
        toolCallId: run.toolCallId,
        questionSetId,
        ...(args.feedback === undefined ? {} : { feedback: args.feedback }),
        questions: args.questions.map((question) => ({ ...question, options: question.options.map((option) => ({ ...option })) })),
      }),
    )
    return new Promise<ToolResult>((resolve, reject) => {
      const onAbort = () => {
        this.questions.delete(questionSetId)
        reject(run.signal.reason)
      }
      run.signal.addEventListener("abort", onAbort, { once: true })
      this.questions.set(questionSetId, {
        sessionId: run.sessionId,
        runId: run.runId,
        questions: args.questions,
        settle: (outcome) => {
          run.signal.removeEventListener("abort", onAbort)
          this.questions.delete(questionSetId)
          if (outcome.kind === "message") {
            resolve({ outcome: "success", content: "The user replied with a message instead of answering; it follows." })
            return
          }
          const render = this.render(this.timeline.entries(run.sessionId))
          const lines = [
            ...(outcome.entries.length === 0 ? [] : [outcome.entries.map(render).join("\n\n")]),
            ...(outcome.skipped.length === 0 ? [] : [`Skipped: ${outcome.skipped.join(", ")}`]),
          ]
          resolve({ outcome: "success", content: lines.join("\n") })
        },
      })
    })
  }

  /**
   * Takes the first answer to the pending question set `questionSetId`:
   * each answered question becomes an answer entry, recorded with the
   * answered event, and the waiting call returns them. A set already
   * answered or ended refuses the answer.
   */
  answer(
    sessionId: string,
    questionSetId: string,
    answers: ReadonlyArray<Answer>,
    sender: Sender,
  ) {
    const pending = this.questions.get(questionSetId)
    if (pending === undefined || pending.sessionId !== sessionId) {
      const asked = this.store
        .eventsAfter(sessionId, 0)
        .some(({ event }) => event.type === "QUESTIONS_ASKED" && event.questionSetId === questionSetId)
      throw asked
        ? new ProtocolError({ code: ErrorCode.alreadyResolved, message: `question set ${questionSetId} is already answered or ended` })
        : new ProtocolError({ code: ErrorCode.notFound, message: `no question set ${questionSetId}` })
    }
    const checked = answerEntries(pending.questions, answers)
    if (!checked.ok) throw invalid(checked.problem)
    const recorded = this.host.commit(sessionId, (append) => {
      append({ type: "QUESTIONS_ANSWERED", questionSetId, answers: answers.map((answer) => ({ ...answer })), sender })
      return this.record(sessionId, pending.runId, checked.entries, null, append)
    })
    pending.settle({ kind: "answered", entries: recorded, skipped: checked.skipped })
  }

  /** Ends the session's waiting question calls: a steered user message arrived instead of an answer. */
  messageArrived(sessionId: string) {
    for (const pending of [...this.questions.values()]) if (pending.sessionId === sessionId) pending.settle({ kind: "message" })
  }

  // Chat boundaries and compaction entries.

  /** Opens a chat boundary at the user message item `position` of the turn `runId` when none is open, in a transaction the caller holds. */
  userMessage(sessionId: string, position: number, runId: string) {
    if (this.timeline.openBoundary(sessionId) === null) this.timeline.openAt(sessionId, position, runId)
  }

  /** Whether an item counts in chat boundaries: neither a seed component nor an item of a context turn. */
  private counted(item: Item, turns: ReadonlyMap<string, TurnRecord>) {
    return countsInBoundary(item, (runId) => turns.get(runId)?.contextItem ?? null)
  }

  private turnMap(sessionId: string) {
    return new Map(this.store.turns(sessionId).map((turn) => [turn.runId, turn]))
  }

  /**
   * After items of the turn `turn` were recorded: closes the open chat
   * boundary once its size reaches 60,000 tokens, owned by the turn, and
   * starts its compaction call. A context turn's items count in no
   * boundary.
   */
  afterItems(sessionId: string, turn: TurnRecord) {
    if (this.turns.has(turn.runId)) return
    const open = this.timeline.openBoundary(sessionId)
    if (open === null) return
    const items = this.conversation.itemsFrom(sessionId, open.position)
    if (items.length === 0) return
    const turns = this.turnMap(sessionId)
    if (!boundaryCloses(items, (runId) => turns.get(runId)?.contextItem ?? null)) return
    const through = items.at(-1)!.position
    this.host.commit(sessionId, () => this.timeline.close(sessionId, open.position, turn.runId, through))
    void this.summarize(sessionId, open.position)
  }

  /**
   * The messages of a chat boundary in order: its user messages and the
   * final agent message of each turn, or a marker for a turn that ended
   * without one, through the boundary's last item. A turn that became a
   * context turn has neither.
   */
  private boundaryMessages(sessionId: string, boundary: Boundary): { readonly messages: ReadonlyArray<BoundaryMessage>; readonly covers: ReadonlyArray<number> } {
    const turns = this.turnMap(sessionId)
    const items = this.conversation.itemsFrom(sessionId, boundary.position).filter((item) => this.counted(item, turns))
    const through = boundary.closedThrough ?? Number.POSITIVE_INFINITY
    const lastOf = new Map<string, Item>()
    for (const item of items) if (item.runId !== null) lastOf.set(item.runId, item)
    const messages: Array<BoundaryMessage> = []
    const covers: Array<number> = []
    for (const item of items) {
      if (item.position > through) break
      if (item.kind === "user") {
        messages.push({ kind: "user", text: item.text })
        covers.push(item.position)
      }
      const turn = item.runId === null ? undefined : turns.get(item.runId)
      if (turn === undefined || lastOf.get(turn.runId) !== item || turn.status === "running" || turn.contextItem !== null) continue
      if (turn.status === "finished" && item.kind === "assistant" && (item.message.tool_calls ?? []).length === 0) {
        const text = messageText(item.message)
        if (text.trim() !== "") {
          messages.push({ kind: "agent", text })
          covers.push(item.position)
        }
      } else if (turn.status === "finished" && item.kind === "result" && item.outcome === "declined") {
        messages.push({ kind: "no_reply", reason: "rejected" })
      } else if (turn.status !== "finished") {
        messages.push({ kind: "no_reply", reason: turn.status === "cancelled" ? "canceled" : turn.status === "interrupted" ? "restarted" : "failed" })
      }
    }
    return { messages, covers }
  }

  /** Whether a boundary has a compaction call due: no entry, or an untrimmed entry that covers fewer than all its messages. */
  private due(sessionId: string, boundary: Boundary) {
    const compaction = this.timeline.compaction(sessionId, boundary.position)
    if (compaction === null) return true
    if (compaction.trimmed) return false
    const covered = new Set(compaction.covers)
    return this.boundaryMessages(sessionId, boundary).covers.some((position) => !covered.has(position))
  }

  /** The model and settings of an auxiliary task: its configured model, else the model of the session's latest turn. */
  private auxiliary(task: AuxiliaryTask, session: SessionRecord): { readonly model: ConfiguredModel; readonly settings: CallSettings } {
    const latest = this.store.turns(session.id).at(-1)
    const id = this.options.auxiliaryModels[task] ?? latest?.model ?? session.model
    const model = this.options.models.find((candidate) => candidate.id === id)
    if (model === undefined) throw new Error(`the ${task} model ${id} is not configured`)
    const selection = latest !== undefined && latest.model === model.id ? latest.reasoningEffort : null
    return { model, settings: callSettings(model, session.modelOverrides[model.id], selection) }
  }

  /**
   * Runs the compaction call of the boundary `position`, unless one runs
   * already, and stores its output as the boundary's compaction entry, or
   * as that entry's new text. Resolves to whether it succeeded; a rewind
   * or fork meanwhile discards the output.
   */
  private summarize(sessionId: string, position: number): Promise<boolean> {
    const key = `${sessionId} ${position}`
    const running = this.compactions.get(key)
    if (running !== undefined) return running
    const version = this.version(sessionId)
    const call = (async () => {
      try {
        const session = this.store.getSession(sessionId)
        const boundary = this.timeline.boundaries(sessionId).find((candidate) => candidate.position === position)
        if (session === null || boundary === undefined) return false
        const { model, settings } = this.auxiliary("compaction", session)
        const { messages, covers } = this.boundaryMessages(sessionId, boundary)
        const entries = this.timeline.entries(sessionId)
        const render = this.render(entries)
        const timeline = entries.filter((entry) => !entry.trimmed).map(render)
        const output = await auxiliaryCall(
          this.options.port,
          { model: model.id, settings, prompt: COMPACTION_PROMPT, input: compactionInput(timeline, messages), maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS },
          this.background.signal,
        )
        if (output.text === "" || this.version(sessionId) !== version || this.store.getSession(sessionId) === null) return false
        this.host.commit(sessionId, (append) => {
          // Only an entry still in the primary timeline is replaced; a trimmed one keeps its text.
          if (this.timeline.compaction(sessionId, position)?.trimmed === true) return
          const latest = this.store.turns(sessionId).at(-1)!
          const owner = this.owner(sessionId, latest.runId)
          const stored = this.timeline.storeCompaction(sessionId, position, owner, output.text, covers, COMPACTION_PROMPT.revision, this.host.now())
          append(
            stored.replaced
              ? { type: "TIMELINE_ENTRY_REPLACED", runId: latest.runId, number: stored.entry.number, text: output.text }
              : { type: "TIMELINE_ENTRY", runId: latest.runId, entry: toEvent(stored.entry) },
          )
        })
        return true
      } catch {
        return false
      } finally {
        this.compactions.delete(key)
      }
    })()
    this.compactions.set(key, call)
    return call
  }

  /**
   * Before a context turn's first trim or validation: waits for the
   * session's running compaction calls, then runs each call still due
   * once more; a call that fails again ends the turn. A cancel ends the
   * wait at once, leaving the calls to finish in the background.
   */
  private async compactionStep(sessionId: string, state: ContextTurn) {
    if (state.compactionWaited) return
    state.compactionWaited = true
    const signal = state.controller.signal
    await untilAborted(Promise.all([...this.compactions.entries()].filter(([key]) => key.startsWith(`${sessionId} `)).map(([, call]) => call)), signal)
    for (const boundary of this.timeline.boundaries(sessionId)) {
      if (!this.due(sessionId, boundary)) continue
      if (await untilAborted(this.summarize(sessionId, boundary.position), signal)) continue
      const first = this.conversation.itemsFrom(sessionId, boundary.position)[0]
      const message = first?.kind === "user" ? ` from the user message ${first.inputId}` : ""
      throw new TurnFailure(`the compaction call for the chat boundary${message} failed twice`, "compaction_failed")
    }
  }

  // Context turns.

  /** The entries directly inside an area as validation reads them. */
  private area(sessionId: string, area: "research" | "memory-draft"): ReadonlyArray<AreaEntry> {
    return this.host.files
      .listArea(sessionId, area)
      .map((entry) => ({ name: entry.name, text: entry.file === null ? null : Buffer.from(entry.file.data).toString("utf8") }))
  }

  private draftFiles(sessionId: string): ReadonlyArray<StoredFile> {
    return this.host.files.listArea(sessionId, "memory-draft").flatMap((entry) => (entry.file === null ? [] : [entry.file]))
  }

  private validate(sessionId: string) {
    const entries = this.timeline.entries(sessionId)
    return validateFiles(this.area(sessionId, "research"), this.area(sessionId, "memory-draft"), entries, this.render(entries))
  }

  /** Delivers one of the context turn's own notification components into its turn, without state components. */
  private deliverOwn(sessionId: string, turn: TurnRecord, component: Component, also: (append: Append, position: number) => void = () => {}) {
    this.host.commit(sessionId, (append) => {
      const window = this.conversation.currentWindow(sessionId)!
      const item = this.conversation.appendItem(sessionId, window.position, { runId: turn.runId, model: turn.model }, { kind: "component", component })
      append({ type: "DEVELOPER_MESSAGE", runId: turn.runId, components: [wire(component)] })
      also(append, item.position)
    })
  }

  private state(runId: string) {
    const state = this.turns.get(runId)
    if (state === undefined) throw new Error(`the turn ${runId} is no context turn`)
    return state
  }

  /**
   * Makes the rest of the turn a context turn: writes the memory draft,
   * delivers the context turn component with the violations found, and
   * starts the research calls and the open boundary's compaction call.
   * A turn at the context limit is cleared first.
   */
  start(session: SessionRecord, turn: TurnRecord, trigger: ContextTrigger, signal: AbortSignal) {
    const sessionId = session.id
    const controller = new AbortController()
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
    const state: ContextTurn = {
      sessionId,
      runId: turn.runId,
      clearings: 0,
      clearable: 0,
      freed: 0,
      validations: 0,
      compactionWaited: false,
      constructed: false,
      research: new Map(),
      controller,
    }
    this.turns.set(turn.runId, state)
    if (trigger === "limit") this.clear(turn)
    const fileState = this.store.files
    this.host.files.writeDraft(sessionId, fileState.files(fileState.generationFiles(sessionId, fileState.generations(sessionId).memory)))
    const violations = this.validate(sessionId)
    const component = contextTurnComponent({
      trigger,
      reserve: RESERVE,
      violations: [...violations.research, ...violations.memory.filter((line) => line !== overCount(violations.count))],
      count: violations.count,
      maxFiles: MEMORY_FILES_MAX,
    })
    this.deliverOwn(sessionId, turn, component, (append, position) => {
      this.store.markContextTurn(sessionId, turn.runId, position, trigger)
      append({ type: "CONTEXT_TURN_STARTED", runId: turn.runId, trigger })
    })
    this.startResearch(session, state)
    const open = this.timeline.openBoundary(sessionId)
    if (open !== null && this.due(sessionId, open)) void this.summarize(sessionId, open.position)
  }

  /**
   * The context turn's next clearing: replaces the oldest tool results of
   * the current checkpoint window other than `context` results with a
   * placeholder until 25%, 50%, or all of the clearable results' tokens
   * before the first clearing are freed.
   */
  private clear(turn: TurnRecord) {
    const state = this.state(turn.runId)
    const sessionId = state.sessionId
    const attempt = (state.clearings + 1) as 1 | 2 | 3
    const window = this.conversation.currentWindow(sessionId)!
    const clearable = this.conversation
      .items(sessionId, window.position)
      .flatMap((item) => (item.kind === "result" && item.cleared !== true && !CONTEXT_TOOLS.has(item.name) ? [item] : []))
    if (attempt === 1) state.clearable = clearable.reduce((sum, item) => sum + resultTokens(item), 0)
    const { positions, freed } = clearingPlan(clearable, attempt, state.clearable, state.freed)
    state.freed += freed
    this.host.commit(sessionId, (append) => {
      this.conversation.clear(sessionId, turn.runId, attempt, positions)
      append({ type: "TOOL_RESULTS_CLEARED", runId: turn.runId, attempt, tokensFreed: freed })
    })
    state.clearings = attempt
  }

  /**
   * A model call of the turn reached the context limit: a turn that is no
   * context turn becomes one after its first clearing, a context turn is
   * cleared again, and after its third clearing it hands off and ends.
   */
  async limitReached(session: SessionRecord, turn: TurnRecord, signal: AbortSignal): Promise<"retry" | "ended"> {
    const state = this.turns.get(turn.runId)
    if (state === undefined) {
      this.start(session, turn, "limit", signal)
      return "retry"
    }
    if (state.clearings < CLEARING_SHARES.length) {
      this.clear(turn)
      return "retry"
    }
    await this.handoff(session, turn, state)
    return "ended"
  }

  /**
   * Starts a research call for each of the research `files` created or
   * changed against the baseline whose current digest no call covers.
   */
  private startResearch(session: SessionRecord, state: ContextTurn, files: ReadonlyArray<StoredFile> = this.host.files.readResearch(session.id)) {
    const sessionId = session.id
    const baseline = new Map(this.conversation.baseline(sessionId, this.conversation.currentWindow(sessionId)!.position).map((file) => [file.name, file.sha256]))
    const names = new Set(files.map((file) => file.name))
    const created = files.filter((file) => !baseline.has(file.name)).map((file) => file.name)
    const deleted = [...baseline.keys()].filter((name) => !names.has(name))
    for (const file of files) {
      const before = baseline.get(file.name)
      if (before === file.sha256 || state.research.get(file.name)?.sha256 === file.sha256) continue
      const text = Buffer.from(file.data).toString("utf8")
      const previous = before === undefined ? null : (this.conversation.content(before) ?? "")
      const input = researchInput({
        name: file.name,
        change: previous === null ? "created" : "changed",
        description: frontmatterDescription(text)?.description ?? "",
        body: previous === null ? text : unifiedDiff(file.name, previous, text),
        created: created.filter((name) => name !== file.name),
        deleted,
      })
      const change = previous === null ? "created" : "changed"
      state.research.set(file.name, { name: file.name, sha256: file.sha256, change, input, promise: this.research(session, input, state) })
    }
  }

  /** Runs one research call, resolving to its summary, or to null when it failed. */
  private async research(session: SessionRecord, input: string, state: ContextTurn): Promise<string | null> {
    try {
      const { model, settings } = this.auxiliary("research", session)
      const output = await auxiliaryCall(this.options.port, { model: model.id, settings, prompt: RESEARCH_PROMPT, input }, state.controller.signal)
      return researchSummary(output.text)
    } catch {
      return null
    }
  }

  /**
   * Appends a research entry for each research file the calls since the
   * last idle cover, in file name order, after starting the calls still
   * needed and retrying each failed one once, and sets the checkpoint
   * window's baseline to the research files the calls saw.
   */
  private async researchStep(session: SessionRecord, turn: TurnRecord, state: ContextTurn) {
    const sessionId = session.id
    const files = this.host.files.readResearch(sessionId)
    this.startResearch(session, state, files)
    const window = this.conversation.currentWindow(sessionId)!.position
    const baseline = this.conversation.baseline(sessionId, window)
    const same =
      baseline.length === files.length && files.every((file) => baseline.some((known) => known.name === file.name && known.sha256 === file.sha256))
    // A call for a file deleted or changed back since it started covers nothing now.
    const calls = [...state.research.values()]
      .filter((call) => files.some((file) => file.name === call.name && file.sha256 === call.sha256))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    if (same) {
      state.research.clear()
      return
    }
    const summaries: Array<{ readonly call: ResearchCall; readonly summary: string }> = []
    for (const call of calls) {
      let summary = await call.promise
      if (summary === null) {
        state.controller.signal.throwIfAborted()
        summary = await this.research(session, call.input, state)
      }
      state.controller.signal.throwIfAborted()
      if (summary === null) throw new TurnFailure(`the research call for research/${call.name} failed twice`, "research_failed")
      summaries.push({ call, summary })
    }
    this.host.commit(sessionId, (append) => {
      const entries = summaries.map(({ call, summary }): NewEntry => ({ kind: "research", fields: { FileName: call.name, Change: call.change, Summary: summary } }))
      this.record(sessionId, turn.runId, entries, RESEARCH_PROMPT.revision, append)
      this.store.files.putFiles(files)
      this.conversation.recordBaseline(sessionId, window, turn.runId, files)
    })
    state.research.clear()
  }

  /** The secondary timelines the memory draft holds, as the checkpoint lists them. */
  private draftTimelines(sessionId: string): ReadonlyArray<SecondaryTimeline> {
    return this.area(sessionId, "memory-draft").flatMap((entry) =>
      entry.text === null ? [] : [{ path: `memory/${entry.name}`, description: frontmatterDescription(entry.text)?.description ?? "" }],
    )
  }

  /**
   * Trims the oldest primary timeline entries until it fits the timelines
   * allowance beside the secondary timelines `timelines`, the memory
   * draft's by default, closing the chat boundary of each trimmed
   * compaction entry. Returns the trimmed entries, or null when none had
   * to go.
   */
  private trim(sessionId: string, runId: string, timelines = this.draftTimelines(sessionId)): ReadonlyArray<Entry> | null {
    const entries = this.timeline.entries(sessionId)
    const numbers = trimPlan(sessionId, entries, timelines, this.render(entries))
    if (numbers.length === 0) return null
    this.host.commit(sessionId, () => {
      this.timeline.trim(sessionId, runId, numbers)
      const last = this.conversation.lastItemPosition(sessionId)
      for (const number of numbers) {
        const boundary = this.timeline.boundaryOf(sessionId, number)
        const open = this.timeline.openBoundary(sessionId)
        if (boundary !== null && open?.position === boundary) this.timeline.close(sessionId, boundary, runId, last)
      }
    })
    const trimmed = new Set(numbers)
    return entries.filter((entry) => trimmed.has(entry.number))
  }

  /**
   * The idle of a context turn: research entries first, then, once, the
   * compaction calls; a trim delivers a timelines trimmed component and
   * the context turn goes on; otherwise validation passing publishes the
   * draft and constructs the next checkpoint window, and failing delivers
   * a failed validation component, or after the third failure falls back.
   */
  async idle(session: SessionRecord, turn: TurnRecord): Promise<"continue" | "ended"> {
    const state = this.state(turn.runId)
    const sessionId = session.id
    await this.researchStep(session, turn, state)
    await this.compactionStep(sessionId, state)
    // Trimming, validation, publishing, and construction run without a
    // further wait, so no cancel can land between them.
    state.controller.signal.throwIfAborted()
    const trimmed = this.trim(sessionId, turn.runId)
    if (trimmed !== null) {
      const window = this.conversation.currentWindow(sessionId)!.position
      const render = this.render(this.timeline.entries(sessionId))
      const unseen = trimmed.filter((entry) => (entry.kind === "compaction" || entry.kind === "research") && entry.windowPosition === window)
      this.deliverOwn(sessionId, turn, timelinesTrimmed(trimmed[0]!.number, trimmed.at(-1)!.number, unseen.map(render)))
      return "continue"
    }
    const violations = this.validate(sessionId)
    if (violationCount(violations) === 0) {
      this.publishDraft(sessionId)
      this.construct(session, turn, state, {})
      return "ended"
    }
    state.validations += 1
    const lines = [...violations.research, ...violations.memory]
    if (state.validations < VALIDATION_ATTEMPTS) {
      this.deliverOwn(sessionId, turn, validationFailed(state.validations, VALIDATION_ATTEMPTS, lines), (append) =>
        append({ type: "VALIDATION_FAILED", runId: turn.runId, attempt: state.validations, violations: lines }),
      )
      return "continue"
    }
    this.host.commit(sessionId, (append) => append({ type: "VALIDATION_FAILED", runId: turn.runId, attempt: state.validations, violations: lines }))
    const unsorted = this.settleDraft(sessionId, turn.runId, true)
    this.construct(session, turn, state, unsorted === undefined ? {} : { unsorted })
    return "ended"
  }

  /**
   * The handoff after a third clearing: a handoff call over the checkpoint
   * window's transcript stores a handoff entry, then the context turn ends
   * as an idle does, without a timelines trimmed component, validates once,
   * and falls back when that fails.
   */
  private async handoff(session: SessionRecord, turn: TurnRecord, state: ContextTurn) {
    const sessionId = session.id
    const { model, settings } = this.auxiliary("handoff", session)
    const entries = this.timeline.entries(sessionId)
    const render = this.render(entries)
    const timeline = entries.filter((entry) => !entry.trimmed).map(render)
    const budget =
      checkpointWindowSize(model, session.modelOverrides[model.id]) -
      estimateTokens(HANDOFF_PROMPT.text) -
      estimateTokens(timeline.join("\n\n")) -
      SUMMARY_MAX_OUTPUT_TOKENS
    const window = this.conversation.currentWindow(sessionId)!.position
    const transcript = handoffTranscript(this.conversation.items(sessionId, window).filter((item) => !seedComponent(item)), budget)
    if (transcript === null) throw new TurnFailure("the handoff transcript does not fit the handoff model even with user text only", "handoff_failed")
    let output: { readonly text: string; readonly truncated: boolean }
    try {
      output = await auxiliaryCall(
        this.options.port,
        { model: model.id, settings, prompt: HANDOFF_PROMPT, input: handoffInput(timeline, transcript), maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS },
        state.controller.signal,
      )
    } catch (error) {
      state.controller.signal.throwIfAborted()
      throw new TurnFailure(`the handoff call failed: ${errorText(error)}`, "handoff_failed")
    }
    if (output.truncated) throw new TurnFailure("the handoff call stopped at its output limit", "handoff_failed")
    if (output.text === "") throw new TurnFailure("the handoff call returned no text", "handoff_failed")
    const [handoff] = this.host.commit(sessionId, (append) =>
      this.record(sessionId, turn.runId, [{ kind: "handoff", fields: { Text: output.text } }], HANDOFF_PROMPT.revision, append),
    )
    await this.researchStep(session, turn, state)
    await this.compactionStep(sessionId, state)
    state.controller.signal.throwIfAborted()
    this.trim(sessionId, turn.runId)
    const violations = this.validate(sessionId)
    if (violationCount(violations) === 0) {
      this.publishDraft(sessionId)
      this.construct(session, turn, state, { handoff: handoff!.number })
      return
    }
    const lines = [...violations.research, ...violations.memory]
    this.host.commit(sessionId, (append) => append({ type: "VALIDATION_FAILED", runId: turn.runId, attempt: 1, violations: lines }))
    const unsorted = this.settleDraft(sessionId, turn.runId, true)
    this.construct(session, turn, state, { handoff: handoff!.number, ...(unsorted === undefined ? {} : { unsorted }) })
  }

  /** Publishes the memory draft as the session's next memory generation and removes it. */
  private publishDraft(sessionId: string) {
    const files = this.draftFiles(sessionId)
    this.store.files.putFiles(files)
    this.host.publish(sessionId, files)
    this.host.files.removeDraft(sessionId)
  }

  /**
   * Settles the memory draft of a context turn that did not pass
   * validation: a draft passing the secondary timeline checks is
   * published; otherwise, when the context turn trimmed entries, the
   * current memory generation is published with them added as
   * `unsorted-<first>-<last>.md`; otherwise the draft is discarded.
   * With `fit`, for a checkpoint window built next, the context turn
   * first trims further until the primary timeline fits its allowance
   * beside the secondary timelines that memory will hold. Returns the
   * unsorted file when there is one.
   */
  private settleDraft(sessionId: string, runId: string, fit = false): { readonly first: number; readonly last: number; readonly path: string } | undefined {
    const files = this.host.files
    if (!files.hasDraft(sessionId)) return undefined
    const stored = this.timeline.entries(sessionId)
    if (memoryViolations(this.area(sessionId, "memory-draft"), stored, this.render(stored)).length === 0) {
      this.publishDraft(sessionId)
      return undefined
    }
    const fileState = this.store.files
    const current = fileState.files(fileState.generationFiles(sessionId, fileState.generations(sessionId).memory))
    const unsortedFile = () => {
      const entries = this.timeline.entries(sessionId)
      const trimmed = new Set(this.timeline.trimmedBy(sessionId, runId))
      const moved = entries.filter((entry) => trimmed.has(entry.number))
      if (moved.length === 0) return null
      const first = moved[0]!.number
      const last = moved.at(-1)!.number
      const description = `Entries #${first} to #${last}, trimmed in one context turn and not yet sorted`
      // A double-quoted YAML string, since ` #` would start a comment.
      const data = Buffer.from(`---\ndescription: ${JSON.stringify(description)}\n---\n\n${moved.map(this.render(entries)).join("\n\n")}\n`, "utf8")
      return { first, last, description, file: { name: `unsorted-${first}-${last}.md`, data, sha256: sha256(data) } satisfies StoredFile }
    }
    const listing = (unsorted: { readonly file: StoredFile; readonly description: string } | null): ReadonlyArray<SecondaryTimeline> =>
      [...current.filter((other) => other.name !== unsorted?.file.name), ...(unsorted === null ? [] : [unsorted.file])]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((other) => ({
          path: `memory/${other.name}`,
          description:
            other === unsorted?.file ? unsorted.description : (frontmatterDescription(Buffer.from(other.data).toString("utf8"))?.description ?? ""),
        }))
    while (fit && this.trim(sessionId, runId, listing(unsortedFile())) !== null) continue
    const unsorted = unsortedFile()
    if (unsorted === null) {
      files.removeDraft(sessionId)
      return undefined
    }
    const { first, last, file } = unsorted
    const published = [...current.filter((other) => other.name !== file.name), file].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    fileState.putFiles(published)
    this.host.publish(sessionId, published)
    files.removeDraft(sessionId)
    return { first, last, path: `memory/${file.name}` }
  }

  /**
   * Constructs the next checkpoint window after the context turn: a fresh
   * seed ending with the session checkpoint, owned by the context turn,
   * with its research baseline, and the continuation component waiting to
   * start the continuation turn. A component over its allowance fails the
   * construction, which leaves the current checkpoint window and ends the
   * turn.
   */
  private construct(
    session: SessionRecord,
    turn: TurnRecord,
    state: ContextTurn,
    extras: { readonly handoff?: number; readonly unsorted?: { readonly first: number; readonly last: number; readonly path: string } },
  ) {
    const sessionId = session.id
    const old = this.conversation.currentWindow(sessionId)!
    const contextItem = this.store.getTurn(sessionId, turn.runId)!.contextItem ?? Number.POSITIVE_INFINITY
    const before = this.conversation.items(sessionId, old.position).filter((item) => item.position < contextItem && !seedComponent(item))
    const entries = this.timeline.entries(sessionId)
    const fileState = this.store.files
    const generation = fileState.generationFiles(sessionId, fileState.generations(sessionId).memory)
    const checkpoint = checkpointComponent({
      sessionId,
      timelines: generation.map((file) => ({
        path: `memory/${file.name}`,
        description: frontmatterDescription(this.conversation.content(file.sha256) ?? "")?.description ?? "",
      })),
      entries,
      render: this.render(entries),
      transcript: recentTranscript(before),
    })
    const { sources, errors } = this.host.seedSources(session, old.position)
    if (errors.length > 0) {
      this.host.commit(sessionId, (append) => {
        for (const error of errors) append({ type: "SESSION_ERROR", code: error.code, message: error.message, runId: turn.runId })
      })
    }
    const seed = renderSeed({ ...sources, checkpoint, tools: null })
    if (!seed.ok) {
      const message = `the next checkpoint window cannot be built: ${allowanceMessage(seed.issue)}`
      this.host.commit(sessionId, (append) => append({ type: "CHECKPOINT_WINDOW_FAILED", runId: turn.runId, message }))
      throw new TurnFailure(message, "checkpoint_window_failed")
    }
    const research = this.host.files.readResearch(sessionId)
    this.host.commit(sessionId, (append) => {
      const now = this.host.now()
      if (sources.instructions !== null) this.conversation.putContent(sources.instructions.sha256, sources.instructions.text)
      const window = this.conversation.insertWindow(sessionId, turn.runId, sources.harness, now)
      for (const component of seed.components) {
        this.conversation.appendItem(sessionId, window.position, { runId: turn.runId, model: turn.model }, { kind: "component", component })
      }
      this.store.files.putFiles(research)
      this.conversation.recordBaseline(sessionId, window.position, turn.runId, research)
      this.conversation.addWaiting(sessionId, { kind: "notification", component: continuationComponent(extras) }, now)
      append({ type: "CHECKPOINT_WINDOW_SEEDED", runId: turn.runId, window: window.position, components: seed.components.map(wire) })
    })
    state.constructed = true
  }

  /**
   * Ends the context turn `runId`'s memory state when its turn ends:
   * discards its research calls and, unless it constructed the next
   * checkpoint window, settles its draft as a context turn ended early.
   */
  ended(sessionId: string, runId: string) {
    const state = this.turns.get(runId)
    if (state === undefined) return
    this.turns.delete(runId)
    state.controller.abort()
    if (!state.constructed) this.settleDraft(sessionId, runId)
  }

  /**
   * At server start: settles the draft of each context turn a stop left
   * running, unless it had constructed the next checkpoint window, and
   * removes every other memory draft.
   */
  settleAtStart() {
    const running = new Map<string, string>()
    for (const { sessionId, runId } of this.store.runningTurns()) {
      if (this.store.getTurn(sessionId, runId)?.contextItem != null) running.set(sessionId, runId)
    }
    for (const session of this.store.sessions()) {
      if (!this.host.files.hasDraft(session.id)) continue
      const runId = running.get(session.id)
      const constructed = runId !== undefined && this.conversation.currentWindow(session.id)?.runId === runId
      if (runId === undefined || constructed) this.host.files.removeDraft(session.id)
      else this.settleDraft(session.id, runId)
    }
  }
}

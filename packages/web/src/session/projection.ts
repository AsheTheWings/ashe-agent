/**
 * A session's view: the conversation items and state that its events
 * produce, folded one event at a time in sequence order.
 */
import type { InputMode, PermissionAnswer, Sender, SessionEvent, SessionEventBody } from "@ashe-agent/protocol"

type ToolOutcome = Extract<SessionEventBody, { type: "TOOL_CALL_RESULT" }>["outcome"]
type Body<T extends SessionEventBody["type"]> = Extract<SessionEventBody, { type: T }>

export type TimelineEntry = Body<"TIMELINE_ENTRY">["entry"]
export type DeveloperComponent = Body<"DEVELOPER_MESSAGE">["components"][number]
export type Question = Body<"QUESTIONS_ASKED">["questions"][number]
export type QuestionAnswer = Body<"QUESTIONS_ANSWERED">["answers"][number]

export type TextPart = { readonly type: "text"; readonly id: string; readonly text: string }

export type ReasoningPart = { readonly type: "reasoning"; readonly id: string; readonly text: string }

export type ProgramCall = { readonly tool: string; readonly outcome: ToolOutcome }

export type ToolPart = {
  readonly type: "tool"
  readonly id: string
  readonly name: string
  readonly argsText: string
  /** Whether the server started running the call. */
  readonly started: boolean
  readonly result: { readonly content: string; readonly outcome: ToolOutcome } | null
  readonly programCalls: ReadonlyArray<ProgramCall>
}

export type AssistantPart = TextPart | ReasoningPart | ToolPart

export type UserItem = {
  readonly kind: "user"
  readonly id: string
  readonly seq: number
  readonly text: string
  readonly mode: InputMode
  readonly sender: Sender
  /** The turn this input started; null for an input that joined a running turn. */
  readonly runId: string | null
}

export type RunStatus = "running" | "finished" | "cancelled" | "failed" | "interrupted"

/**
 * The assistant's output in one turn between two inputs; a turn that an
 * input steered has one segment before the input and one after it.
 */
export type AssistantItem = {
  readonly kind: "assistant"
  readonly id: string
  readonly seq: number
  readonly runId: string
  readonly parts: ReadonlyArray<AssistantPart>
  readonly status: RunStatus
  readonly error: string | null
}

export type NoticeItem = { readonly kind: "notice"; readonly id: string; readonly seq: number; readonly text: string }

/** A session error, shown where it happened among the other items. */
export type ErrorItem = { readonly kind: "error"; readonly id: string; readonly seq: number; readonly code: string; readonly text: string }

/** A timeline entry at the point it was recorded, with the current text of a replaced compaction entry. */
export type EntryItem = {
  readonly kind: "entry"
  readonly id: string
  readonly seq: number
  readonly runId: string
  readonly entry: TimelineEntry
  /** The done entry that resolved this open or problem entry, if one did. */
  readonly resolvedBy: number | null
}

/** A developer message at the point it was delivered. */
export type DeveloperItem = {
  readonly kind: "developer"
  readonly id: string
  readonly seq: number
  readonly runId: string
  readonly components: ReadonlyArray<DeveloperComponent>
}

/** A mark of context work or of what started a turn. */
export type Mark =
  | { readonly mark: "context_turn"; readonly trigger: "threshold" | "limit" }
  | { readonly mark: "clearing"; readonly attempt: number; readonly tokensFreed: number }
  | { readonly mark: "window"; readonly window: number }
  | { readonly mark: "continuation" }
  | { readonly mark: "developer_turn" }
  | { readonly mark: "validation_failed"; readonly attempt: number; readonly violations: ReadonlyArray<string> }

export type MarkItem = { readonly kind: "mark"; readonly id: string; readonly seq: number; readonly runId: string } & Mark

/** A question set the agent asked: open until answered or until its call ends. */
export type QuestionsItem = {
  readonly kind: "questions"
  readonly id: string
  readonly seq: number
  readonly runId: string
  readonly toolCallId: string
  readonly feedback: string | null
  readonly questions: ReadonlyArray<Question>
  readonly answers: ReadonlyArray<QuestionAnswer> | null
  /** Whether the set still takes an answer: no answer yet, and its call and turn still wait. */
  readonly open: boolean
}

export type Item = UserItem | AssistantItem | NoticeItem | ErrorItem | EntryItem | DeveloperItem | MarkItem | QuestionsItem

/** A user message waiting for a turn, from its `INPUT_WAITING` until its `INPUT_RECEIVED`. */
export type PendingInput = {
  readonly inputId: string
  readonly seq: number
  readonly text: string
  readonly mode: InputMode
  readonly sender: Sender
}

export type PendingPermission = {
  readonly requestId: string
  readonly runId: string
  readonly toolCallId: string
  readonly permission: string
  readonly subjects: ReadonlyArray<string>
  readonly patterns: ReadonlyArray<string>
}

export type SessionView = {
  readonly sessionId: string
  /** The number of the last event applied; 0 before any. */
  readonly lastSeq: number
  /** The applied events, kept so a rewind can fold the ones it keeps again. */
  readonly events: ReadonlyArray<SessionEvent>
  readonly sessionDir: string | null
  readonly agent: string | null
  /** The selected model, which the next turn uses. */
  readonly model: string | null
  /** The selected reasoning effort, or null for the model's default. */
  readonly reasoningEffort: string | null
  readonly forkedFrom: { readonly sessionId: string; readonly runId: string | null } | null
  /** The running turn, or null when the session is idle. */
  readonly runId: string | null
  readonly items: ReadonlyArray<Item>
  readonly pending: ReadonlyArray<PendingInput>
  readonly permissions: ReadonlyArray<PendingPermission>
  /** How many assistant segments each turn has, for segment ids. */
  readonly segments: Readonly<Record<string, number>>
}

export const emptyView = (sessionId: string): SessionView => ({
  sessionId,
  lastSeq: 0,
  events: [],
  sessionDir: null,
  agent: null,
  model: null,
  reasoningEffort: null,
  forkedFrom: null,
  runId: null,
  items: [],
  pending: [],
  permissions: [],
  segments: {},
})

const answerText: Record<PermissionAnswer, string> = { once: "allowed once", always: "always allowed", reject: "rejected" }

/**
 * Applies one event; an event at or before `lastSeq` was already applied
 * and changes nothing. A rewind drops the events it removes and, as the
 * server does, the `INPUT_WAITING` events of the inputs whose
 * `INPUT_RECEIVED` it removes, then folds the kept events again.
 */
export const applyEvent = (view: SessionView, event: SessionEvent): SessionView => {
  if (event.seq <= view.lastSeq) return view
  const body = event.event
  if (body.type === "SESSION_REWOUND") {
    const removed = new Set(
      view.events.flatMap(({ seq, event }) => (seq >= body.firstRemovedSeq && event.type === "INPUT_RECEIVED" ? [event.inputId] : [])),
    )
    const kept = view.events.filter(
      (applied) => applied.seq < body.firstRemovedSeq && !(applied.event.type === "INPUT_WAITING" && removed.has(applied.event.inputId)),
    )
    return { ...kept.reduce(fold, emptyView(view.sessionId)), lastSeq: event.seq }
  }
  return fold(view, event)
}

export const applyEvents = (view: SessionView, events: Iterable<SessionEvent>): SessionView => {
  let next = view
  for (const event of events) next = applyEvent(next, event)
  return next
}

const fold = (view: SessionView, event: SessionEvent): SessionView => {
  // Views only ever append to their event list, and a rewind folds a filtered
  // copy, so appending in place keeps replay linear.
  ;(view.events as Array<SessionEvent>).push(event)
  return { ...reduce(view, event), lastSeq: event.seq }
}

const notice = (view: SessionView, seq: number, text: string): SessionView => ({
  ...view,
  items: [...view.items, { kind: "notice", id: `notice:${seq}`, seq, text }],
})

const append = (view: SessionView, item: Item): SessionView => ({ ...view, items: [...view.items, item] })

const mark = (view: SessionView, seq: number, runId: string, value: Mark): SessionView =>
  append(view, { kind: "mark", id: `mark:${seq}`, seq, runId, ...value } as MarkItem)

/** Applies `change` to the items that `matches`. */
const withItems = (view: SessionView, matches: (item: Item) => boolean, change: (item: Item) => Item): SessionView => ({
  ...view,
  items: view.items.map((item) => (matches(item) ? change(item) : item)),
})

/** Closes the question sets of a turn that ended or of a call that has its result. */
const closeQuestions = (view: SessionView, matches: (item: QuestionsItem) => boolean): SessionView =>
  withItems(
    view,
    (item) => item.kind === "questions" && item.open && matches(item),
    (item) => ({ ...item, open: false }),
  )

/** The open assistant segment of the running turn, if the last item is one. */
const openSegment = (view: SessionView): AssistantItem | null => {
  const last = view.items.at(-1)
  return last?.kind === "assistant" && last.status === "running" && last.runId === view.runId ? last : null
}

/** Applies `change` to the open segment, opening one for the running turn when needed. */
const withSegment = (view: SessionView, seq: number, change: (segment: AssistantItem) => AssistantItem): SessionView => {
  const open = openSegment(view)
  if (open !== null) return { ...view, items: [...view.items.slice(0, -1), change(open)] }
  const runId = view.runId
  if (runId === null) return view
  const count = (view.segments[runId] ?? 0) + 1
  const segment: AssistantItem = {
    kind: "assistant",
    id: `${runId}:${count}`,
    seq,
    runId,
    parts: [],
    status: "running",
    error: null,
  }
  return { ...view, segments: { ...view.segments, [runId]: count }, items: [...view.items, change(segment)] }
}

/** Applies `change` to the part `id` in the latest segment holding it. */
const withPart = (view: SessionView, id: string, change: (part: AssistantPart) => AssistantPart): SessionView => {
  for (let index = view.items.length - 1; index >= 0; index--) {
    const item = view.items[index]!
    if (item.kind !== "assistant") continue
    const at = item.parts.findIndex((part) => part.id === id)
    if (at < 0) continue
    const parts = item.parts.with(at, change(item.parts[at]!))
    return { ...view, items: view.items.with(index, { ...item, parts }) }
  }
  return view
}

/** Ends the running turn's segments with `status`. */
const endRun = (view: SessionView, seq: number, runId: string, status: RunStatus, error: string | null): SessionView => {
  let items = closeQuestions(view, (item) => item.runId === runId).items.map((item) =>
    item.kind === "assistant" && item.runId === runId && item.status === "running" ? { ...item, status } : item,
  )
  if (error !== null) {
    const last = items.at(-1)
    if (last?.kind === "assistant" && last.runId === runId) items = [...items.slice(0, -1), { ...last, error }]
    else {
      const count = (view.segments[runId] ?? 0) + 1
      items = [...items, { kind: "assistant", id: `${runId}:${count}`, seq, runId, parts: [], status, error }]
      return { ...view, items, runId: null, segments: { ...view.segments, [runId]: count } }
    }
  }
  return { ...view, items, runId: view.runId === runId ? null : view.runId }
}

const reduce = (view: SessionView, { seq, event }: SessionEvent): SessionView => {
  switch (event.type) {
    case "SESSION_CREATED": {
      const created = {
        ...view,
        sessionDir: event.sessionDir,
        agent: event.agent,
        model: event.model,
        reasoningEffort: event.reasoningEffort,
        forkedFrom: event.forkedFrom,
      }
      return event.forkedFrom === null ? created : notice(created, seq, `Forked from session ${event.forkedFrom.sessionId}`)
    }
    case "INPUT_WAITING": {
      const { type: _, ...input } = event
      return { ...view, pending: [...view.pending, { ...input, seq }] }
    }
    case "INPUT_RECEIVED": {
      const user: UserItem = {
        kind: "user",
        id: event.inputId,
        seq,
        text: event.text,
        mode: event.mode,
        sender: event.sender,
        runId: null,
      }
      return { ...view, items: [...view.items, user], pending: view.pending.filter((input) => input.inputId !== event.inputId) }
    }
    case "RUN_STARTED": {
      const items = view.items.map((item) =>
        item.kind === "user" && event.userMessageIds.includes(item.id) ? { ...item, runId: event.runId } : item,
      )
      const started = { ...view, items, runId: event.runId }
      if (event.cause === "continuation") return mark(started, seq, event.runId, { mark: "continuation" })
      if (event.cause === "notification") return mark(started, seq, event.runId, { mark: "developer_turn" })
      return started
    }
    case "RUN_FINISHED":
      return endRun(view, seq, event.runId, event.outcome.type === "success" ? "finished" : "cancelled", null)
    case "RUN_ERROR":
      return endRun(view, seq, event.runId, "failed", event.message)
    case "RUN_INTERRUPTED":
      return endRun(view, seq, event.runId, "interrupted", null)
    case "TEXT_MESSAGE_START":
      return withSegment(view, seq, (segment) => ({
        ...segment,
        parts: [...segment.parts, { type: "text", id: event.messageId, text: "" }],
      }))
    case "TEXT_MESSAGE_CONTENT":
    case "REASONING_MESSAGE_CONTENT":
      return withPart(view, event.messageId, (part) =>
        part.type === "tool" ? part : { ...part, text: part.text + event.delta },
      )
    case "REASONING_MESSAGE_START":
      return withSegment(view, seq, (segment) => ({
        ...segment,
        parts: [...segment.parts, { type: "reasoning", id: event.messageId, text: "" }],
      }))
    case "TOOL_CALL_START":
      return withSegment(view, seq, (segment) => ({
        ...segment,
        parts: [
          ...segment.parts,
          {
            type: "tool",
            id: event.toolCallId,
            name: event.toolCallName,
            argsText: "",
            started: false,
            result: null,
            programCalls: [],
          },
        ],
      }))
    case "TOOL_CALL_ARGS":
      return withPart(view, event.toolCallId, (part) =>
        part.type === "tool" ? { ...part, argsText: part.argsText + event.delta } : part,
      )
    case "TOOL_EXECUTION_STARTED":
      return withPart(view, event.toolCallId, (part) => (part.type === "tool" ? { ...part, started: true } : part))
    case "TOOL_CALL_RESULT":
      return withPart(closeQuestions(view, (item) => item.toolCallId === event.toolCallId), event.toolCallId, (part) =>
        part.type === "tool" ? { ...part, result: { content: event.content, outcome: event.outcome } } : part,
      )
    case "PROGRAM_CALL_FINISHED":
      return withPart(view, event.toolCallId, (part) =>
        part.type === "tool"
          ? { ...part, programCalls: [...part.programCalls, { tool: event.tool, outcome: event.outcome }] }
          : part,
      )
    case "MODEL_CHANGED":
      return notice(
        { ...view, model: event.model, reasoningEffort: event.reasoningEffort },
        seq,
        `Model changed to ${event.model}${event.reasoningEffort === null ? "" : ` with ${event.reasoningEffort} reasoning`}`,
      )
    case "SESSION_ERROR":
      return append(view, { kind: "error", id: `error:${seq}`, seq, code: event.code, text: event.message })
    case "DEVELOPER_MESSAGE":
      return append(view, { kind: "developer", id: `developer:${seq}`, seq, runId: event.runId, components: event.components })
    case "CHECKPOINT_WINDOW_SEEDED":
      // The first checkpoint window opens with the session; each later one is a mark.
      return event.runId === null ? view : mark(view, seq, event.runId, { mark: "window", window: event.window })
    case "CHECKPOINT_WINDOW_FAILED":
      return append(view, { kind: "error", id: `error:${seq}`, seq, code: "checkpoint_window_failed", text: event.message })
    case "TIMELINE_ENTRY": {
      const entry = event.entry
      const resolved = new Set(entry.resolves)
      const marked = withItems(
        view,
        (item) => item.kind === "entry" && resolved.has(item.entry.number),
        (item) => ({ ...item, resolvedBy: entry.number }),
      )
      return append(marked, { kind: "entry", id: `entry:${entry.number}`, seq, runId: event.runId, entry, resolvedBy: null })
    }
    case "TIMELINE_ENTRY_REPLACED":
      return withItems(
        view,
        (item) => item.kind === "entry" && item.entry.number === event.number,
        (item) => (item.kind === "entry" ? { ...item, entry: { ...item.entry, fields: { ...item.entry.fields, Text: event.text } } } : item),
      )
    case "CONTEXT_TURN_STARTED":
      return mark(view, seq, event.runId, { mark: "context_turn", trigger: event.trigger })
    case "TOOL_RESULTS_CLEARED":
      return mark(view, seq, event.runId, { mark: "clearing", attempt: event.attempt, tokensFreed: event.tokensFreed })
    case "VALIDATION_FAILED":
      return mark(view, seq, event.runId, { mark: "validation_failed", attempt: event.attempt, violations: event.violations })
    case "QUESTIONS_ASKED":
      return append(view, {
        kind: "questions",
        id: event.questionSetId,
        seq,
        runId: event.runId,
        toolCallId: event.toolCallId,
        feedback: event.feedback ?? null,
        questions: event.questions,
        answers: null,
        open: true,
      })
    case "QUESTIONS_ANSWERED":
      return withItems(
        view,
        (item) => item.kind === "questions" && item.id === event.questionSetId,
        (item) => ({ ...item, answers: event.answers, open: false }) as QuestionsItem,
      )
    case "PERMISSION_REQUESTED": {
      const { type: _, ...request } = event
      return { ...view, permissions: [...view.permissions, request] }
    }
    case "PERMISSION_RESOLVED": {
      const request = view.permissions.find((pending) => pending.requestId === event.requestId)
      const remaining = view.permissions.filter((pending) => pending.requestId !== event.requestId)
      const resolved = { ...view, permissions: remaining }
      if (request === undefined) return resolved
      const message = event.message === undefined ? "" : `: ${event.message}`
      return notice(resolved, seq, `Permission ${request.permission} ${answerText[event.answer]}${message}`)
    }
    case "PERMISSION_WITHDRAWN":
      return { ...view, permissions: view.permissions.filter((pending) => pending.requestId !== event.requestId) }
    case "TEXT_MESSAGE_END":
    case "REASONING_START":
    case "REASONING_MESSAGE_END":
    case "REASONING_END":
    case "TOOL_CALL_END":
    case "SESSION_REWOUND":
      return view
  }
}

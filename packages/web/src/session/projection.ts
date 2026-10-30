/**
 * A session's view: the conversation items and state that its events
 * produce, folded one event at a time in sequence order.
 */
import type { InputMode, PermissionAnswer, Sender, SessionEvent, SessionEventBody } from "@ashe-agent/protocol"

type ToolOutcome = Extract<SessionEventBody, { type: "TOOL_CALL_RESULT" }>["outcome"]

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

export type Item = UserItem | AssistantItem | NoticeItem

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
  readonly forkedFrom: { readonly sessionId: string; readonly runId: string | null } | null
  /** The running turn, or null when the session is idle. */
  readonly runId: string | null
  readonly items: ReadonlyArray<Item>
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
  forkedFrom: null,
  runId: null,
  items: [],
  permissions: [],
  segments: {},
})

const answerText: Record<PermissionAnswer, string> = { once: "allowed once", always: "always allowed", reject: "rejected" }

/** Applies one event; an event at or before `lastSeq` was already applied and changes nothing. */
export const applyEvent = (view: SessionView, event: SessionEvent): SessionView => {
  if (event.seq <= view.lastSeq) return view
  const body = event.event
  if (body.type === "SESSION_REWOUND") {
    const kept = view.events.filter((applied) => applied.seq < body.firstRemovedSeq)
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
  let items = view.items.map((item) =>
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
        forkedFrom: event.forkedFrom,
      }
      return event.forkedFrom === null ? created : notice(created, seq, `Forked from session ${event.forkedFrom.sessionId}`)
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
      return { ...view, items: [...view.items, user] }
    }
    case "RUN_STARTED": {
      const items = view.items.map((item) =>
        item.kind === "user" && item.id === event.inputId ? { ...item, runId: event.runId } : item,
      )
      return { ...view, items, runId: event.runId }
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
      return withPart(view, event.toolCallId, (part) =>
        part.type === "tool" ? { ...part, result: { content: event.content, outcome: event.outcome } } : part,
      )
    case "PROGRAM_CALL_FINISHED":
      return withPart(view, event.toolCallId, (part) =>
        part.type === "tool"
          ? { ...part, programCalls: [...part.programCalls, { tool: event.tool, outcome: event.outcome }] }
          : part,
      )
    case "MODEL_CHANGED":
      return notice({ ...view, model: event.model }, seq, `Model changed to ${event.model}`)
    case "COMPACTED":
      return notice(view, seq, `Context compacted from ${event.tokensBefore} to ${event.tokensAfter} tokens`)
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

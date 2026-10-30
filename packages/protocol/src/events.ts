import { Schema } from "effect"
import { Count, Id, InputMode, PermissionAnswer, Sender, Seq, Timestamp } from "./shared.ts"

/*
 * Session events. Events for text, reasoning, tool calls, and run lifecycle
 * carry the AG-UI 1.0 event type and fields for the same purpose; a run is
 * a turn, and AG-UI's threadId is the session id. The other events are this
 * protocol's own.
 */

const event = <const T extends string, F extends Schema.Struct.Fields>(type: T, fields: F) =>
  Schema.Struct({ type: Schema.Literal(type), ...fields })

export const RunStarted = event("RUN_STARTED", {
  threadId: Id,
  runId: Id,
  /** The model the run uses for all of its model calls. */
  model: Id,
  /** The input that started the run. */
  inputId: Id,
})

export const RunFinished = event("RUN_FINISHED", {
  threadId: Id,
  runId: Id,
  outcome: Schema.Union([
    Schema.Struct({ type: Schema.Literal("success") }),
    Schema.Struct({ type: Schema.Literal("cancelled") }),
  ]),
})

export const RunError = event("RUN_ERROR", {
  runId: Id,
  message: Schema.String,
  code: Schema.optionalKey(Schema.String),
})

/** A run that was still running when the server stopped, ended at the next start. */
export const RunInterrupted = event("RUN_INTERRUPTED", {
  threadId: Id,
  runId: Id,
})

export const TextMessageStart = event("TEXT_MESSAGE_START", {
  messageId: Id,
  role: Schema.Literal("assistant"),
})

export const TextMessageContent = event("TEXT_MESSAGE_CONTENT", {
  messageId: Id,
  delta: Schema.String,
})

export const TextMessageEnd = event("TEXT_MESSAGE_END", { messageId: Id })

export const ReasoningStart = event("REASONING_START", { messageId: Id })

export const ReasoningMessageStart = event("REASONING_MESSAGE_START", {
  messageId: Id,
  role: Schema.Literal("reasoning"),
})

export const ReasoningMessageContent = event("REASONING_MESSAGE_CONTENT", {
  messageId: Id,
  delta: Schema.String,
})

export const ReasoningMessageEnd = event("REASONING_MESSAGE_END", { messageId: Id })

export const ReasoningEnd = event("REASONING_END", { messageId: Id })

export const ToolCallStart = event("TOOL_CALL_START", {
  toolCallId: Id,
  toolCallName: Schema.String,
  parentMessageId: Schema.optionalKey(Id),
})

export const ToolCallArgs = event("TOOL_CALL_ARGS", {
  toolCallId: Id,
  delta: Schema.String,
})

export const ToolCallEnd = event("TOOL_CALL_END", { toolCallId: Id })

/** The server started running a tool call; a call with no such event never ran. */
export const ToolExecutionStarted = event("TOOL_EXECUTION_STARTED", { toolCallId: Id })

/** How a tool call ended; every outcome but success is a failed result. */
export const ToolOutcome = Schema.Literals(["success", "failed", "canceled", "declined", "interrupted"])

export const ToolCallResult = event("TOOL_CALL_RESULT", {
  messageId: Id,
  toolCallId: Id,
  role: Schema.Literal("tool"),
  content: Schema.String,
  outcome: ToolOutcome,
})

/** The first event of every session. */
export const SessionCreated = event("SESSION_CREATED", {
  cwd: Schema.String,
  agent: Schema.NullOr(Schema.String),
  model: Id,
  forkedFrom: Schema.NullOr(
    Schema.Struct({
      sessionId: Id,
      /** The last run copied, or null when the fork copied every run. */
      runId: Schema.NullOr(Id),
    }),
  ),
})

/**
 * An input entering the conversation: starting a turn or joining the
 * running one at a step boundary. Inputs of each mode enter in order of
 * arrival.
 */
export const InputReceived = event("INPUT_RECEIVED", {
  inputId: Id,
  text: Schema.String,
  mode: InputMode,
  sender: Sender,
})

export const ModelChanged = event("MODEL_CHANGED", {
  model: Id,
  sender: Sender,
})

/**
 * A rewind removed every event from `firstRemovedSeq` on; a client drops
 * them before applying the events after this one.
 */
export const SessionRewound = event("SESSION_REWOUND", {
  runId: Id,
  firstRemovedSeq: Seq,
})

export const Compacted = event("COMPACTED", {
  runId: Id,
  tokensBefore: Count,
  tokensAfter: Count,
  promptRevision: Schema.String,
})

export const PermissionRequested = event("PERMISSION_REQUESTED", {
  requestId: Id,
  runId: Id,
  toolCallId: Id,
  permission: Schema.String,
  /** The subjects the rules asked about, such as paths, commands, or URLs. */
  subjects: Schema.Array(Schema.String),
  /** The patterns an `always` answer grants. */
  patterns: Schema.Array(Schema.String),
})

export const PermissionResolved = event("PERMISSION_RESOLVED", {
  requestId: Id,
  answer: PermissionAnswer,
  message: Schema.optionalKey(Schema.String),
  /** The client that answered; absent when another answer or a new grant resolved it. */
  sender: Schema.optionalKey(Sender),
})

export const PermissionWithdrawn = event("PERMISSION_WITHDRAWN", {
  requestId: Id,
  reason: Schema.Literals(["canceled", "restart"]),
})

export const SessionEventBody = Schema.Union([
  RunStarted,
  RunFinished,
  RunError,
  RunInterrupted,
  TextMessageStart,
  TextMessageContent,
  TextMessageEnd,
  ReasoningStart,
  ReasoningMessageStart,
  ReasoningMessageContent,
  ReasoningMessageEnd,
  ReasoningEnd,
  ToolCallStart,
  ToolCallArgs,
  ToolCallEnd,
  ToolExecutionStarted,
  ToolCallResult,
  SessionCreated,
  InputReceived,
  ModelChanged,
  SessionRewound,
  Compacted,
  PermissionRequested,
  PermissionResolved,
  PermissionWithdrawn,
])

export type SessionEventBody = typeof SessionEventBody.Type

/** One persisted event of a session, numbered by the session's sequence counter. */
export const SessionEvent = Schema.Struct({
  sessionId: Id,
  seq: Seq,
  timestamp: Timestamp,
  event: SessionEventBody,
})

export type SessionEvent = typeof SessionEvent.Type

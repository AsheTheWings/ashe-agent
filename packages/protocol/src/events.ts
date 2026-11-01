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

/** What started a turn: an input holding a user message, a continuation, or another notification component. */
export const TurnCause = Schema.Literals(["user", "continuation", "notification"])

export const RunStarted = event("RUN_STARTED", {
  threadId: Id,
  runId: Id,
  /** The model the run uses for all of its model calls. */
  model: Id,
  cause: TurnCause,
  /** The user messages the run's starting input holds, none or several, in order. */
  userMessageIds: Schema.Array(Id),
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

/**
 * A tool call that the code mode program of the `execute` call `toolCallId`
 * made ended, with the permission name of the tool it called.
 */
export const ProgramCallFinished = event("PROGRAM_CALL_FINISHED", {
  toolCallId: Id,
  tool: Schema.String,
  outcome: ToolOutcome,
})

/** The first event of every session. */
export const SessionCreated = event("SESSION_CREATED", {
  /** The session's own directory, its starting working directory. */
  sessionDir: Schema.String,
  /** The title of the session's agent, or null for the implicit agent. */
  agent: Schema.NullOr(Schema.String),
  model: Id,
  /** The reasoning effort selected for the model, or null for its default. */
  reasoningEffort: Schema.NullOr(Schema.String),
  forkedFrom: Schema.NullOr(
    Schema.Struct({
      sessionId: Id,
      /** The last run copied, or null when the fork copied every run. */
      runId: Schema.NullOr(Id),
    }),
  ),
})

/** A user message stored to wait for a turn; its `INPUT_RECEIVED` follows when a turn takes it. */
export const InputWaiting = event("INPUT_WAITING", {
  inputId: Id,
  text: Schema.String,
  mode: InputMode,
  sender: Sender,
})

/**
 * A user message entering the conversation: starting a turn or joining the
 * running one at a step boundary. Inputs of each mode enter in order of
 * arrival.
 */
export const InputReceived = event("INPUT_RECEIVED", {
  inputId: Id,
  text: Schema.String,
  mode: InputMode,
  sender: Sender,
})

/** The session's model and reasoning effort selection changed; a null effort is the model's default. */
export const ModelChanged = event("MODEL_CHANGED", {
  model: Id,
  reasoningEffort: Schema.NullOr(Schema.String),
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

/**
 * One developer component as the model receives it: how it was injected,
 * its heading, and its text, the heading line included.
 */
export const DeveloperComponent = Schema.Struct({
  type: Schema.Literals(["seed", "state", "notification"]),
  heading: Schema.String,
  text: Schema.String,
})

/** A developer message entering the conversation: adjoining components the run's model receives together. */
export const DeveloperMessage = event("DEVELOPER_MESSAGE", {
  runId: Id,
  components: Schema.Array(DeveloperComponent),
})

/**
 * The seed a checkpoint window construction rendered after its harness
 * instructions; `runId` is null for the session's first checkpoint window.
 */
export const CheckpointWindowSeeded = event("CHECKPOINT_WINDOW_SEEDED", {
  runId: Schema.NullOr(Id),
  window: Count,
  components: Schema.Array(DeveloperComponent),
})

/**
 * A failure that leaves the session usable, such as an unreadable user
 * instructions file; `runId` names the run it happened in, if any.
 */
export const SessionError = event("SESSION_ERROR", {
  code: Schema.String,
  message: Schema.String,
  runId: Schema.optionalKey(Id),
})

/** The kinds of timeline entries: four the agent appends and four the harness writes. */
export const EntryKind = Schema.Literals(["open", "done", "decision", "problem", "compaction", "research", "answer", "handoff"])

/** A timeline entry as recorded: its number in the session's one sequence, its kind, its fields, and what a done entry resolves. */
export const TimelineEntry = Schema.Struct({
  number: Seq,
  kind: EntryKind,
  /** Field values by name, such as `Text`; a compaction or handoff entry's text is its `Text`. */
  fields: Schema.Record(Schema.String, Schema.String),
  /** The open and problem entries a done entry resolves. */
  resolves: Schema.Array(Seq),
})

/** An entry recorded in the session's timelines, owned by the run `runId`. */
export const TimelineEntryRecorded = event("TIMELINE_ENTRY", {
  runId: Id,
  entry: TimelineEntry,
})

/** A compaction call replaced the text of the compaction entry `number`, keeping its number and place. */
export const TimelineEntryReplaced = event("TIMELINE_ENTRY_REPLACED", {
  runId: Id,
  number: Seq,
  text: Schema.String,
})

/** The rest of the run is a context turn, started by the reserve running short or by the context limit. */
export const ContextTurnStarted = event("CONTEXT_TURN_STARTED", {
  runId: Id,
  trigger: Schema.Literals(["threshold", "limit"]),
})

/** A context turn's clearing `attempt`, 1 to 3, replaced tool results with placeholders, freeing an estimate of tokens. */
export const ToolResultsCleared = event("TOOL_RESULTS_CLEARED", {
  runId: Id,
  attempt: Seq,
  tokensFreed: Count,
})

/** A checkpoint window construction after a context turn failed; the session keeps its current checkpoint window. */
export const CheckpointWindowFailed = event("CHECKPOINT_WINDOW_FAILED", {
  runId: Id,
  message: Schema.String,
})

/** A context turn's check `attempt` of `research/` and `memory-draft/` found violations. */
export const ValidationFailed = event("VALIDATION_FAILED", {
  runId: Id,
  attempt: Seq,
  violations: Schema.Array(Schema.String),
})

/** One option of a question: its label and what choosing it means. */
export const QuestionOption = Schema.Struct({
  label: Schema.String,
  description: Schema.String,
})

export const Question = Schema.Struct({
  id: Schema.String,
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(QuestionOption),
})

/**
 * The agent asks the user `questions` in the tool call `toolCallId`;
 * `feedback` answers the session's previous question set and comes first.
 */
export const QuestionsAsked = event("QUESTIONS_ASKED", {
  runId: Id,
  toolCallId: Id,
  questionSetId: Id,
  feedback: Schema.optionalKey(Schema.String),
  questions: Schema.Array(Question),
})

/** The answer to one question: an option's label as the selection, a note, both, or neither for a skipped question. */
export const QuestionAnswer = Schema.Struct({
  id: Schema.String,
  selection: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
})

/** The first answer to a question set, which closes it in every client. */
export const QuestionsAnswered = event("QUESTIONS_ANSWERED", {
  questionSetId: Id,
  answers: Schema.Array(QuestionAnswer),
  sender: Sender,
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
  ProgramCallFinished,
  SessionCreated,
  InputWaiting,
  InputReceived,
  ModelChanged,
  SessionRewound,
  DeveloperMessage,
  CheckpointWindowSeeded,
  SessionError,
  TimelineEntryRecorded,
  TimelineEntryReplaced,
  ContextTurnStarted,
  ToolResultsCleared,
  CheckpointWindowFailed,
  ValidationFailed,
  QuestionsAsked,
  QuestionsAnswered,
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

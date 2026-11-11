import { Schema } from "effect"
import {
  Agent,
  AgentProfile,
  Count,
  Id,
  InputMode,
  MessageSender,
  Model,
  ProtocolVersion,
  SelectionPatch,
  Sender,
  SessionSummary,
  Seq,
  Timestamp,
} from "./shared.ts"
import { ActionDeclaration } from "./actions.ts"
import {
  ApprovalGrant,
  RetainedAttachmentRef,
  RetainedContent,
  UploadStatus,
} from "./owner.ts"
import {
  BoundarySummary,
  ModelCallUsage,
  ModelInputManifest,
  SemanticEntry,
  SemanticHistory,
  SemanticPageEntry,
  Turn,
} from "./semantic.ts"

/** An object with no fields this protocol defines; unknown fields are ignored. */
const Empty = Schema.Record(Schema.String, Schema.Unknown)

const Tokens = Schema.Struct({
  accessToken: Schema.String,
  accessTokenExpiresAt: Timestamp,
  refreshToken: Schema.String,
  refreshTokenExpiresAt: Timestamp,
  principal: Sender,
})

const method = <P extends Schema.Top, R extends Schema.Top>(params: P, result: R) => ({ params, result })

/** Whether an accepted submission is still pending, has entered a turn, or was removed with its history. */
export const InputDisposition = Schema.Literals(["pending", "admitted", "removed"])

export type InputDisposition = typeof InputDisposition.Type

/** The durable correlation of one caller-owned submission with the input it accepted. */
export const InputReceipt = Schema.Struct({
  submissionId: Id,
  inputId: Id,
  disposition: InputDisposition,
  acceptedAt: Timestamp,
})

export type InputReceipt = typeof InputReceipt.Type

export const InputReceiptLookup = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("observed"), receipt: InputReceipt }),
  Schema.Struct({ kind: Schema.Literal("not_observed"), submissionId: Id }),
])

export type InputReceiptLookup = typeof InputReceiptLookup.Type

/** A target boundary an owner history action can address. */
export const HistoryTarget = Schema.Struct({
  runId: Id,
  position: Seq,
  userMessageIds: Schema.Array(Id),
  /** The turns a rewind of this boundary removes, this one included. */
  affectedTurnIds: Schema.Array(Id),
  /** Pending submissions a confirmed rewind removes. */
  pendingInputIds: Schema.Array(Id),
  rewindEligible: Schema.Boolean,
  forkEligible: Schema.Boolean,
})

export type HistoryTarget = typeof HistoryTarget.Type

/** A harness-issued confirmation scope for one history target and the state it displayed. */
export const MutationScope = Schema.Struct({
  token: Id,
  sessionId: Id,
  targetRunId: Schema.NullOr(Id),
  /** The canonical retained-history revision this token was issued against. */
  readRevision: Id,
  activeTurnId: Schema.NullOr(Id),
  pendingInputIds: Schema.Array(Id),
  contextActive: Schema.Boolean,
  restorePending: Schema.Boolean,
})

export type MutationScope = typeof MutationScope.Type

/** The durable result of one owner history operation, or an explicit unresolved state. */
export const HistoryOperationResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("observed"),
    operationId: Id,
    action: Schema.Literals(["rewind", "fork"]),
    status: Schema.Literal("succeeded"),
    result: Schema.Unknown,
  }),
  Schema.Struct({
    kind: Schema.Literal("unresolved"),
    operationId: Id,
    action: Schema.Literals(["rewind", "fork"]),
  }),
  Schema.Struct({ kind: Schema.Literal("not_observed"), operationId: Id }),
])

export type HistoryOperationResult = typeof HistoryOperationResult.Type

/** One ordered pending owner input as observation exposes it. */
export const PendingInputObservation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("user"),
    inputId: Id,
    submissionId: Schema.NullOr(Id),
    text: Schema.String,
    mode: InputMode,
    sender: MessageSender,
    attachments: Schema.Array(RetainedAttachmentRef),
    selection: Schema.NullOr(SelectionPatch),
  }),
  Schema.Struct({
    kind: Schema.Literal("developer"),
    inputId: Id,
    trigger: Schema.Literals(["notification", "continuation", "fork", "context"]),
    componentType: Schema.String,
    componentName: Schema.NullOr(Schema.String),
    heading: Schema.String,
  }),
])

export type PendingInputObservation = typeof PendingInputObservation.Type

/** Coordinated execution and history eligibility, independent of presentation. */
export const ExecutionEligibility = Schema.Struct({
  activeTurnId: Schema.NullOr(Id),
  activity: Schema.Literals(["working", "idle"]),
  canResume: Schema.Boolean,
  canRewind: Schema.Boolean,
  canFork: Schema.Boolean,
  contextWorkflowActive: Schema.Boolean,
  restorePending: Schema.Boolean,
})

export type ExecutionEligibility = typeof ExecutionEligibility.Type

/** A validated live assigned-action interaction hint in an owner snapshot. */
export const ActionAttentionFact = Schema.Struct({
  actionId: Id,
  name: Id,
  runId: Schema.NullOr(Id),
  needsHumanInput: Schema.Literal(true),
})

export type ActionAttentionFact = typeof ActionAttentionFact.Type

/** A coherent cursor-bound owner snapshot of pending work and eligibility. */
export const SessionObservation = Schema.Struct({
  sessionId: Id,
  /** Canonical facts revision; it changes with pending input, history or selection. */
  revision: Id,
  /** The last persisted event this snapshot includes. */
  cursor: Count,
  selection: AgentProfile,
  activeSelection: Schema.NullOr(AgentProfile),
  pending: Schema.Array(PendingInputObservation),
  execution: ExecutionEligibility,
  userTurnIds: Schema.Array(Id),
  latestSuccessfulBoundaryId: Schema.NullOr(Id),
  attention: Schema.Array(ActionAttentionFact),
})

export type SessionObservation = typeof SessionObservation.Type

/** The bounded semantic collection a page request selects. */
export const SemanticPageObject = Schema.Literals(["turns", "entries", "boundaries"])

export type SemanticPageObject = typeof SemanticPageObject.Type

/** A bounded revision-bound page of one semantic collection. */
export const SemanticPage = Schema.Union([
  Schema.Struct({
    object: Schema.Literal("turns"),
    revision: Id,
    items: Schema.Array(Turn),
    nextCursor: Schema.NullOr(Id),
    latestSuccessfulBoundaryId: Schema.NullOr(Id),
  }),
  Schema.Struct({
    object: Schema.Literal("entries"),
    revision: Id,
    items: Schema.Array(SemanticPageEntry),
    nextCursor: Schema.NullOr(Id),
    latestSuccessfulBoundaryId: Schema.NullOr(Id),
  }),
  Schema.Struct({
    object: Schema.Literal("boundaries"),
    revision: Id,
    items: Schema.Array(BoundarySummary),
    nextCursor: Schema.NullOr(Id),
    latestSuccessfulBoundaryId: Schema.NullOr(Id),
  }),
])

export type SemanticPage = typeof SemanticPage.Type

/** One authenticated chunk of a retained producer capture. */
export const RetainedCapture = Schema.Struct({
  sessionId: Id,
  entryId: Id,
  contentId: Id,
  name: Schema.String,
  mediaType: Schema.String,
  byteLength: Count,
  captureLossBytes: Count,
  offset: Count,
  data: Schema.String,
})

export type RetainedCapture = typeof RetainedCapture.Type

/**
 * Every request a client sends, by method name, with its params and result.
 * A connection's first request is one of the `auth.*` methods.
 */
export const methods = {
  /**
   * Exchanges a sign-in code from a GitHub sign-in for tokens; `verifier`
   * is the client's verifier whose challenge started the sign-in.
   */
  "auth.exchange": method(
    Schema.Struct({ code: Schema.String, verifier: Schema.String, protocolVersion: ProtocolVersion }),
    Tokens,
  ),
  "auth.refresh": method(
    Schema.Struct({ refreshToken: Schema.String, protocolVersion: ProtocolVersion }),
    Tokens,
  ),
  /** Authenticates the connection with an access token or an API token. */
  "auth.authenticate": method(
    Schema.Struct({ token: Schema.String, protocolVersion: ProtocolVersion }),
    Schema.Struct({ principal: Sender }),
  ),
  /** The actions this server declares; clients advertise support by these names. */
  "actions.list": method(Empty, Schema.Struct({ actions: Schema.Array(ActionDeclaration) })),
  /** Replaces the action names this authenticated connection supports. */
  "client.setActions": method(Schema.Struct({ actions: Schema.Array(Id) }), Empty),
  /** The configured models and the one sessions start with by default. */
  "models.list": method(Empty, Schema.Struct({ models: Schema.Array(Model), defaultModel: Id })),
  /** The configured agents and the one sessions run as by default, if any. */
  "agents.list": method(Empty, Schema.Struct({ agents: Schema.Array(Agent), defaultAgent: Schema.NullOr(Id) })),
  "session.list": method(Empty, Schema.Struct({ sessions: Schema.Array(SessionSummary) })),
  "session.create": method(
    Schema.Struct({
      /** Refused when present: each session starts in its own session directory. */
      cwd: Schema.optionalKey(Schema.Never),
      /** Optional initial selection. Omission applies the configured title defaults. */
      selection: Schema.optionalKey(SelectionPatch),
    }),
    Schema.Struct({ session: SessionSummary }),
  ),
  /**
   * Streams the session's persisted events after `afterSeq`, or all of
   * them, as `session.event` notifications, then its live events.
   */
  "session.subscribe": method(
    Schema.Struct({ sessionId: Id, afterSeq: Schema.optionalKey(Seq) }),
    Schema.Struct({ session: SessionSummary }),
  ),
  "session.unsubscribe": method(Schema.Struct({ sessionId: Id }), Empty),
  /** Without a mode, input is admitted as a later UserTurn at the running turn's next complete step, or starts one when idle. */
  "session.input": method(
    Schema.Struct({
      sessionId: Id,
      /** The caller's stable identity for this submission; retries reuse it and its payload. */
      submissionId: Schema.optionalKey(Id),
      text: Schema.String,
      attachments: Schema.optionalKey(Schema.Array(RetainedAttachmentRef)),
      /** Requested selection changes applied with this input at admission. */
      selection: Schema.optionalKey(SelectionPatch),
      mode: Schema.optionalKey(InputMode),
    }),
    Schema.Struct({ inputId: Id, submissionId: Id, receipt: InputReceipt }),
  ),
  /** Resolves the receipt of one caller-owned submission, or reports it not observed. */
  "session.input.receipt": method(
    Schema.Struct({ sessionId: Id, submissionId: Id }),
    InputReceiptLookup,
  ),
  /** A coherent owner snapshot of ordered pending input and coordinated eligibility. */
  "session.observe": method(Schema.Struct({ sessionId: Id }), SessionObservation),
  /** Completes the action assigned to this connection with its declared result. */
  "action.complete": method(Schema.Struct({ sessionId: Id, actionId: Id, result: Schema.Unknown }), Empty),
  /** The assigned executor reports its live action's human-interaction need without completing it. */
  "action.reportInteraction": method(
    Schema.Struct({ actionId: Id, needsHumanInput: Schema.Boolean }),
    Empty,
  ),
  /** Starts an idle session with continuation input, alone or joined to its next eligible batch. */
  "session.resume": method(Schema.Struct({ sessionId: Id }), Empty),
  "session.cancel": method(
    Schema.Struct({ sessionId: Id, expectedTurnId: Id }),
    Schema.Struct({
      outcome: Schema.Literals(["cancelled", "no_longer_current"]),
      currentTurnId: Schema.NullOr(Id),
    }),
  ),
  /** Canonical semantic content and successful request boundaries for owner analysis. */
  "session.semantics": method(Schema.Struct({ sessionId: Id }), SemanticHistory),
  /** One bounded page of turns, typed entries or successful boundaries. */
  "session.semantics.page": method(
    Schema.Struct({
      sessionId: Id,
      object: SemanticPageObject,
      revision: Schema.optionalKey(Id),
      cursor: Schema.optionalKey(Id),
      limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
    }),
    SemanticPage,
  ),
  /** Reads one typed entry body a page omitted. */
  "session.semantics.body": method(
    Schema.Struct({ sessionId: Id, entryId: Id, contentId: Id }),
    Schema.Struct({ entry: SemanticEntry }),
  ),
  /** Reads one successful request boundary a page summarized. */
  "session.semantics.boundary": method(
    Schema.Struct({ sessionId: Id, manifestId: Id }),
    Schema.Struct({ boundary: ModelInputManifest }),
  ),
  /** Stored provider usage for one bounded set of model calls. */
  "session.modelCalls.usage": method(
    Schema.Struct({
      sessionId: Id,
      modelCallIds: Schema.Array(Id).check(Schema.isMaxLength(100)),
    }),
    Schema.Struct({ usage: Schema.Array(ModelCallUsage) }),
  ),
  /** Owner-client access to persisted always approvals, independent of agent tools. */
  "session.grants.list": method(
    Schema.Struct({ sessionId: Id }),
    Schema.Struct({ grants: Schema.Array(ApprovalGrant) }),
  ),
  /** Clears this branch's persisted always approvals for one title. */
  "session.grants.clear": method(
    Schema.Struct({ sessionId: Id, agentTitle: Id }),
    Schema.Struct({ cleared: Count }),
  ),
  /** Copies the session through the user turn `runId`, or entirely, into a new session. */
  "session.fork": method(
    Schema.Struct({
      sessionId: Id,
      runId: Schema.optionalKey(Id),
      historyScope: Id,
      operationId: Id,
    }),
    Schema.Struct({ session: SessionSummary }),
  ),
  /**
   * Removes the turn `runId`, whose starting input holds a user message, and
   * every later turn, then reruns its user messages, or `text` instead.
   */
  "session.rewind": method(
    Schema.Struct({
      sessionId: Id,
      runId: Id,
      historyScope: Id,
      operationId: Id,
      text: Schema.optionalKey(Schema.String),
      /** New selection changes submitted with the reconstructed input. */
      selection: Schema.optionalKey(SelectionPatch),
    }),
    Empty,
  ),
  /** Inspects one history boundary and issues its pending-aware confirmation scope. */
  "session.history.inspect": method(
    Schema.Struct({ sessionId: Id, runId: Schema.optionalKey(Id) }),
    Schema.Struct({ scope: MutationScope, target: Schema.NullOr(HistoryTarget) }),
  ),
  /** Resolves one accepted rewind or fork operation, or reports it unresolved or not observed. */
  "session.history.result": method(
    Schema.Struct({ sessionId: Id, operationId: Id }),
    HistoryOperationResult,
  ),
  /** Authenticated owner-client metadata for retained content and its representations. */
  "content.get": method(
    Schema.Struct({ sessionId: Id, contentId: Id, referenceId: Id }),
    Schema.Struct({ content: RetainedContent }),
  ),
  /** Reads a bounded chunk of one entry-owned retained producer capture. */
  "content.capture": method(
    Schema.Struct({
      sessionId: Id,
      entryId: Id,
      contentId: Id,
      offset: Count,
      length: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_536 })),
    }),
    Schema.Struct({ capture: RetainedCapture }),
  ),
  /** Creates a draft-owned staging upload that survives disconnects. */
  "upload.create": method(
    Schema.Struct({ draftId: Id, name: Schema.String, mediaType: Schema.String, size: Count }),
    Schema.Struct({ upload: UploadStatus }),
  ),
  "upload.status": method(
    Schema.Struct({ uploadId: Id }),
    Schema.Struct({ upload: UploadStatus }),
  ),
  /** Appends a chunk at a repeat-safe offset. `data` is standard base64. */
  "upload.append": method(
    Schema.Struct({ uploadId: Id, offset: Count, data: Schema.String }),
    Schema.Struct({ upload: UploadStatus }),
  ),
  "upload.finalize": method(
    Schema.Struct({ uploadId: Id, size: Count, digest: Schema.String }),
    Schema.Struct({ upload: UploadStatus }),
  ),
} as const

export type Methods = typeof methods
export type MethodName = keyof Methods
export type ParamsOf<M extends MethodName> = Methods[M]["params"]["Type"]
export type ResultOf<M extends MethodName> = Methods[M]["result"]["Type"]

export const methodNames = Object.keys(methods) as ReadonlyArray<MethodName>

/** The methods a connection may send before it is authenticated. */
export const authMethods = ["auth.exchange", "auth.refresh", "auth.authenticate"] as const satisfies ReadonlyArray<MethodName>

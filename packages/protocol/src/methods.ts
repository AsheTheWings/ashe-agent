import { Schema } from "effect"
import {
  Agent,
  Count,
  Id,
  InputMode,
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
import { SemanticHistory } from "./semantic.ts"

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
      text: Schema.String,
      attachments: Schema.optionalKey(Schema.Array(RetainedAttachmentRef)),
      /** Requested selection changes applied with this input at admission. */
      selection: Schema.optionalKey(SelectionPatch),
      mode: Schema.optionalKey(InputMode),
    }),
    Schema.Struct({ inputId: Id }),
  ),
  /** Completes the action assigned to this connection with its declared result. */
  "action.complete": method(Schema.Struct({ sessionId: Id, actionId: Id, result: Schema.Unknown }), Empty),
  /** Starts an idle session with continuation input, alone or joined to its next eligible batch. */
  "session.resume": method(Schema.Struct({ sessionId: Id }), Empty),
  "session.cancel": method(Schema.Struct({ sessionId: Id }), Empty),
  /** Canonical semantic content and successful request boundaries for owner analysis. */
  "session.semantics": method(Schema.Struct({ sessionId: Id }), SemanticHistory),
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
    Schema.Struct({ sessionId: Id, runId: Schema.optionalKey(Id) }),
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
      text: Schema.optionalKey(Schema.String),
      /** New selection changes submitted with the reconstructed input. */
      selection: Schema.optionalKey(SelectionPatch),
    }),
    Empty,
  ),
  /** Authenticated owner-client metadata for retained content and its representations. */
  "content.get": method(
    Schema.Struct({ sessionId: Id, contentId: Id, referenceId: Id }),
    Schema.Struct({ content: RetainedContent }),
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

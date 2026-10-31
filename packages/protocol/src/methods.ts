import { Schema } from "effect"
import {
  Agent,
  Id,
  InputMode,
  Model,
  PermissionAnswer,
  ProtocolVersion,
  Sender,
  SessionSummary,
  Seq,
  Timestamp,
} from "./shared.ts"

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
  "auth.login": method(
    Schema.Struct({ password: Schema.String, protocolVersion: ProtocolVersion }),
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
  /** The configured models and the one sessions start with by default. */
  "models.list": method(Empty, Schema.Struct({ models: Schema.Array(Model), defaultModel: Id })),
  /** The configured agents and the one sessions run as by default, if any. */
  "agents.list": method(Empty, Schema.Struct({ agents: Schema.Array(Agent), defaultAgent: Schema.NullOr(Id) })),
  "session.list": method(Empty, Schema.Struct({ sessions: Schema.Array(SessionSummary) })),
  "session.create": method(
    Schema.Struct({
      /** Refused when present: each session starts in its own session directory. */
      cwd: Schema.optionalKey(Schema.Never),
      model: Schema.optionalKey(Id),
      agent: Schema.optionalKey(Schema.String),
      /** A reasoning effort the starting model lists; without one, the model's default applies. */
      reasoningEffort: Schema.optionalKey(Schema.String),
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
  /** Without a mode, input steers a running turn, or starts one when the session is idle. */
  "session.input": method(
    Schema.Struct({ sessionId: Id, text: Schema.String, mode: Schema.optionalKey(InputMode) }),
    Schema.Struct({ inputId: Id }),
  ),
  "session.cancel": method(Schema.Struct({ sessionId: Id }), Empty),
  /** Selects the model and, optionally, a reasoning effort it lists; without one, the selection is cleared. */
  "session.setModel": method(
    Schema.Struct({ sessionId: Id, model: Id, reasoningEffort: Schema.optionalKey(Schema.String) }),
    Empty,
  ),
  /** Copies the session through the user turn `runId`, or entirely, into a new session. */
  "session.fork": method(
    Schema.Struct({ sessionId: Id, runId: Schema.optionalKey(Id) }),
    Schema.Struct({ session: SessionSummary }),
  ),
  /** Removes the user turn `runId` and every later turn, then reruns its input, or `text` instead. */
  "session.rewind": method(
    Schema.Struct({ sessionId: Id, runId: Id, text: Schema.optionalKey(Schema.String) }),
    Empty,
  ),
  "permission.answer": method(
    Schema.Struct({
      sessionId: Id,
      requestId: Id,
      answer: PermissionAnswer,
      message: Schema.optionalKey(Schema.String),
    }),
    Empty,
  ),
} as const

export type Methods = typeof methods
export type MethodName = keyof Methods
export type ParamsOf<M extends MethodName> = Methods[M]["params"]["Type"]
export type ResultOf<M extends MethodName> = Methods[M]["result"]["Type"]

export const methodNames = Object.keys(methods) as ReadonlyArray<MethodName>

/** The methods a connection may send before it is authenticated. */
export const authMethods = ["auth.login", "auth.refresh", "auth.authenticate"] as const satisfies ReadonlyArray<MethodName>

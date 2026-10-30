import { Schema } from "effect"

/** The protocol versions this package describes, newest last. */
export const PROTOCOL_VERSIONS = [1] as const

export const PROTOCOL_VERSION = PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1]!

/** Protocol versions are positive integers; which ones a server supports is its own choice. */
export const ProtocolVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export const Id = Schema.NonEmptyString

/** Milliseconds since the Unix epoch. */
export const Timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** Who sent an input or an answer: an API token, or a login of the owner. */
export const Sender = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("token"), tokenId: Id, name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("login"), loginId: Id }),
])

export type Sender = typeof Sender.Type

export const Model = Schema.Struct({
  id: Id,
  contextWindow: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  imageInput: Schema.Boolean,
})

export type Model = typeof Model.Type

export const SessionSummary = Schema.Struct({
  id: Id,
  /** The session's own directory, its starting working directory. */
  sessionDir: Schema.String,
  agent: Schema.NullOr(Schema.String),
  model: Id,
  createdAt: Timestamp,
  running: Schema.Boolean,
  /** The number of the session's last persisted event; a subscriber that received it is caught up. */
  lastSeq: Count,
})

export type SessionSummary = typeof SessionSummary.Type

export const InputMode = Schema.Literals(["steer", "queue"])

export type InputMode = typeof InputMode.Type

export const PermissionAnswer = Schema.Literals(["once", "always", "reject"])

export type PermissionAnswer = typeof PermissionAnswer.Type

export const AgentMode = Schema.Literals(["primary", "subagent", "all"])

export const Agent = Schema.Struct({
  name: Id,
  description: Schema.NullOr(Schema.String),
  mode: AgentMode,
  /** The agent's model, or null when it uses the session's selected model. */
  model: Schema.NullOr(Id),
})

export type Agent = typeof Agent.Type

/** An agent file the server refused, by its path, with the reason. */
export const RefusedAgentFile = Schema.Struct({
  path: Schema.String,
  reason: Schema.String,
})

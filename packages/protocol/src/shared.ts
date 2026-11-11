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

/** The always-available title that applies the global model and instruction defaults. */
export const UNTITLED_AGENT_TITLE = "untitled" as const

export const AgentTitle = Schema.NonEmptyString

export type AgentTitle = typeof AgentTitle.Type

/** The selected model and effort. A null model is explicitly unconfigured; null effort is the model default. */
export const ModelSettings = Schema.Struct({
  modelId: Schema.NullOr(Id),
  reasoningEffort: Schema.NullOr(Schema.String),
})

export type ModelSettings = typeof ModelSettings.Type

/** A session's applied title and model selection. */
export const AgentProfile = Schema.Struct({
  agentTitle: AgentTitle,
  modelSettings: ModelSettings,
})

export type AgentProfile = typeof AgentProfile.Type

/**
 * A request to change selected values. Omitted fields inherit. A null
 * model clears the model, and a null effort returns to its model default.
 */
export const SelectionPatch = Schema.Struct({
  agentTitle: Schema.optionalKey(AgentTitle),
  modelSettings: Schema.optionalKey(
    Schema.Struct({
      modelId: Schema.optionalKey(Schema.NullOr(Id)),
      reasoningEffort: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
})

export type SelectionPatch = typeof SelectionPatch.Type

/** A session address with its applied title and model; effort is not part of identity. */
export const AgentIdentity = Schema.Struct({
  sessionId: Id,
  agentTitle: AgentTitle,
  modelId: Schema.NullOr(Id),
})

export type AgentIdentity = typeof AgentIdentity.Type

export const Activity = Schema.Literals(["working", "idle"])

export type Activity = typeof Activity.Type

/** A configured model: its `<provider>/<model>` id, display name, capabilities, and reasoning effort setting. */
export const Model = Schema.Struct({
  id: Id,
  name: Schema.String,
  /** The model's context window, in tokens. */
  contextLimit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  imageInput: Schema.Boolean,
  /** Whether the model accepts native PDF input. */
  pdfInput: Schema.Boolean,
  /** The reasoning efforts the model lists; empty for a model without reasoning. */
  reasoningEfforts: Schema.Array(Schema.String),
  /** The model entry's own reasoning effort setting, if any. */
  reasoningEffort: Schema.NullOr(Schema.String),
})

export type Model = typeof Model.Type

export const SessionSummary = Schema.Struct({
  id: Id,
  /** The session's own directory, its starting working directory. */
  sessionDir: Schema.String,
  identity: AgentIdentity,
  /** The currently applied selection, including an explicitly null model. */
  selection: AgentProfile,
  /** The selection a running AgentTurn is using, or null while idle. */
  activeSelection: Schema.NullOr(AgentProfile),
  /** Current coordinated activity, distinct from historical turn outcomes. */
  activity: Activity,
  createdAt: Timestamp,
  /** The number of the session's last persisted event; a subscriber that received it is caught up. */
  lastSeq: Count,
})

export type SessionSummary = typeof SessionSummary.Type

export const InputMode = Schema.Literals(["steer", "queue"])

export type InputMode = typeof InputMode.Type

export const PermissionAnswer = Schema.Literals(["once", "always", "reject"])

export type PermissionAnswer = typeof PermissionAnswer.Type

/** A title file's state: present, absent, or refused with the reason. */
export const TitleFileState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("present") }),
  Schema.Struct({ state: Schema.Literal("absent") }),
  Schema.Struct({ state: Schema.Literal("refused"), reason: Schema.String }),
])

/** A configured agent, keyed by its title. */
export const Agent = Schema.Struct({
  key: Id,
  /** The key in words, such as "Code Reviewer" for `code-reviewer`. */
  title: Schema.String,
  /** The title file's description, or null without a present title file. */
  description: Schema.NullOr(Schema.String),
  /** The model the agent starts sessions with, or null when it names none. */
  model: Schema.NullOr(Id),
  /** The agent's reasoning effort overrides, by model id. */
  reasoningEfforts: Schema.Record(Schema.String, Schema.String),
  titleFile: TitleFileState,
})

export type Agent = typeof Agent.Type

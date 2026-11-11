import { Schema } from "effect"
import {
  AgentProfile,
  AgentTitle,
  Count,
  Id,
  ModelSettings,
  SelectionPatch,
  Seq,
  Timestamp,
} from "./shared.ts"

/** Who originally authored content, independent of the session that now owns it. */
export const Authorship = Schema.Struct({
  sessionId: Id,
  agentTitle: AgentTitle,
  modelId: Schema.NullOr(Id),
})

export type Authorship = typeof Authorship.Type

/** Whether retained history was authored locally or inherited from another session. */
export const HistoryOwnership = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local") }),
  Schema.Struct({
    kind: Schema.Literal("inherited"),
    sourceSessionId: Id,
    sourceEntryId: Id,
  }),
])

export type HistoryOwnership = typeof HistoryOwnership.Type

export const TurnOutcome = Schema.Literals(["completed", "failed", "cancelled", "interrupted"])

export type TurnOutcome = typeof TurnOutcome.Type

/** One immutable admitted UserTurn and its following AgentTurn. */
export const Turn = Schema.Struct({
  id: Id,
  position: Seq,
  admittedAt: Timestamp,
  /** Ordered content identities admitted into the UserTurn. */
  inputEntryIds: Schema.Array(Id),
  /** User messages in their admitted order. */
  userMessageIds: Schema.Array(Id),
  /** The effective selection established at this UserTurn boundary. */
  profile: AgentProfile,
  /** The immutable applied-settings revision referenced by this turn. */
  settingsRevision: Id,
  /** Null while the AgentTurn is unsettled. */
  outcome: Schema.NullOr(TurnOutcome),
  /** Whether this turn is context-maintenance work, identified by its developer boundary. */
  contextMaintenance: Schema.Boolean,
})

export type Turn = typeof Turn.Type

/** A text value owned by the protocol rather than a model library's stored serialization. */
export const TextContent = Schema.Struct({
  id: Id,
  kind: Schema.Literal("text"),
  text: Schema.String,
})

export type TextContent = typeof TextContent.Type

/** A retained representation shared by immutable content references. */
export const RepresentationRef = Schema.Struct({
  representationId: Id,
  contentId: Id,
  mediaType: Schema.String,
  digest: Schema.String,
  /** The transformation that produced this representation, or null for the retained original. */
  transformation: Schema.NullOr(Schema.String),
})

export type RepresentationRef = typeof RepresentationRef.Type

/** A structured value retains its program shape beside its model-facing representation. */
export const StructuredContent = Schema.Struct({
  id: Id,
  kind: Schema.Literal("structured"),
  value: Schema.Unknown,
})

export type StructuredContent = typeof StructuredContent.Type

export const UserContentPart = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("attachment"),
    attachmentId: Id,
    name: Schema.String,
    content: RepresentationRef,
  }),
])

export type UserContentPart = typeof UserContentPart.Type

export const AgentContentPart = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("media"),
    name: Schema.String,
    content: RepresentationRef,
  }),
])

export type AgentContentPart = typeof AgentContentPart.Type

export const SemanticDeveloperComponent = Schema.Struct({
  id: Id,
  type: Schema.Literals(["seed", "state", "notification", "title", "global"]),
  heading: Schema.String,
  text: Schema.String,
  source: Schema.optionalKey(Schema.String),
})

export type SemanticDeveloperComponent = typeof SemanticDeveloperComponent.Type

export const AgentToolOutcome = Schema.Literals(["success", "failed", "canceled", "declined", "interrupted"])

export type AgentToolOutcome = typeof AgentToolOutcome.Type

/** One AgentTool invocation and its correlated lifecycle. */
export const AgentTool = Schema.Struct({
  id: Id,
  kind: Schema.Literal("agent-tool"),
  modelCallId: Schema.NullOr(Id),
  providerCallId: Schema.NullOr(Id),
  parentInvocationId: Schema.NullOr(Id),
  name: Schema.String,
  arguments: StructuredContent,
  startedAt: Schema.NullOr(Timestamp),
  settledAt: Schema.NullOr(Timestamp),
  outcome: Schema.NullOr(AgentToolOutcome),
  result: Schema.NullOr(
    Schema.Struct({
      content: Schema.Array(
        Schema.Union([
          TextContent,
          Schema.Struct({
            id: Id,
            kind: Schema.Literal("media"),
            name: Schema.String,
            content: RepresentationRef,
          }),
        ]),
      ),
      structured: Schema.NullOr(StructuredContent),
    }),
  ),
  /** Retained producer captures owned by this tool entry. */
  captures: Schema.Array(Schema.suspend(() => CaptureReference)),
})

export type AgentTool = typeof AgentTool.Type

const entryFields = {
  id: Id,
  /** The retained content identity of this entry's canonical body. */
  contentId: Id,
  position: Seq,
  turnId: Schema.NullOr(Id),
  authorship: Authorship,
  ownership: HistoryOwnership,
  createdAt: Timestamp,
}

/** Canonical conversation content. Provider replay state is retained separately. */
export const SemanticEntry = Schema.Union([
  Schema.Struct({ ...entryFields, kind: Schema.Literal("system"), content: TextContent }),
  Schema.Struct({
    ...entryFields,
    kind: Schema.Literal("developer"),
    components: Schema.Array(SemanticDeveloperComponent),
  }),
  Schema.Struct({ ...entryFields, kind: Schema.Literal("user"), parts: Schema.Array(UserContentPart) }),
  Schema.Struct({
    ...entryFields,
    kind: Schema.Literal("agent"),
    modelCallId: Schema.NullOr(Id),
    parts: Schema.Array(AgentContentPart),
  }),
  Schema.Struct({
    ...entryFields,
    kind: Schema.Literal("agent-thought"),
    modelCallId: Schema.NullOr(Id),
    text: Schema.String,
  }),
  Schema.Struct({ ...entryFields, kind: Schema.Literal("agent-tool"), tool: AgentTool }),
])

export type SemanticEntry = typeof SemanticEntry.Type

/** A retained body a page omits, addressed by its owning entry. */
export const EntryBodyReference = Schema.Struct({
  contentId: Id,
  referenceId: Id,
  byteLength: Count,
})

export type EntryBodyReference = typeof EntryBodyReference.Type

/** One paged entry and the reference to its body when the page omitted it. */
export const SemanticPageEntry = Schema.Struct({
  entry: SemanticEntry,
  body: Schema.NullOr(EntryBodyReference),
})

export type SemanticPageEntry = typeof SemanticPageEntry.Type

/** A successful boundary without its potentially large contribution body. */
export const BoundarySummary = Schema.Struct({
  id: Id,
  modelCallId: Id,
  turnId: Id,
  windowPosition: Seq,
  committedAt: Timestamp,
  contributionCount: Count,
  body: EntryBodyReference,
})

export type BoundarySummary = typeof BoundarySummary.Type

/** Stored provider-reported usage for one model call; nulls stay unknown. */
export const ModelCallUsage = Schema.Struct({
  modelCallId: Id,
  providerUsage: Schema.suspend(() => ProviderUsage),
})

export type ModelCallUsage = typeof ModelCallUsage.Type

/** A typed entry-owned retained producer capture, distinct from the model preview. */
export const CaptureReference = Schema.Struct({
  contentId: Id,
  name: Schema.String,
  mediaType: Schema.String,
  byteLength: Count,
  captureLossBytes: Count,
})

export type CaptureReference = typeof CaptureReference.Type

/** The provider response grouping retained with committed output and opaque replay state. */
export const ModelResponse = Schema.Struct({
  id: Id,
  modelCallId: Id,
  entryIds: Schema.Array(Id),
  toolInvocationIds: Schema.Array(Id),
  providerReplay: Schema.Unknown,
})

export type ModelResponse = typeof ModelResponse.Type

/** A retained rendered representation of one contribution. */
export const RenderedContribution = Schema.Struct({
  representationId: Id,
  contentId: Id,
  mediaType: Schema.String,
  digest: Schema.String,
  byteLength: Count,
  renderer: Schema.String,
})

export type RenderedContribution = typeof RenderedContribution.Type

/** A successful request's ordered, immutable input contributions. */
export const InputContribution = Schema.Union([
  Schema.Struct({
    position: Count,
    kind: Schema.Literals(["instruction", "message", "transcript"]),
    sourceEntryId: Schema.NullOr(Id),
    sourceEntryIds: Schema.Array(Id),
    representation: RepresentationRef,
    transformation: Schema.NullOr(Schema.String),
    rendered: RenderedContribution,
  }),
  Schema.Struct({
    position: Count,
    kind: Schema.Literal("tool-definition"),
    name: Schema.String,
    description: Schema.String,
    parameters: Schema.Unknown,
    rendered: RenderedContribution,
  }),
  Schema.Struct({
    position: Count,
    kind: Schema.Literal("placeholder"),
    sourceEntryId: Schema.NullOr(Id),
    reason: Schema.String,
  }),
])

export type InputContribution = typeof InputContribution.Type

/** The exact ordered model input boundary retained after successful response commitment. */
export const ModelInputManifest = Schema.Struct({
  id: Id,
  modelCallId: Id,
  turnId: Id,
  windowPosition: Seq,
  committedAt: Timestamp,
  contributions: Schema.Array(InputContribution),
  measurement: Schema.suspend(() => MeasurementFields),
})

export type ModelInputManifest = typeof ModelInputManifest.Type

export const MeasurementBasis = Schema.Literals([
  "ashe-agent-text-v1",
  "configured-image-allowance",
  "configured-pdf-allowance",
  "provider-reported",
  "unavailable",
])

export type MeasurementBasis = typeof MeasurementBasis.Type

/** One contribution's measured or allowed token count and its coverage. */
export const ContributionMeasurement = Schema.Struct({
  contributionPosition: Count,
  basis: MeasurementBasis,
  methodVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  tokens: Schema.NullOr(Count),
  representationIds: Schema.Array(Id),
  unavailableReason: Schema.optionalKey(Schema.String),
})

export type ContributionMeasurement = typeof ContributionMeasurement.Type

/** The fields of a shared estimate; `Measurement` adds their consistency filter. */
export const MeasurementFields = Schema.Struct({
  method: Schema.Literal("ashe-agent-estimator"),
  methodVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  purpose: Schema.Literals(["execution", "analysis"]),
  coverage: Schema.Literals(["complete", "partial"]),
  knownSubtotal: Count,
  contributions: Schema.Array(ContributionMeasurement),
  unavailable: Schema.Array(
    Schema.Struct({
      contributionPosition: Count,
      reason: Schema.String,
    }),
  ),
})

/** A shared estimate that never presents unknown contributions as zero. */
export const Measurement = MeasurementFields.check(
  Schema.makeFilter(
    (measurement: {
      readonly coverage: string
      readonly knownSubtotal: number
      readonly contributions: ReadonlyArray<{
        readonly contributionPosition: number
        readonly basis: string
        readonly tokens: number | null
        readonly unavailableReason?: string
      }>
      readonly unavailable: ReadonlyArray<{ readonly contributionPosition: number; readonly reason: string }>
    }) => {
      let known = 0
      const unavailable = new Set<number>()
      for (const contribution of measurement.contributions) {
        if (contribution.basis === "unavailable") {
          if (contribution.tokens !== null) return "an unavailable contribution has no token count"
          if (contribution.unavailableReason === undefined || contribution.unavailableReason.trim() === "") {
            return "an unavailable contribution names why it is unavailable"
          }
          unavailable.add(contribution.contributionPosition)
        } else {
          if (contribution.tokens === null) return "a measured contribution has a token count"
          if (contribution.unavailableReason !== undefined) return "a measured contribution has no unavailable reason"
          known += contribution.tokens
        }
      }
      if (known !== measurement.knownSubtotal) return "knownSubtotal is the sum of measured contributions"
      const reported = new Set<number>()
      for (const entry of measurement.unavailable) {
        if (reported.has(entry.contributionPosition)) return "an unavailable contribution is reported once"
        if (!unavailable.has(entry.contributionPosition)) return "unavailable entries name unavailable contributions"
        if (entry.reason.trim() === "") return "an unavailable contribution names why it is unavailable"
        reported.add(entry.contributionPosition)
      }
      if (measurement.coverage === "complete") {
        return unavailable.size === 0 && reported.size === 0 ? true : "complete coverage has no unavailable contributions"
      }
      return unavailable.size > 0 && reported.size === unavailable.size
        ? true
        : "partial coverage reports every unavailable contribution"
    },
  ),
)

export type Measurement = typeof Measurement.Type

/** Canonical semantic history and every successful request boundary retained for a session. */
export const SemanticHistory = Schema.Struct({
  sessionId: Id,
  turns: Schema.Array(Turn),
  entries: Schema.Array(SemanticEntry),
  boundaries: Schema.Array(ModelInputManifest),
})

export type SemanticHistory = typeof SemanticHistory.Type

/** Provider usage is attributed separately from the recorded input estimate. */
export const ProviderUsage = Schema.Struct({
  inputTokens: Schema.NullOr(Count),
  outputTokens: Schema.NullOr(Count),
  totalTokens: Schema.NullOr(Count),
})

export type ProviderUsage = typeof ProviderUsage.Type

/** The immutable effective values for one UserTurn or copied turn. */
export const AppliedSettingsRevision = Schema.Struct({
  id: Id,
  sessionId: Id,
  revision: Seq,
  settings: ModelSettings,
  agentTitle: AgentTitle,
  appliedAt: Timestamp,
})

export type AppliedSettingsRevision = typeof AppliedSettingsRevision.Type

export const SelectionChange = Schema.Struct({
  patch: SelectionPatch,
  inputId: Id,
  settingsRevisionId: Schema.NullOr(Id),
})

export type SelectionChange = typeof SelectionChange.Type

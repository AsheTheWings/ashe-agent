import { Schema } from "effect"
import { Count, Id, Seq, Sender, Timestamp } from "./shared.ts"

export const OWNER_IDENTITY_PATH = "/v1/auth/identity"
export const RETAINED_CONTENT_PATH = "/v1/content"

/** GET /v1/auth/identity: the authenticated owner and the credential's actual expiry. */
export const OwnerIdentity = Schema.Struct({
  principal: Sender,
  /** Null explicitly means a non-expiring API credential. */
  credentialExpiresAt: Schema.NullOr(Timestamp),
  /** The opaque durable identity of the retained harness database. */
  harnessId: Id,
})

export type OwnerIdentity = typeof OwnerIdentity.Type

export const RetainedRepresentationKind = Schema.Literals([
  "original",
  "text",
  "image",
  "pdf-page",
  "converted-text",
])

export type RetainedRepresentationKind = typeof RetainedRepresentationKind.Type

export const RetainedRepresentation = Schema.Struct({
  representationId: Id,
  kind: RetainedRepresentationKind,
  mediaType: Schema.String,
  digest: Schema.String,
  byteLength: Count,
  /** The attachment name when this representation came from one; null for a rendered provider input. */
  filename: Schema.NullOr(Schema.String),
  /** One-based source page for a PDF page representation. */
  page: Schema.NullOr(Seq),
  transformation: Schema.NullOr(Schema.String),
  /** Bounded renderer or conversion metadata for this representation. */
  metadata: Schema.Unknown,
})

export type RetainedRepresentation = typeof RetainedRepresentation.Type

/** Metadata returned before an authenticated retained-content download. */
export const RetainedContent = Schema.Struct({
  contentId: Id,
  referenceId: Id,
  sessionId: Id,
  available: Schema.Boolean,
  representations: Schema.Array(RetainedRepresentation),
})

export type RetainedContent = typeof RetainedContent.Type

export const RetainedContentUnavailable = Schema.Struct({
  code: Schema.Literals(["not_found", "representation_unavailable"]),
  message: Schema.String,
})

export type RetainedContentUnavailable = typeof RetainedContentUnavailable.Type

/** A persisted always-approval scoped to one session and one title. */
export const ApprovalGrant = Schema.Struct({
  sessionId: Id,
  agentTitle: Id,
  position: Seq,
  permission: Schema.String,
  pattern: Schema.String,
})

export type ApprovalGrant = typeof ApprovalGrant.Type

/** A draft-owned resumable upload before input acceptance claims it. */
export const UploadStatus = Schema.Struct({
  uploadId: Id,
  draftId: Id,
  filename: Schema.String,
  mediaType: Schema.String,
  offset: Count,
  size: Schema.NullOr(Count),
  digest: Schema.NullOr(Schema.String),
  createdAt: Timestamp,
  expiresAt: Timestamp,
  claimed: Schema.Boolean,
  /** The retained attachment identity once finalization succeeded. */
  attachmentId: Schema.optionalKey(Id),
  /** The retained content identity once finalization succeeded. */
  contentId: Schema.optionalKey(Id),
})

export type UploadStatus = typeof UploadStatus.Type

/** A retained attachment identity accepted into pending or admitted input. */
export const RetainedAttachmentRef = Schema.Struct({
  attachmentId: Id,
  contentId: Id,
  representationId: Id,
  name: Schema.String,
  mediaType: Schema.String,
  digest: Schema.String,
})

export type RetainedAttachmentRef = typeof RetainedAttachmentRef.Type

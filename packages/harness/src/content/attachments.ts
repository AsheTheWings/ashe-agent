import type { Database } from "bun:sqlite"
import { endSpan, startSpan, type ErrorClass } from "../telemetry/signals.ts"
import type { RetainedAttachmentRef, UploadStatus } from "@ashe-agent/protocol"

/** The defaults one owner's unclaimed staging and one upload are bounded by. */
export interface UploadLimits {
  readonly maxFileBytes: number
  readonly maxImageBytes: number
  readonly maxAttachments: number
  readonly maxSubmissionBytes: number
  readonly quotaBytes: number
  readonly expiryMs: number
  readonly chunkBytes: number
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxFileBytes: 32 * 1024 * 1024,
  maxImageBytes: 20 * 1024 * 1024,
  maxAttachments: 10,
  maxSubmissionBytes: 128 * 1024 * 1024,
  quotaBytes: 512 * 1024 * 1024,
  expiryMs: 24 * 60 * 60 * 1_000,
  chunkBytes: 1024 * 1024,
}

export class AttachmentError extends Error {
  constructor(
    readonly code: "not_found" | "invalid" | "conflict" | "quota" | "expired",
    message: string,
  ) {
    super(message)
  }
}

interface UploadRow {
  owner_id: string
  upload_id: string
  draft_id: string
  name: string
  media_type: string
  expected_size: number
  received_size: number
  status: "open" | "finalized"
  digest: string | null
  attachment_id: string | null
  created_at: number
  expires_at: number
}

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

const uploadError = (error: unknown): ErrorClass =>
  error instanceof AttachmentError
    ? error.code === "quota"
      ? "upload_quota"
      : error.code === "invalid"
        ? "upload_invalid"
        : "conflict"
    : "internal"

/** Draft-owned upload staging and the attachment originals pending or admitted input claims. */
export class AttachmentStore {
  constructor(
    readonly db: Database,
    readonly limits: UploadLimits = DEFAULT_UPLOAD_LIMITS,
  ) {}

  private upload(ownerId: string, uploadId: string): UploadRow {
    const row = this.db
      .query<UploadRow, [string, string]>("SELECT * FROM uploads WHERE owner_id = ? AND upload_id = ?")
      .get(ownerId, uploadId)
    if (row === null) throw new AttachmentError("not_found", `no upload ${uploadId}`)
    return row
  }

  private status(row: UploadRow, now: number): UploadStatus {
    if (row.expires_at <= now && row.status === "open") throw new AttachmentError("expired", `upload ${row.upload_id} has expired`)
    return {
      uploadId: row.upload_id,
      draftId: row.draft_id,
      filename: row.name,
      mediaType: row.media_type,
      offset: row.received_size,
      size: row.expected_size,
      digest: row.digest,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      claimed: row.attachment_id !== null && this.claimCount(row.attachment_id) > 0,
    }
  }

  private claimCount(attachmentId: string): number {
    return (
      this.db
        .query<{ n: number }, [string]>("SELECT count(*) AS n FROM attachment_references WHERE attachment_id = ?")
        .get(attachmentId)?.n ?? 0
    )
  }

  private stagedBytes(ownerId: string): number {
    return (
      this.db
        .query<{ bytes: number }, [string]>(
          `SELECT coalesce(sum(u.expected_size), 0) AS bytes FROM uploads u
            WHERE u.owner_id = ? AND NOT EXISTS (
              SELECT 1 FROM attachment_references r WHERE r.attachment_id = u.attachment_id)`,
        )
        .get(ownerId)?.bytes ?? 0
    )
  }

  /** Creates an upload owned by `ownerId`, whose staging survives connections. */
  private createInternal(ownerId: string, draftId: string, name: string, mediaType: string, size: number, now: number): UploadStatus {
    this.expire(now)
    const image = mediaType.toLowerCase().startsWith("image/")
    const limit = image ? this.limits.maxImageBytes : this.limits.maxFileBytes
    if (size > limit) throw new AttachmentError("invalid", `the file is ${size} bytes, over its limit of ${limit} bytes`)
    if (this.stagedBytes(ownerId) + size > this.limits.quotaBytes) {
      throw new AttachmentError("quota", `the upload would exceed the owner's ${this.limits.quotaBytes}-byte staging quota`)
    }
    const uploadId = crypto.randomUUID()
    this.db
      .query(
        `INSERT INTO uploads
          (owner_id, upload_id, draft_id, name, media_type, expected_size, received_size, status,
           digest, attachment_id, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, 'open', NULL, NULL, ?, ?)`,
      )
      .run(ownerId, uploadId, draftId, name, mediaType, size, now, now + this.limits.expiryMs)
    return this.status(this.upload(ownerId, uploadId), now)
  }

  private observedUpload<A>(call: () => A): A {
    const span = startSpan("ashe_agent.content_upload", {
      "ashe_agent.content.operation": "upload",
    })
    try {
      const result = call()
      endSpan(span, { "ashe_agent.content.outcome": "success" })
      return result
    } catch (error) {
      endSpan(span, { "ashe_agent.content.outcome": "failed" }, uploadError(error))
      throw error
    }
  }

  create(ownerId: string, draftId: string, name: string, mediaType: string, size: number, now: number): UploadStatus {
    return this.observedUpload(() => this.createInternal(ownerId, draftId, name, mediaType, size, now))
  }

  append(ownerId: string, uploadId: string, offset: number, data: string, now: number): UploadStatus {
    return this.observedUpload(() => this.appendInternal(ownerId, uploadId, offset, data, now))
  }

  finalize(ownerId: string, uploadId: string, size: number, digest: string, now: number): UploadStatus {
    return this.observedUpload(() => this.finalizeInternal(ownerId, uploadId, size, digest, now))
  }

  statusOf(ownerId: string, uploadId: string, now: number): UploadStatus {
    this.expire(now)
    return this.status(this.upload(ownerId, uploadId), now)
  }

  /** Appends one chunk, or accepts a repeated write for bytes already staged at that offset. */
  private appendInternal(ownerId: string, uploadId: string, offset: number, data: string, now: number): UploadStatus {
    this.expire(now)
    const row = this.upload(ownerId, uploadId)
    if (row.status !== "open") throw new AttachmentError("conflict", `upload ${uploadId} is already finalized`)
    if (data === "" || data.length % 4 !== 0 || Buffer.from(data, "base64").toString("base64") !== data) {
      throw new AttachmentError("invalid", "the chunk is not canonical base64")
    }
    const bytes = Buffer.from(data, "base64")
    if (bytes.byteLength > this.limits.chunkBytes) {
      throw new AttachmentError("invalid", `the chunk is over ${this.limits.chunkBytes} bytes`)
    }
    if (offset > row.received_size) throw new AttachmentError("conflict", `offset ${offset} is past the staged ${row.received_size} bytes`)
    if (offset + bytes.byteLength > row.expected_size) {
      throw new AttachmentError("invalid", "the chunk exceeds the upload's declared size")
    }
    const existing = this.db
      .query<{ data: Uint8Array }, [string, string, number]>(
        "SELECT data FROM upload_chunks WHERE owner_id = ? AND upload_id = ? AND offset = ?",
      )
      .get(ownerId, uploadId, offset)
    if (offset < row.received_size) {
      if (existing === null || !Buffer.from(existing.data).equals(bytes)) {
        throw new AttachmentError("conflict", `offset ${offset} already holds different bytes`)
      }
      return this.status(row, now)
    }
    this.db
      .query("INSERT INTO upload_chunks (owner_id, upload_id, offset, digest, data) VALUES (?, ?, ?, ?, ?)")
      .run(ownerId, uploadId, offset, sha256(bytes), bytes)
    this.db
      .query("UPDATE uploads SET received_size = ? WHERE owner_id = ? AND upload_id = ?")
      .run(offset + bytes.byteLength, ownerId, uploadId)
    return this.status(this.upload(ownerId, uploadId), now)
  }

  /** Verifies the complete size and digest, then materializes the retained original. */
  private finalizeInternal(ownerId: string, uploadId: string, size: number, digest: string, now: number): UploadStatus {
    this.expire(now)
    const row = this.upload(ownerId, uploadId)
    const expected = digest.toLowerCase().replace(/^sha256:/, "")
    if (row.status === "finalized") {
      if (row.expected_size !== size || row.digest !== expected) {
        throw new AttachmentError("conflict", "the repeated finalize differs from the retained upload")
      }
      return this.status(row, now)
    }
    if (size !== row.expected_size || row.received_size !== size) {
      throw new AttachmentError("conflict", `upload ${uploadId} holds ${row.received_size} of ${row.expected_size} bytes`)
    }
    const chunks = this.db
      .query<{ data: Uint8Array }, [string, string]>(
        "SELECT data FROM upload_chunks WHERE owner_id = ? AND upload_id = ? ORDER BY offset",
      )
      .all(ownerId, uploadId)
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data)))
    const actual = sha256(bytes)
    if (actual !== expected) throw new AttachmentError("invalid", `the upload digest ${actual} does not match ${expected}`)
    const attachmentId = crypto.randomUUID()
    this.db
      .query("INSERT INTO contents (sha256, data, format) VALUES (?, ?, ?) ON CONFLICT (sha256) DO NOTHING")
      .run(actual, bytes, "application/octet-stream")
    this.db
      .query(
        `INSERT INTO attachments (id, content_sha256, format, mime_type, size, owner_id, created_at)
          VALUES (?, ?, 'original', ?, ?, ?, ?)`,
      )
      .run(attachmentId, actual, row.media_type, bytes.byteLength, ownerId, now)
    this.db
      .query("UPDATE uploads SET status = 'finalized', digest = ?, attachment_id = ? WHERE owner_id = ? AND upload_id = ?")
      .run(actual, attachmentId, ownerId, uploadId)
    return this.status(this.upload(ownerId, uploadId), now)
  }

  /** Establishes input references atomically with accepting the referenced originals. */
  claim(ownerId: string, sessionId: string, inputId: string, refs: ReadonlyArray<RetainedAttachmentRef>, now: number) {
    if (refs.length > this.limits.maxAttachments) {
      throw new AttachmentError("invalid", `the input has ${refs.length} attachments, over ${this.limits.maxAttachments}`)
    }
    let bytes = 0
    this.expire(now)
    for (const ref of refs) {
      const attachment = this.db
        .query<{ id: string; content_sha256: string; size: number; owner_id: string }, [string]>(
          "SELECT id, content_sha256, size, owner_id FROM attachments WHERE id = ?",
        )
        .get(ref.attachmentId)
      if (attachment === null || attachment.owner_id !== ownerId) throw new AttachmentError("not_found", `no attachment ${ref.attachmentId}`)
      if (attachment.content_sha256 !== ref.contentId || ref.representationId !== ref.contentId) {
        throw new AttachmentError("invalid", `attachment ${ref.attachmentId} does not match its retained content`)
      }
      if (attachment.content_sha256 !== ref.digest.toLowerCase().replace(/^sha256:/, "")) {
        throw new AttachmentError("invalid", `attachment ${ref.attachmentId} does not match its digest`)
      }
      bytes += attachment.size
    }
    if (bytes > this.limits.maxSubmissionBytes) {
      throw new AttachmentError("invalid", `the input's ${bytes} bytes are over ${this.limits.maxSubmissionBytes}`)
    }
    const insert = this.db.query(
      `INSERT INTO attachment_references (attachment_id, session_id, kind, reference_id, created_at)
        VALUES (?, ?, 'input', ?, ?) ON CONFLICT DO NOTHING`,
    )
    for (const ref of refs) insert.run(ref.attachmentId, sessionId, inputId, now)
  }

  /**
   * Claims attachments already accepted by `sourceSessionId` for a peer
   * message. Ownership is the source session's retained reference, so a
   * peer cannot name another owner's staging upload.
   */
  claimFromSession(
    sourceSessionId: string,
    sessionId: string,
    inputId: string,
    refs: ReadonlyArray<RetainedAttachmentRef>,
    now: number,
  ) {
    if (refs.length > this.limits.maxAttachments) {
      throw new AttachmentError("invalid", `the input has ${refs.length} attachments, over ${this.limits.maxAttachments}`)
    }
    let bytes = 0
    this.expire(now)
    for (const ref of refs) {
      const attachment = this.db
        .query<{ content_sha256: string; size: number }, [string, string]>(
          `SELECT a.content_sha256, a.size FROM attachments a
            WHERE a.id = ? AND EXISTS (
              SELECT 1 FROM attachment_references r
              WHERE r.attachment_id = a.id AND r.session_id = ?)`,
        )
        .get(ref.attachmentId, sourceSessionId)
      if (attachment === null) throw new AttachmentError("not_found", `session ${sourceSessionId} does not retain attachment ${ref.attachmentId}`)
      if (attachment.content_sha256 !== ref.contentId || ref.representationId !== ref.contentId) {
        throw new AttachmentError("invalid", `attachment ${ref.attachmentId} does not match its retained content`)
      }
      if (attachment.content_sha256 !== ref.digest.toLowerCase().replace(/^sha256:/, "")) {
        throw new AttachmentError("invalid", `attachment ${ref.attachmentId} does not match its digest`)
      }
      bytes += attachment.size
    }
    if (bytes > this.limits.maxSubmissionBytes) {
      throw new AttachmentError("invalid", `the input's ${bytes} bytes are over ${this.limits.maxSubmissionBytes}`)
    }
    const insert = this.db.query(
      `INSERT INTO attachment_references (attachment_id, session_id, kind, reference_id, created_at)
        VALUES (?, ?, 'input', ?, ?) ON CONFLICT DO NOTHING`,
    )
    for (const ref of refs) insert.run(ref.attachmentId, sessionId, inputId, now)
  }

  /** Deletes only unclaimed staging whose creation-based expiry has passed. */
  expire(now: number) {
    const expired = this.db
      .query<{ attachment_id: string | null }, [number]>(
        `SELECT attachment_id FROM uploads u WHERE u.expires_at <= ? AND NOT EXISTS (
          SELECT 1 FROM attachment_references r WHERE r.attachment_id = u.attachment_id)`,
      )
      .all(now)
    this.db
      .query(
        `DELETE FROM uploads WHERE expires_at <= ? AND NOT EXISTS (
          SELECT 1 FROM attachment_references r WHERE r.attachment_id = uploads.attachment_id)`,
      )
      .run(now)
    for (const row of expired) {
      if (row.attachment_id !== null && this.claimCount(row.attachment_id) === 0) {
        this.db.query("DELETE FROM attachments WHERE id = ?").run(row.attachment_id)
      }
    }
  }

  attachment(id: string): { readonly id: string; readonly contentSha256: string; readonly size: number } | null {
    const row = this.db
      .query<{ id: string; content_sha256: string; size: number }, [string]>(
        "SELECT id, content_sha256, size FROM attachments WHERE id = ?",
      )
      .get(id)
    return row === null ? null : { id: row.id, contentSha256: row.content_sha256, size: row.size }
  }
}

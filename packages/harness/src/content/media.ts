import type { Database } from "bun:sqlite"
import type { RepresentationRef, RetainedAttachmentRef } from "@ashe-agent/protocol"
import type { Item } from "../sessions/conversation.ts"
import { convertDocument, documentFormat } from "../tools/file/documents.ts"
import { boundedPreview } from "./retention.ts"
import { endSpan, startSpan, type ErrorClass } from "../telemetry/signals.ts"
import type { ConversionPort } from "./conversion.ts"

export interface ModelCapabilities {
  readonly text: boolean
  readonly image: boolean
  readonly pdf: boolean
}

export type ProjectedPart =
  | {
      readonly type: "text"
      readonly text: string
      readonly representation?: RepresentationRef
      readonly metadata?: Readonly<Record<string, unknown>>
    }
  | {
      readonly type: "image"
      readonly mimeType: string
      readonly data: string
      readonly representation: RepresentationRef
      readonly metadata?: Readonly<Record<string, unknown>>
    }
  | {
      readonly type: "pdf"
      readonly mimeType: "application/pdf"
      readonly filename: string
      readonly data: string
      readonly representation: RepresentationRef
      readonly metadata?: Readonly<Record<string, unknown>>
    }

export interface ProjectedAttachment {
  readonly parts: ReadonlyArray<ProjectedPart>
  readonly contributions: ReadonlyArray<{
    readonly representation: RepresentationRef
    readonly transformation: string
  }>
}

export class AttachmentProjectionError extends Error {
  constructor(
    readonly kind: "unsupported" | "conversion" | "missing",
    message: string,
  ) {
    super(message)
  }
}

interface AttachmentRow {
  readonly id: string
  readonly content_sha256: string
  readonly format: string
  readonly mime_type: string
  readonly size: number
  readonly name: string
}

export const safePdfName = (name: string) => {
  const base = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "")
  return base.toLowerCase().endsWith(".pdf") && base.length > 4 ? base : "attachment.pdf"
}

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

const looksPdf = (bytes: Uint8Array) => {
  const prefix = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.byteLength, 1_024)))
  return prefix.includes("%PDF-")
}

const reference = (contentId: string, mediaType: string, transformation: string | null, representationId = contentId): RepresentationRef => ({
  representationId,
  contentId,
  mediaType,
  digest: contentId,
  transformation,
})

/**
 * Prepares retained attachment bytes for one model's explicit capabilities.
 * Derived page and text bytes are immutable representations of the shared
 * original. Current input fails closed; earlier media gets a placeholder.
 */
export class AttachmentMedia {
  constructor(
    private readonly db: Database,
    private readonly conversion: ConversionPort | null,
    private readonly options: {
      readonly dpi: number
      readonly maxLongEdge: number
      readonly maxPixelsPerPage: number
      readonly pagesPerWindow: number
      readonly previewLines: number
      readonly previewBytes: number
      readonly now: () => number
    },
  ) {}

  private attachment(id: string): AttachmentRow {
    const row = this.db.query<AttachmentRow, [string]>(
      `SELECT a.id, a.content_sha256, a.format, a.mime_type, a.size, u.name
        FROM attachments a JOIN uploads u ON u.attachment_id = a.id
        WHERE a.id = ? ORDER BY u.created_at LIMIT 1`,
    ).get(id)
    if (row === null) throw new AttachmentProjectionError("missing", `attachment ${id} is unavailable`)
    return row
  }

  private content(contentId: string): Uint8Array {
    const row = this.db.query<{ data: Uint8Array }, [string]>("SELECT data FROM contents WHERE sha256 = ?").get(contentId)
    if (row === null) throw new AttachmentProjectionError("missing", `retained content ${contentId} is unavailable`)
    return new Uint8Array(row.data)
  }

  private prefix(contentId: string): Uint8Array {
    const row = this.db.query<{ prefix: Uint8Array }, [string]>(
      "SELECT substr(data, 1, 1024) AS prefix FROM contents WHERE sha256 = ?",
    ).get(contentId)
    if (row === null) throw new AttachmentProjectionError("missing", `retained content ${contentId} is unavailable`)
    return new Uint8Array(row.prefix)
  }

  /** Metadata of a retained attachment, without loading its original. */
  info(attachmentId: string) {
    const row = this.attachment(attachmentId)
    return { name: row.name, mediaType: row.mime_type, format: row.format }
  }

  /** The retained original of an attachment. */
  original(attachmentId: string) {
    const row = this.attachment(attachmentId)
    return { name: row.name, mediaType: row.mime_type, format: row.format, bytes: this.content(row.content_sha256) }
  }

  private put(attachmentId: string, bytes: Uint8Array, mediaType: string, transformation: string, metadata: Record<string, unknown>) {
    const digest = sha256(bytes)
    const representationId = transformation === "pdf-page-image"
      ? `${transformation}:${String(metadata.page ?? 1)}:${digest}`
      : transformation === "pdf-text"
        ? `${transformation}:${String(metadata.windowOffset ?? 1)}:${digest}`
        : `${transformation}:${digest}`
    const recorded = transformation.startsWith("pdf-")
      ? { ...metadata, digest, renderer: "pdfium-wasm", rendererVersion: "3.0.0" }
      : { ...metadata, digest }
    this.db.query("INSERT INTO contents (sha256, data, format) VALUES (?, ?, ?) ON CONFLICT (sha256) DO NOTHING")
      .run(digest, bytes, mediaType)
    this.db.query(
      `INSERT INTO attachment_representations
        (attachment_id, representation_id, content_sha256, media_type, transformation, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (attachment_id, representation_id) DO NOTHING`,
    ).run(attachmentId, representationId, digest, mediaType, transformation, JSON.stringify(recorded), this.options.now())
    return reference(digest, mediaType, transformation, representationId)
  }

  private representations(attachmentId: string) {
    return this.db.query<{
      representation_id: string
      content_sha256: string
      media_type: string
      transformation: string
      metadata: string
    }, [string]>(
      `SELECT representation_id, content_sha256, media_type, transformation, metadata
        FROM attachment_representations WHERE attachment_id = ? ORDER BY created_at, representation_id`,
    ).all(attachmentId).map((row) => ({ ...row, metadata: JSON.parse(row.metadata) as Record<string, unknown> }))
  }

  async project(
    item: Extract<Item, { kind: "user" }>,
    capabilities: ModelCapabilities,
    current: boolean,
    signal: AbortSignal,
  ): Promise<ProjectedAttachment> {
    const span = startSpan("ashe_agent.media_projection", {})
    try {
      const result = await this.projectInternal(item, capabilities, current, signal)
      const routes = new Set(result.contributions.map((entry) => entry.transformation))
      const route = routes.has("attachment-native-pdf")
        ? "native-pdf"
        : routes.has("pdf-page-image")
          ? "pdf-pages"
          : routes.has("pdf-page-text")
            ? "pdf-text"
            : routes.has("document-markdown")
              ? "document"
              : routes.has("attachment-placeholder")
              ? "placeholder"
              : routes.has("attachment-original") && result.parts.some((part) => part.type === "image")
                ? "image"
                : "text"
      endSpan(span, { "ashe_agent.media.route": route, "ashe_agent.content.outcome": "success" })
      return result
    } catch (error) {
      const failure: ErrorClass = error instanceof AttachmentProjectionError
        ? error.kind === "unsupported"
          ? "attachment_unsupported"
          : error.kind === "conversion"
            ? "conversion_failed"
            : "not_found"
        : "internal"
      endSpan(span, { "ashe_agent.content.outcome": "failed" }, failure)
      throw error
    }
  }

  /** Projects a retained PDF tool result for a later model's capabilities. */
  async projectPdf(
    source: {
      readonly filename: string
      readonly data: string
      readonly path?: string
      readonly attachmentId?: string
      readonly pageOffset?: number
      readonly pageLimit?: number
      readonly representation?: RepresentationRef
    },
    capabilities: ModelCapabilities,
    signal: AbortSignal,
  ): Promise<ReadonlyArray<ProjectedPart>> {
    const bytes = new Uint8Array(Buffer.from(source.data, "base64"))
    const contentId = sha256(bytes)
    const original = source.representation ?? reference(contentId, "application/pdf", "attachment-native-pdf")
    if (capabilities.pdf) {
      return [{
        type: "pdf",
        mimeType: "application/pdf",
        filename: safePdfName(source.filename),
        data: source.data,
        representation: original,
        metadata: { windowOffset: 1, windowLimit: "all" },
      }]
    }
    const window = { offset: source.pageOffset ?? 1, limit: source.pageLimit ?? this.options.pagesPerWindow }
    const handle = source.attachmentId !== undefined
      ? `attachmentId="${source.attachmentId}"`
      : source.path === undefined
        ? null
        : `path="${source.path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    if (this.conversion === null) {
      const text = `[PDF ${source.filename} is retained but unavailable: local PDF conversion is unavailable.]`
      const digest = sha256(Buffer.from(text))
      return [{
        type: "text",
        text,
        representation: reference(digest, "text/plain", "pdf-unavailable", `pdf-unavailable:${digest}`),
        metadata: { filename: source.filename, windowOffset: window.offset, windowLimit: window.limit },
      }]
    }
    try {
      const converted = await this.conversion.convert({
        load: async () => bytes,
        window,
        geometry: {
          dpi: this.options.dpi,
          maxLongEdge: this.options.maxLongEdge,
          maxPixelsPerPage: this.options.maxPixelsPerPage,
        },
        signal,
      })
      const parts: Array<ProjectedPart> = []
      const text = boundedPreview(converted.text, {
        previewLines: this.options.previewLines,
        previewBytes: this.options.previewBytes,
      })
      const first = converted.pages[0]?.page ?? window.offset
      const end = converted.pages.at(-1)?.page ?? first - 1
      const continuation = end < converted.total && handle !== null
        ? ` Continue with file_read ${handle} pageOffset=${end + 1}.`
        : ""
      const windowMetadata = {
        windowOffset: window.offset,
        windowLimit: window.limit,
        firstPage: first,
        lastPage: end,
        total: converted.total,
      }
      if (text.text !== "") {
        const rendered = `# PDF ${source.filename}\n\nPages ${first}-${end} of ${converted.total}. Text window: ${text.includedLines} of ${text.totalLines} lines, ${text.includedBytes} of ${text.totalBytes} bytes.${continuation}\n\n${text.text}`
        const digest = sha256(Buffer.from(rendered))
        parts.push({
          type: "text",
          text: rendered,
          representation: reference(digest, "text/plain", "pdf-page-text", `pdf-page-text:${window.offset}:${digest}`),
          metadata: { renderer: "pdfium-wasm", rendererVersion: "3.0.0", ...windowMetadata },
        })
      }
      if (capabilities.image) {
        for (const page of converted.pages) {
          const pageId = sha256(page.png)
          parts.push({
            type: "image",
            mimeType: "image/png",
            data: Buffer.from(page.png).toString("base64"),
            representation: reference(pageId, "image/png", "pdf-page-image", `pdf-page-image:${page.page}:${pageId}`),
            metadata: {
              renderer: "pdfium-wasm",
              rendererVersion: "3.0.0",
              page: page.page,
              width: page.width,
              height: page.height,
              dpi: this.options.dpi,
              maxLongEdge: this.options.maxLongEdge,
              maxPixelsPerPage: this.options.maxPixelsPerPage,
              ...windowMetadata,
            },
          })
        }
      }
      if (parts.length === 0) {
        const fallback = `[PDF ${source.filename} has no extractable text or rendered pages for this model.${continuation}]`
        const digest = sha256(Buffer.from(fallback))
        return [{
          type: "text",
          text: fallback,
          representation: reference(digest, "text/plain", "pdf-unavailable", `pdf-placeholder:${window.offset}:${digest}`),
          metadata: { filename: source.filename, renderer: "pdfium-wasm", rendererVersion: "3.0.0", ...windowMetadata },
        }]
      }
      return parts
    } catch (error) {
      const text = `[PDF ${source.filename} is retained but unavailable: ${error instanceof Error ? error.message : String(error)}]`
      const digest = sha256(Buffer.from(text))
      return [{
        type: "text",
        text,
        representation: reference(digest, "text/plain", "pdf-unavailable", `pdf-unavailable:${window.offset}:${digest}`),
        metadata: { filename: source.filename },
      }]
    }
  }

  private async projectInternal(
    item: Extract<Item, { kind: "user" }>,
    capabilities: ModelCapabilities,
    current: boolean,
    signal: AbortSignal,
  ): Promise<ProjectedAttachment> {
    const parts: Array<ProjectedPart> = []
    const contributions: Array<{ representation: RepresentationRef; transformation: string }> = []
    for (const ref of item.attachments ?? []) {
      let attachment: AttachmentRow
      try {
        attachment = this.attachment(ref.attachmentId)
      } catch (error) {
        if (!current && error instanceof AttachmentProjectionError && error.kind === "missing") {
          parts.push({ type: "text", text: `[Attachment ${ref.name} is retained but unavailable to this model: its original is missing]` })
          contributions.push({
            representation: {
              representationId: ref.representationId,
              contentId: ref.contentId,
              mediaType: ref.mediaType,
              digest: ref.digest,
              transformation: null,
            },
            transformation: "attachment-placeholder",
          })
          continue
        }
        throw error
      }
      const hasContent = this.db.query("SELECT 1 FROM contents WHERE sha256 = ?").get(attachment.content_sha256) !== null
      if (!hasContent) {
        if (current) throw new AttachmentProjectionError("missing", `retained content ${attachment.content_sha256} is unavailable`)
        parts.push({ type: "text", text: `[Attachment ${ref.name} is retained but unavailable to this model: its original is missing]` })
        contributions.push({
          representation: {
            representationId: ref.representationId,
            contentId: ref.contentId,
            mediaType: ref.mediaType,
            digest: ref.digest,
            transformation: null,
          },
          transformation: "attachment-placeholder",
        })
        continue
      }
      const load = () => this.content(attachment.content_sha256)
      const original = reference(attachment.content_sha256, attachment.mime_type, null)
      const unsupported = (reason: string) => {
        if (current) throw new AttachmentProjectionError("unsupported", reason)
        const text = `[Attachment ${attachment.name} is retained but unavailable to this model: ${reason}]`
        parts.push({ type: "text", text })
        contributions.push({ representation: original, transformation: "attachment-placeholder" })
      }
      if (attachment.mime_type.startsWith("image/")) {
        if (!capabilities.image) {
          unsupported(`the model does not accept image input`)
          continue
        }
        parts.push({ type: "image", mimeType: attachment.mime_type, data: Buffer.from(load()).toString("base64"), representation: original })
        contributions.push({ representation: original, transformation: "attachment-original" })
        continue
      }
      if (attachment.mime_type === "application/pdf" || attachment.format === "application/pdf" || looksPdf(this.prefix(attachment.content_sha256))) {
        if (capabilities.pdf) {
          const bytes = load()
          parts.push({
            type: "pdf",
            mimeType: "application/pdf",
            filename: safePdfName(attachment.name),
            data: Buffer.from(bytes).toString("base64"),
            representation: original,
          })
          contributions.push({ representation: original, transformation: "attachment-native-pdf" })
          continue
        }
        let derived = this.representations(attachment.id).filter((row) =>
          row.transformation === "pdf-text" || row.transformation === "pdf-page-image")
        if (derived.length === 0) {
          if (this.conversion === null) {
            unsupported("PDF conversion is unavailable")
            continue
          }
          let converted
          try {
            converted = await this.conversion.convert({
              load: async () => load(),
              window: { offset: 1, limit: this.options.pagesPerWindow },
              geometry: {
                dpi: this.options.dpi,
                maxLongEdge: this.options.maxLongEdge,
                maxPixelsPerPage: this.options.maxPixelsPerPage,
              },
              signal,
            })
          } catch (error) {
            if (current) throw new AttachmentProjectionError("conversion", `PDF conversion failed for ${attachment.name}: ${error instanceof Error ? error.message : String(error)}`)
            unsupported("PDF conversion failed")
            continue
          }
          const text = boundedPreview(converted.text, { previewLines: this.options.previewLines, previewBytes: this.options.previewBytes })
          this.db.transaction(() => {
            if (text.text !== "") {
              this.put(attachment.id, Buffer.from(text.text, "utf8"), "text/plain", "pdf-text", {
                pageOffset: converted.pages[0]?.page ?? 1,
                pageLimit: converted.pages.length,
                windowOffset: 1,
                windowLimit: this.options.pagesPerWindow,
                total: converted.total,
                includedLines: text.includedLines,
                totalLines: text.totalLines,
                includedBytes: text.includedBytes,
                totalBytes: text.totalBytes,
              })
            }
            for (const page of converted.pages) {
              this.put(attachment.id, page.png, "image/png", "pdf-page-image", {
                page: page.page,
                total: page.total,
                windowOffset: 1,
                windowLimit: this.options.pagesPerWindow,
                width: page.width,
                height: page.height,
                dpi: this.options.dpi,
                maxLongEdge: this.options.maxLongEdge,
                maxPixelsPerPage: this.options.maxPixelsPerPage,
              })
            }
          })()
          derived = this.representations(attachment.id).filter((row) =>
            row.transformation === "pdf-text" || row.transformation === "pdf-page-image")
        }
        const textRow = derived.find((row) => row.transformation === "pdf-text")
        const imageRows = derived.filter((row) => row.transformation === "pdf-page-image")
          .sort((a, b) => Number(a.metadata.page) - Number(b.metadata.page))
        const total = Number((textRow ?? imageRows[0])?.metadata.total ?? 0)
        const first = Math.min(...(imageRows.length > 0
          ? imageRows.map((row) => Number(row.metadata.page))
          : [Number(textRow?.metadata.pageOffset ?? 1)]))
        const end = imageRows.length > 0
          ? Math.max(...imageRows.map((row) => Number(row.metadata.page)))
          : Number(textRow?.metadata.pageOffset ?? 0)
        if (textRow !== undefined) {
          const representation = reference(textRow.content_sha256, "text/plain", "pdf-text", textRow.representation_id)
          const text = new TextDecoder().decode(this.content(textRow.content_sha256))
          const metadata = textRow.metadata
          const continuation = end < total
            ? ` Continue with file_read attachmentId="${attachment.id}" pageOffset=${end + 1}.`
            : ""
          parts.push({
            type: "text",
            text: `# PDF ${attachment.name}\n\nPages ${first}-${end} of ${total}. Text window: ${String(metadata.includedLines ?? "?")} of ${String(metadata.totalLines ?? "?")} lines, ${String(metadata.includedBytes ?? "?")} of ${String(metadata.totalBytes ?? "?")} bytes.${continuation}\n\n${text}`,
          })
          contributions.push({ representation, transformation: "pdf-page-text" })
        }
        if (capabilities.image) {
          for (const row of imageRows) {
            const representation = reference(row.content_sha256, "image/png", "pdf-page-image", row.representation_id)
            parts.push({
              type: "image",
              mimeType: "image/png",
              data: Buffer.from(this.content(row.content_sha256)).toString("base64"),
              representation,
            })
            contributions.push({ representation, transformation: "pdf-page-image" })
          }
        }
        if (textRow === undefined && (!capabilities.image || imageRows.length === 0)) {
          unsupported("the PDF has no extractable text and OCR is not enabled")
        }
        continue
      }
      const bytes = load()
      const format = documentFormat(attachment.name, bytes)
      if (format !== null) {
        const converted = await convertDocument(bytes, format)
        if (!converted.ok) {
          unsupported(`document conversion is unavailable (${converted.reason})`)
          continue
        }
        const preview = boundedPreview(converted.markdown, { previewLines: this.options.previewLines, previewBytes: this.options.previewBytes })
        const representation = this.put(attachment.id, Buffer.from(preview.text, "utf8"), "text/plain", "document-markdown", {
          sourceFormat: String(format),
          includedLines: preview.includedLines,
          totalLines: preview.totalLines,
          includedBytes: preview.includedBytes,
          totalBytes: preview.totalBytes,
        })
        const continuation = preview.includedBytes < preview.totalBytes
          ? ` Continue with file_read attachmentId="${attachment.id}".`
          : ""
        parts.push({
          type: "text",
          text: `# ${attachment.name}\n\nText window: ${preview.includedLines} of ${preview.totalLines} lines, ${preview.includedBytes} of ${preview.totalBytes} bytes.${continuation}\n\n${preview.text}`,
        })
        contributions.push({ representation, transformation: "document-markdown" })
        continue
      }
      if (attachment.mime_type.startsWith("text/") || attachment.format === "text/plain") {
        const value = new TextDecoder("utf-8").decode(bytes)
        const preview = boundedPreview(value, { previewLines: this.options.previewLines, previewBytes: this.options.previewBytes })
        const representation = this.put(attachment.id, Buffer.from(preview.text, "utf8"), "text/plain", "text-preview", {
          includedLines: preview.includedLines,
          totalLines: preview.totalLines,
          includedBytes: preview.includedBytes,
          totalBytes: preview.totalBytes,
        })
        const continuation = preview.includedBytes < preview.totalBytes
          ? ` Continue with file_read attachmentId="${attachment.id}".`
          : ""
        parts.push({
          type: "text",
          text: `# ${attachment.name}\n\nText window: ${preview.includedLines} of ${preview.totalLines} lines, ${preview.includedBytes} of ${preview.totalBytes} bytes.${continuation}\n\n${preview.text}`,
        })
        contributions.push({ representation, transformation: "text-preview" })
        continue
      }
      unsupported("the model has no supported representation for this file")
    }
    return { parts, contributions }
  }
}

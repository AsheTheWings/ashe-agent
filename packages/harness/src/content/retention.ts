import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import type { Database } from "bun:sqlite"
import type { ToolResult } from "../agent/tools.ts"
import type { ToolContent, ToolContentPart } from "../agent/window.ts"
import { emitLog, endSpan, startSpan } from "../telemetry/signals.ts"

export interface ContentPolicy {
  readonly collectionBytes: number
  readonly previewLines: number
  readonly previewBytes: number
}

export interface RetainedResult {
  readonly text: string
  readonly name: string
  readonly mediaType: string
  readonly captureLossBytes: number
}

const encoder = new TextEncoder()
const bytes = (text: string) => encoder.encode(text).byteLength
const referenceName = (referenceId: string) => {
  const safe = referenceId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 128)
  return `${safe === "" ? crypto.randomUUID() : safe}.txt`
}

const cutUtf8 = (text: string, limit: number) => {
  const encoded = encoder.encode(text)
  if (encoded.byteLength <= limit) return text
  const marker = "\n...\n"
  if (limit <= bytes(marker) + 2) {
    let end = Math.max(0, Math.min(limit, encoded.byteLength))
    while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1
    return new TextDecoder().decode(encoded.subarray(0, end))
  }
  const contentLimit = limit - bytes(marker)
  const headBudget = Math.max(1, Math.floor(contentLimit * 0.75))
  let headEnd = Math.min(headBudget, encoded.byteLength)
  while (headEnd > 0 && (encoded[headEnd]! & 0xc0) === 0x80) headEnd -= 1
  let tailStart = Math.max(headEnd, encoded.byteLength - (contentLimit - headEnd))
  while (tailStart < encoded.byteLength && (encoded[tailStart]! & 0xc0) === 0x80) tailStart += 1
  const decoder = new TextDecoder()
  return `${decoder.decode(encoded.subarray(0, headEnd))}${marker}${decoder.decode(encoded.subarray(tailStart))}`
}

/** A bounded observation of retained text with explicit continuation information. */
export const boundedPreview = (text: string, policy: Pick<ContentPolicy, "previewLines" | "previewBytes">) => {
  const lines = text === "" ? [] : text.split("\n")
  if (lines.length > 0 && text.endsWith("\n")) lines.pop()
  const head: Array<string> = []
  let size = 0
  for (const line of lines.slice(0, policy.previewLines)) {
    const separator = head.length === 0 ? 0 : 1
    const next = `${separator === 0 ? "" : "\n"}${line}`
    if (size + bytes(next) <= policy.previewBytes) {
      head.push(line)
      size += bytes(next)
      continue
    }
    const remaining = policy.previewBytes - size - separator
    if (remaining > 0) {
      const cut = cutUtf8(line, remaining)
      head.push(cut)
      size += bytes(cut) + separator
    }
    break
  }
  return {
    text: head.join("\n"),
    includedLines: head.length,
    totalLines: lines.length,
    includedBytes: size,
    totalBytes: bytes(text),
  }
}

/**
 * Applies the common model-observation policy to a tool result. Full text
 * is retained only when the model observation is bounded; already-windowed
 * results carry no captured source and stay as returned by their tool.
 */
export const observeToolResult = (result: ToolResult, policy: ContentPolicy, referenceId: string): ToolResult => {
  if (result.alreadyBounded === true) {
    const source = result.capturedText
    const sourceBytes = source === undefined ? 0 : bytes(source)
    if (source === undefined || source === "" || (result.projectionTruncated !== true && (result.captureLossBytes ?? 0) === 0)) {
      return result
    }
    let captureLossBytes = result.captureLossBytes ?? 0
    const retainedText = sourceBytes <= policy.collectionBytes ? source : cutUtf8(source, policy.collectionBytes)
    if (retainedText !== source) captureLossBytes += Math.max(0, sourceBytes - bytes(retainedText))
    const retention: RetainedResult = {
      text: retainedText,
      name: referenceName(referenceId),
      mediaType: "text/plain",
      captureLossBytes,
    }
    const loss = captureLossBytes === 0
      ? ""
      : ` Capture loss: ${captureLossBytes} bytes were omitted before the retained capture.`
    const withFooter = (fallback: boolean): ToolContent => {
      const footer = fallback
        ? `Captured output was not retained because the content store failed.${loss}`
        : `${captureLossBytes === 0 ? "Full captured text" : "The retained capture"} is available at references/${retention.name}.${loss}`
      return typeof result.content === "string"
        ? `${result.content}\n\n[${footer}]`
        : [...result.content, { type: "text", text: `[${footer}]` }]
    }
    return {
      ...result,
      content: withFooter(false),
      retention,
      retentionFallback: withFooter(true),
    }
  }
  if (typeof result.content !== "string") {
    const textParts = result.content.filter((part) => part.type === "text")
    if (textParts.length === 0 && result.capturedText === undefined) return result
    const source = result.capturedText ?? textParts.map((part) => part.text).join("\n\n")
    const sourceBytes = bytes(source)
    if (result.capturedText === undefined && sourceBytes <= policy.collectionBytes && sourceBytes <= policy.previewBytes) {
      return result
    }
    let captureLossBytes = result.captureLossBytes ?? 0
    const retainedText = sourceBytes <= policy.collectionBytes ? source : cutUtf8(source, policy.collectionBytes)
    if (retainedText !== source) captureLossBytes += Math.max(0, sourceBytes - bytes(retainedText))
    const totalLines = retainedText === ""
      ? 0
      : retainedText.split("\n").length - (retainedText.endsWith("\n") ? 1 : 0)
    const totalBytes = bytes(retainedText)
    let remainingLines = policy.previewLines
    let remainingBytes = policy.previewBytes
    let includedLines = 0
    let includedBytes = 0
    const bounded: Array<ToolContentPart> = result.capturedText === undefined
      ? result.content.flatMap((part): Array<ToolContentPart> => {
          if (part.type !== "text") return [part]
          if (remainingLines <= 0 || remainingBytes <= 0) return []
          const preview = boundedPreview(part.text, {
            previewLines: remainingLines,
            previewBytes: remainingBytes,
          })
          remainingLines -= preview.includedLines
          remainingBytes -= preview.includedBytes
          includedLines += preview.includedLines
          includedBytes += preview.includedBytes
          return preview.text === "" ? [] : [{ ...part, text: preview.text }]
        })
      : (() => {
          const preview = boundedPreview(retainedText, {
            previewLines: policy.previewLines,
            previewBytes: policy.previewBytes,
          })
          includedLines = preview.includedLines
          includedBytes = preview.includedBytes
          let inserted = false
          const media = result.content.flatMap((part): Array<ToolContentPart> => {
            if (part.type !== "text") return [part]
            if (inserted) return []
            inserted = true
            return preview.text === "" ? [] : [{ ...part, text: preview.text }]
          })
          return inserted || preview.text === "" ? media : [{ type: "text", text: preview.text }, ...media]
        })()
    const retention: RetainedResult = {
      text: retainedText,
      name: referenceName(referenceId),
      mediaType: "text/plain",
      captureLossBytes,
    }
    const loss = captureLossBytes === 0
      ? ""
      : `\nCapture loss: ${captureLossBytes} bytes were omitted before the retained capture.`
    const window = `[Text output window: ${includedLines} of ${totalLines} lines, ${includedBytes} of ${totalBytes} bytes.`
    return {
      ...result,
      content: [
        ...bounded,
        { type: "text", text: `${window} Full captured text is retained at references/${retention.name}.]${loss}` },
      ],
      retention,
      retentionFallback: [
        ...bounded,
        { type: "text", text: `${window} Full captured output was not retained because the content store failed.]${loss}` },
      ],
    }
  }
  const captured = result.capturedText
  const source = captured ?? (typeof result.content === "string" ? result.content : "")
  if (source === "") return result
  const sourceBytes = bytes(source)
  let captureLossBytes = result.captureLossBytes ?? 0
  if (captured === undefined && sourceBytes <= policy.collectionBytes) return result
  if (sourceBytes <= policy.collectionBytes && sourceBytes <= policy.previewBytes) return result
  const retainedText = sourceBytes <= policy.collectionBytes ? source : cutUtf8(source, policy.collectionBytes)
  if (retainedText !== source) captureLossBytes += Math.max(0, sourceBytes - bytes(retainedText))
  const lineCount = retainedText === ""
    ? 0
    : retainedText.split("\n").length - (retainedText.endsWith("\n") ? 1 : 0)
  const preview = bytes(retainedText) <= policy.previewBytes
    ? {
        text: retainedText,
        includedLines: lineCount,
        totalLines: lineCount,
        includedBytes: bytes(retainedText),
        totalBytes: bytes(retainedText),
      }
    : boundedPreview(retainedText, policy)
  const retention: RetainedResult = {
    text: retainedText,
    name: referenceName(referenceId),
    mediaType: "text/plain",
    captureLossBytes,
  }
  const loss = captureLossBytes === 0
    ? ""
    : `\nCapture loss: ${captureLossBytes} bytes were omitted before the retained capture.`
  const window = `[Output window: ${preview.includedLines} of ${preview.totalLines} lines, ${preview.includedBytes} of ${preview.totalBytes} bytes.`
  return {
    ...result,
    content: `${preview.text}${loss}\n\n${window} Full captured text is retained at references/${retention.name}.]`,
    retention,
    retentionFallback: `${preview.text}${loss}\n\n${window} Full captured output was not retained because the content store failed.]`,
  }
}

/** History-owned recoverable tool output, stored beside session research and memory. */
export class ContentReferences {
  constructor(
    private readonly db: Database,
    private readonly sessionsDir: string,
  ) {}

  private directory(sessionId: string) {
    return join(this.sessionsDir, sessionId, "references")
  }

  /** One bounded chunk of an entry-owned retained capture, or null when no such capture exists. */
  read(sessionId: string, entryId: string, contentId: string, offset: number, length: number) {
    const row = this.db
      .query<{
        name: string
        media_type: string
        capture_loss_bytes: number
        content_sha256: string
      }, [string, string, string]>(
        `SELECT name, media_type, capture_loss_bytes, content_sha256 FROM content_references
          WHERE session_id = ? AND entry_id = ? AND content_sha256 = ?`,
      )
      .get(sessionId, entryId, contentId)
    if (row === null) return null
    if (basename(row.name) !== row.name || row.name === "" || row.name === "." || row.name === "..") return null
    const path = join(this.directory(sessionId), row.name)
    let byteLength: number
    try {
      byteLength = statSync(path).size
    } catch {
      return null
    }
    if (offset > byteLength) return null
    const bytes = readFileSync(path)
    return {
      sessionId,
      entryId,
      contentId,
      name: row.name,
      mediaType: row.media_type,
      byteLength,
      captureLossBytes: row.capture_loss_bytes,
      offset,
      bytes: bytes.subarray(offset, Math.min(byteLength, offset + length)),
    }
  }

  /** Writes the retained bytes and records their owning entry in one caller transaction. */
  attach(sessionId: string, entryId: string, retention: RetainedResult, contentId: string, at: number) {
    const span = startSpan("ashe_agent.content_retention", {
      "ashe_agent.content.operation": "retention",
      "ashe_agent.content.capture_loss": retention.captureLossBytes > 0,
    })
    const directory = this.directory(sessionId)
    const destination = join(directory, retention.name)
    const temporary = join(directory, `.${retention.name}.${crypto.randomUUID()}`)
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      writeFileSync(temporary, retention.text, { mode: 0o600, flag: "wx" })
      renameSync(temporary, destination)
      this.db.query(
        `INSERT INTO content_references
          (session_id, entry_id, content_sha256, name, media_type, capture_loss_bytes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(sessionId, entryId, contentId, retention.name, retention.mediaType, retention.captureLossBytes, at)
      endSpan(span, { "ashe_agent.content.outcome": "success" })
    } catch (error) {
      rmSync(temporary, { force: true })
      rmSync(destination, { force: true })
      emitLog("ashe_agent.content.retention_failed", {
        "ashe_agent.content.operation": "retention",
        "error.type": "retention_failed",
      })
      endSpan(span, { "ashe_agent.content.outcome": "failed" }, "retention_failed")
      throw error
    }
  }

  /** Copies the source's referenced bytes while a fork stages its branch directory. */
  copyFiles(sourceId: string, targetId: string) {
    const rows = this.db.query<{ name: string }, [string]>(
      "SELECT name FROM content_references WHERE session_id = ?",
    ).all(sourceId)
    if (rows.length === 0) return
    const target = this.directory(targetId)
    mkdirSync(target, { recursive: true, mode: 0o700 })
    for (const row of rows) {
      const from = join(this.directory(sourceId), row.name)
      const to = join(target, row.name)
      try {
        writeFileSync(to, readFileSync(from), { mode: 0o600 })
      } catch {
        // A missing source remains an explicit unavailable retained reference.
      }
    }
  }

  /** Removes bytes no retained entry names. */
  cleanup(sessionId: string) {
    const directory = this.directory(sessionId)
    let names: Array<string>
    try {
      names = readdirSync(directory)
    } catch {
      return
    }
    const owned = new Set(this.db.query<{ name: string }, [string]>(
      "SELECT name FROM content_references WHERE session_id = ?",
    ).all(sessionId).map((row) => row.name))
    for (const name of names) if (!owned.has(name)) rmSync(join(directory, name), { recursive: true, force: true })
    if (owned.size === 0) rmSync(directory, { recursive: true, force: true })
  }
}

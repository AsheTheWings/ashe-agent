import { open, readFile, stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { Glob } from "bun"
import { Schema } from "effect"
import { builtinTool, type Tool, type ToolResult } from "../../agent/tools.ts"
import type { ToolContentPart } from "../../agent/window.ts"
import type { ConversionPort, PdfGeometry } from "../../content/conversion.ts"
import { safePdfName } from "../../content/media.ts"
import { permissionPath } from "../../permissions/paths.ts"
import { convertDocument, documentFormat, MAX_DOCUMENT_BYTES } from "./documents.ts"
import {
  decodeText,
  looksBinary,
  MAX_TOTAL_MEDIA_BYTES,
  MAX_WINDOW_BYTES,
  readMany,
  readWindow,
  streamRefusal,
  type FileRead,
  type PathKind,
} from "./read-window.ts"

/** The largest image `file_read` returns. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
/** The largest text file `file_read` reads. */
export const MAX_TEXT_BYTES = 32 * 1024 * 1024
/** The most files one glob pattern names. */
export const MAX_GLOB_MATCHES = 1_000

const Args = Schema.Struct({
  path: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)]).annotate({
    description:
      "A file path or list of paths and glob patterns; relative paths use the session directory.",
  })),
  attachmentId: Schema.optionalKey(Schema.NonEmptyString.annotate({
    description: "A retained attachment id from an input or continuation note in this session.",
  })),
  offset: Schema.optionalKey(
    Schema.Int.annotate({ description: "The 1-based line to start from; a negative offset counts from the end." }),
  ),
  column: Schema.optionalKey(
    Schema.Int.annotate({ description: "The 1-based character of the starting line, continuing a cut line." }),
  ),
  limit: Schema.optionalKey(Schema.Int.annotate({ description: "The most lines to read per file, at most 2000." })),
  pageOffset: Schema.optionalKey(
    Schema.Int.annotate({ description: "The first PDF page to render locally, 1-based; separate from text-line offset." }),
  ),
  pageLimit: Schema.optionalKey(
    Schema.Int.annotate({ description: "The most PDF pages to render locally; separate from text-line limit." }),
  ),
})

const description = `Reads files with line numbers; cuts name their continuation. Documents become Markdown. PDF pageOffset/pageLimit select pages; image models get page images, text-only models text. Images return as images. Continue a retained attachment with attachmentId and no path.`

const isGlob = (path: string) => /[*?[{]/.test(path)

const IMAGE_SIGNATURES: ReadonlyArray<{ readonly mimeType: string; readonly matches: (bytes: Uint8Array) => boolean }> = [
  { mimeType: "image/png", matches: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mimeType: "image/jpeg", matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mimeType: "image/gif", matches: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  {
    mimeType: "image/webp",
    matches: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
]

const imageType = (bytes: Uint8Array) => IMAGE_SIGNATURES.find((signature) => signature.matches(bytes))?.mimeType ?? null

const looksPdf = (bytes: Uint8Array) => {
  const prefix = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.byteLength, 1_024)))
  return prefix.includes("%PDF-")
}

const digest = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

const kindOf = async (path: string): Promise<{ kind: PathKind; size: number }> => {
  try {
    const info = await stat(path)
    const kind: PathKind = info.isFile()
      ? "file"
      : info.isDirectory()
        ? "directory"
        : info.isCharacterDevice()
          ? "character"
          : info.isBlockDevice()
            ? "block"
            : info.isFIFO()
              ? "fifo"
              : "socket"
    return { kind, size: info.size }
  } catch {
    return { kind: "absent", size: 0 }
  }
}

const head = async (path: string, length: number) => {
  const handle = await open(path, "r")
  try {
    const buffer = new Uint8Array(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

const text = (value: string, failed = false, mediaLimitReached = false): FileRead => ({
  parts: [{ type: "text", text: value }],
  failed,
  ...(mediaLimitReached ? { mediaLimitReached: true } : {}),
})

/**
 * One file a read names: how it is shown, the path as written made
 * absolute by its text, which a device or stream path such as
 * `/proc/self/fd/0` is refused by too, and the resolved path authorized
 * and read, which `again` resolves anew.
 */
interface Named {
  readonly shown: string
  readonly given: string
  readonly absolute: string
  readonly again: () => string
}

interface RetainedRead {
  readonly name: string
  readonly mediaType: string
  readonly format: string
  readonly prefix: Uint8Array
  readonly load: () => Uint8Array
}

export interface FileReadOptions {
  readonly conversion?: ConversionPort
  readonly pdfGeometry?: PdfGeometry
  readonly pdfPagesPerWindow?: number
}

/**
 * Reads one file: refused, an image, a converted document, or text,
 * windowed. A file whose path resolves differently than when it was
 * authorized is not read.
 */
const readFileAt = async (
  file: Named,
  options: {
    offset?: number
    column?: number
    limit?: number
    pageOffset?: number
    pageLimit?: number
    maxBytes: number
    imageInput: boolean
    pdfInput?: boolean
    attachmentId?: string
    conversion?: ConversionPort
    pdfGeometry?: PdfGeometry
    pdfPagesPerWindow?: number
    signal?: AbortSignal
    mediaBytesLeft?: number
  },
): Promise<FileRead> => {
  const { shown, given, absolute } = file
  const now = file.again()
  if (now !== absolute) return text(`${shown} was not read: it resolved to ${absolute} when authorized and resolves to ${now} now.`, true)
  const { kind, size } = await kindOf(absolute)
  const refusal = streamRefusal(given, kind) ?? streamRefusal(absolute, kind)
  if (refusal !== null) return text(refusal, true)
  if (kind === "absent") return text(`${shown} does not exist.`, true)
  if (kind === "directory") return text(`${shown} is a directory.`, true)
  const window = {
    maxBytes: options.maxBytes,
    ...(options.offset === undefined ? {} : { offset: options.offset }),
    ...(options.column === undefined ? {} : { column: options.column }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  }
  if (size > MAX_DOCUMENT_BYTES) {
    const image = imageType(await head(absolute, 16)) !== null
    return text(`${shown} is ${size} bytes, over the ${image ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES}-byte limit of file_read.`, true)
  }
  const prefix = await head(absolute, 1_024)
  const mimeType = imageType(prefix)
  if (mimeType !== null) {
    const mediaBytes = Math.ceil(size / 3) * 4
    if (mediaBytes > (options.mediaBytesLeft ?? Number.POSITIVE_INFINITY)) {
      return text(
        `${shown} was not read: it would exceed the ${MAX_TOTAL_MEDIA_BYTES} base64-byte media limit of this result.`,
        true,
        true,
      )
    }
    const bytes = new Uint8Array(await readFile(absolute))
    if (size > MAX_IMAGE_BYTES) return text(`${shown} is ${size} bytes, over the ${MAX_IMAGE_BYTES}-byte limit for images.`, true)
    if (!options.imageInput) return text(`${shown} is an image (${mimeType}), and the turn's model cannot view images.`, true)
    const content = digest(bytes)
    return {
      parts: [
        { type: "text", text: `${shown} is an image (${mimeType}, ${size} bytes).` },
        {
          type: "image",
          path: shown,
          mimeType,
          data: Buffer.from(bytes).toString("base64"),
          representation: {
            representationId: `image:${content}`,
            contentId: content,
            mediaType: mimeType,
            digest: content,
            transformation: "image-original",
          },
          metadata: { path: shown },
        },
      ],
      failed: false,
    }
  }
  const pdf = looksPdf(prefix)
  const format = pdf ? "pdf" : documentFormat(given, prefix) ?? documentFormat(absolute, prefix)
  if (format !== null) {
    if (String(format) === "pdf") {
      const pageOffset = options.pageOffset ?? 1
      const pageLimit = options.pageLimit ?? options.pdfPagesPerWindow ?? 8
      const load = async () => {
        if (file.again() !== absolute) throw new Error(`${shown} resolved differently before its PDF was loaded`)
        return new Uint8Array(await readFile(absolute))
      }
      if (options.pdfInput === true && options.pageOffset === undefined && options.pageLimit === undefined) {
        if (size * 2 > (options.mediaBytesLeft ?? Number.POSITIVE_INFINITY)) {
          return text(
            `${shown} was not read: it would exceed the ${MAX_TOTAL_MEDIA_BYTES} base64-byte media limit of this result.`,
            true,
            true,
          )
        }
        const bytes = await load()
        const content = digest(bytes)
        return {
          parts: [{
            type: "pdf",
            path: shown,
            mimeType: "application/pdf",
            filename: safePdfName(shown.split("/").at(-1) ?? "file.pdf"),
            data: Buffer.from(bytes).toString("base64"),
            representation: {
              representationId: `file-native-pdf:${content}`,
              contentId: content,
              mediaType: "application/pdf",
              digest: content,
              transformation: "file-native-pdf",
            },
            metadata: { renderer: "ashe-agent/file-read-native@1", pageWindow: "all" },
          }],
          failed: false,
        }
      }
      if (options.conversion === undefined) {
        return text(`${shown} is a PDF, but local PDF conversion is unavailable.`, true)
      }
      try {
        const converted = await options.conversion.convert({
          load,
          window: { offset: pageOffset, limit: pageLimit },
          geometry: options.pdfGeometry ?? { dpi: 144, maxLongEdge: 2_048, maxPixelsPerPage: 4_194_304 },
          signal: options.signal ?? new AbortController().signal,
        })
        const first = converted.pages[0]?.page ?? pageOffset
        const end = converted.pages.at(-1)?.page ?? first - 1
        const continuation = end < converted.total
          ? options.attachmentId === undefined
            ? ` Continue with pageOffset=${end + 1}.`
            : ` Continue with file_read attachmentId="${options.attachmentId}" pageOffset=${end + 1}.`
          : ""
        const heading = `${shown}: PDF pages ${first}-${end} of ${converted.total}.${continuation}`
        const parts: Array<ToolContentPart> = []
        let mediaBytes = 0
        if (converted.text !== "") {
          parts.push({ type: "text", text: `${heading}\n\n${readWindow(converted.text, window)}` })
        } else {
          parts.push({ type: "text", text: heading })
        }
        if (options.imageInput) {
          for (const page of converted.pages) {
            const content = digest(page.png)
            mediaBytes += Math.ceil(page.png.byteLength / 3) * 4
            if (mediaBytes > (options.mediaBytesLeft ?? Number.POSITIVE_INFINITY)) {
              return text(
                `${shown} was not read: its rendered pages would exceed the ${MAX_TOTAL_MEDIA_BYTES} base64-byte media limit of this result.`,
                true,
                true,
              )
            }
            parts.push({
              type: "image",
              path: `${shown}#page=${page.page}`,
              mimeType: "image/png",
              data: Buffer.from(page.png).toString("base64"),
              representation: {
                representationId: `pdf-page-image:${page.page}:${content}`,
                contentId: content,
                mediaType: "image/png",
                digest: content,
                transformation: "pdf-page-image",
              },
              metadata: {
                renderer: "pdfium-wasm",
                rendererVersion: "3.0.0",
                windowOffset: pageOffset,
                windowLimit: pageLimit,
                page: page.page,
                total: page.total,
                width: page.width,
                height: page.height,
                dpi: options.pdfGeometry?.dpi ?? 144,
                maxLongEdge: options.pdfGeometry?.maxLongEdge ?? 2_048,
                maxPixelsPerPage: options.pdfGeometry?.maxPixelsPerPage ?? 4_194_304,
              },
            })
          }
        } else if (converted.text === "") {
          return text(`${shown} has no extractable PDF text in pages ${pageOffset}-${pageOffset + pageLimit - 1}, and the model cannot view rendered pages; OCR is not enabled.`, true)
        }
        return { parts, failed: false }
      } catch (error) {
        return text(`${shown} could not be rendered as a PDF page window (${error instanceof Error ? error.message : String(error)})`, true)
      }
    }
    const bytes = new Uint8Array(await readFile(absolute))
    const converted = await convertDocument(bytes, format as Exclude<typeof format, "pdf">)
    if (!converted.ok) return text(`${shown} could not be converted from ${format} to Markdown (${converted.reason})`, true)
    return text(readWindow(converted.markdown, window))
  }
  const bytes = new Uint8Array(await readFile(absolute))
  const detected = documentFormat(given, bytes) ?? documentFormat(absolute, bytes)
  if (detected !== null) {
    const converted = await convertDocument(bytes, detected)
    if (!converted.ok) return text(`${shown} could not be converted from ${detected} to Markdown (${converted.reason})`, true)
    return text(readWindow(converted.markdown, window))
  }
  if (looksBinary(bytes)) return text(`${shown} is a binary file, which file_read does not read.`, true)
  return text(readWindow(decodeText(bytes), window))
}

/**
 * The files a list of paths and glob patterns names, each with how it is
 * shown and its absolute path as the operating system resolves it, the
 * path both authorized and read.
 */
const expand = async (paths: ReadonlyArray<string>, cwd: string) => {
  const files: Array<Named> = []
  const notes: Array<string> = []
  for (const path of paths) {
    if (!isGlob(path)) {
      files.push({ shown: path, given: resolve(cwd, path), absolute: permissionPath(path, cwd), again: () => permissionPath(path, cwd) })
      continue
    }
    // The pattern's literal leading directories resolve as the operating system walks them; the rest is matched below them.
    const parts = path.split("/")
    const literal = parts.findIndex((part) => isGlob(part))
    const prefix = parts.slice(0, literal).join("/")
    const base = prefix === "" && isAbsolute(path) ? "/" : prefix
    const root = base === "" ? permissionPath(".", cwd) : permissionPath(base, cwd)
    const pattern = parts.slice(literal).join("/")
    const matches: Array<string> = []
    let more = false
    for await (const match of new Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
      if (matches.length === MAX_GLOB_MATCHES) {
        more = true
        break
      }
      matches.push(match)
    }
    if (matches.length === 0) notes.push(`[${path} matches no files.]`)
    if (more) notes.push(`[${path} matches more than ${MAX_GLOB_MATCHES} files; only the first ${MAX_GLOB_MATCHES} found are read.]`)
    for (const match of matches.sort()) {
      const shown = base === "" ? match : base === "/" ? `/${match}` : `${base}/${match}`
      files.push({ shown, given: resolve(cwd, shown), absolute: permissionPath(match, root), again: () => permissionPath(shown, cwd) })
    }
  }
  const seen = new Set<string>()
  return { files: files.filter((file) => (seen.has(file.absolute) ? false : (seen.add(file.absolute), true))), notes }
}

/** Adjacent text parts joined, so a result is one text unless it carries images. */
const contentOf = (parts: ReadonlyArray<ToolContentPart>): ToolResult["content"] => {
  const merged: Array<ToolContentPart> = []
  for (const part of parts) {
    const last = merged.at(-1)
    if (part.type === "text" && last?.type === "text") merged[merged.length - 1] = { type: "text", text: `${last.text}\n${part.text}` }
    else merged.push(part)
  }
  return merged.length === 1 && merged[0]!.type === "text" ? merged[0]!.text : merged
}

const readAttachmentAt = async (
  attachmentId: string,
  attachment: RetainedRead,
  options: {
    readonly offset?: number
    readonly column?: number
    readonly limit?: number
    readonly pageOffset?: number
    readonly pageLimit?: number
    readonly imageInput: boolean
    readonly pdfInput: boolean
    readonly conversion?: ConversionPort
    readonly pdfGeometry?: PdfGeometry
    readonly pdfPagesPerWindow?: number
    readonly signal: AbortSignal
  },
): Promise<FileRead> => {
  const shown = `attachment:${attachmentId}`
  if (typeof attachment.mediaType !== "string") {
    return text(`${shown} has incomplete metadata (${Object.keys(attachment).join(", ")}).`, true)
  }
  const pdf = looksPdf(attachment.prefix)
  const format = pdf ? "pdf" : documentFormat(attachment.name, attachment.prefix)
  if (attachment.mediaType.startsWith("image/") || imageType(attachment.prefix) !== null) {
    if (!options.imageInput) return text(`${shown} is an image, and the turn's model cannot view images.`, true)
    const bytes = attachment.load()
    const content = digest(bytes)
    return {
      parts: [
        { type: "text", text: `${shown} is ${attachment.name} (${attachment.mediaType}, ${bytes.byteLength} bytes).` },
        {
          type: "image",
          path: shown,
          mimeType: imageType(bytes.subarray(0, 16)) ?? attachment.mediaType,
          data: Buffer.from(bytes).toString("base64"),
          representation: {
            representationId: `attachment:${attachmentId}`,
            contentId: content,
            mediaType: attachment.mediaType,
            digest: content,
            transformation: "attachment-original",
          },
          metadata: { attachmentId },
        },
      ],
      failed: false,
    }
  }
  if (format === "pdf") {
    if (options.pdfInput && options.pageOffset === undefined && options.pageLimit === undefined) {
      const bytes = attachment.load()
      const content = digest(bytes)
      return {
        parts: [{
          type: "pdf",
          path: shown,
          mimeType: "application/pdf",
          filename: "attachment.pdf",
          data: Buffer.from(bytes).toString("base64"),
          representation: {
            representationId: `attachment:${attachmentId}`,
            contentId: content,
            mediaType: "application/pdf",
            digest: content,
            transformation: "attachment-native-pdf",
          },
          metadata: { attachmentId, renderer: "ashe-agent/file-read-native@1", pageWindow: "all" },
        }],
        failed: false,
      }
    }
    if (options.conversion === undefined) return text(`${shown} is a PDF, but local PDF conversion is unavailable.`, true)
    const pageOffset = options.pageOffset ?? 1
    const pageLimit = options.pageLimit ?? options.pdfPagesPerWindow ?? 8
    try {
      const converted = await options.conversion.convert({
        load: async () => attachment.load(),
        window: { offset: pageOffset, limit: pageLimit },
        geometry: options.pdfGeometry ?? { dpi: 144, maxLongEdge: 2_048, maxPixelsPerPage: 4_194_304 },
        signal: options.signal,
      })
      const first = converted.pages[0]?.page ?? pageOffset
      const end = converted.pages.at(-1)?.page ?? first - 1
      const continuation = end < converted.total
        ? ` Continue with file_read attachmentId="${attachmentId}" pageOffset=${end + 1}.`
        : ""
      const heading = `${shown} (${attachment.name}): PDF pages ${first}-${end} of ${converted.total}.${continuation}`
      const parts: Array<ToolContentPart> = [{
        type: "text",
        text: converted.text === ""
          ? heading
          : `${heading}\n\n${readWindow(converted.text, {
              maxBytes: MAX_WINDOW_BYTES,
              ...(options.offset === undefined ? {} : { offset: options.offset }),
              ...(options.column === undefined ? {} : { column: options.column }),
              ...(options.limit === undefined ? {} : { limit: options.limit }),
            })}`,
      }]
      if (options.imageInput) {
        for (const page of converted.pages) {
          const content = digest(page.png)
          parts.push({
            type: "image",
            path: `${shown}#page=${page.page}`,
            mimeType: "image/png",
            data: Buffer.from(page.png).toString("base64"),
            representation: {
              representationId: `pdf-page-image:${page.page}:${content}`,
              contentId: content,
              mediaType: "image/png",
              digest: content,
              transformation: "pdf-page-image",
            },
            metadata: {
              attachmentId,
              renderer: "pdfium-wasm",
              rendererVersion: "3.0.0",
              windowOffset: pageOffset,
              windowLimit: pageLimit,
              page: page.page,
              total: page.total,
              width: page.width,
              height: page.height,
              dpi: options.pdfGeometry?.dpi ?? 144,
              maxLongEdge: options.pdfGeometry?.maxLongEdge ?? 2_048,
              maxPixelsPerPage: options.pdfGeometry?.maxPixelsPerPage ?? 4_194_304,
            },
          })
        }
      } else if (converted.text === "") {
        return text(`${shown} has no extractable PDF text in pages ${pageOffset}-${pageOffset + pageLimit - 1}, and the model cannot view rendered pages; OCR is not enabled.`, true)
      }
      return { parts, failed: false }
    } catch (error) {
      return text(`${shown} could not be rendered as a PDF page window (${error instanceof Error ? error.message : String(error)})`, true)
    }
  }
  const bytes = attachment.load()
  if (format !== null) {
    const converted = await convertDocument(bytes, format)
    if (!converted.ok) return text(`${shown} could not be converted from ${format} to Markdown (${converted.reason})`, true)
    return text(readWindow(converted.markdown, {
      maxBytes: MAX_WINDOW_BYTES,
      ...(options.offset === undefined ? {} : { offset: options.offset }),
      ...(options.column === undefined ? {} : { column: options.column }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    }))
  }
  if (looksBinary(bytes)) return text(`${shown} is a binary attachment, which file_read does not read.`, true)
  return text(readWindow(decodeText(bytes), {
    maxBytes: MAX_WINDOW_BYTES,
    ...(options.offset === undefined ? {} : { offset: options.offset }),
    ...(options.column === undefined ? {} : { column: options.column }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  }))
}

/**
 * `file_read`: reads one path, or a list of paths and glob patterns, each
 * checked under the `read` permission; nothing about what was read is
 * recorded.
 */
export const fileReadTool = (options: FileReadOptions = {}): Tool =>
  builtinTool<typeof Args, Awaited<ReturnType<typeof expand>> | { readonly attachmentId: string }>({
    namespace: "file",
    name: "read",
    permission: "read",
    description,
    args: Args,
    prepare: async ({ path, attachmentId }, run) => {
      if (attachmentId !== undefined) {
        if (path !== undefined) return { outcome: "failed", content: "attachmentId cannot be combined with path." }
        if (run.retainedAttachmentInfo?.(attachmentId) == null) {
          return { outcome: "failed", content: `The retained attachment ${attachmentId} is not available in this session.` }
        }
        return {
          check: { permission: "read", subjects: [`attachment:${attachmentId}`], patterns: [`attachment:${attachmentId}`] },
          plan: { attachmentId },
        }
      }
      if (path === undefined) return { outcome: "failed", content: "file_read needs a path or an attachmentId." }
      const expanded = await expand(typeof path === "string" ? [path] : path, run.cwd)
      const subjects = [...new Set(expanded.files.map((file) => file.absolute))]
      return { check: { permission: "read", subjects, patterns: subjects }, plan: expanded }
    },
    run: async ({ path, attachmentId, offset, column, limit, pageOffset, pageLimit }, run, plan) => {
      if ((pageOffset !== undefined || pageLimit !== undefined) && (offset !== undefined || column !== undefined || limit !== undefined)) {
        return {
          outcome: "failed",
          content: "pageOffset/pageLimit select a PDF page window and cannot be combined with text-line offset, column, or limit.",
        }
      }
      const common = {
        ...(offset === undefined ? {} : { offset }),
        ...(column === undefined ? {} : { column }),
        ...(limit === undefined ? {} : { limit }),
        ...(pageOffset === undefined ? {} : { pageOffset }),
        ...(pageLimit === undefined ? {} : { pageLimit }),
        imageInput: run.imageInput,
        pdfInput: run.pdfInput === true,
        signal: run.signal,
        ...(options.conversion === undefined ? {} : { conversion: options.conversion }),
        ...(options.pdfGeometry === undefined ? {} : { pdfGeometry: options.pdfGeometry }),
        ...(options.pdfPagesPerWindow === undefined ? {} : { pdfPagesPerWindow: options.pdfPagesPerWindow }),
      }
      if ("attachmentId" in plan) {
        const attachment = run.readRetainedAttachment?.(plan.attachmentId) ?? null
        if (attachment === null) {
          return { outcome: "failed", content: `The retained attachment ${plan.attachmentId} is not available in this session.` }
        }
        const read = await readAttachmentAt(plan.attachmentId, attachment, common)
        return { outcome: read.failed ? "failed" : "success", content: contentOf(read.parts), alreadyBounded: true }
      }
      const { files, notes } = plan
      if (typeof path === "string" && !isGlob(path)) {
        const read = await readFileAt(files[0]!, { ...common, maxBytes: MAX_WINDOW_BYTES })
        return { outcome: read.failed ? "failed" : "success", content: contentOf(read.parts), alreadyBounded: true }
      }
      const byShown = new Map(files.map((file) => [file.shown, file]))
      const reads = await readMany(
        files.map((file) => file.shown),
        (shown, maxBytes, mediaBytesLeft) => readFileAt(byShown.get(shown)!, { ...common, maxBytes, mediaBytesLeft }),
      )
      return {
        outcome: "success",
        content: contentOf([...notes.map((note) => ({ type: "text" as const, text: note })), ...reads]),
        alreadyBounded: true,
      }
    },
  })

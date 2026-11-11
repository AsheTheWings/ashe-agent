import type { ToolContentPart } from "../../agent/window.ts"

/** Ceilings of one `file_read` window. */
export const MAX_LINES = 2_000
export const MAX_WINDOW_BYTES = 128 * 1024
export const MAX_LINE_CHARACTERS = 2_000
/** The ceiling of a read of several files, in bytes. */
export const MAX_TOTAL_BYTES = 100 * 1024

const encoder = new TextEncoder()
/** The UTF-8 length of text, in bytes. */
export const byteLength = (text: string) => encoder.encode(text).length

/** UTF-8 text with a leading byte order mark removed and CRLF line endings as LF. */
export const decodeText = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")

/** Whether bytes look binary: a NUL byte among the first 8 KB. */
export const looksBinary = (bytes: Uint8Array) => bytes.subarray(0, 8192).includes(0)

export type PathKind = "file" | "directory" | "character" | "block" | "fifo" | "socket" | "symlink" | "absent"

/** Why a path is never read as a file, or null: devices, process file descriptors, FIFOs, and sockets. */
export const streamRefusal = (path: string, kind: PathKind): string | null => {
  const device = path === "/dev" || path.startsWith("/dev/") || /^\/proc\/[^/]+\/fd(\/|$)/.test(path)
  if (device || kind === "character" || kind === "block" || kind === "fifo" || kind === "socket") {
    return `${path} is a device or stream, which file_read does not read.`
  }
  return null
}

/**
 * A line from its 1-based character `column`, cut to `MAX_LINE_CHARACTERS`
 * characters, never inside a character; `next` is the column the rest
 * continues from when it was cut.
 */
const clipLine = (line: string, column: number): { text: string; next: number | null } => {
  if (column === 1 && line.length <= MAX_LINE_CHARACTERS) return { text: line, next: null }
  const characters = Array.from(line).slice(column - 1)
  if (characters.length <= MAX_LINE_CHARACTERS) return { text: characters.join(""), next: null }
  return { text: characters.slice(0, MAX_LINE_CHARACTERS).join(""), next: column + MAX_LINE_CHARACTERS }
}

export interface WindowOptions {
  /** The 1-based line to start from; a negative offset counts from the end, -1 being the last line. */
  readonly offset?: number
  /** The 1-based character of the starting line to start from. */
  readonly column?: number
  readonly limit?: number
  /** The most bytes the window may hold; `MAX_WINDOW_BYTES` at most. */
  readonly maxBytes?: number
}

/**
 * A window of text as `cat -n` numbers it: at most `MAX_LINES` lines,
 * `MAX_WINDOW_BYTES` bytes, and `MAX_LINE_CHARACTERS` characters per line.
 * When it stops at a ceiling, at an empty file, or past the end, it says so
 * and names the offset to continue from, and a cut line's column too.
 */
export const readWindow = (text: string, options: WindowOptions = {}): string => {
  const lines = text === "" ? [] : text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  const total = lines.length
  if (total === 0) return "[The file is empty; continue from offset 1 once it has lines.]"
  const requested = options.offset ?? 1
  const start = requested < 0 ? Math.max(1, total + requested + 1) : Math.max(1, requested)
  if (start > total) {
    return `[Offset ${start} is past the end of the file, which has ${total} lines; continue from offset 1, or use a negative offset to read its end.]`
  }
  const column = Math.max(1, options.column ?? 1)
  const startLength = Array.from(lines[start - 1]!).length
  if (column > 1 && column > startLength) {
    return `[Column ${column} is past the end of line ${start}, which has ${startLength} characters; continue from offset ${start + 1}.]`
  }
  const limit = Math.min(Math.max(1, options.limit ?? MAX_LINES), MAX_LINES)
  const maxBytes = Math.min(options.maxBytes ?? MAX_WINDOW_BYTES, MAX_WINDOW_BYTES)
  const out: Array<string> = []
  let bytes = 0
  const cuts: Array<{ line: number; next: number }> = []
  let line = start
  for (; line <= total && line < start + limit; line += 1) {
    const cut = clipLine(lines[line - 1]!, line === start ? column : 1)
    const numbered = `${String(line).padStart(6)}\t${cut.text}`
    const size = byteLength(numbered) + 1
    if (bytes + size > maxBytes) break
    out.push(numbered)
    bytes += size
    if (cut.next !== null) cuts.push({ line, next: cut.next })
  }
  const notes: Array<string> = []
  const first = cuts[0]
  if (first !== undefined) {
    const continues = `continue line ${first.line} from offset ${first.line}, column ${first.next}`
    notes.push(
      cuts.length === 1
        ? `[Line ${first.line} was cut at ${MAX_LINE_CHARACTERS} characters; ${continues}.]`
        : `[${cuts.length} lines were cut at ${MAX_LINE_CHARACTERS} characters; ${continues}, and each other cut line from its own offset, column ${MAX_LINE_CHARACTERS + 1}.]`,
    )
  }
  if (line <= total) {
    const reason = line === start + limit ? `${limit} lines` : `${maxBytes} bytes`
    notes.push(
      out.length === 0
        ? `[Line ${start} does not fit in the remaining ${maxBytes} bytes; continue from offset ${start}.]`
        : `[Stopped at ${reason}: lines ${start}-${line - 1} of ${total}; continue from offset ${line}.]`,
    )
  }
  return [...out, ...notes].join("\n")
}

/** One file's read: its content parts, and whether it failed. */
export interface FileRead {
  readonly parts: ReadonlyArray<ToolContentPart>
  readonly failed: boolean
  readonly mediaLimitReached?: boolean
}

/** Base64 media bytes one read may return across all of its files. */
export const MAX_TOTAL_MEDIA_BYTES = 8 * 1024 ** 2

/**
 * The reads of several files, each under a `==> path <==` header and each
 * given what is left of `MAX_TOTAL_BYTES` of text and
 * `MAX_TOTAL_MEDIA_BYTES` of base64 media; once either is spent, the
 * remaining files are named as not read.
 */
export const readMany = async (
  files: ReadonlyArray<string>,
  read: (file: string, maxBytes: number, mediaBytesLeft: number) => Promise<FileRead>,
): Promise<Array<ToolContentPart>> => {
  const parts: Array<ToolContentPart> = []
  const skipped: Array<string> = []
  let used = 0
  let mediaUsed = 0
  let mediaStopped = false
  for (const [index, file] of files.entries()) {
    if (used >= MAX_TOTAL_BYTES || mediaUsed >= MAX_TOTAL_MEDIA_BYTES) {
      mediaStopped = mediaUsed >= MAX_TOTAL_MEDIA_BYTES
      skipped.push(file)
      continue
    }
    const header = `==> ${file} <==`
    const result = await read(file, Math.min(MAX_WINDOW_BYTES, MAX_TOTAL_BYTES - used), MAX_TOTAL_MEDIA_BYTES - mediaUsed)
    parts.push({ type: "text", text: header }, ...result.parts)
    used += byteLength(header) + result.parts.reduce((sum, part) => sum + (part.type === "text" ? byteLength(part.text) : 0), 0)
    mediaUsed += result.parts.reduce((sum, part) => sum + (part.type === "text" ? 0 : byteLength(part.data)), 0)
    if (result.mediaLimitReached === true) {
      mediaStopped = true
      const remaining = files.slice(index + 1)
      skipped.push(...remaining)
      break
    }
  }
  if (skipped.length > 0) {
    parts.push({
      type: "text",
      text: mediaStopped
        ? `[Stopped at ${MAX_TOTAL_MEDIA_BYTES} base64 media bytes in total; not read: ${skipped.join(", ")}.]`
        : `[Stopped at ${MAX_TOTAL_BYTES} bytes in total; not read: ${skipped.join(", ")}.]`,
    })
  }
  return parts
}

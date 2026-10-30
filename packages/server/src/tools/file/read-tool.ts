import { open, readFile, stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { Glob } from "bun"
import { Schema } from "effect"
import { builtinTool, type Tool, type ToolResult } from "../../agent/tools.ts"
import type { ToolContentPart } from "../../agent/window.ts"
import { permissionPath } from "../../permissions/paths.ts"
import { convertDocument, documentFormat, MAX_DOCUMENT_BYTES } from "./documents.ts"
import {
  decodeText,
  looksBinary,
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
  path: Schema.Union([Schema.String, Schema.Array(Schema.String)]).annotate({
    description:
      "A file path, or a list of file paths and glob patterns such as `src/**/*.ts`. Relative paths resolve against the session's starting working directory.",
  }),
  offset: Schema.optionalKey(
    Schema.Int.annotate({ description: "The line to start from, 1-based; a negative offset counts from the end, -1 being the last line." }),
  ),
  column: Schema.optionalKey(
    Schema.Int.annotate({ description: "The character of the starting line to start from, 1-based; continues a line that a read cut." }),
  ),
  limit: Schema.optionalKey(Schema.Int.annotate({ description: "The most lines to read from each file, at most 2000." })),
})

const description = `Reads files. Text comes back with line numbers as \`cat -n\` prints them, at most 2000 lines, 128 KB, and 2000 characters per line at a time; when a read stops early or cuts a line, its result names the offset, and the column for a cut line, to continue from. Documents (PDF, Word, Excel, PowerPoint, OpenDocument, RTF, EPUB, and CSV files) are converted to Markdown and read the same way. PNG, JPEG, GIF, and WebP images come back as images when the model can view them. A list of paths and glob patterns reads every file under its own header, up to 100 KB in total.`

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

const text = (value: string, failed = false): FileRead => ({ parts: [{ type: "text", text: value }], failed })

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

/**
 * Reads one file: refused, an image, a converted document, or text,
 * windowed. A file whose path resolves differently than when it was
 * authorized is not read.
 */
const readFileAt = async (
  file: Named,
  options: { offset?: number; column?: number; limit?: number; maxBytes: number; imageInput: boolean },
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
  const bytes = new Uint8Array(await readFile(absolute))
  const mimeType = imageType(bytes)
  if (mimeType !== null) {
    if (size > MAX_IMAGE_BYTES) return text(`${shown} is ${size} bytes, over the ${MAX_IMAGE_BYTES}-byte limit for images.`, true)
    if (!options.imageInput) return text(`${shown} is an image (${mimeType}), and the turn's model cannot view images.`, true)
    return {
      parts: [
        { type: "text", text: `${shown} is an image (${mimeType}, ${size} bytes).` },
        { type: "image", path: shown, mimeType, data: Buffer.from(bytes).toString("base64") },
      ],
      failed: false,
    }
  }
  const format = documentFormat(given, bytes) ?? documentFormat(absolute, bytes)
  if (format !== null) {
    const converted = await convertDocument(bytes, format)
    if (!converted.ok) return text(`${shown} could not be converted from ${format} to Markdown (${converted.reason})`, true)
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

/**
 * `file_read`: reads one path, or a list of paths and glob patterns, each
 * checked under the `read` permission; nothing about what was read is
 * recorded.
 */
export const fileReadTool = (): Tool =>
  builtinTool<typeof Args, Awaited<ReturnType<typeof expand>>>({
    namespace: "file",
    name: "read",
    description,
    args: Args,
    prepare: async ({ path }, run) => {
      const expanded = await expand(typeof path === "string" ? [path] : path, run.cwd)
      const subjects = [...new Set(expanded.files.map((file) => file.absolute))]
      return { check: { permission: "read", subjects, patterns: subjects }, plan: expanded }
    },
    run: async ({ path, offset, column, limit }, run, { files, notes }) => {
      const window = {
        ...(offset === undefined ? {} : { offset }),
        ...(column === undefined ? {} : { column }),
        ...(limit === undefined ? {} : { limit }),
        imageInput: run.imageInput,
      }
      if (typeof path === "string" && !isGlob(path)) {
        const read = await readFileAt(files[0]!, { ...window, maxBytes: MAX_WINDOW_BYTES })
        return { outcome: read.failed ? "failed" : "success", content: contentOf(read.parts) }
      }
      const byShown = new Map(files.map((file) => [file.shown, file]))
      const reads = await readMany(
        files.map((file) => file.shown),
        (shown, maxBytes) => readFileAt(byShown.get(shown)!, { ...window, maxBytes }),
      )
      return { outcome: "success", content: contentOf([...notes.map((note) => ({ type: "text" as const, text: note })), ...reads]) }
    },
  })

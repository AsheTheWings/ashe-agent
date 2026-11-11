import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { TITLE_DESCRIPTION_MAX_LENGTH } from "../context/constants.ts"
import { parseFrontmatter } from "./frontmatter.ts"

/** A title as it displays: its key with each dash a space and each word capitalized. */
export const displayTitle = (key: string) =>
  key
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")

/** The file metadata that tells whether a file may have changed since it was read. */
export interface FileMetadata {
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
}

/**
 * What reading an instructions file found: its text and metadata, its
 * absence, or why it cannot be read.
 */
export type FileText =
  | { readonly kind: "text"; readonly text: string; readonly metadata: FileMetadata }
  | { readonly kind: "unchanged" }
  | { readonly kind: "absent" }
  | { readonly kind: "error"; readonly reason: string }

const metadataOf = (stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): FileMetadata => ({
  dev: stat.dev,
  ino: stat.ino,
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs,
})

/** Whether two metadata records describe the same unchanged file. */
export const sameMetadata = (a: FileMetadata, b: FileMetadata) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs

/**
 * Reads a regular file as UTF-8 with its metadata. With `noFollow`, a
 * symlink at `path` is refused rather than followed. With `unchangedFrom`,
 * a file whose metadata equals it is reported unchanged without reading.
 * The open never blocks, so a FIFO or device is refused as not a regular file.
 */
export const readFileText = (
  path: string,
  options: { readonly noFollow?: boolean; readonly unchangedFrom?: FileMetadata } = {},
): FileText => {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (options.noFollow === true ? constants.O_NOFOLLOW : 0))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { kind: "absent" }
    if (code === "ELOOP") return { kind: "error", reason: "it is a symlink" }
    return { kind: "error", reason: `it is unreadable (${code ?? "read failed"})` }
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return { kind: "error", reason: "it is not a regular file" }
    if (options.unchangedFrom !== undefined && sameMetadata(metadataOf(stat), options.unchangedFrom)) return { kind: "unchanged" }
    return { kind: "text", text: readFileSync(fd, "utf8"), metadata: metadataOf(stat) }
  } catch (error) {
    return { kind: "error", reason: `it is unreadable (${(error as NodeJS.ErrnoException).code ?? "read failed"})` }
  } finally {
    closeSync(fd)
  }
}

/** A title file's description and the user instructions of its body, or why it is refused. */
export type ParsedTitleFile =
  | { readonly ok: true; readonly description: string; readonly body: string }
  | { readonly ok: false; readonly reason: string }

/**
 * Parses a title file: YAML frontmatter holding only `description:` of 1 to
 * 1,024 characters, then a body that is the agent's user instructions.
 */
export const parseTitleFile = (text: string): ParsedTitleFile => {
  const parsed = parseFrontmatter(text)
  if (!parsed.ok) return parsed
  const keys = Object.keys(parsed.data)
  const others = keys.filter((key) => key !== "description")
  if (others.length > 0) return { ok: false, reason: `its frontmatter holds ${others.map((key) => JSON.stringify(key)).join(", ")}, not only description` }
  const description = parsed.data.description
  if (typeof description !== "string" || description.trim() === "") return { ok: false, reason: "its frontmatter has no description" }
  if ([...description].length > TITLE_DESCRIPTION_MAX_LENGTH) {
    return { ok: false, reason: `its description is longer than ${TITLE_DESCRIPTION_MAX_LENGTH} characters` }
  }
  return { ok: true, description, body: parsed.body }
}

/** A title file as the server finds it. */
export type TitleFile =
  | {
      readonly state: "present"
      readonly path: string
      readonly description: string
      readonly body: string
      /** The whole file, which the body and its metadata come from. */
      readonly text: string
      readonly metadata: FileMetadata
    }
  | { readonly state: "unchanged"; readonly path: string }
  | { readonly state: "absent"; readonly path: string }
  | { readonly state: "refused"; readonly path: string; readonly reason: string }

/**
 * The title file of the agent `key`: `<dir>/<key>.md`, a regular file read
 * without following a symlink; unchanged, unread, when its metadata equals
 * `unchangedFrom`.
 */
export const readTitleFile = (dir: string, key: string, unchangedFrom?: FileMetadata): TitleFile => {
  const path = join(dir, `${key}.md`)
  const read = readFileText(path, { noFollow: true, ...(unchangedFrom === undefined ? {} : { unchangedFrom }) })
  if (read.kind === "absent") return { state: "absent", path }
  if (read.kind === "unchanged") return { state: "unchanged", path }
  if (read.kind === "error") return { state: "refused", path, reason: read.reason }
  const parsed = parseTitleFile(read.text)
  if (!parsed.ok) return { state: "refused", path, reason: parsed.reason }
  return { state: "present", path, description: parsed.description, body: parsed.body, text: read.text, metadata: read.metadata }
}

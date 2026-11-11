import { lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { entryPath, permissionPath } from "../../permissions/paths.ts"
import { derive, type Hunk } from "./patch.ts"

type Kind = "file" | "directory" | "absent"

/** The file operations a patch needs, over absolute paths. */
export interface PatchFiles {
  /** What a path reaches, following a final symlink. */
  readonly kind: (path: string) => Promise<Kind>
  /** What a directory entry is itself, a symlink being `link`. */
  readonly entryKind: (path: string) => Promise<Kind | "link">
  readonly read: (path: string) => Promise<string>
  /** Writes a file, creating its missing parent directories. */
  readonly write: (path: string, contents: string) => Promise<void>
  /** Removes a directory entry, a symlink itself rather than its target. */
  readonly remove: (path: string) => Promise<void>
}

const absentOnMissing = async <A>(probe: () => Promise<A>, absent: A): Promise<A> => {
  try {
    return await probe()
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT" || (error as { code?: string }).code === "ENOTDIR") return absent
    throw error
  }
}

/** The host filesystem's files. */
export const diskFiles: PatchFiles = {
  kind: (path) => absentOnMissing(async () => ((await stat(path)).isDirectory() ? "directory" : "file"), "absent" as Kind),
  entryKind: (path) =>
    absentOnMissing(async () => {
      const info = await lstat(path)
      return info.isSymbolicLink() ? "link" : info.isDirectory() ? "directory" : "file"
    }, "absent" as Kind | "link"),
  read: (path) => readFile(path, "utf8"),
  write: async (path, contents) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents)
  },
  remove: (path) => rm(path),
}

/**
 * How a patch's paths become absolute paths: `target` for a file read or
 * written, `entry` for a directory entry removed.
 */
export interface PatchPaths {
  readonly target: (path: string) => string
  readonly entry: (path: string) => string
}

/** Paths resolved against `cwd` as the operating system walks them, the ones authorization decides. */
export const diskPaths = (cwd: string): PatchPaths => ({
  target: (path) => permissionPath(path, cwd),
  entry: (path) => entryPath(path, cwd),
})

/** Paths resolved against `cwd` by their text alone, for files that are not on disk. */
export const lexicalPaths = (cwd: string): PatchPaths => ({
  target: (path) => resolve(cwd, path),
  entry: (path) => resolve(cwd, path),
})

/**
 * A hunk with the absolute paths it acts on, fixed before any hunk runs:
 * Add File writes `target`; Delete File removes `entry`; Update File reads
 * `target` and writes it, or with a move writes `destination` and removes
 * the source's `entry`.
 */
export type Located =
  | { readonly hunk: Extract<Hunk, { type: "add" }>; readonly target: string }
  | { readonly hunk: Extract<Hunk, { type: "delete" }>; readonly entry: string }
  | {
      readonly hunk: Extract<Hunk, { type: "update" }>
      readonly target: string
      readonly move: { readonly destination: string; readonly entry: string } | null
    }

/** Every hunk's paths, resolved once. */
export const locate = (hunks: ReadonlyArray<Hunk>, paths: PatchPaths): ReadonlyArray<Located> =>
  hunks.map((hunk): Located => {
    if (hunk.type === "add") return { hunk, target: paths.target(hunk.path) }
    if (hunk.type === "delete") return { hunk, entry: paths.entry(hunk.path) }
    const target = paths.target(hunk.path)
    if (hunk.movePath === undefined) return { hunk, target, move: null }
    const destination = paths.target(hunk.movePath)
    return { hunk, target, move: destination === target ? null : { destination, entry: paths.entry(hunk.path) } }
  })

/** Every path a located hunk reads, writes, or removes, in order and without repeats. */
export const locatedPaths = (located: ReadonlyArray<Located>): ReadonlyArray<string> => [
  ...new Set(
    located.flatMap((item) => {
      if ("entry" in item) return [item.entry]
      if (item.hunk.type === "add") return [item.target]
      const update = item as Extract<Located, { move: unknown }>
      return update.move === null ? [update.target] : [update.move.entry, update.target, update.move.destination]
    }),
  ),
]

/** One applied hunk: `A`, `M`, or `D` and the path as the patch gave it, its move destination for a move. */
export interface Applied {
  readonly kind: "A" | "M" | "D"
  readonly path: string
}

/** A hunk that could not be applied, after the hunks before it were. */
export class ApplyFailure extends Error {
  constructor(
    message: string,
    readonly applied: ReadonlyArray<Applied>,
  ) {
    super(message)
  }
}

const readText = async (files: PatchFiles, path: string) => {
  const kind = await files.kind(path)
  if (kind !== "file") throw new Error(`Failed to read file to update ${path}: ${kind === "absent" ? "file does not exist" : "path is a directory"}`)
  return files.read(path)
}

const writable = async (files: PatchFiles, path: string) => {
  if ((await files.kind(path)) === "directory") throw new Error(`Failed to write ${path}: path is a directory`)
}

/**
 * Applies located hunks in order, as Codex does: Add File writes the file,
 * replacing an existing one; Delete File removes a file or symlink entry
 * without reading it; Update File rewrites a file, moving it when the hunk
 * names a destination. A hunk that fails stops the patch, leaving the
 * hunks before it applied.
 */
export const applyHunks = async (located: ReadonlyArray<Located>, files: PatchFiles = diskFiles): Promise<ReadonlyArray<Applied>> => {
  const applied: Array<Applied> = []
  for (const item of located) {
    try {
      if ("entry" in item) {
        const kind = await files.entryKind(item.entry)
        if (kind === "absent") throw new Error(`Failed to delete ${item.entry}: file does not exist`)
        if (kind === "directory") throw new Error(`Failed to delete ${item.entry}: path is a directory`)
        await files.remove(item.entry)
        applied.push({ kind: "D", path: item.hunk.path })
      } else if (item.hunk.type === "add") {
        await writable(files, item.target)
        const contents = item.hunk.contents
        await files.write(item.target, contents === "" || contents.endsWith("\n") ? contents : `${contents}\n`)
        applied.push({ kind: "A", path: item.hunk.path })
      } else {
        const update = item as Extract<Located, { move: unknown }>
        const next = derive(update.hunk.path, update.hunk.chunks, await readText(files, update.target))
        if (update.move === null) {
          await files.write(update.target, next)
          applied.push({ kind: "M", path: update.hunk.path })
        } else {
          await writable(files, update.move.destination)
          await files.write(update.move.destination, next)
          await files.remove(update.move.entry)
          applied.push({ kind: "M", path: update.hunk.movePath! })
        }
      }
    } catch (error) {
      throw new ApplyFailure(error instanceof Error ? error.message : String(error), applied)
    }
  }
  return applied
}

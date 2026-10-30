import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { derive, type Hunk } from "./patch.ts"

/** The file operations a patch needs, over absolute paths. */
export interface PatchFiles {
  readonly kind: (path: string) => Promise<"file" | "directory" | "absent">
  readonly read: (path: string) => Promise<string>
  /** Writes a file, creating its missing parent directories. */
  readonly write: (path: string, contents: string) => Promise<void>
  readonly remove: (path: string) => Promise<void>
}

/** The host filesystem's files. */
export const diskFiles: PatchFiles = {
  kind: async (path) => {
    try {
      return (await stat(path)).isDirectory() ? "directory" : "file"
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return "absent"
      throw error
    }
  },
  read: (path) => readFile(path, "utf8"),
  write: async (path, contents) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents)
  },
  remove: (path) => rm(path),
}

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

const readText = async (files: PatchFiles, path: string, verb: string) => {
  const kind = await files.kind(path)
  if (kind !== "file") throw new Error(`Failed to ${verb} ${path}: ${kind === "absent" ? "file does not exist" : "path is a directory"}`)
  return files.read(path)
}

/**
 * Applies hunks in order, as Codex does: Add File writes the file,
 * replacing an existing one; Delete File removes a file; Update File
 * rewrites one, moving it when the hunk names a destination. A hunk that
 * fails stops the patch, leaving the hunks before it applied.
 */
export const applyHunks = async (hunks: ReadonlyArray<Hunk>, cwd: string, files: PatchFiles = diskFiles): Promise<ReadonlyArray<Applied>> => {
  const applied: Array<Applied> = []
  for (const hunk of hunks) {
    const path = resolve(cwd, hunk.path)
    try {
      if (hunk.type === "add") {
        if ((await files.kind(path)) === "directory") throw new Error(`Failed to write ${path}: path is a directory`)
        await files.write(path, hunk.contents === "" || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`)
        applied.push({ kind: "A", path: hunk.path })
      } else if (hunk.type === "delete") {
        await readText(files, path, "delete")
        await files.remove(path)
        applied.push({ kind: "D", path: hunk.path })
      } else {
        const next = derive(hunk.path, hunk.chunks, await readText(files, path, "read file to update"))
        if (hunk.movePath === undefined || resolve(cwd, hunk.movePath) === path) {
          await files.write(path, next)
          applied.push({ kind: "M", path: hunk.path })
        } else {
          const destination = resolve(cwd, hunk.movePath)
          if ((await files.kind(destination)) === "directory") throw new Error(`Failed to write ${destination}: path is a directory`)
          await files.write(destination, next)
          await files.remove(path)
          applied.push({ kind: "M", path: hunk.movePath })
        }
      }
    } catch (error) {
      throw new ApplyFailure(error instanceof Error ? error.message : String(error), applied)
    }
  }
  return applied
}

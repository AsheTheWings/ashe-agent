import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs"
import { join } from "node:path"
import type { FileMetadata } from "../agents/titles.ts"

/** A research or memory file: its name in its directory, its bytes, and their SHA-256. */
export interface StoredFile {
  readonly name: string
  readonly data: Uint8Array
  readonly sha256: string
}

/** A memory generation's file as recorded: its digest and its metadata as published. */
export interface RecordedFile {
  readonly name: string
  readonly sha256: string
  readonly metadata: FileMetadata
}

/** What a memory check found: nothing, or the paths that differ from the current generation. */
export type MemoryCheck = { readonly ok: true } | { readonly ok: false; readonly paths: ReadonlyArray<string> }

/** What a scratch copy did: how many entries it skipped as sockets, FIFOs, or devices. */
export interface ScratchCopy {
  readonly skipped: number
}

/** A session id's shape; the sweep removes only entries named like one. */
const SESSION_ID = /^[a-z0-9]{12}$/

const GENERATION_MODE = 0o555
const MEMORY_FILE_MODE = 0o444

export const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex")

const metadataOf = (stat: Stats): FileMetadata => ({
  dev: stat.dev,
  ino: stat.ino,
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs,
})

const sameMetadata = (a: FileMetadata, b: FileMetadata) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs

const lstat = (path: string): Stats | null => {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

/** Whether `name` names a research or memory file: Markdown, directly in its directory. */
const markdownName = (name: string) => name.endsWith(".md")

/**
 * Opens `path` without following a symlink at it and returns its status
 * and, for a regular file, its bytes, both read through that one
 * descriptor; null when nothing is there or it is a symlink.
 */
const readNoFollow = (path: string): { readonly stat: Stats; readonly data: Uint8Array | null } | null => {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ELOOP") return null
    throw error
  }
  try {
    const stat = fstatSync(fd)
    return { stat, data: stat.isFile() ? readFileSync(fd) : null }
  } finally {
    closeSync(fd)
  }
}

/**
 * Removes `path` and, for a directory, everything in it, making each
 * directory writable first and never following a symlink.
 */
export const removeTree = (path: string) => {
  const stat = lstat(path)
  if (stat === null) return
  if (!stat.isDirectory()) {
    unlinkSync(path)
    return
  }
  chmodSync(path, 0o700)
  for (const entry of readdirSync(path)) removeTree(join(path, entry))
  rmdirSync(path)
}

/**
 * A session's files: its directory under the sessions directory, holding
 * `research/`, the `memory` symlink to its current memory generation
 * under the memory directory, and the `scratch` symlink to its target
 * under the scratch root. Every operation is synchronous and follows no
 * symlink it does not own.
 */
export class SessionFiles {
  constructor(
    readonly sessionsDir: string,
    readonly memoryDir: string,
    readonly scratchRoot: string,
  ) {}

  sessionDir(id: string) {
    return join(this.sessionsDir, id)
  }

  generationDir(id: string, generation: number) {
    return join(this.memoryDir, id, String(generation))
  }

  scratchTarget(id: string) {
    return join(this.scratchRoot, id)
  }

  /**
   * Creates a new session's directory with `research/`, its memory
   * directory, and its scratch target with the `scratch` symlink to it;
   * returns the removal of exactly what it created. None of them may
   * exist yet.
   */
  createLayout(id: string): () => void {
    const created: Array<string> = []
    const remove = () => {
      for (const path of created.reverse()) removeTree(path)
    }
    try {
      for (const root of [this.sessionsDir, this.memoryDir, this.scratchRoot]) mkdirSync(root, { recursive: true, mode: 0o700 })
      for (const path of [this.sessionDir(id), join(this.memoryDir, id), this.scratchTarget(id)]) {
        mkdirSync(path, { mode: 0o700 })
        created.push(path)
      }
      // An explicit mode, since `mkdirSync` applies the process umask.
      chmodSync(this.sessionDir(id), 0o700)
      mkdirSync(join(this.sessionDir(id), "research"), { mode: 0o700 })
      symlinkSync(this.scratchTarget(id), join(this.sessionDir(id), "scratch"))
    } catch (error) {
      remove()
      throw error
    }
    return remove
  }

  /**
   * Writes the memory generation `generation` of the session `id`, a
   * read-only directory of read-only `files`, and returns each file's
   * metadata as written. A leftover directory of that generation, from an
   * interrupted publish, is replaced.
   */
  writeGeneration(id: string, generation: number, files: ReadonlyArray<StoredFile>): ReadonlyArray<RecordedFile> {
    const dir = this.generationDir(id, generation)
    mkdirSync(join(this.memoryDir, id), { recursive: true, mode: 0o700 })
    removeTree(dir)
    mkdirSync(dir, { mode: 0o700 })
    for (const file of files) {
      const path = join(dir, file.name)
      writeFileSync(path, file.data, { mode: 0o600, flag: "wx" })
      chmodSync(path, MEMORY_FILE_MODE)
    }
    chmodSync(dir, GENERATION_MODE)
    return files.map((file) => ({ name: file.name, sha256: file.sha256, metadata: metadataOf(lstatSync(join(dir, file.name))) }))
  }

  /** Points the session's `memory` symlink at `generation` by renaming a new symlink over it. */
  pointMemory(id: string, generation: number) {
    const link = join(this.sessionDir(id), "memory")
    const temporary = join(this.sessionDir(id), `.memory-${randomUUID()}`)
    symlinkSync(this.generationDir(id, generation), temporary)
    try {
      // A rename cannot replace a directory, so one at `memory` goes first, without following anything in it.
      if (lstat(link)?.isDirectory()) removeTree(link)
      renameSync(temporary, link)
    } catch (error) {
      removeTree(temporary)
      throw error
    }
  }

  /** Removes every memory generation directory of the session `id` but `generation`. */
  removeOtherGenerations(id: string, generation: number) {
    const dir = join(this.memoryDir, id)
    if (lstat(dir) === null) return
    for (const entry of readdirSync(dir)) if (entry !== String(generation)) removeTree(join(dir, entry))
  }

  /** Removes every file of the session `id`: its directory, memory generations, and scratch target. */
  removeSession(id: string) {
    for (const path of [this.sessionDir(id), join(this.memoryDir, id), this.scratchTarget(id)]) removeTree(path)
  }

  /**
   * Compares the session's `memory` with its current `generation` as
   * `recorded`: `memory` must be a symlink to the generation's directory,
   * which must be read-only and hold exactly the recorded files, each a
   * read-only regular file whose metadata equals the recorded, or whose
   * content still hashes to the recorded digest. Returns the paths that
   * differ, `memory` itself when the symlink does.
   */
  checkMemory(id: string, generation: number, recorded: ReadonlyArray<RecordedFile>): MemoryCheck {
    const link = join(this.sessionDir(id), "memory")
    const dir = this.generationDir(id, generation)
    const linkStat = lstat(link)
    if (linkStat === null || !linkStat.isSymbolicLink() || readlinkSync(link) !== dir) return { ok: false, paths: ["memory"] }
    const dirStat = lstat(dir)
    if (dirStat === null || !dirStat.isDirectory()) return { ok: false, paths: ["memory"] }
    const paths = new Set<string>()
    if ((dirStat.mode & 0o777) !== GENERATION_MODE) paths.add("memory")
    const expected = new Map(recorded.map((file) => [file.name, file]))
    let entries: Array<string>
    try {
      entries = readdirSync(dir)
    } catch {
      // A directory that cannot be listed, such as one of mode 000, is a mismatch to republish.
      return { ok: false, paths: ["memory"] }
    }
    for (const entry of entries) {
      const file = expected.get(entry)
      if (file === undefined) {
        paths.add(`memory/${entry}`)
        continue
      }
      expected.delete(entry)
      let read: ReturnType<typeof readNoFollow>
      try {
        read = lstatSync(join(dir, entry)).isFile() ? readNoFollow(join(dir, entry)) : null
      } catch {
        read = null
      }
      // A file whose metadata changed but whose bytes still hash to the recorded digest is unchanged.
      if (read === null || read.data === null || (read.stat.mode & 0o777) !== MEMORY_FILE_MODE) paths.add(`memory/${entry}`)
      else if (!sameMetadata(metadataOf(read.stat), file.metadata) && sha256(read.data) !== file.sha256) paths.add(`memory/${entry}`)
    }
    for (const name of expected.keys()) paths.add(`memory/${name}`)
    return paths.size === 0 ? { ok: true } : { ok: false, paths: [...paths].sort() }
  }

  /** The session's research files: the regular Markdown files directly inside `research/`, never through a symlink. */
  readResearch(id: string): ReadonlyArray<StoredFile> {
    const dir = join(this.sessionDir(id), "research")
    const stat = lstat(dir)
    if (stat === null || !stat.isDirectory()) return []
    return readdirSync(dir)
      .filter(markdownName)
      .sort()
      .flatMap((name) => {
        // Only regular files are research files; anything else, such as a socket or a directory, is skipped unopened.
        if (lstat(join(dir, name))?.isFile() !== true) return []
        const read = readNoFollow(join(dir, name))
        if (read === null || read.data === null) return []
        return [{ name, data: read.data, sha256: sha256(read.data) }]
      })
  }

  /**
   * Makes the session's research files exactly `files`: each is written
   * under a temporary name and renamed into place, replacing whatever is
   * at its path, a symlink included, and every other research file is
   * deleted. `research/` is recreated when it is not a directory.
   */
  writeResearch(id: string, files: ReadonlyArray<StoredFile>) {
    const dir = join(this.sessionDir(id), "research")
    const stat = lstat(dir)
    if (stat !== null && !stat.isDirectory()) unlinkSync(dir)
    if (stat === null || !stat.isDirectory()) mkdirSync(dir, { mode: 0o700 })
    const keep = new Set(files.map((file) => file.name))
    for (const file of files) {
      const temporary = join(dir, `.${file.name}.${randomUUID()}`)
      writeFileSync(temporary, file.data, { mode: 0o600, flag: "wx" })
      const existing = lstat(join(dir, file.name))
      // A rename cannot replace a directory, so one at the path goes first.
      if (existing?.isDirectory()) removeTree(join(dir, file.name))
      renameSync(temporary, join(dir, file.name))
    }
    for (const name of readdirSync(dir)) {
      if (markdownName(name) && !keep.has(name) && lstatSync(join(dir, name)).isFile()) unlinkSync(join(dir, name))
    }
  }

  /** Recreates the session's scratch target, and its `scratch` symlink, when missing; returns whether the target was lost. */
  ensureScratch(id: string): boolean {
    const target = this.scratchTarget(id)
    const link = join(this.sessionDir(id), "scratch")
    const lost = lstat(target) === null
    if (lost) mkdirSync(target, { recursive: true, mode: 0o700 })
    const linkStat = lstat(link)
    if (linkStat === null || !linkStat.isSymbolicLink() || readlinkSync(link) !== target) {
      if (linkStat !== null) removeTree(link)
      symlinkSync(target, link)
    }
    return lost
  }

  /** The apparent size in bytes of the regular files and symlinks under the session's scratch target. */
  scratchSize(id: string): number {
    const walk = (path: string): number => {
      const stat = lstat(path)
      if (stat === null) return 0
      if (stat.isDirectory()) return readdirSync(path).reduce((sum, entry) => sum + walk(join(path, entry)), 0)
      return stat.isFile() || stat.isSymbolicLink() ? stat.size : 0
    }
    return walk(this.scratchTarget(id))
  }

  /**
   * Copies the scratch contents of `sourceId` into the scratch target of
   * `targetId`, keeping symlinks as symlinks, cloning files by reflink
   * where the filesystem supports it, and skipping sockets, FIFOs, and
   * devices.
   */
  copyScratch(sourceId: string, targetId: string): ScratchCopy {
    let skipped = 0
    const copy = (from: string, to: string) => {
      for (const entry of readdirSync(from)) {
        const path = join(from, entry)
        const destination = join(to, entry)
        const stat = lstatSync(path)
        if (stat.isDirectory()) {
          // Writable while its entries are copied, then given the source's mode.
          mkdirSync(destination, { mode: 0o700 })
          copy(path, destination)
          chmodSync(destination, stat.mode & 0o777)
        } else if (stat.isSymbolicLink()) symlinkSync(readlinkSync(path), destination)
        else if (stat.isFile()) copyFileSync(path, destination, constants.COPYFILE_FICLONE)
        else skipped++
      }
    }
    const from = this.scratchTarget(sourceId)
    if (lstat(from)?.isDirectory()) copy(from, this.scratchTarget(targetId))
    return { skipped }
  }

  /**
   * Removes each direct entry of the sessions directory, the memory
   * directory, and the scratch root that is named like a session id for
   * which `recorded` is false, following no symlink; other entries stay.
   */
  sweep(recorded: (id: string) => boolean) {
    for (const root of [this.sessionsDir, this.memoryDir, this.scratchRoot]) {
      if (!lstat(root)?.isDirectory()) continue
      for (const entry of readdirSync(root)) if (SESSION_ID.test(entry) && !recorded(entry)) removeTree(join(root, entry))
    }
  }
}

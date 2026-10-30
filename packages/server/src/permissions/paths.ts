import { lstatSync, realpathSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

/** A path as an absolute, normalized path against `cwd`, without touching the filesystem. */
export const absolutePath = (path: string, cwd: string) => resolve(cwd, path)

const exists = (path: string) => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * The path a permission decides: absolute against `cwd`, with symlinks
 * followed. A path that does not exist yet resolves its deepest existing
 * ancestor and appends the normalized rest.
 */
export const permissionPath = (path: string, cwd: string): string => {
  const absolute = absolutePath(path, cwd)
  const rest: Array<string> = []
  let existing = absolute
  while (!exists(existing) && dirname(existing) !== existing) {
    rest.unshift(basename(existing))
    existing = dirname(existing)
  }
  let real: string
  try {
    real = realpathSync(existing)
  } catch {
    // A dangling symlink: decide by the path as written.
    real = existing
  }
  return rest.length === 0 ? real : join(real, ...rest)
}

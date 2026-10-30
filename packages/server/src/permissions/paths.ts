import { readlinkSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"

/** A filesystem's view of one path, whose parent is already a real path. */
export type PathLookup = (path: string) =>
  | { readonly kind: "real"; readonly path: string }
  | { readonly kind: "dangling"; readonly target: string }
  | { readonly kind: "absent" }

const fileSystemLookup: PathLookup = (path) => {
  try {
    return { kind: "real", path: realpathSync(path) }
  } catch {
    try {
      return { kind: "dangling", target: readlinkSync(path) }
    } catch {
      return { kind: "absent" }
    }
  }
}

/** How many dangling symlinks one path follows before the rest is kept as written; Linux's own limit. */
const MAX_LINKS = 40

/**
 * The path a permission decides, walked one component at a time as the
 * operating system would: each existing prefix is replaced by its real
 * path before the next component, so a `..` after a symlink leaves the
 * symlink's target. A component that does not exist yet, such as a new
 * file or directory, is kept as written, and a `..` after it returns to
 * its parent. A dangling symlink is replaced by the path it points to.
 */
export const resolvePath = (path: string, cwd: string, lookup: PathLookup, links = 0): string => {
  const components = (isAbsolute(path) ? path : `${cwd}/${path}`).split("/").filter((part) => part !== "" && part !== ".")
  let current = "/"
  for (const component of components) {
    const next = join(current, component)
    const found = lookup(next)
    if (found.kind === "real") current = found.path
    else if (found.kind === "dangling" && links < MAX_LINKS) current = resolvePath(found.target, dirname(next), lookup, links + 1)
    else current = next
  }
  return current
}

/** The path a permission decides for `path` given against `cwd`, resolved on the filesystem. */
export const permissionPath = (path: string, cwd: string) => resolvePath(path, cwd, fileSystemLookup)

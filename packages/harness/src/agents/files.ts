import { readdirSync, readFileSync, statSync } from "node:fs"

export type Read = { readonly kind: "text"; readonly text: string } | { readonly kind: "absent" } | { readonly kind: "error"; readonly message: string }

/** The reads agent, instruction, and skill discovery makes, so it can run over files in memory. */
export interface ConfigFiles {
  /** A directory's entry names, or a failure; `absent` when it does not exist. */
  readonly list: (dir: string) => { readonly kind: "entries"; readonly names: ReadonlyArray<string> } | Exclude<Read, { kind: "text" }>
  readonly read: (path: string) => Read
  readonly isDirectory: (path: string) => boolean
}

const failure = (error: unknown): Exclude<Read, { kind: "text" }> =>
  (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "error", message: error instanceof Error ? error.message : String(error) }

export const diskFiles: ConfigFiles = {
  list: (dir) => {
    try {
      return { kind: "entries", names: readdirSync(dir) }
    } catch (error) {
      return failure(error)
    }
  },
  read: (path) => {
    try {
      return { kind: "text", text: readFileSync(path, "utf8") }
    } catch (error) {
      return failure(error)
    }
  },
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
}

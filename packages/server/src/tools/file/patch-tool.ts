import { Schema } from "effect"
import { builtinTool, type Tool } from "../../agent/tools.ts"
import { permissionPath } from "../../permissions/paths.ts"
import { applyHunks, ApplyFailure, type PatchFiles } from "./apply.ts"
import { parse, PatchParseError, type Hunk } from "./patch.ts"
// The description keeps the words of Codex's function-style `apply_patch` tool (Apache-2.0, see
// test/fixtures/codex-apply-patch/LICENSE and NOTICE).
import description from "./patch-description.md" with { type: "text" }

const Args = Schema.Struct({
  patch: Schema.String.annotate({ description: "The entire contents of the patch, from `*** Begin Patch` to `*** End Patch`." }),
})

/** The paths a hunk writes or removes, as the patch names them. */
const hunkPaths = (hunk: Hunk) => (hunk.type === "update" && hunk.movePath !== undefined ? [hunk.path, hunk.movePath] : [hunk.path])

const parsed = (patch: string): ReadonlyArray<Hunk> | string => {
  try {
    const hunks = parse(patch)
    return hunks.length === 0 ? "No files were modified: the patch has no hunks." : hunks
  } catch (error) {
    if (error instanceof PatchParseError) return `The patch is invalid: ${error.message}`
    throw error
  }
}

/**
 * `file_patch`: applies a patch in Codex's format, its paths resolved
 * against the session's starting working directory and authorized under
 * the `edit` permission as one call.
 */
export const filePatchTool = (files?: PatchFiles): Tool =>
  builtinTool({
    namespace: "file",
    name: "patch",
    description,
    args: Args,
    permission: ({ patch }, run) => {
      const hunks = parsed(patch)
      if (typeof hunks === "string") return { outcome: "failed", content: hunks }
      const subjects = [...new Set(hunks.flatMap(hunkPaths).map((path) => permissionPath(path, run.cwd)))]
      return { permission: "edit", subjects, patterns: subjects }
    },
    run: async ({ patch }, run) => {
      const hunks = parsed(patch) as ReadonlyArray<Hunk>
      const summary = (applied: ReadonlyArray<{ kind: string; path: string }>) => applied.map((item) => `${item.kind} ${item.path}`)
      try {
        const applied = await applyHunks(hunks, run.cwd, files)
        return { outcome: "success", content: ["Success. Updated the following files:", ...summary(applied)].join("\n") }
      } catch (error) {
        if (!(error instanceof ApplyFailure)) throw error
        const done = error.applied.length === 0 ? [] : ["The hunks before it were applied:", ...summary(error.applied)]
        return { outcome: "failed", content: [`The patch failed: ${error.message}`, ...done].join("\n") }
      }
    },
  })

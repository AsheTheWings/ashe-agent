import { Schema } from "effect"
import { builtinTool, type Tool } from "../../agent/tools.ts"
import { applyHunks, ApplyFailure, diskPaths, locate, locatedPaths, type Located, type PatchFiles } from "./apply.ts"
import { parse, PatchParseError, type Hunk } from "./patch.ts"
// The description keeps the words of Codex's function-style `apply_patch` tool (Apache-2.0, see
// test/fixtures/codex-apply-patch/LICENSE and NOTICE).
import description from "./patch-description.md" with { type: "text" }

const Args = Schema.Struct({
  patch: Schema.String.annotate({ description: "The entire contents of the patch, from `*** Begin Patch` to `*** End Patch`." }),
})

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
 * against the session directory as the operating
 * system walks them once, before any hunk runs, and authorized under the
 * `edit` permission as one call for exactly the paths it then reads,
 * writes, and removes. When the paths resolve differently by the time the
 * call runs, nothing is changed.
 */
export const filePatchTool = (files?: PatchFiles): Tool =>
  builtinTool<typeof Args, ReadonlyArray<Located>>({
    namespace: "file",
    name: "patch",
    description,
    args: Args,
    prepare: ({ patch }, run) => {
      const hunks = parsed(patch)
      if (typeof hunks === "string") return { outcome: "failed", content: hunks }
      const located = locate(hunks, diskPaths(run.cwd))
      const subjects = locatedPaths(located)
      return { check: { permission: "edit", subjects, patterns: subjects }, plan: located }
    },
    run: async ({ patch }, run, located) => {
      const now = locatedPaths(locate(parsed(patch) as ReadonlyArray<Hunk>, diskPaths(run.cwd)))
      const authorized = locatedPaths(located)
      const moved = authorized.filter((path, index) => now[index] !== path)
      if (moved.length > 0 || now.length !== authorized.length) {
        return {
          outcome: "failed",
          content: `The patch was not applied: its paths resolve differently than when it was authorized (${moved.join(", ")}). Nothing was changed.`,
        }
      }
      const summary = (applied: ReadonlyArray<{ kind: string; path: string }>) => applied.map((item) => `${item.kind} ${item.path}`)
      try {
        const applied = await applyHunks(located, files)
        return { outcome: "success", content: ["Success. Updated the following files:", ...summary(applied)].join("\n") }
      } catch (error) {
        if (!(error instanceof ApplyFailure)) throw error
        const done = error.applied.length === 0 ? [] : ["The hunks before it were applied:", ...summary(error.applied)]
        return { outcome: "failed", content: [`The patch failed: ${error.message}`, ...done].join("\n") }
      }
    },
  })

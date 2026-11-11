import type { Tool } from "../../agent/tools.ts"
import { filePatchTool } from "./patch-tool.ts"
import { fileReadTool, type FileReadOptions } from "./read-tool.ts"

/** The tools of the `file` namespace: `file_read` and `file_patch`. */
export const fileTools = (options: FileReadOptions = {}): ReadonlyArray<Tool> => [fileReadTool(options), filePatchTool()]

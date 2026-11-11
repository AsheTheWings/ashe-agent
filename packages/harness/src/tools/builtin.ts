import { Redacted } from "effect"
import type { Tool } from "../agent/tools.ts"
import { skillTool } from "../agents/skill-tool.ts"
import { fileTools } from "./file/index.ts"
import { shellTools, type ShellProcesses } from "./shell/index.ts"
import { exaClient, webTools } from "./web/index.ts"

export interface BuiltinToolInputs {
  readonly shellYieldMs: number
  readonly shellMaxOutputTokens: number
  readonly exaBaseUrl: string
  readonly exaApiKey: Redacted.Redacted<string> | null
  readonly skillRoots: ReadonlyArray<string>
}

/** The built-in tools serve offers: file, shell, and skill tools always, web tools exactly when an Exa key is delivered. */
export const builtinTools = (inputs: BuiltinToolInputs, processes: ShellProcesses, fetchFn: typeof fetch = fetch): ReadonlyArray<Tool> => [
  ...fileTools(),
  skillTool(inputs.skillRoots),
  ...shellTools(processes, { yieldMs: inputs.shellYieldMs, maxOutputTokens: inputs.shellMaxOutputTokens }),
  ...(inputs.exaApiKey === null ? [] : webTools(exaClient(inputs.exaBaseUrl, Redacted.value(inputs.exaApiKey), fetchFn))),
]

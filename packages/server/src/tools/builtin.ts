import { Redacted } from "effect"
import type { Tool } from "../agent/tools.ts"
import { fileTools } from "./file/index.ts"
import { shellTools, type ShellProcesses } from "./shell/index.ts"
import { exaClient, webTools } from "./web/index.ts"

export interface BuiltinToolInputs {
  readonly shellYieldMs: number
  readonly shellMaxOutputTokens: number
  readonly exaBaseUrl: string
  readonly exaApiKey: Redacted.Redacted<string> | null
}

/** The built-in tools serve offers: file and shell tools always, web tools exactly when an Exa key is delivered. */
export const builtinTools = (inputs: BuiltinToolInputs, processes: ShellProcesses, fetchFn: typeof fetch = fetch): ReadonlyArray<Tool> => [
  ...fileTools(),
  ...shellTools(processes, { yieldMs: inputs.shellYieldMs, maxOutputTokens: inputs.shellMaxOutputTokens }),
  ...(inputs.exaApiKey === null ? [] : webTools(exaClient(inputs.exaBaseUrl, Redacted.value(inputs.exaApiKey), fetchFn))),
]

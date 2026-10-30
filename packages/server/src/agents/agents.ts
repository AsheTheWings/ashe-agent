import { join } from "node:path"
import { Result, Schema } from "effect"
import { Permission } from "../inputs/shapes.ts"
import { diskFiles, type ConfigFiles } from "./files.ts"
import { parseFrontmatter } from "./frontmatter.ts"

export type AgentMode = "primary" | "subagent" | "all"

/** What a session records from its agent at creation. */
export interface AgentSettings {
  readonly temperature: number | null
  readonly permission: Permission | null
}

export const noAgentSettings: AgentSettings = { temperature: null, permission: null }

export interface AgentDefinition {
  readonly name: string
  readonly path: string
  readonly description: string | null
  readonly mode: AgentMode
  readonly model: string | null
  readonly settings: AgentSettings
  /** The instructions that replace the global ones for the agent's sessions. */
  readonly body: string
}

export interface RefusedAgent {
  readonly path: string
  readonly reason: string
}

export interface AgentCatalog {
  readonly agents: ReadonlyArray<AgentDefinition>
  readonly refused: ReadonlyArray<RefusedAgent>
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const decodePermission = Schema.decodeUnknownResult(Permission)

/**
 * Validates one agent file's text: its frontmatter may set `description`,
 * `mode` (`primary`, `subagent`, or `all`, `all` when absent), `model` (a
 * configured model id), `temperature` (a finite number from 0 to 2), and
 * `permission`; its body is the agent's instructions.
 */
export const parseAgent = (
  name: string,
  path: string,
  text: string,
  modelIds: ReadonlySet<string>,
): { readonly ok: true; readonly agent: AgentDefinition } | { readonly ok: false; readonly reason: string } => {
  if (!NAME.test(name)) return { ok: false, reason: "its file name is not a valid agent name" }
  const parsed = parseFrontmatter(text)
  if (!parsed.ok) return parsed
  const data = parsed.data
  const description = data.description
  if (description !== undefined && description !== null && typeof description !== "string") return { ok: false, reason: "description is not a string" }
  const mode = data.mode ?? "all"
  if (mode !== "primary" && mode !== "subagent" && mode !== "all") return { ok: false, reason: "mode is not primary, subagent, or all" }
  const model = data.model ?? null
  if (model !== null && (typeof model !== "string" || !modelIds.has(model))) return { ok: false, reason: "model is not a configured model id" }
  const temperature = data.temperature ?? null
  if (temperature !== null && (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    return { ok: false, reason: "temperature is not a finite number from 0 to 2" }
  }
  let permission: Permission | null = null
  if (data.permission !== undefined && data.permission !== null) {
    const decoded = decodePermission(data.permission)
    if (Result.isFailure(decoded)) return { ok: false, reason: "permission is malformed" }
    permission = decoded.success
  }
  return {
    ok: true,
    agent: {
      name,
      path,
      description: typeof description === "string" ? description : null,
      mode,
      model,
      settings: { temperature, permission },
      body: parsed.body,
    },
  }
}

/** Reads every `<name>.md` of `dir` as an agent; an absent directory defines none. */
export const loadAgents = (dir: string, modelIds: ReadonlySet<string>, files: ConfigFiles = diskFiles): AgentCatalog => {
  const listed = files.list(dir)
  if (listed.kind === "absent") return { agents: [], refused: [] }
  if (listed.kind === "error") return { agents: [], refused: [{ path: dir, reason: `the agents directory is unreadable: ${listed.message}` }] }
  const agents: Array<AgentDefinition> = []
  const refused: Array<RefusedAgent> = []
  for (const file of listed.names.filter((name) => name.endsWith(".md")).toSorted()) {
    const path = join(dir, file)
    const read = files.read(path)
    if (read.kind !== "text") {
      refused.push({ path, reason: read.kind === "absent" ? "it disappeared while being read" : `it is unreadable: ${read.message}` })
      continue
    }
    const result = parseAgent(file.slice(0, -".md".length), path, read.text, modelIds)
    if (result.ok) agents.push(result.agent)
    else refused.push({ path, reason: result.reason })
  }
  return { agents, refused }
}

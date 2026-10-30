import { ErrorCode } from "@ashe-agent/protocol"
import { ProtocolError } from "../server/websocket.ts"
import type { SessionSetup } from "../sessions/hub.ts"
import { loadAgents, noAgentSettings } from "./agents.ts"
import { diskFiles, type ConfigFiles } from "./files.ts"
import { discoverSkills, skillCatalog } from "./skills.ts"

export interface FileSetupOptions {
  readonly agentsDir: string
  readonly instructionsFile: string
  readonly skillRoots: ReadonlyArray<string>
  readonly modelIds: ReadonlySet<string>
  /** The code mode catalog, or null without code mode. */
  readonly codeMode?: () => string | null
  readonly files?: ConfigFiles
}

const invalid = (message: string) => new ProtocolError({ code: ErrorCode.invalidInput, message })

/** The global instructions file's content; null when it is absent, and an error when it is present but unreadable. */
const globalInstructions = (path: string, files: ConfigFiles): string | null => {
  const read = files.read(path)
  if (read.kind === "text") return read.text
  if (read.kind === "absent") return null
  throw new ProtocolError({ code: ErrorCode.internalError, message: `the global instructions file ${path} is unreadable: ${read.message}` })
}

/**
 * Session setup from the agents directory, the global instructions file,
 * and the skill roots, all read when a session is created or agents are
 * listed. Nothing is read from a session's directory.
 */
export const fileSetup = (options: FileSetupOptions): SessionSetup => {
  const files = options.files ?? diskFiles
  return {
    resolve: (name) => {
      if (name === null) return { agent: null, instructions: globalInstructions(options.instructionsFile, files), model: null, settings: noAgentSettings }
      const agent = loadAgents(options.agentsDir, options.modelIds, files).agents.find((candidate) => candidate.name === name)
      if (agent === undefined) throw invalid(`no valid agent ${name}`)
      if (agent.mode === "subagent") throw invalid(`the agent ${name} is a subagent and cannot run a session`)
      return { agent: agent.name, instructions: agent.body, model: agent.model, settings: agent.settings }
    },
    catalogs: () => ({ skills: skillCatalog(discoverSkills(options.skillRoots, files)), codeMode: options.codeMode?.() ?? null }),
    agents: () => {
      const { agents, refused } = loadAgents(options.agentsDir, options.modelIds, files)
      return {
        agents: agents.map((agent) => ({ name: agent.name, description: agent.description, mode: agent.mode, model: agent.model })),
        refused,
      }
    },
  }
}

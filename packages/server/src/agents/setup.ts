import { createHash } from "node:crypto"
import { join } from "node:path"
import { ErrorCode } from "@ashe-agent/protocol"
import { evaluate, type Rule } from "../permissions/rules.ts"
import { ProtocolError } from "../server/websocket.ts"
import type { Catalogs, SessionSetup, UserInstructions } from "../sessions/hub.ts"
import type { AgentRegistry, SessionAgent } from "./agents.ts"
import { diskFiles, type ConfigFiles } from "./files.ts"
import { discoverSkills, skillCatalog } from "./skills.ts"
import { readFileText, type FileMetadata } from "./titles.ts"

export interface FileSetupOptions {
  readonly agents: AgentRegistry
  readonly instructionsFile: string
  readonly skillRoots: ReadonlyArray<string>
  /** The code mode catalog of the tools the rules leave offered, or null without one. */
  readonly codeMode?: (rules: ReadonlyArray<Rule>) => string | null
  readonly files?: ConfigFiles
}

const invalid = (message: string) => new ProtocolError({ code: ErrorCode.invalidInput, message })

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

/** Why the user instructions cannot be read: the file and the reason. */
export class InstructionsUnreadable extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`the user instructions file ${path} is refused: ${reason}`)
  }
}

/** The file a known version of the user instructions was read from, with its metadata then. */
export interface KnownInstructions {
  readonly path: string
  readonly metadata: FileMetadata
}

/**
 * The user instructions of a session of `agent`, read now: its agent's
 * title file while that file exists, else the global instructions file;
 * null when neither exists, and "unchanged", unread, when the chosen file
 * is `known`'s with the same metadata. A title file that exists but is
 * refused, or a chosen file that cannot be read, throws
 * `InstructionsUnreadable`.
 */
export const readUserInstructions = (
  agent: SessionAgent,
  registry: AgentRegistry,
  globalFile: string,
  known?: KnownInstructions,
): UserInstructions | null | "unchanged" => {
  const gate = (path: string) => (known !== undefined && known.path === path ? known.metadata : undefined)
  if (agent.key !== null) {
    const title = registry.titleFile(agent.key, gate(join(registry.titlesDir, `${agent.key}.md`)))
    if (title.state === "unchanged") return "unchanged"
    if (title.state === "refused") throw new InstructionsUnreadable(title.path, title.reason)
    if (title.state === "present") return { source: "title", path: title.path, text: title.body, sha256: sha256(title.body), metadata: title.metadata }
  }
  const unchangedFrom = gate(globalFile)
  const global = readFileText(globalFile, unchangedFrom === undefined ? {} : { unchangedFrom })
  if (global.kind === "unchanged") return "unchanged"
  if (global.kind === "absent") return null
  if (global.kind === "error") throw new InstructionsUnreadable(globalFile, global.reason)
  return { source: "global", path: globalFile, text: global.text, sha256: sha256(global.text), metadata: global.metadata }
}

/**
 * Session setup from the configured agents, their title files, the global
 * instructions file, and the skill roots, all read when they are needed.
 * Nothing is read from a session's directory.
 */
export const fileSetup = (options: FileSetupOptions): SessionSetup => {
  const files = options.files ?? diskFiles
  return {
    resolve: (key) => {
      const agent = options.agents.resolve(key)
      if (agent === null) throw invalid(`no agent ${key}`)
      return agent
    },
    userInstructions: (agent, known) => readUserInstructions(agent, options.agents, options.instructionsFile, known),
    catalogs: (rules) => ({
      skills: skillCatalog(discoverSkills(options.skillRoots, files).filter((skill) => evaluate(rules, "skill", skill.name) !== "deny")),
      codeMode: options.codeMode?.(rules) ?? null,
    }),
    agents: () => ({ agents: options.agents.list(), defaultAgent: options.agents.defaultAgent }),
  }
}

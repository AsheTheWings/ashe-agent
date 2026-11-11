import type { Agents, ModelOverrides, Permission } from "../inputs/shapes.ts"
import { displayTitle, readTitleFile, type FileMetadata, type TitleFile } from "./titles.ts"

/** What a session keeps from its agent, as recorded at its creation. */
export interface SessionAgent {
  /** The agent's title, or null for the implicit agent. */
  readonly key: string | null
  /** The model the agent starts sessions with, if it names one. */
  readonly model: string | null
  /** The agent's overrides of model settings, by model id. */
  readonly overrides: Readonly<Record<string, ModelOverrides>>
  /** The agent's permission rules, layered after the global rules. */
  readonly permission: Permission | null
}

/** The implicit agent: no title, no model of its own, no overrides, and only the global rules. */
export const implicitAgent: SessionAgent = { key: null, model: null, overrides: {}, permission: null }

/** A title file's state as `agents.list` reports it. */
export type TitleFileState =
  | { readonly state: "present" }
  | { readonly state: "absent" }
  | { readonly state: "refused"; readonly reason: string }

/** An agent as `agents.list` reports it. */
export interface AgentListing {
  readonly key: string
  readonly title: string
  readonly description: string | null
  readonly model: string | null
  /** The agent's reasoning effort overrides, by model id. */
  readonly reasoningEfforts: Readonly<Record<string, string>>
  readonly titleFile: TitleFileState
}

/** The configured agents, the default one, and their title files in `titlesDir`. */
export class AgentRegistry {
  constructor(
    private readonly agents: Agents,
    readonly defaultAgent: string | null,
    readonly titlesDir: string,
  ) {}

  /** Whether `key` is a configured agent. */
  has(key: string) {
    return Object.hasOwn(this.agents, key)
  }

  /**
   * The agent a new session runs as: `key`, else the default agent, else
   * the implicit agent; null for a key that is no agent.
   */
  resolve(key: string | null): SessionAgent | null {
    const chosen = key ?? this.defaultAgent
    if (chosen === null) return implicitAgent
    if (!this.has(chosen)) return null
    const entry = this.agents[chosen]!
    return { key: chosen, model: entry.model ?? null, overrides: entry.models ?? {}, permission: entry.permission ?? null }
  }

  /** The title file of the agent `key`, read now, or unchanged when its metadata equals `unchangedFrom`. */
  titleFile(key: string, unchangedFrom?: FileMetadata): TitleFile {
    return readTitleFile(this.titlesDir, key, unchangedFrom)
  }

  /** Every agent with its display title, its title file's description and state, its starting model, and its effort overrides. */
  list(): ReadonlyArray<AgentListing> {
    return Object.entries(this.agents).map(([key, entry]) => {
      const file = this.titleFile(key)
      const reasoningEfforts: Record<string, string> = {}
      for (const [model, overrides] of Object.entries(entry.models ?? {})) {
        if (overrides.reasoningEffort !== undefined) reasoningEfforts[model] = overrides.reasoningEffort
      }
      return {
        key,
        title: displayTitle(key),
        description: file.state === "present" ? file.description : null,
        model: entry.model ?? null,
        reasoningEfforts,
        titleFile: file.state === "refused" ? { state: "refused", reason: file.reason } : { state: file.state === "absent" ? "absent" : "present" },
      }
    })
  }
}

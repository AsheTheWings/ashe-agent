import {
  CHECKPOINT_WINDOW_CAP,
  RESERVE,
  SEED_ALLOWANCE,
  TOOL_DEFINITIONS_ALLOWANCE,
  WORKING_MARGIN,
} from "../context/constants.ts"
import type { AgentEntry, Agents, AuxiliaryModels, ModelOverrides, Providers } from "../inputs/shapes.ts"

/** A configured model: its id, where it is served, its capabilities, and its settings. */
export interface ConfiguredModel {
  /** `<provider>/<model>`. */
  readonly id: string
  readonly provider: string
  /** The provider's own id of the model, sent in each call. */
  readonly upstream: string
  /** The display name, the id when the entry sets none. */
  readonly name: string
  readonly contextLimit: number
  readonly imageInput: boolean
  /** Whether the model accepts a temperature. */
  readonly temperatureCapable: boolean
  /** The reasoning efforts the model lists; empty for a model without reasoning. */
  readonly efforts: ReadonlyArray<string>
  readonly settings: ModelOverrides
}

/** Every model the providers register, in the order the config lists them. */
export const configuredModels = (providers: Providers): ReadonlyArray<ConfiguredModel> =>
  Object.entries(providers).flatMap(([provider, entry]) =>
    Object.entries(entry.models).map(([upstream, model]) => {
      const { checkpointWindowSize, temperature, reasoningEffort } = model
      return {
        id: `${provider}/${upstream}`,
        provider,
        upstream,
        name: model.name ?? `${provider}/${upstream}`,
        contextLimit: model.limit.context,
        imageInput: model.capabilities.input.includes("image"),
        temperatureCapable: model.capabilities.temperature === true,
        efforts: model.capabilities.reasoning?.efforts ?? [],
        settings: {
          ...(checkpointWindowSize === undefined ? {} : { checkpointWindowSize }),
          ...(temperature === undefined ? {} : { temperature }),
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        },
      }
    }),
  )

/**
 * A model's checkpoint window size for an agent: the agent's override, else
 * the model entry's setting, else its context limit capped at 480,000.
 */
export const checkpointWindowSize = (model: ConfiguredModel, overrides: ModelOverrides | undefined): number =>
  overrides?.checkpointWindowSize ?? model.settings.checkpointWindowSize ?? Math.min(model.contextLimit, CHECKPOINT_WINDOW_CAP)

/** What a checkpoint window size leaves after the seed, the tool definitions, and the reserve. */
export const workingMargin = (size: number) => size - SEED_ALLOWANCE - TOOL_DEFINITIONS_ALLOWANCE - RESERVE

/** The reasoning and temperature a model call sends. */
export interface CallSettings {
  readonly temperature?: number
  readonly reasoning?: { readonly effort?: string; readonly summary: "auto" }
}

/**
 * The settings of a call to `model`. Its reasoning effort is `selection`,
 * the selection the turn recorded, when `model` is the turn's model and
 * lists it, else the agent's override, else the model entry's setting, else
 * none; a model listing efforts always gets a reasoning summary. Its
 * temperature is the agent's override, else the entry's setting, and only a
 * model that accepts one gets it.
 */
export const callSettings = (
  model: ConfiguredModel,
  overrides: ModelOverrides | undefined,
  selection: string | null,
): CallSettings => {
  const listed = (effort: string | undefined) => (effort !== undefined && model.efforts.includes(effort) ? effort : undefined)
  const effort = listed(selection ?? undefined) ?? listed(overrides?.reasoningEffort) ?? listed(model.settings.reasoningEffort)
  const temperature = overrides?.temperature ?? model.settings.temperature
  return {
    ...(model.temperatureCapable && temperature !== undefined ? { temperature } : {}),
    ...(model.efforts.length === 0 ? {} : { reasoning: { ...(effort === undefined ? {} : { effort }), summary: "auto" as const } }),
  }
}

/** The configuration the model and agent checks need. */
export interface ModelConfig {
  readonly providers: Providers
  readonly defaultModel: string
  readonly agents: Agents
  readonly defaultAgent: string | null
  readonly auxiliaryModels: AuxiliaryModels
}

/** A problem with one input, named by its key. */
export interface ConfigIssue {
  readonly key: keyof ModelConfig
  readonly problem: string
}

/** The problems of one set of settings for `model`: a setting its capabilities refuse, or a size over its context limit. */
const settingProblems = (model: ConfiguredModel, settings: ModelOverrides): ReadonlyArray<string> => [
  ...(settings.temperature !== undefined && !model.temperatureCapable ? [`sets a temperature, which ${model.id} does not accept`] : []),
  ...(settings.reasoningEffort !== undefined && !model.efforts.includes(settings.reasoningEffort)
    ? [`sets the reasoning effort ${JSON.stringify(settings.reasoningEffort)}, which ${model.id} does not list`]
    : []),
  ...(settings.checkpointWindowSize !== undefined && settings.checkpointWindowSize > model.contextLimit
    ? [`sets a checkpointWindowSize of ${settings.checkpointWindowSize}, above the ${model.contextLimit} tokens of ${model.id}'s limit.context`]
    : []),
]

/**
 * The relations between the model and agent inputs that their shapes
 * cannot check: every named model is configured, every setting has its
 * capability, and every pair of a model and an agent, the implicit agent
 * included, leaves the working margin.
 */
export const modelConfigIssues = (config: ModelConfig): ReadonlyArray<ConfigIssue> => {
  const issues: Array<ConfigIssue> = []
  const models = configuredModels(config.providers)
  const byId = new Map(models.map((model) => [model.id, model]))
  if (models.length === 0) issues.push({ key: "providers", problem: "must register at least one model" })
  for (const model of models) {
    for (const problem of settingProblems(model, model.settings)) issues.push({ key: "providers", problem: `the model ${model.id} ${problem}` })
  }
  if (models.length > 0 && !byId.has(config.defaultModel)) {
    issues.push({ key: "defaultModel", problem: `names ${JSON.stringify(config.defaultModel)}, which no provider registers` })
  }
  for (const [task, id] of Object.entries(config.auxiliaryModels)) {
    if (id !== undefined && !byId.has(id)) issues.push({ key: "auxiliaryModels", problem: `${task} names ${JSON.stringify(id)}, which no provider registers` })
  }
  if (config.defaultAgent !== null && !Object.hasOwn(config.agents, config.defaultAgent)) {
    issues.push({ key: "defaultAgent", problem: `names ${JSON.stringify(config.defaultAgent)}, which is no agent` })
  }
  const agents: ReadonlyArray<[string, AgentEntry]> = [["the implicit agent", {}], ...Object.entries(config.agents).map(([key, agent]): [string, AgentEntry] => [`the agent ${key}`, agent])]
  for (const [label, agent] of agents) {
    if (agent.model !== undefined && !byId.has(agent.model)) {
      issues.push({ key: "agents", problem: `${label} starts with ${JSON.stringify(agent.model)}, which no provider registers` })
    }
    for (const [id, overrides] of Object.entries(agent.models ?? {})) {
      const model = byId.get(id)
      if (model === undefined) issues.push({ key: "agents", problem: `${label} overrides ${JSON.stringify(id)}, which no provider registers` })
      else for (const problem of settingProblems(model, overrides)) issues.push({ key: "agents", problem: `${label} ${problem}` })
    }
    for (const model of models) {
      const margin = workingMargin(checkpointWindowSize(model, agent.models?.[model.id]))
      if (margin < WORKING_MARGIN) {
        issues.push({
          key: agent === agents[0]![1] ? "providers" : "agents",
          problem: `the model ${model.id} with ${label} leaves a working margin of ${margin} tokens, below ${WORKING_MARGIN}`,
        })
      }
    }
  }
  return issues
}

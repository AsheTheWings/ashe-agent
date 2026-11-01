import type { Agent, Model } from "@ashe-agent/protocol"

/** The reasoning effort a model runs with when none is selected: the agent's override, else the model's setting. */
export const defaultEffort = (model: Model, agent: Agent | undefined): string | null => agent?.reasoningEfforts[model.id] ?? model.reasoningEffort

/** The agent a session runs as, found by the key or title its events name. */
export const agentNamed = (agents: ReadonlyArray<Agent>, name: string | null): Agent | undefined =>
  name === null ? undefined : agents.find((agent) => agent.key === name || agent.title === name)

import type { Agent, SelectionPatch } from "@ashe-agent/protocol"

/** The title key a control shows: a requested key, else the applied key or untitled. */
export const titleControlValue = (patch: SelectionPatch | undefined, applied: string | null): string =>
  patch !== undefined && Object.hasOwn(patch, "agentTitle") ? patch.agentTitle! : (applied ?? "untitled")

/** Title choices submit configured keys and show display titles only as labels. */
export const titleOptions = (agents: ReadonlyArray<Agent>) =>
  agents.map((agent) => ({ value: agent.key, label: agent.title }))

/** The model a control shows: an explicitly requested value, else the applied value. */
export const modelControlValue = (patch: SelectionPatch | undefined, applied: string | null): string | null => {
  const settings = patch?.modelSettings
  return settings !== undefined && Object.hasOwn(settings, "modelId") ? (settings.modelId ?? null) : applied
}

/** The effort a control shows, with an explicit null represented by the model's default effort. */
export const effortControlValue = (
  patch: SelectionPatch | undefined,
  applied: string | null,
  fallback: string,
): string => {
  const settings = patch?.modelSettings
  return settings !== undefined && Object.hasOwn(settings, "reasoningEffort")
    ? (settings.reasoningEffort ?? fallback)
    : (applied ?? fallback)
}

/** Maps the control's default choice back to the protocol's explicit model-default effort. */
export const effortRequestValue = (value: string, fallback: string): string | null =>
  value === fallback ? null : value

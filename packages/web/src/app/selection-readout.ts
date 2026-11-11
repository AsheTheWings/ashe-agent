import type { AgentProfile, SelectionPatch } from "@ashe-agent/protocol"
import { createElement } from "react"

/** A complete profile as visible text, including an unconfigured model and default effort. */
export const profileText = (profile: AgentProfile): string =>
  `${profile.agentTitle} · ${profile.modelSettings.modelId ?? "no model"} · ${
    profile.modelSettings.reasoningEffort ?? "default effort"
  }`

/** The profile a requested patch would apply, filling omitted fields from the applied profile. */
export const requestedProfile = (applied: AgentProfile, patch: SelectionPatch | undefined): AgentProfile => ({
  agentTitle:
    patch !== undefined && Object.hasOwn(patch, "agentTitle") ? patch.agentTitle! : applied.agentTitle,
  modelSettings: {
    modelId:
      patch?.modelSettings !== undefined && Object.hasOwn(patch.modelSettings, "modelId")
        ? patch.modelSettings.modelId!
        : applied.modelSettings.modelId,
    reasoningEffort:
      patch?.modelSettings !== undefined && Object.hasOwn(patch.modelSettings, "reasoningEffort")
        ? patch.modelSettings.reasoningEffort!
        : applied.modelSettings.reasoningEffort,
  },
})

const readout = (label: string, profile: AgentProfile) =>
  createElement(
    "span",
    { className: "text-muted-foreground text-xs", "aria-label": `${label} selection` },
    `${label}: ${profileText(profile)}`,
  )

/** Applied, requested, and active selections shown side by side as distinct states. */
export const SelectionReadouts = ({
  applied,
  requested,
  active,
}: {
  readonly applied: AgentProfile
  readonly requested: SelectionPatch | undefined
  readonly active: AgentProfile | null
}) =>
  createElement(
    "span",
    { className: "flex items-center gap-3" },
    readout("applied", applied),
    requested === undefined ? null : readout("requested", requestedProfile(applied, requested)),
    active === null ? null : readout("active", active),
  )

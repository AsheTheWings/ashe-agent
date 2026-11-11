import { AssistantRuntimeProvider } from "@assistant-ui/react"
import type { InputMode } from "@ashe-agent/protocol"
import { useMemo, useState } from "react"
import { Thread } from "@/components/assistant-ui/elements/thread.aui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useSessionRuntime } from "@/chat/use-session-runtime.ts"
import { agentNamed, defaultEffort } from "@/session/efforts.ts"
import {
  effortControlValue,
  effortRequestValue,
  modelControlValue,
  titleControlValue,
  titleOptions,
} from "@/session/selection-controls.ts"
import { useClient, useClientState } from "./client-context.tsx"
import { SelectionReadouts } from "./selection-readout.ts"
import { PermissionQueue } from "./permission-queue.tsx"
import { PendingInputs, SystemItem } from "./session-items.tsx"
import { UserActions } from "./user-actions.tsx"

const UNCONFIGURED_MODEL = "__ashe_agent_unconfigured__"

/** The session's requested or applied title, kept local until the next submission. */
const TitleSwitch = () => {
  const client = useClient()
  const agents = useClientState((state) => state.agents)
  const view = useClientState((state) => (state.activeSessionId === null ? undefined : state.views[state.activeSessionId]))
  const requested = useClientState((state) =>
    state.activeSessionId === null ? undefined : state.requestedSelections[state.activeSessionId],
  )
  if (view === undefined) return null
  const title = titleControlValue(requested, view.agent)
  return (
    <Select
      value={title}
      onValueChange={(value) => {
        if (typeof value === "string" && value !== title) void client.setAgentTitle(value).catch(() => {})
      }}
    >
      <SelectTrigger size="sm" aria-label="Agent title">
        <SelectValue placeholder="Title" />
      </SelectTrigger>
      <SelectContent>
        {titleOptions(agents).map((agent) => (
          <SelectItem key={agent.value} value={agent.value}>
            {agent.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** The session's selected model, switchable to any model from `models.list`, which starts at its default effort. */
const ModelSwitch = () => {
  const client = useClient()
  const models = useClientState((state) => state.models)
  const model = useClientState((state) => {
    if (state.activeSessionId === null) return null
    return modelControlValue(
      state.requestedSelections[state.activeSessionId],
      state.views[state.activeSessionId]?.model ?? null,
    )
  })
  return (
    <Select
      value={model ?? UNCONFIGURED_MODEL}
      onValueChange={(value) => {
        if (value === UNCONFIGURED_MODEL) {
          if (model !== null) void client.clearModel().catch(() => {})
        } else if (typeof value === "string" && value !== model) void client.setModel(value).catch(() => {})
      }}
    >
      <SelectTrigger size="sm" aria-label="Model">
        <SelectValue placeholder="Model" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNCONFIGURED_MODEL}>No model selected</SelectItem>
        {models.map((choice) => (
          <SelectItem key={choice.id} value={choice.id}>
            {choice.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** The session's selected reasoning effort among its model's, the default one marked. */
const EffortSwitch = () => {
  const client = useClient()
  const models = useClientState((state) => state.models)
  const agents = useClientState((state) => state.agents)
  const view = useClientState((state) => (state.activeSessionId === null ? undefined : state.views[state.activeSessionId]))
  const requested = useClientState((state) =>
    state.activeSessionId === null ? undefined : state.requestedSelections[state.activeSessionId],
  )
  const modelId = modelControlValue(requested, view?.model ?? null)
  const model = models.find((candidate) => candidate.id === modelId)
  if (view === undefined || model === undefined || model.reasoningEfforts.length === 0) return null
  const title =
    requested !== undefined && Object.hasOwn(requested, "agentTitle") ? requested.agentTitle : view.agent
  const fallback = defaultEffort(model, agentNamed(agents, title ?? null)) ?? "__model_default__"
  const selected = effortControlValue(requested, view.reasoningEffort, fallback)
  return (
    <Select
      value={selected}
      onValueChange={(value) => {
        if (typeof value === "string" && value !== selected) {
          void client.setReasoningEffort(effortRequestValue(value, fallback)).catch(() => {})
        }
      }}
    >
      <SelectTrigger size="sm" aria-label="Reasoning effort">
        <SelectValue placeholder="Effort" />
      </SelectTrigger>
      <SelectContent>
        {!model.reasoningEfforts.includes(fallback) && <SelectItem value={fallback}>Default</SelectItem>}
        {model.reasoningEfforts.map((effort) => (
          <SelectItem key={effort} value={effort}>
            {effort === fallback ? `${effort} (default)` : effort}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

const QueueSwitch = ({ queued, onChange }: { queued: boolean; onChange: (queued: boolean) => void }) => (
  <div className="flex items-center gap-2 px-1">
    <Switch id="queue-input" checked={queued} onCheckedChange={onChange} />
    <Label htmlFor="queue-input" className="text-muted-foreground text-xs font-normal">
      {queued ? "Queue after the turn" : "Steer the turn"}
    </Label>
  </div>
)

export const SessionPane = () => {
  const client = useClient()
  const view = useClientState((state) =>
    state.activeSessionId === null ? undefined : state.views[state.activeSessionId],
  )
  const sessionId = useClientState((state) => state.activeSessionId)
  const connected = useClientState((state) => state.status === "connected")
  const [queued, setQueued] = useState(false)
  const requested = useClientState((state) =>
    state.activeSessionId === null ? undefined : state.requestedSelections[state.activeSessionId],
  )
  const applied =
    view === undefined
      ? null
      : {
          agentTitle: view.agent ?? "untitled",
          modelSettings: { modelId: view.model, reasoningEffort: view.reasoningEffort },
        }
  const mode: InputMode | undefined = queued ? "queue" : undefined
  const runtime = useSessionRuntime(client, mode)
  const components = useMemo(
    () => ({
      UserActions,
      SystemItem,
      BeforeComposer: PendingInputs,
      ComposerExtra: () => <QueueSwitch queued={queued} onChange={setQueued} />,
    }),
    [queued],
  )

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-2">
        <span className="font-mono text-xs">{sessionId}</span>
        {view?.agent != null && <Badge variant="outline">{view.agent}</Badge>}
        {view?.runId != null && <Badge variant="secondary">running</Badge>}
        {applied !== null && (
          <SelectionReadouts applied={applied} requested={requested} active={view?.activeSelection ?? null} />
        )}
        <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs" title={view?.sessionDir ?? ""}>
          {view?.sessionDir}
        </span>
        <ModelSwitch />
        <EffortSwitch />
        <TitleSwitch />
        {view !== undefined && view.runId === null && (
          <Button size="sm" variant="outline" disabled={!connected} onClick={() => void client.resumeSession().catch(() => {})}>
            Continue
          </Button>
        )}
      </header>
      <PermissionQueue />
      <div className="min-h-0 flex-1">
        <AssistantRuntimeProvider runtime={runtime}>
          <Thread components={components} />
        </AssistantRuntimeProvider>
      </div>
    </section>
  )
}

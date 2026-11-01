import { PlusIcon, RefreshCwIcon } from "lucide-react"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { defaultEffort } from "@/session/efforts.ts"
import { useClient, useClientState } from "./client-context.tsx"

const NO_AGENT = "none"
const DEFAULT_EFFORT = "default"

const NewSessionDialog = ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => {
  const client = useClient()
  const models = useClientState((state) => state.models)
  const agents = useClientState((state) => state.agents)
  const [model, setModel] = useState<string | null>(null)
  const [agent, setAgent] = useState<string>(NO_AGENT)
  const [effort, setEffort] = useState<string>(DEFAULT_EFFORT)
  const [busy, setBusy] = useState(false)
  const chosenAgent = agents.find((choice) => choice.key === agent)
  // An agent that names a model starts its sessions with it.
  const chosenModel = chosenAgent?.model ?? model ?? models[0]?.id ?? null
  const modelEntry = models.find((choice) => choice.id === chosenModel)
  const fallback = modelEntry === undefined ? null : defaultEffort(modelEntry, chosenAgent)

  const create = () => {
    setBusy(true)
    const options = {
      ...(chosenModel === null ? {} : { model: chosenModel }),
      ...(agent === NO_AGENT ? {} : { agent }),
      ...(effort === DEFAULT_EFFORT ? {} : { reasoningEffort: effort }),
    }
    void client
      .createSession(options)
      .then(() => onOpenChange(false))
      .catch(() => {})
      .finally(() => setBusy(false))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New session</DialogTitle>
          <DialogDescription>The session starts in its own session directory on the server.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>Model</Label>
            <Select
              value={chosenModel}
              disabled={chosenAgent?.model != null}
              onValueChange={(value) => {
                setModel(value as string)
                setEffort(DEFAULT_EFFORT)
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {models.map((choice) => (
                  <SelectItem key={choice.id} value={choice.id}>
                    {choice.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {modelEntry !== undefined && modelEntry.reasoningEfforts.length > 0 && (
            <div className="flex flex-col gap-2">
              <Label>Reasoning effort</Label>
              <Select value={effort} onValueChange={(value) => setEffort(value as string)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_EFFORT}>{fallback === null ? "Default" : `${fallback} (default)`}</SelectItem>
                  {modelEntry.reasoningEfforts
                    .filter((choice) => choice !== fallback)
                    .map((choice) => (
                      <SelectItem key={choice} value={choice}>
                        {choice}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label>Agent</Label>
            <Select
              value={agent}
              onValueChange={(value) => {
                setAgent(value as string)
                setEffort(DEFAULT_EFFORT)
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_AGENT}>{NO_AGENT}</SelectItem>
                {agents.map((choice) => (
                  <SelectItem key={choice.key} value={choice.key}>
                    <span className="flex flex-col">
                      <span>{choice.title}</span>
                      <span className="text-muted-foreground text-xs">
                        {choice.titleFile.state === "present"
                          ? choice.description
                          : "No title file: uses the global user instructions"}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={create} disabled={busy || chosenModel === null}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export const SessionList = () => {
  const client = useClient()
  const sessions = useClientState((state) => state.sessions)
  const active = useClientState((state) => state.activeSessionId)
  const [creating, setCreating] = useState(false)

  return (
    <aside className="bg-muted/30 flex min-h-0 w-72 flex-1 flex-col border-e">
      <div className="flex items-center justify-between gap-2 p-3">
        <span className="text-sm font-medium">Sessions</span>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon" aria-label="Refresh sessions" onClick={() => void client.refreshSessions().catch(() => {})}>
            <RefreshCwIcon />
          </Button>
          <Button variant="ghost" size="icon" aria-label="New session" onClick={() => setCreating(true)}>
            <PlusIcon />
          </Button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-1 px-2 pb-2">
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                onClick={() => void client.open(session.id).catch(() => {})}
                className={cn(
                  "hover:bg-accent flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-start text-sm",
                  session.id === active && "bg-accent",
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="truncate font-mono text-xs">{session.id}</span>
                  {session.running && <Badge variant="secondary">running</Badge>}
                </span>
                <span className="text-muted-foreground truncate text-xs">
                  {session.agent === null ? session.model : `${session.agent} · ${session.model}`} ·{" "}
                  {new Date(session.createdAt).toLocaleString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </ScrollArea>
      <NewSessionDialog open={creating} onOpenChange={setCreating} />
    </aside>
  )
}

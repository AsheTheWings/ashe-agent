import { useAuiState } from "@assistant-ui/react"
import { GitForkIcon, PencilIcon, RotateCcwIcon } from "lucide-react"
import { useState } from "react"
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { useClient } from "./client-context.tsx"

export const REWIND_WARNING =
  "This turn and every later turn are removed from the session. Files and other effects of those turns stay as they are."

type Rewinding = { readonly edit: boolean } | null

/**
 * Rerun, edit and rerun, and fork on a user input that started a turn,
 * disabled while a turn runs. A rewind first states what it removes and
 * what it keeps.
 */
export const UserActions = () => {
  const client = useClient()
  const runId = useAuiState((s) => (s.message.metadata.custom as { runId?: string | null }).runId ?? null)
  const text = useAuiState((s) => s.message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""))
  const running = useAuiState((s) => s.thread.isRunning)
  const [rewinding, setRewinding] = useState<Rewinding>(null)
  const [draft, setDraft] = useState(text)
  if (runId === null) return null

  const confirm = () => {
    const edited = rewinding?.edit === true ? draft : undefined
    setRewinding(null)
    void client.rewind(runId, edited).catch(() => {})
  }

  return (
    <div className="text-muted-foreground flex gap-1">
      <TooltipIconButton tooltip="Rerun" disabled={running} onClick={() => setRewinding({ edit: false })}>
        <RotateCcwIcon />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="Edit and rerun"
        disabled={running}
        onClick={() => {
          setDraft(text)
          setRewinding({ edit: true })
        }}
      >
        <PencilIcon />
      </TooltipIconButton>
      <TooltipIconButton tooltip="Fork through this turn" disabled={running} onClick={() => void client.fork(runId).catch(() => {})}>
        <GitForkIcon />
      </TooltipIconButton>
      <Dialog open={rewinding !== null} onOpenChange={(open) => !open && setRewinding(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{rewinding?.edit === true ? "Edit and rerun" : "Rerun"}</DialogTitle>
            <DialogDescription>{REWIND_WARNING}</DialogDescription>
          </DialogHeader>
          {rewinding?.edit === true && (
            <Textarea aria-label="Input" value={draft} onChange={(event) => setDraft(event.target.value)} rows={6} />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRewinding(null)}>
              Keep the session
            </Button>
            <Button variant="destructive" disabled={rewinding?.edit === true && draft.trim() === ""} onClick={confirm}>
              Remove and rerun
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

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
import { useClient, useClientState } from "./client-context.tsx"

export const REWIND_WARNING =
  "This turn and every later turn are removed from the session. Research and memory files return to their state when this turn started; scratch, other files, and other effects of the removed turns stay as they are."

type Rewinding = { readonly edit: boolean } | null

/**
 * Rerun and edit-and-rerun work while a turn runs; fork appears only on a
 * settled turn. A rewind first states what it removes and what it keeps.
 */
export const UserActions = () => {
  const client = useClient()
  const runId = useAuiState((s) => (s.message.metadata.custom as { runId?: string | null }).runId ?? null)
  const text = useAuiState((s) => s.message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""))
  const settled = useClientState((state) =>
    runId === null || state.activeSessionId === null
      ? false
      : (state.views[state.activeSessionId]?.settled.includes(runId) ?? false),
  )
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
      <TooltipIconButton tooltip="Rerun" onClick={() => setRewinding({ edit: false })}>
        <RotateCcwIcon />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="Edit and rerun"
        onClick={() => {
          setDraft(text)
          setRewinding({ edit: true })
        }}
      >
        <PencilIcon />
      </TooltipIconButton>
      {settled && (
        <TooltipIconButton tooltip="Fork through this turn" onClick={() => void client.fork(runId).catch(() => {})}>
          <GitForkIcon />
        </TooltipIconButton>
      )}
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

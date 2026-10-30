import type { PermissionAnswer } from "@ashe-agent/protocol"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { splitPending } from "@/chat/pending-permissions.ts"
import type { PendingPermission } from "@/session/projection.ts"
import { useClient, useClientState } from "./client-context.tsx"

const NONE: ReadonlyArray<PendingPermission> = []

const QueuedRequest = ({ request }: { request: PendingPermission }) => {
  const client = useClient()
  const [message, setMessage] = useState("")
  const answer = (choice: PermissionAnswer) => void client.answerPermission(request.requestId, choice, message).catch(() => {})
  return (
    <li className="flex flex-col gap-2 rounded-lg border p-2">
      <span className="font-mono text-xs break-all">
        {request.permission}: {request.subjects.join(", ")}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-40 flex-1"
          placeholder="Message with a rejection (optional)"
          aria-label="Rejection message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <Button size="sm" onClick={() => answer("once")}>
          Allow once
        </Button>
        <Button size="sm" variant="outline" onClick={() => answer("always")} title={request.patterns.join(", ")}>
          Always allow
        </Button>
        <Button size="sm" variant="destructive" onClick={() => answer("reject")}>
          Reject
        </Button>
      </div>
    </li>
  )
}

/**
 * The pending permission requests that their tool call's approval cannot
 * hold, because an earlier request of the same call is waiting there.
 */
export const PermissionQueue = () => {
  const permissions = useClientState((state) =>
    state.activeSessionId === null ? NONE : (state.views[state.activeSessionId]?.permissions ?? NONE),
  )
  const { queued } = splitPending(permissions)
  if (queued.length === 0) return null
  return (
    <section aria-label="Further permission requests" className="border-b px-4 py-2">
      <h2 className="text-muted-foreground mb-2 text-xs">Further permission requests of a waiting tool call</h2>
      <ul className="flex flex-col gap-2">
        {queued.map((request) => (
          <QueuedRequest key={request.requestId} request={request} />
        ))}
      </ul>
    </section>
  )
}

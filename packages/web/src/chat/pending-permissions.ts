import type { PendingPermission } from "../session/projection.ts"

/**
 * A session's pending permission requests, split by where they show: the
 * first request of each tool call as that call's approval, and every
 * further request of a call already waiting, such as concurrent asks of
 * one code mode program, in the permission queue.
 */
export const splitPending = (permissions: ReadonlyArray<PendingPermission>) => {
  const byToolCall = new Map<string, PendingPermission>()
  const queued: Array<PendingPermission> = []
  for (const request of permissions) {
    if (byToolCall.has(request.toolCallId)) queued.push(request)
    else byToolCall.set(request.toolCallId, request)
  }
  return { byToolCall: byToolCall as ReadonlyMap<string, PendingPermission>, queued: queued as ReadonlyArray<PendingPermission> }
}

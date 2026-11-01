import {
  useExternalStoreRuntime,
  type AppendMessage,
  type ExternalStoreAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react"
import type { InputMode, PermissionAnswer } from "@ashe-agent/protocol"
import { useMemo } from "react"
import { useStore } from "zustand"
import type { SessionClient } from "@/session/client.ts"
import type { AssistantItem, AssistantPart, Item, PendingPermission, SessionView } from "@/session/projection.ts"
import { splitPending } from "./pending-permissions.ts"

const NO_ITEMS: ReadonlyArray<Item> = []

const statusOf = (item: AssistantItem, pending: Pending): NonNullable<ThreadMessageLike["status"]> => {
  switch (item.status) {
    case "running":
      // A call waiting on a permission answer needs the user, which opens its tool group.
      return item.parts.some((part) => pending.has(part.id))
        ? { type: "requires-action", reason: "tool-calls" }
        : { type: "running" }
    case "finished":
      return { type: "complete", reason: "stop" }
    case "cancelled":
      return { type: "incomplete", reason: "cancelled" }
    case "failed":
      return { type: "incomplete", reason: "error", error: item.error ?? "the turn failed" }
    case "interrupted":
      return { type: "incomplete", reason: "other", error: "the server stopped during this turn" }
  }
}

/** A pending permission request as the approval of the tool call waiting on it. */
const approvalOf = (request: PendingPermission) => ({
  id: request.requestId,
  prompt: `${request.permission}: ${request.subjects.join(", ")}`,
  allowFreeform: true,
  options: [
    { id: "once", kind: "allow-once", label: "Allow once" },
    { id: "always", kind: "allow-always", label: "Always allow", grants: request.patterns },
    { id: "reject", kind: "reject-once", label: "Reject" },
  ],
})

type Pending = ReadonlyMap<string, PendingPermission>

const partOf = (part: AssistantPart, pending: Pending) => {
  switch (part.type) {
    case "text":
      return { type: "text" as const, text: part.text }
    case "reasoning":
      return { type: "reasoning" as const, text: part.text }
    case "tool":
      return {
        type: "tool-call" as const,
        toolCallId: part.id,
        toolName: part.name,
        argsText: part.argsText,
        ...(pending.has(part.id) ? { approval: approvalOf(pending.get(part.id)!) } : {}),
        ...(part.result === null
          ? {}
          : { result: part.result.content, isError: part.result.outcome !== "success" }),
      }
  }
}

/**
 * One conversation item as an assistant-ui message: a user message carries
 * the turn it started, and a tool call waiting on a permission carries it
 * as its approval. Every other item is a system message carrying the item
 * itself, which the thread's system item slot renders.
 */
const convertItem = (item: Item, pending: Pending): ThreadMessageLike => {
  switch (item.kind) {
    case "user":
      return {
        role: "user",
        id: item.id,
        content: [{ type: "text", text: item.text }],
        metadata: { custom: { runId: item.runId, mode: item.mode } },
      }
    case "assistant":
      return {
        role: "assistant",
        id: item.id,
        content: item.parts.map((part) => partOf(part, pending)),
        status: statusOf(item, pending),
        metadata: { runId: item.runId },
      }
    case "notice":
    case "error":
      return { role: "system", id: item.id, content: [{ type: "text", text: item.text }], metadata: { custom: { item } } }
    case "entry":
    case "developer":
    case "mark":
    case "questions":
      return { role: "system", id: item.id, content: [{ type: "text", text: item.kind }], metadata: { custom: { item } } }
  }
}

const textOf = (message: AppendMessage) =>
  message.content.map((part) => (part.type === "text" ? part.text : "")).join("")

/**
 * The assistant-ui runtime over the open session's view in the session
 * client's store. Input goes out in `inputMode`; the server, not the
 * browser, holds queued input, so the queue lanes stay empty here.
 */
export const useSessionRuntime = (client: SessionClient, inputMode: InputMode | undefined) => {
  const view = useStore(client.store, (state): SessionView | undefined =>
    state.activeSessionId === null ? undefined : state.views[state.activeSessionId],
  )
  const connected = useStore(client.store, (state) => state.status === "connected")
  const running = view?.runId != null

  const adapter = useMemo((): ExternalStoreAdapter<Item> => {
    const send = (message: AppendMessage) => void client.send(textOf(message), inputMode).catch(() => {})
    // The first pending request of each tool call; the permission queue shows the others.
    const pending = splitPending(view?.permissions ?? []).byToolCall
    return {
      messages: view?.items ?? NO_ITEMS,
      convertMessage: (item) => convertItem(item, pending),
      isRunning: running,
      isDisabled: !connected || view === undefined,
      ...(view?.runId == null ? {} : { activeRunId: view.runId }),
      onNew: async (message) => send(message),
      onRespondToToolApproval: async ({ approvalId, approved, optionId, text }) => {
        const answer: PermissionAnswer =
          optionId === "once" || optionId === "always" || optionId === "reject" ? optionId : approved ? "once" : "reject"
        await client.answerPermission(approvalId, answer, text).catch(() => {})
      },
      onCancel: async () => {
        await client.cancel().catch(() => {})
      },
      queue: {
        items: [],
        steerItems: [],
        enqueue: send,
        steer: send,
        move: () => {},
        edit: () => {},
        remove: () => {},
      },
    }
  }, [client, view, running, connected, inputMode])

  return useExternalStoreRuntime(adapter)
}

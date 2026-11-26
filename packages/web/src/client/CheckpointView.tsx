import { memo, useEffect, useMemo, useRef, useState } from "react"
import { BrainIcon, LayersIcon, Loader2Icon, WrenchIcon } from "lucide-react"
import type {
  ContextMediaProjection,
  ModelCallContext,
  ModelCallContextItem,
  OfferedToolDefinition,
  SemanticEntry,
  SemanticPageEntry,
} from "@ashe-agent/protocol"
import { useClient, useClientState } from "@/app/client-context.tsx"
import { Badge } from "@/components/ui/badge.tsx"
import { Button } from "@/components/ui/button.tsx"
import { FormattedPayload } from "./json-view.tsx"
import { PlainText } from "./markdown.tsx"
import {
  SemanticBlockHeader,
  SemanticEntryContent,
  useAutoHydrateSemanticBody,
} from "./SessionView.tsx"
import { formatBytes } from "./types.ts"

const CLEARED_RESULT_TEXT = "[Result cleared to free context. Run the call again if you need it.]"

const MAX_SYSTEM_CACHE = 40
const systemBlobCache = new Map<string, string>()

const rememberSystemBlob = (key: string, text: string) => {
  if (systemBlobCache.has(key)) systemBlobCache.delete(key)
  systemBlobCache.set(key, text)
  if (systemBlobCache.size > MAX_SYSTEM_CACHE) {
    const oldest = systemBlobCache.keys().next().value
    if (oldest !== undefined) systemBlobCache.delete(oldest)
  }
}

const MediaProjectionList = ({ items }: { readonly items: ReadonlyArray<ContextMediaProjection> }) => {
  if (items.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 pt-1">
      {items.map((item, index) => (
        <Badge key={index} variant="secondary" className="font-mono text-[10px] font-normal">
          {item.kind === "placeholder"
            ? `${item.name} · placeholder (${item.reason})`
            : `${item.name} · ${item.content.mediaType}${item.byteLength > 0 ? ` · ${formatBytes(item.byteLength)}` : ""}`}
        </Badge>
      ))}
    </div>
  )
}

const ContextItemRow = memo(({
  contextId,
  item,
  index,
  matchedPageEntry,
  onOpenSession,
}: {
  readonly contextId: string
  readonly item: ModelCallContextItem
  readonly index: number
  readonly matchedPageEntry: SemanticPageEntry | undefined
  readonly onOpenSession?: ((sessionId: string) => void) | undefined
}) => {
  const client = useClient()
  const sessionId = useClientState((state) => state.activeSessionId)
  const {
    hostRef,
    hydrated,
    loading: hydratingBody,
    error: bodyError,
    retry: retryBody,
  } = useAutoHydrateSemanticBody(sessionId, matchedPageEntry?.entry.id, matchedPageEntry?.body ?? null)

  const resolvedEntry = hydrated ?? matchedPageEntry?.entry
  const pendingBody = hydrated === null && matchedPageEntry?.body !== null && matchedPageEntry !== undefined

  const fallbackSystemKey =
    item.kind === "system-message" && resolvedEntry === undefined && sessionId !== null
      ? `${sessionId}:${item.contentId}:${contextId}`
      : null
  const [fallbackSystemText, setFallbackSystemText] = useState<string | null>(() =>
    fallbackSystemKey !== null ? (systemBlobCache.get(fallbackSystemKey) ?? null) : null,
  )
  const [fallbackError, setFallbackError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    setFallbackSystemText(fallbackSystemKey !== null ? (systemBlobCache.get(fallbackSystemKey) ?? null) : null)
    setFallbackError(null)
  }, [fallbackSystemKey])

  useEffect(() => {
    if (fallbackSystemKey === null || sessionId === null || item.kind !== "system-message") return
    if (systemBlobCache.has(fallbackSystemKey)) {
      setFallbackSystemText(systemBlobCache.get(fallbackSystemKey)!)
      return
    }
    let cancelled = false
    void client
      .downloadContent(sessionId, item.contentId, contextId)
      .then((blob) => blob.text())
      .then((text) => {
        if (cancelled) return
        rememberSystemBlob(fallbackSystemKey, text)
        setFallbackSystemText(text)
      })
      .catch(() => {
        if (!cancelled) setFallbackError("Could not load harness instructions.")
      })
    return () => {
      cancelled = true
    }
  }, [attempt, client, contextId, fallbackSystemKey, item, sessionId])

  const metaTag = (
    <span className="text-muted-foreground/75 shrink-0 font-mono text-[11px] tabular-nums">
      #{index + 1}
      {item.kind === "agent-tool"
        ? ` · ${formatBytes(item.inputByteLength + item.resultByteLength)}${item.resultCleared ? " · cleared" : ""}`
        : item.kind === "agent-thought" && item.opaque
          ? " · opaque replay"
          : ` · ${formatBytes(item.byteLength)}`}
    </span>
  )

  if (item.kind === "developer-message" && item.transcript !== null) {
    const transcriptEntry: SemanticEntry = {
      id: item.transcript.id,
      contentId: item.transcript.id,
      position: index + 1,
      turnId: null,
      authorship: { sessionId: sessionId ?? "session", agentTitle: "harness", modelId: null },
      ownership: { kind: "local" },
      createdAt: 0,
      kind: "developer-message",
      components: [item.transcript],
    }
    return (
      <li className="flex flex-col gap-2.5 py-5 text-sm [content-visibility:auto] [contain-intrinsic-size:auto_180px]">
        <SemanticBlockHeader entry={transcriptEntry} onOpenSession={onOpenSession} extraRight={metaTag} />
        <SemanticEntryContent entry={transcriptEntry} />
      </li>
    )
  }

  if (item.kind === "agent-thought" && resolvedEntry === undefined) {
    return (
      <li className="flex flex-col gap-2 py-5 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <span className="text-muted-foreground inline-flex items-center gap-2 font-mono font-semibold tracking-wide">
            <BrainIcon className="size-3.5 shrink-0" />
            AGENT-THOUGHT
          </span>
          {metaTag}
        </div>
        <p className="text-muted-foreground text-xs">
          {item.opaque ? "Opaque provider reasoning state replayed to the model." : "Replayed reasoning."}
        </p>
      </li>
    )
  }

  if (item.kind === "system-message" && resolvedEntry === undefined) {
    const syntheticSystem: SemanticEntry = {
      id: `system:${contextId}`,
      contentId: item.contentId,
      position: index + 1,
      turnId: null,
      authorship: { sessionId: sessionId ?? "session", agentTitle: "harness", modelId: null },
      ownership: { kind: "local" },
      createdAt: 0,
      kind: "system-message",
      content: { id: item.contentId, kind: "text", text: fallbackSystemText ?? "" },
    }
    return (
      <li className="flex flex-col gap-2.5 py-5 text-sm">
        <SemanticBlockHeader entry={syntheticSystem} onOpenSession={onOpenSession} extraRight={metaTag} />
        {fallbackSystemText !== null ? (
          <PlainText text={fallbackSystemText} className="text-xs leading-relaxed text-foreground" />
        ) : fallbackError !== null ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{fallbackError}</span>
            <Button type="button" size="xs" variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="text-muted-foreground flex items-center gap-2 py-1 text-xs">
            <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
            <span>Loading harness instructions ({formatBytes(item.byteLength)})…</span>
          </div>
        )}
      </li>
    )
  }

  if (resolvedEntry === undefined) return null

  const displayEntry: SemanticEntry =
    item.kind === "agent-tool" && item.resultCleared && resolvedEntry.kind === "agent-tool"
      ? {
          ...resolvedEntry,
          tool: {
            ...resolvedEntry.tool,
            result: {
              content: [{ id: `${resolvedEntry.id}:cleared`, kind: "text", text: CLEARED_RESULT_TEXT }],
              structured: null,
            },
          },
        }
      : resolvedEntry

  return (
    <li
      ref={(node) => {
        hostRef.current = node
      }}
      className="flex flex-col gap-2.5 py-5 text-sm [content-visibility:auto] [contain-intrinsic-size:auto_180px]"
    >
      <SemanticBlockHeader entry={displayEntry} onOpenSession={onOpenSession} extraRight={metaTag} />
      {pendingBody ? (
        <div className="text-muted-foreground flex items-center gap-2 py-1 text-xs">
          {bodyError !== null ? (
            <>
              <span className="text-destructive">{bodyError}</span>
              <Button type="button" size="xs" variant="ghost" onClick={retryBody}>
                Retry
              </Button>
            </>
          ) : (
            <>
              <Loader2Icon className={hydratingBody ? "size-3.5 shrink-0 animate-spin" : "size-3.5 shrink-0"} />
              <span>Loading content ({formatBytes(matchedPageEntry!.body!.byteLength)})…</span>
            </>
          )}
        </div>
      ) : (
        <>
          <SemanticEntryContent entry={displayEntry} />
          {item.kind === "user-message" && item.attachments.length > 0 && (
            <MediaProjectionList items={item.attachments} />
          )}
          {item.kind === "agent-tool" && !item.resultCleared && item.resultMedia.length > 0 && (
            <MediaProjectionList items={item.resultMedia} />
          )}
        </>
      )}
    </li>
  )
})

const ToolDefinitionRow = memo(({ tool, index }: { readonly tool: OfferedToolDefinition; readonly index: number }) => (
  <li className="flex flex-col gap-2.5 py-5 text-sm [content-visibility:auto] [contain-intrinsic-size:auto_180px]">
    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
      <div className="flex min-w-0 items-center gap-2">
        <WrenchIcon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="font-mono font-semibold tracking-wide text-muted-foreground">
          tool definition · <span className="text-foreground">{tool.name}</span>
        </span>
      </div>
      <span className="text-muted-foreground/75 shrink-0 font-mono text-[11px] tabular-nums">
        tool #{index + 1}
      </span>
    </div>
    <div className="flex flex-col gap-2">
      {tool.description !== "" && (
        <PlainText text={tool.description} className="text-xs leading-relaxed text-muted-foreground" />
      )}
      <FormattedPayload value={tool.parameters} className="h-52" fitAlmostFull />
    </div>
  </li>
))

export const Checkpoint = ({
  context,
  entries = [],
  onOpenSession,
}: {
  readonly context: ModelCallContext | null
  readonly entries?: ReadonlyArray<SemanticPageEntry>
  readonly onOpenSession?: (sessionId: string) => void
}) => {
  const pageEntryById = useMemo(
    () => new Map<string, SemanticPageEntry>(entries.map((item) => [item.entry.id, item])),
    [entries],
  )

  if (context === null) {
    return (
      <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 px-6 py-20 text-center sm:px-10 lg:px-12 xl:px-16">
        <div className="bg-muted flex size-10 items-center justify-center rounded-xl border">
          <LayersIcon className="size-5" />
        </div>
        <p className="text-sm font-medium text-foreground">No checkpoint window yet</p>
        <p className="max-w-sm text-xs">No successful model request is retained for this session yet.</p>
      </div>
    )
  }

  return (
    <div className="w-full px-6 sm:px-10 lg:px-12 xl:px-16">
      <ol className="divide-y divide-border">
        {context.items.map((item, index) => {
          const sourceId =
            item.kind === "developer-message"
              ? (item.transcript === null ? (item.sourceEntryIds[0] ?? null) : null)
              : item.sourceEntryId
          const matchedPageEntry = sourceId !== null ? pageEntryById.get(sourceId) : undefined
          return (
            <ContextItemRow
              key={`${item.kind}:${sourceId ?? index}:${index}`}
              contextId={context.id}
              item={item}
              index={index}
              matchedPageEntry={matchedPageEntry}
              onOpenSession={onOpenSession}
            />
          )
        })}
        {context.tools.map((tool, index) => (
          <ToolDefinitionRow key={`tool:${tool.name}:${index}`} tool={tool} index={index} />
        ))}
      </ol>
    </div>
  )
}

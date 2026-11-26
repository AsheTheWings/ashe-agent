import { memo, useEffect, useMemo, useState } from "react"
import { BrainIcon, ChevronRightIcon, LayersIcon, Loader2Icon, WrenchIcon } from "lucide-react"
import type {
  ContextMediaProjection,
  ModelCallContext,
  ModelCallContextItem,
  OfferedToolDefinition,
  SemanticEntry,
  SemanticPageEntry,
} from "@ashe-agent/protocol"
import { cn } from "cn"
import { useClient, useClientState } from "@/app/client-context.tsx"
import { Badge } from "@/components/ui/badge.tsx"
import { Button } from "@/components/ui/button.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx"
import { FormattedPayload } from "./json-view.tsx"
import { PlainText } from "./markdown.tsx"
import {
  SemanticBlockHeader,
  SemanticEntryContent,
  useAutoHydrateSemanticBody,
} from "./SessionView.tsx"
import { estimateContextItemTokens, estimateToolDefinitionTokens, formatTokens, formatTokensTooltip } from "./stats.ts"
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

  const itemTokens = estimateContextItemTokens(item)
  const metaTag = (
    <span className="text-muted-foreground/75 flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums">
      <span>#{index + 1}</span>
      <span className="text-muted-foreground/50" aria-hidden="true">·</span>
      {item.kind === "agent-thought" && item.opaque ? (
        <span>opaque</span>
      ) : (
        <Tooltip>
          <TooltipTrigger render={<span className="cursor-default" />}>
            {formatTokens(itemTokens, true)}
          </TooltipTrigger>
          <TooltipContent>{formatTokensTooltip(itemTokens, true)}</TooltipContent>
        </Tooltip>
      )}
      {item.kind === "agent-tool" && item.resultCleared && (
        <>
          <span className="text-muted-foreground/50" aria-hidden="true">·</span>
          <span>cleared</span>
        </>
      )}
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
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
          <span className="text-muted-foreground inline-flex items-center gap-2 font-mono font-semibold tracking-wide">
            <BrainIcon className="size-3.5 shrink-0" />
            AGENT-THOUGHT
          </span>
          <span className="text-muted-foreground/50" aria-hidden="true">·</span>
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

const ToolDefinitionsBlock = memo(({ tools }: { readonly tools: ReadonlyArray<OfferedToolDefinition> }) => {
  const [open, setOpen] = useState(false)
  const toolMetrics = useMemo(
    () => tools.map((tool) => ({ tool, tokens: estimateToolDefinitionTokens(tool) })),
    [tools],
  )
  const totalTokens = useMemo(
    () => toolMetrics.reduce((sum, entry) => sum + entry.tokens, 0),
    [toolMetrics],
  )

  return (
    <li className="py-5 text-sm" data-slot="tool-definitions-block">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          render={
            <button
              type="button"
              className="hover:text-foreground focus-visible:ring-ring/50 group flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-md py-0.5 text-start text-[11px] outline-none transition-colors focus-visible:ring-2"
            />
          }
        >
          <ChevronRightIcon
            className={cn(
              "text-muted-foreground size-3.5 shrink-0 transition-transform duration-150",
              open && "rotate-90",
            )}
          />
          <WrenchIcon className="text-muted-foreground size-3.5 shrink-0" />
          <span className="font-mono font-semibold tracking-wide text-muted-foreground">
            TOOL-DEFINITIONS
          </span>
          <span className="text-muted-foreground/50" aria-hidden="true">·</span>
          <span className="text-muted-foreground/80 font-normal tabular-nums">
            {tools.length} {tools.length === 1 ? "tool" : "tools"}
          </span>
          <span className="text-muted-foreground/50" aria-hidden="true">·</span>
          <span className="text-muted-foreground/75 shrink-0 font-mono text-[11px] tabular-nums">
            {formatTokens(totalTokens, true)}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {toolMetrics.length === 0 ? (
            <p className="text-muted-foreground pt-3 text-xs">No tools offered in this checkpoint window.</p>
          ) : (
            <div className="mt-3 divide-y divide-border/60 border-t border-border/60">
              {toolMetrics.map(({ tool, tokens }, index) => (
                <div key={`tool:${tool.name}:${index}`} className="flex flex-col gap-2 py-4 first:pt-3 last:pb-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                    <span className="font-mono text-xs font-semibold text-foreground">{tool.name}</span>
                    <span className="text-muted-foreground/50" aria-hidden="true">·</span>
                    <span className="text-muted-foreground/75 shrink-0 font-mono text-[11px] tabular-nums">
                      #{index + 1} · {formatTokens(tokens, true)}
                    </span>
                  </div>
                  {tool.description !== "" && (
                    <PlainText text={tool.description} className="text-xs leading-relaxed text-muted-foreground" />
                  )}
                  <FormattedPayload value={tool.parameters} className="h-52" fitAlmostFull />
                </div>
              ))}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
})

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
        <ToolDefinitionsBlock key={`tools:${context.id}`} tools={context.tools} />
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
      </ol>
    </div>
  )
}

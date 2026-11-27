import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import {
  BrainIcon,
  CheckCircle2Icon,
  Code2Icon,
  EyeIcon,
  FileDiffIcon,
  FileIcon,
  Loader2Icon,
  TerminalIcon,
  UserIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react"
import type { EntryBodyReference, SemanticEntry, SemanticPageEntry } from "@ashe-agent/protocol"
import { cn } from "cn"
import { useClient, useClientState } from "@/app/client-context.tsx"
import { Badge } from "@/components/ui/badge.tsx"
import { Button } from "@/components/ui/button.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx"
import { sessionPath } from "@/shared/routes.ts"
import { BlockBoundary, PatchDiffPre, RetainedMedia } from "./blocks.tsx"
import {
  FormattedPayload,
  resolveScrollPaneHeight,
  TOOL_PANE_BASE_HEIGHT,
} from "./json-view.tsx"
import { MarkdownText, PlainText } from "./markdown.tsx"
import { estimateEntryTokens, formatTokens, formatTokensTooltip, hasVisibleSemanticContent } from "./stats.ts"
import { decodeBase64, formatAgentLabel, formatBytes, formatFullTime, formatHumanDateTime } from "./types.ts"

type SemanticToolEntry = Extract<SemanticEntry, { kind: "agent-tool" }>

const MAX_HYDRATED_CACHE = 120
const hydratedBodyCache = new Map<string, SemanticEntry>()

const rememberHydratedBody = (key: string, entry: SemanticEntry) => {
  if (hydratedBodyCache.has(key)) hydratedBodyCache.delete(key)
  hydratedBodyCache.set(key, entry)
  if (hydratedBodyCache.size > MAX_HYDRATED_CACHE) {
    const oldest = hydratedBodyCache.keys().next().value
    if (oldest !== undefined) hydratedBodyCache.delete(oldest)
  }
}

/** Auto-hydrates a page-omitted semantic body as its block approaches the viewport. */
export const useAutoHydrateSemanticBody = (
  sessionId: string | null,
  entryId: string | undefined,
  body: EntryBodyReference | null,
) => {
  const client = useClient()
  const cacheKey = sessionId !== null && entryId !== undefined && body !== null ? `${sessionId}:${entryId}:${body.contentId}` : null
  const [hydrated, setHydrated] = useState<SemanticEntry | null>(() =>
    cacheKey !== null ? (hydratedBodyCache.get(cacheKey) ?? null) : null,
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const hostRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    setHydrated(cacheKey !== null ? (hydratedBodyCache.get(cacheKey) ?? null) : null)
    setError(null)
  }, [cacheKey])

  const retry = useCallback(() => {
    setError(null)
    setAttempt((count) => count + 1)
  }, [])

  useEffect(() => {
    if (cacheKey === null || sessionId === null || entryId === undefined || body === null) return
    if (hydratedBodyCache.has(cacheKey)) {
      setHydrated(hydratedBodyCache.get(cacheKey)!)
      return
    }
    let cancelled = false
    let started = false

    const startFetch = () => {
      if (started || cancelled) return
      started = true
      setLoading(true)
      setError(null)
      void client
        .semanticBody(sessionId, entryId, body.contentId)
        .then((full) => {
          if (cancelled) return
          rememberHydratedBody(cacheKey, full)
          setHydrated(full)
        })
        .catch(() => {
          if (!cancelled) setError("Could not load full content.")
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }

    const node = hostRef.current
    if (node === null || typeof IntersectionObserver === "undefined") {
      startFetch()
      return () => {
        cancelled = true
      }
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((candidate) => candidate.isIntersecting)) {
          observer.disconnect()
          startFetch()
        }
      },
      { rootMargin: "600px 0px" },
    )
    observer.observe(node)
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [attempt, body, cacheKey, client, entryId, sessionId])

  return { hostRef, hydrated, loading, error, retry }
}

export const SEMANTIC_BLOCK_LABEL: Readonly<Record<SemanticEntry["kind"], string>> = {
  "system-message": "SYSTEM-MESSAGE",
  "developer-message": "DEVELOPER-MESSAGE",
  "user-message": "USER-MESSAGE",
  "agent-message": "AGENT-MESSAGE",
  "agent-thought": "AGENT-THOUGHT",
  "agent-tool": "AGENT-TOOL",
}

export const ToolOutcomeBadge = ({ outcome }: { readonly outcome: SemanticToolEntry["tool"]["outcome"] }) => {
  if (outcome === "success") {
    return (
      <span className="bg-positive-background text-positive inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium">
        <CheckCircle2Icon className="size-3 shrink-0" />
        success
      </span>
    )
  }
  if (outcome === "failed" || outcome === "declined" || outcome === "canceled" || outcome === "interrupted") {
    return (
      <span className="bg-destructive/12 text-destructive inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium">
        <XCircleIcon className="size-3 shrink-0" />
        {outcome}
      </span>
    )
  }
  return (
    <span className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium">
      <Loader2Icon className="size-3 shrink-0 animate-spin" />
      running
    </span>
  )
}

const AgentIdentityMeta = ({
  agentTitle,
  modelId,
  sessionLink,
  onOpenSession,
}: {
  readonly agentTitle: string
  readonly modelId: string | null
  readonly sessionLink?: string
  readonly onOpenSession?: ((sessionId: string) => void) | undefined
}) => (
  <span className="text-muted-foreground/75 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px]">
    {sessionLink !== undefined && (
      <>
        <a
          href={sessionPath(sessionLink)}
          onClick={(event) => {
            if (onOpenSession === undefined || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
            event.preventDefault()
            onOpenSession(sessionLink)
          }}
          className="text-sidebar-primary hover:underline font-mono"
        >
          from {sessionLink}
        </a>
        <span aria-hidden="true">·</span>
      </>
    )}
    <span className="truncate">{formatAgentLabel(agentTitle)}</span>
    {modelId !== null && (
      <>
        <span aria-hidden="true">·</span>
        <span className="truncate font-mono">{modelId}</span>
      </>
    )}
  </span>
)

const BlockKindIcon = ({ kind }: { readonly kind: SemanticEntry["kind"] }) => {
  switch (kind) {
    case "system-message":
      return <TerminalIcon className="text-muted-foreground size-3.5 shrink-0" />
    case "developer-message":
      return <Code2Icon className="text-muted-foreground size-3.5 shrink-0" />
    case "user-message":
      return <UserIcon className="text-sidebar-primary size-3.5 shrink-0" />
    case "agent-message":
      return (
        <span
          className="text-foreground inline-flex h-3.5 shrink-0 items-center text-[12px] font-normal leading-none tracking-tight select-none"
          style={{ fontFamily: "var(--font-brand)" }}
          aria-hidden="true"
        >
          AA
        </span>
      )
    case "agent-thought":
      return <BrainIcon className="text-muted-foreground size-3.5 shrink-0" />
    case "agent-tool":
      return <WrenchIcon className="text-muted-foreground size-3.5 shrink-0" />
  }
}

const blockLabelClass = (kind: SemanticEntry["kind"]): string => {
  switch (kind) {
    case "user-message":
      return "text-sidebar-primary"
    case "agent-message":
      return "text-foreground"
    default:
      return "text-muted-foreground"
  }
}

export const SemanticBlockHeader = ({
  entry,
  onOpenSession,
  extraRight,
}: {
  readonly entry: SemanticEntry
  readonly onOpenSession?: ((sessionId: string) => void) | undefined
  readonly extraRight?: ReactNode
}) => {
  const peerSender = entry.kind === "user-message" && entry.sender?.kind === "session" ? entry.sender : null
  const showAuthor = entry.kind === "agent-message" || entry.kind === "agent-thought" || entry.kind === "agent-tool"

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
      <BlockKindIcon kind={entry.kind} />
      <span className={cn("font-mono font-semibold tracking-wide", blockLabelClass(entry.kind))}>
        {SEMANTIC_BLOCK_LABEL[entry.kind]}
      </span>
      {entry.kind === "system-message" && (
        <>
          <span className="text-muted-foreground/50" aria-hidden="true">·</span>
          <span className="text-muted-foreground/80 font-normal">Harness instructions</span>
        </>
      )}
      {entry.kind === "agent-tool" && (
        <>
          <span className="text-muted-foreground/50" aria-hidden="true">·</span>
          <span className="font-mono text-xs font-semibold text-foreground">{entry.tool.name}</span>
          <ToolOutcomeBadge outcome={entry.tool.outcome} />
        </>
      )}
      {entry.ownership.kind === "inherited" && (
        <Badge variant="secondary" className="text-[10px]">
          inherited from {entry.ownership.sourceSessionId}
        </Badge>
      )}
      {peerSender !== null && (
        <>
          <span className="text-muted-foreground/50" aria-hidden="true">·</span>
          <AgentIdentityMeta
            agentTitle={peerSender.agentTitle}
            modelId={peerSender.modelId}
            sessionLink={peerSender.sessionId}
            onOpenSession={onOpenSession}
          />
        </>
      )}
      {showAuthor && (
        <>
          <span className="text-muted-foreground/50" aria-hidden="true">·</span>
          <AgentIdentityMeta
            agentTitle={entry.authorship.agentTitle}
            modelId={entry.authorship.modelId}
          />
        </>
      )}
      {extraRight !== undefined && (
        <>
          <span className="text-muted-foreground/50" aria-hidden="true">·</span>
          {extraRight}
        </>
      )}
    </div>
  )
}

const semanticToolRenderers: Readonly<Record<string, (entry: SemanticToolEntry) => ReactNode>> = {
  file_patch: (entry) => {
    const value = entry.tool.arguments.value
    const patch =
      value !== null && typeof value === "object" && "patch" in value && typeof value.patch === "string"
        ? value.patch
        : null
    const paths =
      patch === null
        ? []
        : [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((match) => match[1]!)
    const resultText =
      entry.tool.result?.content
        .map((part) => (part.kind === "text" ? part.text : `[${part.name} ${part.content.mediaType}]`))
        .join("\n") ?? "No retained patch result yet."
    return (
      <section className="flex flex-col gap-2 pt-1" aria-label="File patch">
        <div className="flex items-center gap-1.5 font-mono text-xs font-medium text-foreground">
          <FileDiffIcon className="text-muted-foreground size-3.5 shrink-0" />
          <span>FilePatch · {paths.length === 0 ? "patch" : paths.join(", ")}</span>
        </div>
        {patch !== null && <PatchDiffPre patch={patch} />}
        <FormattedPayload value={resultText} className="max-h-52" />
      </section>
    )
  },
}

export const SemanticToolBody = ({ entry }: { readonly entry: SemanticToolEntry }) => {
  const client = useClient()
  const sessionId = useClientState((state) => state.activeSessionId)
  const [capture, setCapture] = useState<{ name: string; data: string; offset: number; byteLength: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inputNeeded, setInputNeeded] = useState(0)
  const [resultNeeded, setResultNeeded] = useState(0)

  const handleInputHeight = useCallback((height: number) => {
    setInputNeeded((prev) => (prev === height ? prev : height))
  }, [])
  const handleResultHeight = useCallback((height: number) => {
    setResultNeeded((prev) => (prev === height ? prev : height))
  }, [])

  const sharedHeight = resolveScrollPaneHeight([inputNeeded, resultNeeded])
  const paneStyle = sharedHeight > TOOL_PANE_BASE_HEIGHT ? { height: sharedHeight } : undefined

  const resultValue: unknown =
    entry.tool.result === null
      ? null
      : entry.tool.result.structured !== null
        ? entry.tool.result.structured.value
        : entry.tool.result.content
            .map((part) => (part.kind === "text" ? part.text : `[${part.name} ${part.content.mediaType}]`))
            .join("\n")

  return (
    <div className="flex flex-col gap-2.5" data-content-id={entry.contentId}>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="min-w-0">
          <div className="text-muted-foreground mb-1 text-[10px] font-medium uppercase tracking-wider">Input</div>
          <FormattedPayload
            value={entry.tool.arguments.value}
            className="h-52"
            style={paneStyle}
            onNeededHeightChange={handleInputHeight}
          />
        </div>
        <div className="min-w-0">
          <div className="text-muted-foreground mb-1 text-[10px] font-medium uppercase tracking-wider">Result</div>
          <FormattedPayload
            value={resultValue}
            emptyText="No retained result."
            className="h-52"
            style={paneStyle}
            onNeededHeightChange={handleResultHeight}
          />
        </div>
      </div>

      {entry.tool.result?.content.map((part) =>
        part.kind === "media" ? <div key={part.id}><RetainedMedia entry={part} /></div> : null,
      )}

      {semanticToolRenderers[entry.tool.name]?.(entry)}

      {entry.tool.captures.length > 0 && (
        <div className="flex flex-col gap-1.5 text-xs">
          {entry.tool.captures.map((captureRef) => (
            <div key={captureRef.contentId} className="flex flex-wrap items-center gap-2 border-t pt-2">
              <span className="font-mono font-medium">{captureRef.name}</span>
              <span className="text-muted-foreground tabular-nums">
                {captureRef.mediaType} · {formatBytes(captureRef.byteLength)}
                {captureRef.captureLossBytes > 0 ? ` · ${formatBytes(captureRef.captureLossBytes)} lost` : ""}
              </span>
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="ml-auto"
                onClick={() => {
                  if (sessionId === null) return
                  void client
                    .capture(sessionId, entry.id, captureRef.contentId, 0, 65_536)
                    .then((result) =>
                      setCapture({
                        name: result.name,
                        data: decodeBase64(result.data),
                        offset: result.offset,
                        byteLength: result.byteLength,
                      }),
                    )
                    .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "capture read failed"))
                }}
              >
                <EyeIcon className="size-3" />
                Preview
              </Button>
            </div>
          ))}
          {error !== null && <p className="text-destructive">{error}</p>}
          {capture !== null && <FormattedPayload value={capture.data} className="h-52" fitAlmostFull />}
        </div>
      )}
    </div>
  )
}

export const SemanticEntryContent = ({ entry }: { readonly entry: SemanticEntry }) => {
  if (entry.kind === "system-message") {
    return <PlainText text={entry.content.text} className="text-xs leading-relaxed text-foreground" />
  }
  if (entry.kind === "developer-message") {
    return (
      <div className="flex flex-col divide-y divide-border/60">
        {entry.components.map((component) => (
          <div key={component.id} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-foreground">{component.heading || component.type}</span>
              <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[10px] uppercase">
                {component.type}
              </span>
            </div>
            <PlainText text={component.text} className="text-xs leading-relaxed text-muted-foreground" />
          </div>
        ))}
      </div>
    )
  }
  if (entry.kind === "user-message") {
    return (
      <div className="flex flex-col gap-2">
        {entry.parts.map((part, index) =>
          part.kind === "text" ? (
            <PlainText key={index} text={part.text} className="text-sm leading-6 text-foreground" />
          ) : (
            <div key={index} className="flex flex-col gap-1">
              <span className="font-mono text-xs text-muted-foreground">{part.name}</span>
              <RetainedMedia entry={part} />
            </div>
          ),
        )}
      </div>
    )
  }
  if (entry.kind === "agent-message") {
    return (
      <div className="flex flex-col gap-2">
        {entry.parts.map((part, index) =>
          part.kind === "text" ? (
            <MarkdownText key={index} text={part.text} />
          ) : (
            <RetainedMedia key={index} entry={part} />
          ),
        )}
      </div>
    )
  }
  if (entry.kind === "agent-thought") {
    return <PlainText text={entry.text} className="text-xs leading-relaxed text-muted-foreground" />
  }
  return <SemanticToolBody entry={entry} />
}

const SessionBlock = memo(({
  item,
  onOpenSession,
  onInspectModelCall,
}: {
  readonly item: SemanticPageEntry
  readonly onOpenSession?: ((sessionId: string) => void) | undefined
  readonly onInspectModelCall?: ((modelCallId: string) => void) | undefined
}) => {
  const sessionId = useClientState((state) => state.activeSessionId)
  const { hostRef, hydrated, loading, error, retry } = useAutoHydrateSemanticBody(sessionId, item.entry.id, item.body)
  const entry = hydrated ?? item.entry
  const pendingBody = hydrated === null && item.body !== null

  if (!pendingBody && !hasVisibleSemanticContent(entry)) return null

  const tokenCount = estimateEntryTokens({ entry, body: pendingBody ? item.body : null })
  const inspectCallId =
    entry.kind === "agent-message" || entry.kind === "agent-thought"
      ? entry.modelCallId
      : entry.kind === "agent-tool"
        ? entry.tool.modelCallId
        : null

  const handleBlockClick = (event: React.MouseEvent<HTMLElement>) => {
    if (!event.shiftKey || inspectCallId === null || onInspectModelCall === undefined) return
    const selection = typeof window !== "undefined" ? window.getSelection() : null
    if (selection !== null && !selection.isCollapsed) return
    event.preventDefault()
    onInspectModelCall(inspectCallId)
  }

  return (
    <article
      ref={(node) => {
        hostRef.current = node
      }}
      onClick={handleBlockClick}
      className="flex flex-col gap-2.5 py-5 [content-visibility:auto] [contain-intrinsic-size:auto_180px]"
      data-content-id={entry.contentId}
      data-kind={entry.kind}
      data-user-anchor={entry.kind === "user-message" ? (entry.turnId ?? entry.id) : undefined}
      data-model-call-id={inspectCallId ?? undefined}
      data-tool-id={entry.kind === "agent-tool" ? (entry.tool.providerCallId ?? entry.tool.id) : undefined}
      data-thought-id={entry.kind === "agent-thought" ? (entry.modelCallId ?? entry.id) : undefined}
    >
      <SemanticBlockHeader
        entry={entry}
        onOpenSession={onOpenSession}
        extraRight={
          <span className="text-muted-foreground/75 flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums">
            {entry.createdAt > 0 && (
              <>
                <time dateTime={new Date(entry.createdAt).toISOString()}>
                  {formatHumanDateTime(entry.createdAt)}
                </time>
                <span className="text-muted-foreground/50" aria-hidden="true">·</span>
              </>
            )}
            <Tooltip>
              <TooltipTrigger render={<span className="cursor-default" />}>
                {formatTokens(tokenCount, true)}
              </TooltipTrigger>
              <TooltipContent>
                {formatTokensTooltip(tokenCount, true)}
                {inspectCallId !== null ? " · Shift+click block to inspect checkpoint window" : ""}
              </TooltipContent>
            </Tooltip>
          </span>
        }
      />

      {pendingBody ? (
        <div className="text-muted-foreground flex items-center gap-2 py-1 text-xs">
          {error !== null ? (
            <>
              <span className="text-destructive">{error}</span>
              <Button type="button" size="xs" variant="ghost" onClick={retry}>
                Retry
              </Button>
            </>
          ) : (
            <>
              <Loader2Icon className={cn("size-3.5 shrink-0", loading && "animate-spin")} />
              <span>Loading content ({formatBytes(item.body!.byteLength)})…</span>
            </>
          )}
        </div>
      ) : (
        <SemanticEntryContent entry={entry} />
      )}
    </article>
  )
})

export const SessionNotebook = ({
  entries,
  onOpenSession,
  onInspectModelCall,
}: {
  readonly entries: ReadonlyArray<SemanticPageEntry>
  readonly onOpenSession?: (sessionId: string) => void
  readonly onInspectModelCall?: (modelCallId: string) => void
}) => {
  const visibleEntries = entries.filter((item) => item.body !== null || hasVisibleSemanticContent(item.entry))

  return (
    <div className="w-full px-6 sm:px-10 lg:px-12 xl:px-16">
      <div className="divide-y divide-border">
        {visibleEntries.map((entry) => (
          <BlockBoundary
            key={entry.entry.id}
            fallback={
              <pre className="max-h-72 overflow-auto py-5 whitespace-pre-wrap font-mono text-xs">
                {JSON.stringify(entry.entry).slice(0, 4_096)}
                {typeof entry.body === "string" ? entry.body : entry.body === null ? "" : `\n${JSON.stringify(entry.body)}`}
              </pre>
            }
          >
            <SessionBlock item={entry} onOpenSession={onOpenSession} onInspectModelCall={onInspectModelCall} />
          </BlockBoundary>
        ))}
      </div>
      {visibleEntries.length === 0 && (
        <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-center">
          <div className="bg-muted flex size-10 items-center justify-center rounded-xl border">
            <FileIcon className="size-5" />
          </div>
          <p className="text-sm font-medium text-foreground">No canonical history yet</p>
          <p className="max-w-xs text-xs">Canonical semantic blocks appear here as the session executes.</p>
        </div>
      )}
    </div>
  )
}

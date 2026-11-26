import { useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangleIcon,
  BarChart3Icon,
  BellIcon,
  BrainIcon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronRightIcon,
  CircleDotIcon,
  InfoIcon,
  LayersIcon,
  Loader2Icon,
  MessageSquareIcon,
  PanelLeftDashedIcon,
  PanelLeftIcon,
  WrenchIcon,
  XCircleIcon,
  XIcon,
} from "lucide-react"
import type { ModelInputManifest, SemanticPageEntry } from "@ashe-agent/protocol"
import { barX, defineChart } from "@tanstack/charts"
import { scaleBand } from "@tanstack/charts/scales/band"
import { scaleLinear } from "@tanstack/charts/scales/linear"
import { tooltip } from "@tanstack/charts/tooltip"
import { Chart } from "@tanstack/charts/react"
import { cn } from "cn"
import { Badge } from "@/components/ui/badge.tsx"
import { Button } from "@/components/ui/button.tsx"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx"
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx"
import type { AssistantItem, ReasoningPart, SessionView, ToolPart } from "@/session/projection.ts"
import { computeCheckpointStats, computeSessionStats, type CheckpointSegment } from "./stats.ts"
import { VIEWS, formatFullTime, type ShortcutPreferences, type ViewName } from "./types.ts"

export type SessionNotificationEntry =
  | {
      readonly id: string
      readonly kind: "activity"
      readonly timestamp: number
      readonly view: SessionView | undefined
      readonly onReveal: (target: string) => void
    }
  | {
      readonly id: string
      readonly kind: "notice"
      readonly tone: "info" | "warning" | "destructive"
      readonly timestamp: number
      readonly message: string
      readonly detail?: string
      readonly badge?: string
      readonly actionLabel?: string
      readonly onAction?: () => void
      readonly secondaryActionLabel?: string
      readonly onSecondaryAction?: () => void
      readonly onDismiss?: () => void
    }

const findLastMeaningfulContent = (
  view: SessionView | undefined,
): { readonly thought: ReasoningPart | null; readonly tool: ToolPart | null } => {
  if (view === undefined) return { thought: null, tool: null }
  let thought: ReasoningPart | null = null
  let tool: ToolPart | null = null
  for (let i = view.items.length - 1; i >= 0; i--) {
    const item = view.items[i]
    if (item === undefined || item.kind !== "assistant") continue
    const assistant: AssistantItem = item
    for (let j = assistant.parts.length - 1; j >= 0; j--) {
      const part = assistant.parts[j]
      if (part === undefined) continue
      if (thought === null && part.type === "reasoning" && part.text.trim() !== "") {
        thought = part
      } else if (tool === null && part.type === "tool") {
        tool = part
      }
      if (thought !== null && tool !== null) return { thought, tool }
    }
  }
  return { thought, tool }
}

const summarizeToolArgs = (argsText: string): string => {
  const trimmed = argsText.trim()
  if (trimmed === "" || trimmed === "{}") return ""
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const key of ["path", "file", "command", "cmd", "query", "url", "pattern", "target"]) {
        const value = parsed[key]
        if (typeof value === "string" && value.trim() !== "") return value.trim().split("\n")[0]!
      }
      const firstString = Object.values(parsed).find((value): value is string => typeof value === "string" && value.trim() !== "")
      if (firstString !== undefined) return firstString.trim().split("\n")[0]!
    }
  } catch {
    // Fall back to first non-empty line of raw args text.
  }
  return trimmed.split("\n")[0] ?? ""
}

/** ActivityPreview entry content showing the last meaningful thought and/or tool call, even when idle. */
const ActivityPreviewContent = ({
  view,
  onReveal,
}: {
  readonly view: SessionView | undefined
  readonly onReveal: (target: string) => void
}) => {
  const active = view?.runId !== null && view?.runId !== undefined
  const { thought, tool } = findLastMeaningfulContent(view)
  const thoughtLine = thought?.text.trim().split(/\r?\n/)[0]?.trim() ?? ""
  const toolSummary = tool === null ? "" : summarizeToolArgs(tool.argsText)
  const toolOutcome = tool?.result?.outcome ?? null
  const toolRunning = tool !== null && tool.result === null && (tool.started || active)
  const split = thought !== null && tool !== null

  if (thought === null && tool === null) {
    return (
      <span className="text-muted-foreground flex h-full min-w-0 flex-1 items-center gap-1.5 truncate px-3">
        {active ? (
          <>
            <Loader2Icon className="text-primary size-3.5 shrink-0 animate-spin" />
            <span>Working…</span>
          </>
        ) : (
          <span>No agent thoughts or tool calls yet</span>
        )}
      </span>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-1 items-stretch overflow-hidden">
      {thought !== null && (
        <button
          type="button"
          onClick={() => onReveal(`thought:${thought.modelCallId ?? thought.id}`)}
          title={thoughtLine || "Thoughts"}
          className={cn(
            "hover:bg-accent/70 focus-visible:bg-accent/70 flex h-full min-w-0 items-center gap-1.5 rounded-none px-3 text-start outline-none transition-colors",
            split ? "basis-1/2 border-e border-border" : "flex-1",
          )}
        >
          <BrainIcon className={cn("size-3.5 shrink-0", active && tool === null ? "text-primary animate-pulse" : "text-muted-foreground")} />
          <span
            className="text-muted-foreground min-w-0 flex-1 overflow-hidden whitespace-nowrap"
            style={{
              maskImage: "linear-gradient(to right, black calc(100% - 28px), transparent 100%)",
              WebkitMaskImage: "linear-gradient(to right, black calc(100% - 28px), transparent 100%)",
            }}
          >
            {thoughtLine || "Thinking…"}
          </span>
        </button>
      )}
      {tool !== null && (
        <button
          type="button"
          onClick={() => onReveal(`tool:${tool.id}`)}
          title={`${tool.name}${toolSummary ? ` · ${toolSummary}` : ""}`}
          className={cn(
            "hover:bg-accent/70 focus-visible:bg-accent/70 flex h-full min-w-0 items-center gap-1.5 rounded-none px-3 text-start outline-none transition-colors",
            split ? "basis-1/2" : "flex-1",
          )}
        >
          {toolRunning ? (
            <Loader2Icon className="text-primary size-3.5 shrink-0 animate-spin" />
          ) : toolOutcome === "failed" || toolOutcome === "declined" || toolOutcome === "canceled" || toolOutcome === "interrupted" ? (
            <XCircleIcon className="text-destructive size-3.5 shrink-0" />
          ) : toolOutcome === "success" ? (
            <CheckCircle2Icon className="text-positive size-3.5 shrink-0" />
          ) : (
            <WrenchIcon className="text-muted-foreground size-3.5 shrink-0" />
          )}
          <span
            className="min-w-0 flex-1 overflow-hidden whitespace-nowrap"
            style={{
              maskImage: "linear-gradient(to right, black calc(100% - 28px), transparent 100%)",
              WebkitMaskImage: "linear-gradient(to right, black calc(100% - 28px), transparent 100%)",
            }}
          >
            <span className="font-mono text-[11px] font-medium text-foreground">{tool.name}</span>
            {toolSummary !== "" && (
              <span className="text-muted-foreground"> · {toolSummary}</span>
            )}
          </span>
        </button>
      )}
    </div>
  )
}

/** Standalone ActivityPreview row (also rendered as an entry inside SessionNotifications). */
export const ActivityPreview = ({
  view,
  onReveal,
}: {
  readonly view: SessionView | undefined
  readonly onReveal: (target: string) => void
}) => (
  <div
    data-slot="activity-preview-bar"
    className="bg-muted/30 flex h-9 shrink-0 items-stretch border-b text-xs"
  >
    <ActivityPreviewContent view={view} onReveal={onReveal} />
  </div>
)

const NotificationEntryRow = ({
  entry,
  onActionComplete,
}: {
  readonly entry: SessionNotificationEntry
  readonly onActionComplete?: () => void
}) => {
  if (entry.kind === "activity") {
    return (
      <div data-slot="notification-entry" data-kind="activity" className="flex h-9 min-w-0 flex-1 items-stretch text-xs">
        <ActivityPreviewContent
          view={entry.view}
          onReveal={(target) => {
            onActionComplete?.()
            entry.onReveal(target)
          }}
        />
      </div>
    )
  }

  const ToneIcon =
    entry.tone === "destructive"
      ? XCircleIcon
      : entry.tone === "warning"
        ? AlertTriangleIcon
        : InfoIcon
  const toneClass =
    entry.tone === "destructive"
      ? "text-destructive"
      : entry.tone === "warning"
        ? "text-warning"
        : "text-muted-foreground"

  return (
    <div
      data-slot="notification-entry"
      data-kind="notice"
      className={cn(
        "flex h-9 min-w-0 flex-1 items-center gap-2 px-3 text-xs",
        entry.tone === "destructive" && "bg-destructive/5",
      )}
    >
      <ToneIcon className={cn("size-3.5 shrink-0", toneClass)} />
      {entry.badge !== undefined && (
        <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
          {entry.badge}
        </Badge>
      )}
      <span className={cn("min-w-0 truncate", entry.tone === "destructive" ? "text-destructive font-medium" : "text-foreground")} title={entry.detail ? `${entry.message} — ${entry.detail}` : entry.message}>
        {entry.message}
        {entry.detail !== undefined && entry.detail !== "" && (
          <span className="text-muted-foreground font-normal"> · {entry.detail}</span>
        )}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {entry.secondaryActionLabel !== undefined && entry.onSecondaryAction !== undefined && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={(event) => {
              event.stopPropagation()
              entry.onSecondaryAction?.()
              onActionComplete?.()
            }}
          >
            {entry.secondaryActionLabel}
          </Button>
        )}
        {entry.actionLabel !== undefined && entry.onAction !== undefined && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={(event) => {
              event.stopPropagation()
              entry.onAction?.()
              onActionComplete?.()
            }}
          >
            {entry.actionLabel}
          </Button>
        )}
        {entry.onDismiss !== undefined && (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss notification"
            className="text-muted-foreground hover:text-foreground size-6"
            onClick={(event) => {
              event.stopPropagation()
              entry.onDismiss?.()
            }}
          >
            <XIcon className="size-3" />
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Bar 2 notification queue.
 * Collapsed: renders the latest single entry (`h-9`).
 * Expanded: displays up to 5 entries in one viewport (`max-h-[180px]`, latest at top) with compact scroll.
 */
export const SessionNotifications = ({
  entries,
  defaultExpanded = false,
}: {
  readonly entries: ReadonlyArray<SessionNotificationEntry>
  readonly defaultExpanded?: boolean
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const containerRef = useRef<HTMLDivElement>(null)
  const latest = entries[0]

  useEffect(() => {
    if (!expanded) return
    const onPointerDown = (event: PointerEvent) => {
      if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) {
        setExpanded(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        setExpanded(false)
      }
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [expanded])

  const handleBarClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null
    if (target?.closest("button, a, [role='button']")) return
    setExpanded((open) => !open)
  }

  const hasDestructive = entries.some((entry) => entry.kind === "notice" && entry.tone === "destructive")
  const hasWarning = entries.some((entry) => entry.kind === "notice" && entry.tone === "warning")
  const hasAlert = entries.some((entry) => entry.kind === "notice")
  const bellToneClass = hasDestructive
    ? "text-destructive"
    : hasWarning
      ? "text-warning"
      : hasAlert
        ? "text-sidebar-primary"
        : "text-muted-foreground"

  return (
    <div
      ref={containerRef}
      data-slot="session-notifications"
      data-expanded={expanded ? "true" : "false"}
      className="bg-muted/30 relative flex h-9 shrink-0 items-stretch border-b text-xs"
      onClick={handleBarClick}
    >
      {expanded ? (
        <div className="text-muted-foreground flex min-w-0 flex-1 items-center gap-2 px-3">
          <BellIcon className={cn("size-3.5 shrink-0", bellToneClass)} />
          <span className="font-medium text-foreground">Session notifications</span>
          <span className={cn("tabular-nums", bellToneClass)}>({entries.length})</span>
        </div>
      ) : latest !== undefined ? (
        <NotificationEntryRow entry={latest} />
      ) : (
        <span className="text-muted-foreground flex flex-1 items-center px-3">No notifications</span>
      )}

      <button
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse session notifications" : `Expand session notifications (${entries.length})`}
        title={expanded ? "Collapse notifications" : `Session notifications (${entries.length})`}
        onClick={() => setExpanded((open) => !open)}
        className={cn(
          "hover:bg-accent/70 focus-visible:bg-accent/70 text-muted-foreground hover:text-foreground flex h-full shrink-0 items-center gap-1.5 px-2.5 outline-none transition-colors",
          expanded && "bg-accent/70 text-foreground",
        )}
      >
        <BellIcon className={cn("size-3.5 shrink-0", expanded ? "text-foreground" : bellToneClass)} />
        {entries.length > 1 && (
          <span className={cn("text-[11px] font-medium tabular-nums", expanded ? "text-foreground" : bellToneClass)}>
            {entries.length}
          </span>
        )}
      </button>

      {expanded && (
        <div
          role="region"
          aria-label="Session notifications"
          data-slot="session-notifications-list"
          className="bg-popover text-popover-foreground scrollbar-compact absolute inset-x-0 top-full z-30 max-h-[185px] overflow-y-auto border-b shadow-md divide-y divide-border/60"
        >
          {entries.map((entry) => (
            <div key={entry.id} className="hover:bg-accent/35 flex h-9 items-stretch transition-colors">
              <NotificationEntryRow entry={entry} onActionComplete={() => setExpanded(false)} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Compact queue drawer button shown on Session/Checkpoint stats bars when non-activity alerts exist. */
const StatsQueueToggle = ({
  entries,
}: {
  readonly entries: ReadonlyArray<SessionNotificationEntry>
}) => {
  const [expanded, setExpanded] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const alertCount = entries.filter((entry) => entry.kind !== "activity").length

  useEffect(() => {
    if (!expanded) return
    const onPointerDown = (event: PointerEvent) => {
      if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) {
        setExpanded(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        setExpanded(false)
      }
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [expanded])

  if (alertCount === 0) return null

  const hasDestructive = entries.some((entry) => entry.kind === "notice" && entry.tone === "destructive")
  const hasWarning = entries.some((entry) => entry.kind === "notice" && entry.tone === "warning")
  const bellToneClass = hasDestructive ? "text-destructive" : hasWarning ? "text-warning" : "text-sidebar-primary"

  return (
    <div ref={containerRef} className="flex h-full shrink-0 items-stretch">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`Session notifications (${alertCount})`}
        title={`Session notifications (${alertCount})`}
        onClick={() => setExpanded((open) => !open)}
        className={cn(
          "hover:bg-accent/70 focus-visible:bg-accent/70 text-foreground flex h-full shrink-0 items-center gap-1.5 px-2.5 text-xs outline-none transition-colors",
          expanded && "bg-accent/70",
        )}
      >
        <BellIcon className={cn("size-3.5 shrink-0", expanded ? "text-foreground" : bellToneClass)} />
        <span className={cn("text-[11px] font-medium tabular-nums", expanded ? "text-foreground" : bellToneClass)}>
          {alertCount}
        </span>
      </button>

      {expanded && (
        <div
          role="region"
          aria-label="Session notifications"
          data-slot="session-notifications-list"
          className="bg-popover text-popover-foreground scrollbar-compact absolute inset-x-0 top-full z-30 max-h-[185px] overflow-y-auto border-b shadow-md divide-y divide-border/60"
        >
          {entries.map((entry) => (
            <div key={entry.id} className="hover:bg-accent/35 flex h-9 items-stretch transition-colors">
              <NotificationEntryRow entry={entry} onActionComplete={() => setExpanded(false)} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Persistent second header bar on Session showing high-value timeline stats and an expandable breakdown popover. */
export const SessionStatsBar = ({
  entries,
  notifications = [],
}: {
  readonly entries: ReadonlyArray<SemanticPageEntry>
  readonly notifications?: ReadonlyArray<SessionNotificationEntry>
}) => {
  const stats = useMemo(() => computeSessionStats(entries), [entries])

  return (
    <div
      data-slot="session-stats-bar"
      className="bg-muted/30 relative flex h-9 shrink-0 items-stretch border-b text-xs"
    >
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="hover:bg-accent/70 focus-visible:bg-accent/70 flex h-full min-w-0 flex-1 items-center gap-3 overflow-hidden rounded-none px-3 text-start outline-none transition-colors"
            />
          }
        >
          <span className="text-foreground flex shrink-0 items-center gap-1.5 font-medium tabular-nums">
            <MessageSquareIcon className="text-muted-foreground size-3.5 shrink-0" />
            {stats.totalMessages} {stats.totalMessages === 1 ? "msg" : "msgs"}
            <span className="text-muted-foreground font-normal">
              ({stats.userMessages} user · {stats.agentMessages} agent)
            </span>
          </span>

          <span className="bg-border h-3.5 w-px shrink-0" aria-hidden="true" />

          <span className="flex min-w-0 items-center gap-1.5 truncate tabular-nums">
            <WrenchIcon className="text-muted-foreground size-3.5 shrink-0" />
            <span className="font-medium text-foreground shrink-0">
              {stats.toolCalls} {stats.toolCalls === 1 ? "tool" : "tools"}
            </span>
            {stats.mostUsedTool !== null && (
              <span className="text-muted-foreground truncate">
                · top <code className="font-mono text-[11px] text-foreground">{stats.mostUsedTool.name}</code> ({stats.mostUsedTool.count})
              </span>
            )}
            {stats.failedTools > 0 && (
              <span className="text-destructive shrink-0 font-medium">· {stats.failedTools} failed</span>
            )}
          </span>

          <span className="bg-border hidden h-3.5 w-px shrink-0 sm:inline-block" aria-hidden="true" />

          <span className="text-muted-foreground hidden shrink-0 items-center gap-1.5 tabular-nums sm:flex">
            <BarChart3Icon className="size-3.5 shrink-0" />
            <span>~{stats.estimatedTokens.toLocaleString()} est. tokens</span>
            <ChevronRightIcon className="text-muted-foreground/60 size-3 shrink-0" />
          </span>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(28rem,calc(100vw-2rem))] gap-3 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-foreground">Session insights</span>
            <span className="text-muted-foreground tabular-nums text-[11px]">
              ~{stats.estimatedTokens.toLocaleString()} est. tokens · {stats.thoughts} thoughts
            </span>
          </div>

          {stats.topTools.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">Tool calls</span>
              <div className="flex flex-col gap-1">
                {stats.topTools.slice(0, 8).map((tool) => (
                  <div key={tool.name} className="flex items-center justify-between gap-2 text-xs">
                    <code className="truncate font-mono text-[11px] text-foreground">{tool.name}</code>
                    <span className="text-muted-foreground shrink-0 tabular-nums">
                      {tool.count}
                      {tool.failed > 0 && <span className="text-destructive"> ({tool.failed} failed)</span>}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {stats.byKind.length > 0 && (
            <div className="flex flex-col gap-1.5 border-t pt-2.5">
              <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">Estimated tokens by block type</span>
              <div className="flex flex-col gap-1">
                {stats.byKind.map((row) => (
                  <div key={row.kind} className="flex items-center justify-between gap-2 text-xs tabular-nums">
                    <span className="text-foreground">
                      {row.label} <span className="text-muted-foreground">({row.count})</span>
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground">~{row.tokens.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>
      <StatsQueueToggle entries={notifications} />
    </div>
  )
}

const CheckpointBreakdownChart = ({ segments }: { readonly segments: ReadonlyArray<CheckpointSegment> }) => {
  const chartData = useMemo(
    () =>
      segments.slice(0, 12).map((segment) => ({
        label: segment.label.length > 26 ? `${segment.label.slice(0, 25)}…` : segment.label,
        tokens: segment.tokens,
      })),
    [segments],
  )

  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          barX(chartData, {
            x: "tokens",
            y: "label",
            fill: "var(--chart-1)",
            radius: 4,
            maxThickness: 18,
          }),
        ],
        scales: {
          x: { scale: scaleLinear, nice: true, grid: true, axis: { label: "Est. tokens" } },
          y: { scale: () => scaleBand<string>().padding(0.28) },
        },
        tooltip,
      }),
    [chartData],
  )

  if (typeof window === "undefined" || chartData.length === 0) return null
  const height = Math.max(96, Math.min(260, chartData.length * 24 + 34))
  return (
    <div className="[&_*]:outline-none">
      <Chart ariaLabel="Token distribution across semantic components" definition={definition} height={height} className="w-full" />
    </div>
  )
}

/** Persistent second header bar on Checkpoint showing token stats, semantic distribution bar, and detailed popover. */
export const CheckpointStatsBar = ({
  manifest,
  entries,
  usage,
  notifications = [],
}: {
  readonly manifest: ModelInputManifest | null
  readonly entries: ReadonlyArray<SemanticPageEntry>
  readonly usage: ReadonlyArray<{ readonly modelCallId: string; readonly providerUsage: unknown }>
  readonly notifications?: ReadonlyArray<SessionNotificationEntry>
}) => {
  const stats = useMemo(() => computeCheckpointStats(manifest, entries, usage), [entries, manifest, usage])

  if (stats === null) {
    return (
      <div
        data-slot="checkpoint-stats-bar"
        className="bg-muted/30 text-muted-foreground relative flex h-9 shrink-0 items-stretch border-b text-xs"
      >
        <span className="flex flex-1 items-center px-3">No retained checkpoint boundary yet</span>
        <StatsQueueToggle entries={notifications} />
      </div>
    )
  }

  return (
    <div
      data-slot="checkpoint-stats-bar"
      className="bg-muted/30 relative flex h-9 shrink-0 items-stretch border-b text-xs"
    >
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="hover:bg-accent/70 focus-visible:bg-accent/70 flex h-full min-w-0 flex-1 items-center gap-3 overflow-hidden rounded-none px-3 text-start outline-none transition-colors"
            />
          }
        >
          <span className="flex shrink-0 items-center gap-1.5 font-medium text-foreground tabular-nums">
            <LayersIcon className="text-muted-foreground size-3.5 shrink-0" />
            <span>{stats.knownSubtotal.toLocaleString()} est. tokens</span>
            {stats.coverage === "partial" && (
              <span className="text-warning inline-flex items-center gap-0.5 text-[11px] font-normal" title={`${stats.unavailableCount} unavailable contribution(s)`}>
                <AlertTriangleIcon className="size-3" />
                partial
              </span>
            )}
          </span>

          {(stats.providerInputTokens !== null || stats.providerOutputTokens !== null) && (
            <>
              <span className="bg-border hidden h-3.5 w-px shrink-0 md:inline-block" aria-hidden="true" />
              <span className="text-muted-foreground hidden shrink-0 tabular-nums md:inline">
                Provider:{" "}
                <span className="text-foreground font-medium">
                  {stats.providerInputTokens !== null ? `${stats.providerInputTokens.toLocaleString()} in` : "—"}
                  {stats.providerOutputTokens !== null ? ` / ${stats.providerOutputTokens.toLocaleString()} out` : ""}
                </span>
              </span>
            </>
          )}

          {stats.segments.length > 0 && (
            <>
              <span className="bg-border h-3.5 w-px shrink-0" aria-hidden="true" />
              <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                <div
                  className="bg-muted flex h-2.5 min-w-20 max-w-64 flex-1 overflow-hidden rounded-full border border-border/60"
                  aria-label="Semantic token distribution"
                >
                  {stats.segments.map((segment) => (
                    <span
                      key={segment.id}
                      style={{
                        width: `${Math.max(segment.share * 100, 1.5)}%`,
                        backgroundColor: segment.colorToken,
                      }}
                      className="h-full border-e border-background/50 last:border-e-0"
                      title={`${segment.label}${segment.detail ? ` (${segment.detail})` : ""}: ~${segment.tokens.toLocaleString()} tokens (${Math.round(segment.share * 100)}%)`}
                    />
                  ))}
                </div>
                <span className="text-muted-foreground hidden truncate text-[11px] lg:inline">
                  {stats.segments
                    .slice(0, 3)
                    .map((segment) => `${segment.label} ${Math.round(segment.share * 100)}%`)
                    .join(" · ")}
                </span>
              </div>
            </>
          )}

          <span className="text-muted-foreground ml-auto flex shrink-0 items-center gap-1 text-[11px] tabular-nums">
            <span className="hidden sm:inline">Window {stats.windowPosition}</span>
            <ChevronRightIcon className="text-muted-foreground/60 size-3 shrink-0" />
          </span>
        </PopoverTrigger>

        <PopoverContent align="start" initialFocus={false} className="w-[min(36rem,calc(100vw-2rem))] gap-3.5 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <p className="text-xs font-semibold text-foreground">Checkpoint window {stats.windowPosition}</p>
              <p className="text-muted-foreground text-[11px] tabular-nums">
                {stats.knownSubtotal.toLocaleString()} known tokens · {stats.coverage} coverage
                {stats.unavailableCount > 0 ? ` · ${stats.unavailableCount} unavailable` : ""} · {formatFullTime(stats.committedAt)}
              </p>
            </div>
            <code className="text-muted-foreground font-mono text-[10px]">{stats.boundaryId}</code>
          </div>

          {stats.segments.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">
                Estimated semantic distribution
              </span>
              <CheckpointBreakdownChart segments={stats.segments} />
              <div className="scrollbar-compact max-h-44 overflow-y-auto border-t pt-2">
                <div className="flex flex-col gap-1">
                  {stats.segments.map((segment) => (
                    <div key={segment.id} className="flex items-center justify-between gap-2 text-xs tabular-nums">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span
                          className="size-2 shrink-0 rounded-full"
                          style={{ backgroundColor: segment.colorToken }}
                          aria-hidden="true"
                        />
                        <span className="truncate font-medium text-foreground">{segment.label}</span>
                        {segment.detail !== undefined && (
                          <span className="text-muted-foreground shrink-0 text-[11px]">({segment.detail})</span>
                        )}
                      </span>
                      <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
                        ~{segment.tokens.toLocaleString()} ({Math.round(segment.share * 100)}%)
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1.5 border-t pt-2.5">
            <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">
              Provider-reported usage
            </span>
            {stats.providerUsage.length === 0 ? (
              <p className="text-muted-foreground text-xs">Unknown; the provider reported no usage.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {stats.providerUsage.map((entry) => (
                  <div key={entry.modelCallId} className="flex flex-col gap-1">
                    <span className="text-muted-foreground font-mono text-[10px]">{entry.modelCallId}</span>
                    <Table>
                      <TableBody>
                        {entry.metrics.map((metric) => (
                          <TableRow key={metric.key}>
                            <TableCell className="py-1 font-mono text-xs text-muted-foreground">{metric.key}</TableCell>
                            <TableCell className="py-1 text-right font-mono text-xs tabular-nums">{metric.value}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ))}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <StatsQueueToggle entries={notifications} />
    </div>
  )
}

/** Constant two-bar workspace header: Bar 1 = session title + Views dropdown; Bar 2 = SessionNotifications / view stats. */
export const WorkspaceHeader = ({
  title,
  currentView,
  onViewChange,
  notifications,
  semanticEntries,
  checkpointManifest,
  checkpointUsage,
  sidebarPinned,
  onToggleSidebar,
  onSidebarPeekStart,
  onSidebarPeekEnd,
  attentionCount,
  needsHuman,
  shortcuts,
}: {
  readonly title: string
  readonly currentView: ViewName
  readonly onViewChange: (next: ViewName) => void
  readonly notifications: ReadonlyArray<SessionNotificationEntry>
  readonly semanticEntries: ReadonlyArray<SemanticPageEntry>
  readonly checkpointManifest: ModelInputManifest | null
  readonly checkpointUsage: ReadonlyArray<{ readonly modelCallId: string; readonly providerUsage: unknown }>
  readonly sidebarPinned: boolean
  readonly onToggleSidebar: () => void
  readonly onSidebarPeekStart?: () => void
  readonly onSidebarPeekEnd?: () => void
  readonly attentionCount: number
  readonly needsHuman: boolean
  readonly shortcuts: ShortcutPreferences
}) => {
  const activeViewLabel = VIEWS.find((entry) => entry.value === currentView)?.label ?? "Chat"
  const shortcutHint = shortcuts.viewModifier === "alt" ? "Alt+I" : "Ctrl+I"

  return (
    <div
      data-slot="workspace-header"
      className="bg-background absolute inset-x-0 top-0 z-20"
    >
      <header className="bg-background flex h-11 items-center gap-2 border-b px-3">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={cn("relative shrink-0", sidebarPinned && "md:hidden")}
                aria-label={sidebarPinned ? "Toggle sidebar" : "Dock sidebar"}
                onClick={onToggleSidebar}
                onMouseEnter={() => {
                  if (!sidebarPinned) onSidebarPeekStart?.()
                }}
                onMouseLeave={() => {
                  if (!sidebarPinned) onSidebarPeekEnd?.()
                }}
              />
            }
          >
            {sidebarPinned ? <PanelLeftIcon className="size-4" /> : <PanelLeftDashedIcon className="size-4" />}
            {attentionCount > 0 && (
              <span className="bg-destructive text-destructive-foreground absolute -end-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium">
                {attentionCount}
              </span>
            )}
          </TooltipTrigger>
          <TooltipContent>{sidebarPinned ? "Toggle sidebar" : "Dock sidebar (hover to preview)"}</TooltipContent>
        </Tooltip>

        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h2 className="truncate text-sm font-medium text-foreground" title={title}>
            {title}
          </h2>
          {needsHuman && (
            <Badge role="status" variant="destructive" className="shrink-0 gap-1 text-[11px]">
              <CircleDotIcon className="size-2.5" />
              Needs you
            </Badge>
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label="View"
                title={`Switch view (${shortcutHint})`}
                className="hover:bg-accent/70 data-[popup-open]:bg-accent/70 focus-visible:ring-ring/50 inline-flex h-7 shrink-0 items-center rounded-md px-2.5 text-xs font-medium text-foreground outline-none transition-colors focus-visible:ring-2"
              />
            }
          >
            <span>{activeViewLabel}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="min-w-44 rounded-xl p-1 shadow-lg">
            {VIEWS.map((entry) => (
              <DropdownMenuItem
                key={entry.value}
                className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs"
                onClick={() => onViewChange(entry.value)}
              >
                <span>{entry.label}</span>
                {entry.value === currentView && <CheckIcon className="text-ring size-3.5 shrink-0" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {currentView === "chat" && <SessionNotifications entries={notifications} />}
      {currentView === "session" && <SessionStatsBar entries={semanticEntries} notifications={notifications} />}
      {currentView === "checkpoint" && (
        <CheckpointStatsBar
          manifest={checkpointManifest}
          entries={semanticEntries}
          usage={checkpointUsage}
          notifications={notifications}
        />
      )}
    </div>
  )
}

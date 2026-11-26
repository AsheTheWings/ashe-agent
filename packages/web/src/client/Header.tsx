import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  AlertTriangleIcon,
  BarChart3Icon,
  BellIcon,
  BrainIcon,
  CheckCircle2Icon,
  CheckIcon,
  CircleDotIcon,
  InfoIcon,
  LayersIcon,
  Loader2Icon,
  MessageSquareIcon,
  RotateCcwIcon,
  WrenchIcon,
  XCircleIcon,
  XIcon,
} from "lucide-react"
import type { ModelCallContext, ModelCallContextSummary, SemanticPageEntry } from "@ashe-agent/protocol"
import { cn } from "cn"
import { Badge } from "@/components/ui/badge.tsx"
import { Button } from "@/components/ui/button.tsx"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx"
import type { AssistantItem, ReasoningPart, SessionView, ToolPart } from "@/session/projection.ts"
import { SecondaryWindowIcon, SidebarPaneIcon } from "./icons.tsx"
import { computeCheckpointStats, computeSessionStats, formatTokens, formatTokensTooltip, type CheckpointSegment } from "./stats.ts"
import { VIEWS, formatCompactTime, formatFullTime, type ShortcutPreferences, type ViewName } from "./types.ts"

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
      readonly sessionId?: string
      readonly sessionTitle?: string
      readonly isOtherSession?: boolean
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

/** ActivityPreview content showing the latest thought and/or tool call, even when idle. */
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
      <span className="text-muted-foreground flex h-full min-w-0 flex-1 items-center gap-1.5 truncate px-2.5">
        {active ? (
          <>
            <Loader2Icon className="text-primary size-3.5 shrink-0 animate-spin" />
            <span>Working…</span>
          </>
        ) : (
          <span>No agent activity yet</span>
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
            "hover:bg-accent/70 focus-visible:bg-accent/70 flex h-full min-w-0 items-center gap-1.5 rounded-none px-2.5 text-start outline-none transition-colors",
            split ? "basis-1/2 border-e border-border/70" : "flex-1",
          )}
        >
          <BrainIcon className={cn("size-3.5 shrink-0", active && tool === null ? "text-primary animate-pulse" : "text-muted-foreground")} />
          <span
            className="text-muted-foreground min-w-0 flex-1 overflow-hidden whitespace-nowrap"
            style={{
              maskImage: "linear-gradient(to right, black calc(100% - 24px), transparent 100%)",
              WebkitMaskImage: "linear-gradient(to right, black calc(100% - 24px), transparent 100%)",
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
            "hover:bg-accent/70 focus-visible:bg-accent/70 flex h-full min-w-0 items-center gap-1.5 rounded-none px-2.5 text-start outline-none transition-colors",
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
              maskImage: "linear-gradient(to right, black calc(100% - 24px), transparent 100%)",
              WebkitMaskImage: "linear-gradient(to right, black calc(100% - 24px), transparent 100%)",
            }}
          >
            <span className="font-mono text-[11px] font-medium text-foreground">{tool.name}</span>
            {toolSummary !== "" && <span className="text-muted-foreground"> · {toolSummary}</span>}
          </span>
        </button>
      )}
    </div>
  )
}

/** Standalone ActivityPreview strip. */
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
  padRightForBell = false,
}: {
  readonly entry: SessionNotificationEntry
  readonly onActionComplete?: () => void
  readonly padRightForBell?: boolean
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
  const singlePrimaryAction =
    entry.actionLabel !== undefined &&
    entry.onAction !== undefined &&
    entry.secondaryActionLabel === undefined &&
    entry.onDismiss === undefined

  return (
    <div
      data-slot="notification-entry"
      data-kind="notice"
      className={cn(
        "flex min-h-9 min-w-0 flex-1 items-center gap-2 py-1.5 ps-3 text-xs",
        padRightForBell ? "pe-3" : "pe-0",
        entry.tone === "destructive" && "bg-destructive/5",
      )}
    >
      <ToneIcon className={cn("size-3.5 shrink-0", toneClass)} />
      {entry.isOtherSession && entry.sessionTitle !== undefined && (
        <Badge variant="outline" className="max-w-28 shrink-0 truncate text-[10px] font-normal">
          {entry.sessionTitle}
        </Badge>
      )}
      {entry.badge !== undefined && (
        <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
          {entry.badge}
        </Badge>
      )}
      <span
        className={cn("min-w-0 flex-1 truncate", entry.tone === "destructive" ? "text-destructive font-medium" : "text-foreground")}
        title={entry.detail ? `${entry.message} — ${entry.detail}` : entry.message}
      >
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
            className={cn("h-6 px-2 text-[11px]", singlePrimaryAction && "w-24 justify-center")}
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
        {padRightForBell && <span className="w-10 shrink-0" aria-hidden="true" />}
      </div>
    </div>
  )
}

/** Expandable notification queue component. */
export const SessionNotifications = ({
  entries,
  defaultExpanded = false,
  className,
}: {
  readonly entries: ReadonlyArray<SessionNotificationEntry>
  readonly defaultExpanded?: boolean
  readonly className?: string
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
      className={cn(
        "bg-muted/30 hover:bg-accent/45 relative flex h-9 shrink-0 cursor-pointer items-stretch gap-1 border-b pe-3 text-xs transition-colors",
        expanded && "bg-accent/40",
        className,
      )}
      onClick={handleBarClick}
    >
      {expanded ? (
        <div className={cn("flex min-w-0 flex-1 items-center gap-2 ps-3", bellToneClass)}>
          <BellIcon className="size-3.5 shrink-0" />
          <span className="font-medium">Notifications</span>
          <span className="tabular-nums">({entries.length})</span>
        </div>
      ) : latest !== undefined ? (
        <NotificationEntryRow entry={latest} />
      ) : (
        <span className="text-muted-foreground flex flex-1 items-center ps-3">No notifications</span>
      )}

      {!expanded && (
        <span
          aria-hidden="true"
          className="flex h-full w-10 shrink-0 items-center justify-center gap-1 select-none"
        >
          <BellIcon className={cn("size-3.5 shrink-0", bellToneClass)} />
          {entries.length > 1 && (
            <span className={cn("text-[11px] font-medium tabular-nums", bellToneClass)}>
              {entries.length}
            </span>
          )}
        </span>
      )}

      {expanded && (
        <div
          role="region"
          aria-label="Notifications"
          data-slot="session-notifications-list"
          className="bg-popover text-popover-foreground scrollbar-compact absolute inset-x-0 top-full z-30 max-h-[185px] cursor-default overflow-y-auto border-b shadow-md divide-y divide-border/60"
        >
          {entries.map((entry) => (
            <div key={entry.id} className="hover:bg-accent/35 flex min-h-9 items-stretch transition-colors">
              <NotificationEntryRow entry={entry} padRightForBell onActionComplete={() => setExpanded(false)} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Secondary-window panel body for Session insights. */
export const SessionInsightsPanel = ({
  entries,
}: {
  readonly entries: ReadonlyArray<SemanticPageEntry>
}) => {
  const stats = useMemo(() => computeSessionStats(entries), [entries])

  return (
    <div data-slot="session-insights-panel" className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground text-xs tabular-nums">
          {stats.totalMessages} {stats.totalMessages === 1 ? "message" : "messages"} ({stats.userMessages} user · {stats.agentMessages} agent)
        </span>
        <span className="text-muted-foreground tabular-nums text-[11px]">
          {formatTokens(stats.estimatedTokens, true)} · {stats.thoughts} thoughts
        </span>
      </div>

      {stats.topTools.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t pt-3">
          <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">Tool calls</span>
          <div className="flex flex-col gap-1">
            {stats.topTools.slice(0, 12).map((tool) => (
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
        <div className="flex flex-col gap-1.5 border-t pt-3">
          <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">Estimated by block type</span>
          <div className="flex flex-col gap-1">
            {stats.byKind.map((row) => (
              <div key={row.kind} className="flex items-center justify-between gap-2 text-xs tabular-nums">
                <span className="text-foreground">
                  {row.label} <span className="text-muted-foreground">({row.count})</span>
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">{formatTokens(row.tokens, true)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** Compact Session stats trigger rendered inside ViewPanel (or standalone SessionStatsBar). */
const SessionStatsContent = ({
  entries,
  secondaryWindowOpen = false,
  onToggleSecondaryWindow,
}: {
  readonly entries: ReadonlyArray<SemanticPageEntry>
  readonly secondaryWindowOpen?: boolean
  readonly onToggleSecondaryWindow?: (() => void) | undefined
}) => {
  const stats = useMemo(() => computeSessionStats(entries), [entries])

  return (
    <button
      type="button"
      aria-expanded={onToggleSecondaryWindow !== undefined ? secondaryWindowOpen : undefined}
      onClick={onToggleSecondaryWindow}
      className={cn(
        "hover:bg-accent/70 focus-visible:bg-accent/70 flex h-full min-w-0 flex-1 items-center gap-2.5 overflow-hidden rounded-none px-2.5 text-start outline-none transition-colors",
        secondaryWindowOpen && "bg-accent/55",
      )}
    >
      <span className="text-foreground flex shrink-0 items-center gap-1.5 font-medium tabular-nums">
        <MessageSquareIcon className="text-muted-foreground size-3.5 shrink-0" />
        {stats.totalMessages} {stats.totalMessages === 1 ? "msg" : "msgs"}
        <span className="text-muted-foreground hidden font-normal lg:inline">
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
          <span className="text-muted-foreground hidden truncate xl:inline">
            · top <code className="font-mono text-[11px] text-foreground">{stats.mostUsedTool.name}</code> ({stats.mostUsedTool.count})
          </span>
        )}
        {stats.failedTools > 0 && (
          <span className="text-destructive shrink-0 font-medium">· {stats.failedTools} failed</span>
        )}
      </span>

      <span className="bg-border h-3.5 w-px shrink-0" aria-hidden="true" />

      <Tooltip>
        <TooltipTrigger
          render={
            <span className="text-muted-foreground flex shrink-0 items-center gap-1 tabular-nums" />
          }
        >
          <BarChart3Icon className="size-3.5 shrink-0" />
          <span>{formatTokens(stats.estimatedTokens, true)}</span>
        </TooltipTrigger>
        <TooltipContent>{formatTokensTooltip(stats.estimatedTokens, true)}</TooltipContent>
      </Tooltip>
    </button>
  )
}

/** Standalone Session stats strip. */
export const SessionStatsBar = ({
  entries,
}: {
  readonly entries: ReadonlyArray<SemanticPageEntry>
}) => (
  <div
    data-slot="session-stats-bar"
    className="bg-muted/30 relative flex h-9 shrink-0 items-stretch border-b text-xs"
  >
    <SessionStatsContent entries={entries} />
  </div>
)

const CheckpointDistributionBar = ({
  segments,
  className,
}: {
  readonly segments: ReadonlyArray<CheckpointSegment>
  readonly className?: string
}) => (
  <div
    className={cn("bg-muted flex overflow-hidden rounded-full border border-border/60", className)}
    aria-label="Context breakdown"
  >
    {segments.map((segment) => (
      <span
        key={segment.id}
        style={{
          width: `${Math.max(segment.share * 100, 1.5)}%`,
          backgroundColor: segment.colorToken,
        }}
        className="h-full border-e border-background/50 last:border-e-0"
        title={`${segment.label}${segment.detail ? ` (${segment.detail})` : ""}: ${formatTokens(segment.tokens, true)} (${Math.round(segment.share * 100)}%)`}
      />
    ))}
  </div>
)

/** Secondary-window panel body for Checkpoint window context breakdown and snapshot selection. */
export const CheckpointInsightsPanel = ({
  context,
  contexts = [],
  latestContextId = null,
  isHistorical = false,
  onSelectContext,
  entries,
  usage,
}: {
  readonly context: ModelCallContext | null
  readonly contexts?: ReadonlyArray<ModelCallContextSummary>
  readonly latestContextId?: string | null
  readonly isHistorical?: boolean
  readonly onSelectContext?: ((contextId: string | null) => void) | undefined
  readonly entries: ReadonlyArray<SemanticPageEntry>
  readonly usage: ReadonlyArray<{ readonly modelCallId: string; readonly providerUsage: unknown }>
}) => {
  const stats = useMemo(() => computeCheckpointStats(context, entries, usage), [context, entries, usage])
  const orderedSnapshots = useMemo(() => [...contexts].reverse(), [contexts])

  if (stats === null) {
    return (
      <p className="text-muted-foreground text-xs">
        No retained checkpoint window yet.
      </p>
    )
  }

  return (
    <div data-slot="checkpoint-insights-panel" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-foreground">
            Checkpoint window {stats.windowPosition} · {formatTokens(stats.windowTokens)}
          </p>
          <p className="text-muted-foreground text-[11px] tabular-nums">
            {formatFullTime(stats.committedAt)}
            {stats.coverage === "partial" ? ` · partial (${stats.unavailableCount} unmeasured)` : ""}
          </p>
        </div>
        {isHistorical && onSelectContext !== undefined && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="h-6 gap-1 px-2 text-[11px]"
            onClick={() => onSelectContext(null)}
          >
            <RotateCcwIcon className="size-3" />
            Latest
          </Button>
        )}
      </div>

      {stats.groups.length > 0 && (
        <div className="flex flex-col gap-2.5 border-t pt-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">
              Context breakdown
            </span>
            <span className="text-muted-foreground text-[10px]">est. · 1T ≈ 4 chars</span>
          </div>
          <CheckpointDistributionBar segments={stats.segments} className="h-3.5 w-full" />
          <div className="flex flex-col gap-2 pt-1">
            {stats.groups.map((group) => (
              <div key={group.id} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2 text-xs tabular-nums">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {group.subgroups.length === 0 && (
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: group.colorToken }}
                        aria-hidden="true"
                      />
                    )}
                    <span className="truncate font-semibold text-foreground">{group.label}</span>
                    {group.detail !== undefined && (
                      <span className="text-muted-foreground shrink-0 text-[11px]">({group.detail})</span>
                    )}
                  </span>
                  <span className="font-mono text-[11px] font-medium text-foreground">
                    {Math.round(group.share * 100)}%{" "}
                    <span className="text-muted-foreground font-normal">({formatTokens(group.tokens, true)})</span>
                  </span>
                </div>
                {group.subgroups.length > 0 && (
                  <div className="flex flex-col gap-1 ps-3.5">
                    {group.subgroups.map((subgroup) => (
                      <div key={subgroup.id} className="flex items-center justify-between gap-2 text-xs tabular-nums">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: subgroup.colorToken }}
                            aria-hidden="true"
                          />
                          <span className="truncate text-foreground/90">{subgroup.label}</span>
                          {subgroup.detail !== undefined && (
                            <span className="text-muted-foreground truncate text-[11px]">({subgroup.detail})</span>
                          )}
                        </span>
                        <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
                          {Math.round(subgroup.share * 100)}% ({formatTokens(subgroup.tokens, true)})
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {orderedSnapshots.length > 1 && onSelectContext !== undefined && (
        <div className="flex flex-col gap-1.5 border-t pt-3">
          <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">
            Snapshots
          </span>
          <div className="flex flex-col gap-0.5">
            {orderedSnapshots.map((snapshot) => {
              const selected = snapshot.id === stats.contextId
              const isLatest = snapshot.id === latestContextId
              return (
                <button
                  key={snapshot.id}
                  type="button"
                  onClick={() => onSelectContext(isLatest ? null : snapshot.id)}
                  className={cn(
                    "hover:bg-accent/70 focus-visible:bg-accent/70 flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-start text-xs outline-none transition-colors",
                    selected && "bg-accent/60 font-medium text-foreground",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-1.5 tabular-nums">
                    <span className="text-foreground">Window {snapshot.windowPosition}</span>
                    <span className="text-muted-foreground">· {formatCompactTime(snapshot.committedAt)}</span>
                    {isLatest && (
                      <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
                        Latest
                      </Badge>
                    )}
                  </span>
                  <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums">
                    <span>{snapshot.itemCount} blocks</span>
                    {selected && <CheckIcon className="text-ring size-3 shrink-0" />}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/** Compact Checkpoint window stats trigger rendered inside ViewPanel (or standalone CheckpointStatsBar). */
const CheckpointStatsContent = ({
  context,
  isHistorical = false,
  onSelectContext,
  entries,
  usage,
  secondaryWindowOpen = false,
  onToggleSecondaryWindow,
}: {
  readonly context: ModelCallContext | null
  readonly isHistorical?: boolean
  readonly onSelectContext?: ((contextId: string | null) => void) | undefined
  readonly entries: ReadonlyArray<SemanticPageEntry>
  readonly usage: ReadonlyArray<{ readonly modelCallId: string; readonly providerUsage: unknown }>
  readonly secondaryWindowOpen?: boolean
  readonly onToggleSecondaryWindow?: (() => void) | undefined
}) => {
  const stats = useMemo(() => computeCheckpointStats(context, entries, usage), [context, entries, usage])

  if (stats === null) {
    return (
      <span className="text-muted-foreground flex h-full flex-1 items-center px-2.5">
        No retained checkpoint window yet
      </span>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-1 items-stretch">
      <button
        type="button"
        aria-expanded={onToggleSecondaryWindow !== undefined ? secondaryWindowOpen : undefined}
        onClick={onToggleSecondaryWindow}
        className={cn(
          "hover:bg-accent/70 focus-visible:bg-accent/70 flex h-full min-w-0 flex-1 items-center gap-2.5 overflow-hidden rounded-none px-2.5 text-start outline-none transition-colors",
          secondaryWindowOpen && "bg-accent/55",
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="flex shrink-0 items-center gap-1.5 font-medium text-foreground tabular-nums" />
            }
          >
            <LayersIcon className="text-muted-foreground size-3.5 shrink-0" />
            <span>{formatTokens(stats.windowTokens)}</span>
            {stats.coverage === "partial" && (
              <span className="text-warning inline-flex items-center gap-0.5 text-[11px] font-normal">
                <AlertTriangleIcon className="size-3" />
                partial
              </span>
            )}
          </TooltipTrigger>
          <TooltipContent>
            {formatTokensTooltip(stats.windowTokens)}
            {stats.coverage === "partial" ? ` · ${stats.unavailableCount} unmeasured` : ""}
          </TooltipContent>
        </Tooltip>

        {stats.segments.length > 0 && (
          <>
            <span className="bg-border h-3.5 w-px shrink-0" aria-hidden="true" />
            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
              <CheckpointDistributionBar segments={stats.segments} className="h-2 min-w-16 max-w-44 flex-1" />
              <span className="text-muted-foreground hidden truncate text-[11px] xl:inline">
                {stats.groups
                  .map((group) => `${group.label} ${Math.round(group.share * 100)}%`)
                  .join(" · ")}
              </span>
            </div>
          </>
        )}

        <Tooltip>
          <TooltipTrigger
            render={
              <span className="text-muted-foreground ml-auto flex shrink-0 items-center gap-1 text-[11px] tabular-nums" />
            }
          >
            <span className="hidden sm:inline">
              Window {stats.windowPosition} · {formatCompactTime(stats.committedAt)}
            </span>
          </TooltipTrigger>
          <TooltipContent>{formatFullTime(stats.committedAt)}</TooltipContent>
        </Tooltip>
      </button>

      {isHistorical && onSelectContext !== undefined && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => onSelectContext(null)}
                className="hover:bg-accent/70 focus-visible:bg-accent/70 text-sidebar-primary flex h-full shrink-0 items-center gap-1 border-s border-border/70 px-2 text-[11px] font-medium outline-none transition-colors"
              />
            }
          >
            <RotateCcwIcon className="size-3 shrink-0" />
            <span>Latest</span>
          </TooltipTrigger>
          <TooltipContent>Return to latest checkpoint window snapshot</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

/** Standalone Checkpoint window stats strip. */
export const CheckpointStatsBar = ({
  context,
  isHistorical = false,
  onSelectContext,
  entries,
  usage,
}: {
  readonly context: ModelCallContext | null
  readonly isHistorical?: boolean
  readonly onSelectContext?: ((contextId: string | null) => void) | undefined
  readonly entries: ReadonlyArray<SemanticPageEntry>
  readonly usage: ReadonlyArray<{ readonly modelCallId: string; readonly providerUsage: unknown }>
}) => (
  <div
    data-slot="checkpoint-stats-bar"
    className="bg-muted/30 relative flex h-9 shrink-0 items-stretch border-b text-xs"
  >
    <CheckpointStatsContent
      context={context}
      isHistorical={isHistorical}
      onSelectContext={onSelectContext}
      entries={entries}
      usage={usage}
    />
  </div>
)

/** View-owned inset panel slot inside the primary header bar. */
export const ViewPanel = ({
  children,
  className,
}: {
  readonly children: ReactNode
  readonly className?: string
}) => (
  <div
    data-slot="view-panel"
    className={cn(
      "bg-muted/40 border-border/60 flex h-7 min-w-0 flex-1 items-stretch overflow-hidden rounded-lg border text-xs",
      className,
    )}
  >
    {children}
  </div>
)

/**
 * Primary workspace header bar (`44px` on desktop) hosting session title, view-owned `ViewPanel`,
 * View switcher, and reserved Secondary Window toggle slot, plus a conditional `SessionNotifications`
 * secondary bar whenever actionable alerts exist. On narrow mobile viewports, `ViewPanel` drops
 * to a compact strip below the primary bar so title and controls stay readable.
 */
export const WorkspaceHeader = ({
  title,
  currentView,
  onViewChange,
  view,
  onReveal,
  notifications,
  semanticEntries,
  checkpointContext,
  isHistoricalContext = false,
  onSelectContext,
  checkpointUsage,
  sidebarPinned,
  onToggleSidebar,
  onSidebarPeekStart,
  onSidebarPeekEnd,
  attentionCount,
  needsHuman,
  shortcuts,
  hasSecondaryContent = false,
  secondaryWindowOpen = false,
  onToggleSecondaryWindow,
}: {
  readonly title: string
  readonly currentView: ViewName
  readonly onViewChange: (next: ViewName) => void
  readonly view?: SessionView | undefined
  readonly onReveal?: (target: string) => void
  readonly notifications: ReadonlyArray<SessionNotificationEntry>
  readonly semanticEntries: ReadonlyArray<SemanticPageEntry>
  readonly checkpointContext: ModelCallContext | null
  readonly isHistoricalContext?: boolean
  readonly onSelectContext?: ((contextId: string | null) => void) | undefined
  readonly checkpointUsage: ReadonlyArray<{ readonly modelCallId: string; readonly providerUsage: unknown }>
  readonly sidebarPinned: boolean
  readonly onToggleSidebar: () => void
  readonly onSidebarPeekStart?: () => void
  readonly onSidebarPeekEnd?: () => void
  readonly attentionCount: number
  readonly needsHuman: boolean
  readonly shortcuts: ShortcutPreferences
  readonly hasSecondaryContent?: boolean
  readonly secondaryWindowOpen?: boolean
  readonly onToggleSecondaryWindow?: () => void
}) => {
  const activeViewLabel = VIEWS.find((entry) => entry.value === currentView)?.label ?? "Chat"
  const shortcutHint = shortcuts.viewModifier === "alt" ? "Alt+I" : "Ctrl+I"

  const viewPanelContent =
    currentView === "chat" ? (
      <ActivityPreviewContent view={view} onReveal={onReveal ?? (() => {})} />
    ) : currentView === "session" ? (
      <SessionStatsContent
        entries={semanticEntries}
        secondaryWindowOpen={secondaryWindowOpen}
        onToggleSecondaryWindow={onToggleSecondaryWindow}
      />
    ) : (
      <CheckpointStatsContent
        context={checkpointContext}
        isHistorical={isHistoricalContext}
        onSelectContext={onSelectContext}
        entries={semanticEntries}
        usage={checkpointUsage}
        secondaryWindowOpen={secondaryWindowOpen}
        onToggleSecondaryWindow={onToggleSecondaryWindow}
      />
    )

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
            <SidebarPaneIcon className="size-4" />
            {attentionCount > 0 && (
              <span className="bg-destructive text-destructive-foreground absolute -end-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium">
                {attentionCount}
              </span>
            )}
          </TooltipTrigger>
          <TooltipContent>{sidebarPinned ? "Toggle sidebar" : "Dock sidebar (hover to preview)"}</TooltipContent>
        </Tooltip>

        <div className="flex min-w-0 shrink items-center gap-2 md:max-w-[14rem] lg:max-w-[18rem]">
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

        <div className="hidden min-w-0 flex-1 items-center justify-center px-2 md:flex">
          <ViewPanel className="max-w-2xl">{viewPanelContent}</ViewPanel>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1 md:ml-0">
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <DropdownMenuTrigger
                    render={
                      <button
                        type="button"
                        aria-label="View"
                        className="hover:bg-accent/70 data-[popup-open]:bg-accent/70 focus-visible:ring-ring/50 inline-flex h-7 min-w-24 shrink-0 items-center justify-center rounded-md px-2.5 text-xs font-medium text-foreground outline-none transition-colors focus-visible:ring-2"
                      />
                    }
                  />
                }
              >
                <span>{activeViewLabel}</span>
              </TooltipTrigger>
              <TooltipContent>Switch view ({shortcutHint})</TooltipContent>
            </Tooltip>
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

          <div
            data-slot="secondary-window-toggle-slot"
            className="flex h-7 w-10 shrink-0 items-center justify-center"
          >
            {hasSecondaryContent && !secondaryWindowOpen && onToggleSecondaryWindow !== undefined && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Open secondary window"
                      aria-expanded={false}
                      aria-keyshortcuts="Control+."
                      data-slot="secondary-window-toggle"
                      onClick={onToggleSecondaryWindow}
                    />
                  }
                >
                  <SecondaryWindowIcon className="size-4" />
                </TooltipTrigger>
                <TooltipContent>Open secondary window (Ctrl+.)</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </header>

      <div className="bg-muted/30 flex h-9 shrink-0 items-stretch border-b text-xs md:hidden">
        {viewPanelContent}
      </div>

      {notifications.length > 0 && <SessionNotifications entries={notifications} />}
    </div>
  )
}

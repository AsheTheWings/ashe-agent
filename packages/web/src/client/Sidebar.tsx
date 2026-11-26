import { useEffect, useRef, useState } from "react"
import {
  AlertCircleIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronRightIcon,
  ClockIcon,
  Loader2Icon,
  LogOutIcon,
  MailIcon,
  MailOpenIcon,
  MoreHorizontalIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SettingsIcon,
  ShieldOffIcon,
  XIcon,
} from "lucide-react"
import { cn } from "cn"
import { useClient, useClientState } from "@/app/client-context.tsx"
import { Badge } from "@/components/ui/badge.tsx"
import { Button } from "@/components/ui/button.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.tsx"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx"
import { Input } from "@/components/ui/input.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx"
import type { WebStateClient, WebStateView } from "./web-state-client.ts"
import { SidebarPaneIcon } from "./icons.tsx"
import { formatFullTime, formatRelativeTime, randomId, sessionDisplayTitle } from "./types.ts"

type DerivedSessionRow = {
  readonly sessionId: string
  readonly title: string
  readonly working: boolean
  readonly attention: boolean
  readonly filed: boolean
  readonly pinned: boolean
  readonly unread: boolean
  readonly optedOut: boolean
  readonly returnAt: number
  readonly submittedAt: number
  readonly state: WebStateView["sessions"][string] | undefined
}

const SidebarRow = ({
  row,
  active,
  sharedLive,
  onOpen,
  onCommand,
  onDragStateChange,
  onMenuOpenChange,
}: {
  readonly row: DerivedSessionRow
  readonly active: boolean
  readonly sharedLive: boolean
  readonly onOpen: (attention: boolean) => void
  readonly onCommand: (command: Parameters<WebStateClient["command"]>[0]) => void
  readonly onDragStateChange: (dragging: boolean) => void
  readonly onMenuOpenChange?: ((open: boolean) => void) | undefined
}) => {
  const { state } = row
  const canDragToFile = sharedLive && state !== undefined && !row.filed && !row.working && !row.attention
  return (
    <li
      draggable={canDragToFile}
      onDragStart={(event) => {
        if (!canDragToFile) {
          event.preventDefault()
          return
        }
        event.dataTransfer.setData("text/session", row.sessionId)
        event.dataTransfer.effectAllowed = "move"
        onDragStateChange(true)
      }}
      onDragEnd={() => onDragStateChange(false)}
      className={cn(
        "group relative flex items-center rounded-md transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent/60",
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 pr-7 text-start outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring rounded-md"
        onClick={() => onOpen(row.attention)}
      >
        <span className="mt-1 flex size-3.5 shrink-0 items-center justify-center">
          {row.attention ? (
            <AlertCircleIcon className="text-destructive size-3.5" aria-label="Needs human input" />
          ) : row.working ? (
            <Loader2Icon className="text-sidebar-primary size-3.5 animate-spin" aria-label="Working" />
          ) : row.unread ? (
            <span className="bg-sidebar-primary size-2 rounded-full" aria-label="Unread" />
          ) : row.pinned ? (
            <PinIcon className="text-muted-foreground size-3" aria-label="Pinned" />
          ) : (
            <span className="size-1.5 rounded-full bg-transparent" aria-hidden="true" />
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-[13px] leading-snug", row.unread && "font-medium")}>
            {row.title}
          </span>
          <span
            className="text-muted-foreground block truncate text-[11px] leading-tight tabular-nums"
            title={formatFullTime(row.returnAt)}
          >
            {row.attention
              ? "Needs you"
              : row.working
                ? "Working"
                : row.filed
                  ? `Filed · ${formatRelativeTime(row.returnAt)}`
                  : formatRelativeTime(row.returnAt)}
          </span>
        </span>
      </button>

      <DropdownMenu {...(onMenuOpenChange === undefined ? {} : { onOpenChange: onMenuOpenChange })}>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Session actions"
              className="absolute end-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
            />
          }
        >
          <MoreHorizontalIcon className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem
            disabled={!sharedLive}
            onClick={() =>
              onCommand({
                kind: "organization.set",
                operationId: randomId(),
                sessionId: row.sessionId,
                patch: { pinned: !row.pinned },
              })
            }
          >
            {row.pinned ? <PinOffIcon /> : <PinIcon />}
            {row.pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!sharedLive}
            onClick={() =>
              onCommand({
                kind: "read.set",
                operationId: randomId(),
                sessionId: row.sessionId,
                unread: !row.unread,
                ...(state === undefined ? {} : { generation: state.readGeneration }),
              })
            }
          >
            {row.unread ? <MailOpenIcon /> : <MailIcon />}
            {row.unread ? "Mark read" : "Mark unread"}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!sharedLive}
            onClick={() =>
              onCommand({
                kind: "organization.set",
                operationId: randomId(),
                sessionId: row.sessionId,
                patch: { snoozedUntil: Date.now() + 3_600_000 },
              })
            }
          >
            <ClockIcon />
            Snooze 1 hour
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!sharedLive || (!row.filed && state === undefined)}
            onClick={() => {
              if (row.filed) {
                onCommand({
                  kind: "organization.set",
                  operationId: randomId(),
                  sessionId: row.sessionId,
                  patch: { filed: false },
                })
              } else if (state !== undefined) {
                onCommand({
                  kind: "file.manual",
                  operationId: randomId(),
                  sessionId: row.sessionId,
                  observedCursor: state.sourceCursor,
                  observedRevision: state.revision,
                })
              }
            }}
          >
            {row.filed ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
            {row.filed ? "Reopen to Inbox" : "File"}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!sharedLive}
            onClick={() =>
              onCommand({
                kind: "organization.set",
                operationId: randomId(),
                sessionId: row.sessionId,
                patch: { optedOut: !row.optedOut },
              })
            }
          >
            <ShieldOffIcon />
            {row.optedOut ? "Enable auto-filing" : "Opt out of auto-filing"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

export const Sidebar = ({
  web,
  active,
  onOpen,
  onCommand,
  onNew,
  onOpenSettings,
  pinned = true,
  onTogglePin,
  showPinControl = true,
  onMenuOpenChange,
  width,
  className,
}: {
  readonly web: WebStateView
  readonly active: string | null
  readonly onOpen: (sessionId: string, attention: boolean) => void
  readonly onCommand: (command: Parameters<WebStateClient["command"]>[0]) => void
  readonly onNew: () => void
  readonly onOpenSettings: () => void
  readonly pinned?: boolean
  readonly onTogglePin?: () => void
  readonly showPinControl?: boolean
  readonly onMenuOpenChange?: (open: boolean) => void
  readonly width?: number
  readonly className?: string
}) => {
  const client = useClient()
  const sessions = useClientState((state) => state.sessions)
  const observations = useClientState((state) => state.observations)
  const views = useClientState((state) => state.views)
  const models = useClientState((state) => state.models)
  const [filedOpen, setFiledOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [dragOverFiled, setDragOverFiled] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  const normalizedQuery = searchQuery.trim().toLowerCase()

  const rows: Array<DerivedSessionRow> = sessions
    .map((session) => {
      const state = web.sessions[session.id]
      const observation = observations[session.id]
      const working =
        state?.working === true ||
        observation?.execution.activity === "working" ||
        (observation?.pending.length ?? 0) > 0
      const attention = state?.needsHuman === true || (observation?.attention.length ?? 0) > 0
      return {
        sessionId: session.id,
        title: sessionDisplayTitle(session, views[session.id], models, session.id),
        working,
        attention,
        filed: state?.filed === true,
        pinned: state?.pinned === true,
        unread: state?.unread === true,
        optedOut: state?.optedOut === true,
        returnAt: state?.lastReturnAt ?? session.createdAt,
        submittedAt: state?.lastSubmissionAt ?? session.createdAt,
        state,
      }
    })
    .filter(
      (row) =>
        normalizedQuery === "" ||
        row.title.toLowerCase().includes(normalizedQuery) ||
        row.sessionId.toLowerCase().includes(normalizedQuery),
    )

  const working = rows
    .filter((row) => row.working || row.attention)
    .sort((a, b) => Number(b.attention) - Number(a.attention) || Number(b.pinned) - Number(a.pinned) || b.submittedAt - a.submittedAt || a.returnAt - b.returnAt)

  const inbox = rows
    .filter((row) => !row.working && !row.attention && !row.filed)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.returnAt - a.returnAt)

  const filed = rows
    .filter((row) => !row.working && !row.attention && row.filed)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.returnAt - a.returnAt)

  const sharedLive = web.status === "live"

  const handleDropToFile = (sessionId: string) => {
    if (!sharedLive || sessionId === "") return
    const state = web.sessions[sessionId]
    if (state === undefined) return
    onCommand({
      kind: "file.manual",
      operationId: randomId(),
      sessionId,
      observedCursor: state.sourceCursor,
      observedRevision: state.revision,
    })
  }

  return (
    <aside
      style={width !== undefined ? { width: `${width}px` } : undefined}
      className={cn(
        "bg-sidebar text-sidebar-foreground border-sidebar-border flex h-full min-h-0 w-[264px] shrink-0 flex-col border-e",
        className,
      )}
    >
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-sidebar-border px-3">
        <button
          type="button"
          className="text-sidebar-primary focus-visible:ring-sidebar-ring rounded-sm text-[24px] leading-none tracking-tight select-none outline-none focus-visible:ring-2"
          style={{ fontFamily: "var(--font-brand)" }}
          aria-label="AsheAgent"
          title="New session"
          onClick={onNew}
        >
          AA
        </button>
        <div className="flex items-center gap-1">
          {web.status !== "live" && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Refresh sessions"
                    onClick={() => void client.refreshSessions().catch(() => {})}
                  />
                }
              >
                <RefreshCwIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>Refresh sessions</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Search sessions"
                  aria-pressed={searchOpen}
                  className={cn(searchOpen && "bg-sidebar-accent text-sidebar-accent-foreground")}
                  onClick={() => {
                    setSearchOpen((open) => {
                      if (open) setSearchQuery("")
                      return !open
                    })
                  }}
                />
              }
            >
              <SearchIcon className="size-4" />
            </TooltipTrigger>
            <TooltipContent>Search sessions</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="New session"
                  onClick={onNew}
                />
              }
            >
              <PlusIcon className="size-4" />
            </TooltipTrigger>
            <TooltipContent>New session</TooltipContent>
          </Tooltip>
          {showPinControl && onTogglePin !== undefined && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={pinned ? "Float sidebar" : "Dock sidebar"}
                    aria-pressed={pinned}
                    onClick={onTogglePin}
                  />
                }
              >
                <SidebarPaneIcon className="size-4" />
              </TooltipTrigger>
              <TooltipContent>{pinned ? "Float sidebar (hover to open)" : "Dock sidebar"}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {searchOpen && (
        <div className="border-sidebar-border shrink-0 border-b px-2 py-1.5">
          <div className="relative">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2" />
            <Input
              ref={searchInputRef}
              type="text"
              aria-label="Filter sessions"
              placeholder="Search sessions…"
              className="bg-background/80 h-7 pl-7 pr-7 text-xs"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation()
                  setSearchQuery("")
                  setSearchOpen(false)
                }
              }}
            />
            {searchQuery !== "" && (
              <button
                type="button"
                aria-label="Clear search"
                className="text-muted-foreground hover:text-foreground absolute end-1.5 top-1/2 -translate-y-1/2 rounded p-0.5"
                onClick={() => {
                  setSearchQuery("")
                  searchInputRef.current?.focus()
                }}
              >
                <XIcon className="size-3" />
              </button>
            )}
          </div>
        </div>
      )}

      {!sharedLive && (
        <div
          role="status"
          data-slot="sidebar-stale-banner"
          className={cn(
            "border-sidebar-border flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5 text-[11px]",
            web.status === "incompatible"
              ? "bg-destructive/10 text-destructive"
              : "bg-warning-background/60 text-warning",
          )}
        >
          <span className="truncate">{web.error ?? "Shared organization is stale"}</span>
          {web.status === "incompatible" && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="h-5 shrink-0 px-1.5 text-[10px]"
              onClick={() => window.location.reload()}
            >
              Reload
            </Button>
          )}
        </div>
      )}

      <div className="scrollbar-compact min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {working.length > 0 && (
          <section className="mb-3">
            <div className="flex items-center justify-between px-2 py-1">
              <h2 className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">Working</h2>
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px] tabular-nums">{working.length}</Badge>
            </div>
            <ul className="flex flex-col gap-0.5">
              {working.map((row) => (
                <SidebarRow
                  key={row.sessionId}
                  row={row}
                  active={active === row.sessionId}
                  sharedLive={sharedLive}
                  onOpen={(attention) => onOpen(row.sessionId, attention)}
                  onCommand={onCommand}
                  onDragStateChange={setDragging}
                  onMenuOpenChange={onMenuOpenChange}
                />
              ))}
            </ul>
          </section>
        )}

        <section className="mb-3">
          <div className="flex items-center justify-between px-2 py-1">
            <h2 className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">Inbox</h2>
            {inbox.length > 0 && (
              <span className="text-muted-foreground text-[11px] tabular-nums">{inbox.length}</span>
            )}
          </div>
          {inbox.length === 0 ? (
            <p className="text-muted-foreground px-2 py-2 text-xs">
              {normalizedQuery !== ""
                ? "No matching sessions."
                : working.length === 0
                  ? "No sessions yet."
                  : "No idle sessions in Inbox."}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {inbox.map((row) => (
                <SidebarRow
                  key={row.sessionId}
                  row={row}
                  active={active === row.sessionId}
                  sharedLive={sharedLive}
                  onOpen={(attention) => onOpen(row.sessionId, attention)}
                  onCommand={onCommand}
                  onDragStateChange={setDragging}
                  onMenuOpenChange={onMenuOpenChange}
                />
              ))}
            </ul>
          )}
        </section>

        {(filed.length > 0 || dragging) && (
          <Collapsible open={filedOpen || normalizedQuery !== ""} onOpenChange={setFiledOpen}>
            <div
              onDragOver={(event) => {
                if (!sharedLive) return
                event.preventDefault()
                setDragOverFiled(true)
              }}
              onDragLeave={() => setDragOverFiled(false)}
              onDrop={(event) => {
                event.preventDefault()
                setDragOverFiled(false)
                setDragging(false)
                handleDropToFile(event.dataTransfer.getData("text/session"))
              }}
              className={cn(
                "rounded-md transition-colors",
                dragging && "border border-dashed border-sidebar-border",
                dragOverFiled && "border-primary bg-accent/60",
              )}
            >
              <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium uppercase tracking-wider outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring">
                <ChevronRightIcon className={cn("size-3.5 transition-transform", filedOpen && "rotate-90")} />
                <ArchiveIcon className="size-3" />
                <span>{dragOverFiled ? "Drop to file" : dragging ? "Drop here to file" : "Filed"}</span>
                {filed.length > 0 && (
                  <span className="ml-auto tabular-nums">{filed.length}</span>
                )}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="flex flex-col gap-0.5 pb-1">
                  {filed.map((row) => (
                    <SidebarRow
                      key={row.sessionId}
                      row={row}
                      active={active === row.sessionId}
                      sharedLive={sharedLive}
                      onOpen={(attention) => onOpen(row.sessionId, attention)}
                      onCommand={onCommand}
                      onDragStateChange={setDragging}
                      onMenuOpenChange={onMenuOpenChange}
                    />
                  ))}
                </ul>
              </CollapsibleContent>
            </div>
          </Collapsible>
        )}
      </div>

      <div className="border-sidebar-border flex shrink-0 items-center justify-between gap-1 border-t p-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="flex-1 justify-start gap-2 text-xs"
          onClick={onOpenSettings}
        >
          <SettingsIcon className="size-3.5" />
          Settings
        </Button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Sign out"
                onClick={() => client.signOut()}
              />
            }
          >
            <LogOutIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>Sign out</TooltipContent>
        </Tooltip>
      </div>
    </aside>
  )
}

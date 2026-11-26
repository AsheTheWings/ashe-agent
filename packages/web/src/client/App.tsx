import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowDownIcon, PanelLeftDashedIcon, PanelLeftIcon } from "lucide-react"
import { Toaster, toast } from "sonner"
import type { ModelInputManifest } from "@ashe-agent/protocol"
import { useClient, useClientState } from "../app/client-context.tsx"
import { SIGN_IN_RETURN_PATH_KEY, SignIn } from "../app/sign-in.tsx"
import { useTheme } from "../app/theme/useTheme.ts"
import { parseSessionPath, sessionPath } from "../shared/routes.ts"
import { Alert, AlertDescription } from "@/components/ui/alert.tsx"
import { Button } from "@/components/ui/button.tsx"
import { Sheet, SheetContent } from "@/components/ui/sheet.tsx"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip.tsx"
import type { AssistantItem, SessionView, UserItem } from "../session/projection.ts"
import { RewindDialog, setDraftFailureReporter, setRenderFailureReporter } from "./blocks.tsx"
import { Chat } from "./ChatView.tsx"
import { Checkpoint } from "./CheckpointView.tsx"
import { Composer, type ComposerNotificationReport } from "./Composer.tsx"
import { DraftStore, type Draft } from "./drafts.ts"
import {
  ActivityPreview,
  CheckpointStatsBar,
  SessionNotifications,
  SessionStatsBar,
  WorkspaceHeader,
  type SessionNotificationEntry,
} from "./Header.tsx"
import { SessionNotebook } from "./SessionView.tsx"
import { SettingsDialog, type SettingsTab } from "./SettingsDialog.tsx"
import { Sidebar } from "./Sidebar.tsx"
import {
  PREFS_KEY,
  VIEWS,
  formatRelativeTime,
  loadShortcutPreferences,
  loadSidebarPinned,
  randomId,
  saveShortcutPreferences,
  saveSidebarPinned,
  saveView,
  savedViews,
  sessionDisplayTitle,
  type ShortcutPreferences,
  type ViewName,
} from "./types.ts"
import { UncertainOperation, useWebState, WebStateClient } from "./web-state-client.ts"

export {
  ActivityPreview,
  Chat,
  Checkpoint,
  CheckpointStatsBar,
  SessionNotebook,
  SessionNotifications,
  SessionStatsBar,
  setDraftFailureReporter,
  setRenderFailureReporter,
}

const escapeAttr = (value: string): string =>
  typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&")

const isNonEmptyDraft = (draft: Draft): boolean =>
  draft.text.trim() !== "" || draft.attachments.length > 0 || Object.keys(draft.selection).length > 0

const createStarterDraft = (): Draft => {
  let selection: Draft["selection"] = {}
  try {
    const raw = window.localStorage.getItem(PREFS_KEY)
    if (raw !== null) {
      const prefs = JSON.parse(raw) as { model?: string | null; agent?: string; reasoningEffort?: string | null }
      selection = {
        ...(prefs.agent === undefined ? {} : { agentTitle: prefs.agent }),
        ...(prefs.model === undefined && prefs.reasoningEffort === undefined
          ? {}
          : {
              modelSettings: {
                ...(prefs.model === undefined ? {} : { modelId: prefs.model }),
                ...(prefs.reasoningEffort === undefined ? {} : { reasoningEffort: prefs.reasoningEffort }),
              },
            }),
      }
    }
  } catch {}
  return {
    version: 1,
    id: randomId(),
    authority: "new",
    sessionId: "new",
    writerId: "new",
    text: "",
    mode: "steer",
    selection,
    attachments: [],
    updatedAt: Date.now(),
    source: null,
  }
}

const emptyViewLike = (sessionId: string): SessionView => ({
  sessionId,
  lastSeq: 0,
  events: [],
  sessionDir: null,
  agent: null,
  model: null,
  reasoningEffort: null,
  forkedFrom: null,
  runId: null,
  activeSelection: null,
  items: [],
  pending: [],
  permissions: [],
  segments: {},
  streams: {},
  settled: [],
})

const Workspace = ({ webClient }: { readonly webClient: WebStateClient }) => {
  const client = useClient()
  const web = useWebState(webClient)
  const theme = useTheme()
  const clientError = useClientState((state) => state.error)
  const status = useClientState((state) => state.status)
  const sessions = useClientState((state) => state.sessions)
  const sessionsLoaded = useClientState((state) => state.sessionsLoaded)
  const models = useClientState((state) => state.models)
  const active = useClientState((state) => state.activeSessionId)
  const view = useClientState((state) => (state.activeSessionId === null ? undefined : state.views[state.activeSessionId]))
  const observation = useClientState((state) => (state.activeSessionId === null ? undefined : state.observations[state.activeSessionId]))
  const observations = useClientState((state) => state.observations)
  const semantic = useClientState((state) => (state.activeSessionId === null ? undefined : state.semantic[state.activeSessionId]))

  const lastFailure =
    view === undefined
      ? undefined
      : [...view.items]
          .reverse()
          .find(
            (item): item is AssistantItem =>
              item.kind === "assistant" &&
              (item.error !== null || item.status === "failed" || item.status === "cancelled" || item.status === "interrupted"),
          )
  const recovered =
    lastFailure === undefined || view === undefined
      ? undefined
      : view.items.some((item) => item.kind === "assistant" && item.status === "finished" && item.seq > lastFailure.seq)
  const executionNotice =
    lastFailure === undefined
      ? null
      : recovered === true
        ? "Execution recovered after an earlier failure"
        : (lastFailure.error ?? (lastFailure.status === "cancelled" ? "Execution cancelled" : `Execution ${lastFailure.status}`))

  const [views, setViews] = useState<Record<string, ViewName>>(savedViews)
  const currentView = active === null ? "chat" : (views[active] ?? "chat")
  const [drafts, setDrafts] = useState<Record<string, Draft | null>>({})
  const [starterDraft, setStarterDraft] = useState<Draft>(createStarterDraft)
  const [unsupportedDrafts, setUnsupportedDrafts] = useState<ReadonlyArray<{ readonly key: string; readonly raw: string }>>([])
  const [recoverables, setRecoverables] = useState<ReadonlyArray<Draft>>([])
  const [recoveryTick, setRecoveryTick] = useState(0)
  const [composerNotifications, setComposerNotifications] = useState<ComposerNotificationReport | null>(null)
  const notificationFirstSeen = useRef<Map<string, number>>(new Map())
  const [activityStamp, setActivityStamp] = useState(1)
  const lastActivitySig = useRef<string>("")
  const [sidebarPinned, setSidebarPinned] = useState<boolean>(loadSidebarPinned)
  const [sidebarHoverOpen, setSidebarHoverOpen] = useState(false)
  const [sidebarMenuOpen, setSidebarMenuOpen] = useState(false)
  const sidebarMenuOpenRef = useRef(false)
  const sidebarHoverTimer = useRef<number | null>(null)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("appearance")
  const [shortcuts, setShortcuts] = useState<ShortcutPreferences>(loadShortcutPreferences)
  const [readEligible, setReadEligible] = useState<string | null>(null)
  const [rewindItem, setRewindItem] = useState<UserItem | null>(null)
  const rewindOperation = useRef(randomId())
  const [checkpoint, setCheckpoint] = useState<{
    manifest: ModelInputManifest
    usage: ReadonlyArray<{ modelCallId: string; providerUsage: unknown }>
  } | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const composerDockRef = useRef<HTMLDivElement>(null)
  const scrolls = useRef<Record<string, number>>({})
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  const pendingPinRef = useRef(false)
  const [pinnedUserItemId, setPinnedUserItemId] = useState<string | null>(null)
  const scrolledPinRef = useRef<string | null>(null)
  const [elasticRoomPx, setElasticRoomPx] = useState(0)
  const lastSeenUserIdRef = useRef<string | null>(null)
  const initialUrlHandledRef = useRef(false)
  const suppressPushRef = useRef(false)

  const clearSidebarTimer = useCallback(() => {
    if (sidebarHoverTimer.current !== null) {
      window.clearTimeout(sidebarHoverTimer.current)
      sidebarHoverTimer.current = null
    }
  }, [])

  const openSidebarPeek = useCallback(() => {
    clearSidebarTimer()
    setSidebarHoverOpen(true)
  }, [clearSidebarTimer])

  const scheduleSidebarPeekClose = useCallback(() => {
    clearSidebarTimer()
    sidebarHoverTimer.current = window.setTimeout(() => {
      if (!sidebarMenuOpenRef.current) setSidebarHoverOpen(false)
    }, 180)
  }, [clearSidebarTimer])

  const handleSidebarMenuOpenChange = useCallback((open: boolean) => {
    sidebarMenuOpenRef.current = open
    setSidebarMenuOpen(open)
    if (open) clearSidebarTimer()
  }, [clearSidebarTimer])

  useEffect(() => clearSidebarTimer, [clearSidebarTimer])

  useEffect(() => {
    saveSidebarPinned(sidebarPinned)
    if (sidebarPinned) {
      clearSidebarTimer()
      setSidebarHoverOpen(false)
    }
  }, [clearSidebarTimer, sidebarPinned])

  const draftsStore = useMemo(() => {
    try {
      return new DraftStore(window.localStorage, window.localStorage)
    } catch {
      return null
    }
  }, [])
  const authority = web.harnessId !== null && web.principal !== null ? `${web.harnessId}:${web.principal}` : null
  const draft = active === null ? null : (drafts[active] ?? null)

  const setSessionView = useCallback((sessionId: string, next: ViewName) => {
    setViews((current) => ({ ...current, [sessionId]: next }))
    saveView(sessionId, next)
  }, [])

  const notify = useCallback((message: string) => {
    toast(message)
  }, [])

  useEffect(() => {
    if (active === null || authority === null || draftsStore === null) return
    const record = draftsStore.load(authority, active)
    setDrafts((current) => (current[active] === undefined ? { ...current, [active]: record.active } : current))
    for (const attachment of record.active?.attachments ?? []) {
      if (attachment.state !== "ready" || attachment.stagingUploadId === undefined) {
        if (attachment.state === "ready" && attachment.stagingUploadId === undefined) {
          draftsStore.expireAttachment(authority, active, attachment.uploadId)
          setDrafts((current) => ({ ...current, [active]: draftsStore.load(authority, active).active }))
        }
        continue
      }
      void client
        .uploadStatus(attachment.stagingUploadId)
        .then((uploadState) => {
          if (uploadState.attachmentId === undefined) {
            draftsStore.expireAttachment(authority, active, attachment.stagingUploadId!)
            const refreshed = draftsStore.load(authority, active)
            setDrafts((current) => ({ ...current, [active]: refreshed.active }))
          }
        })
        .catch(() => {
          draftsStore.expireAttachment(authority, active, attachment.stagingUploadId!)
          setDrafts((current) => ({ ...current, [active]: draftsStore.load(authority, active).active }))
        })
    }
  }, [active, authority, client, draftsStore])

  useEffect(() => {
    setRenderFailureReporter(() => webClient.reportDiagnostic("web.render_failure", { "web.error_type": "component_error" }))
    setDraftFailureReporter(() =>
      webClient.reportDiagnostic("web.draft", { "web.operation": "save", "web.outcome": "unavailable" }),
    )
    return () => {
      setRenderFailureReporter(null)
      setDraftFailureReporter(null)
    }
  }, [webClient])

  useEffect(() => {
    if (active === null || authority === null || draftsStore === null) return
    const unsupported = draftsStore.unsupported(authority, active)
    setUnsupportedDrafts(unsupported)
    setRecoverables(draftsStore.candidates(authority, active).filter(isNonEmptyDraft))
    if (unsupported.length > 0) toast(`${unsupported.length} saved draft record(s) use an unsupported format.`)
  }, [active, authority, draftsStore])

  useEffect(() => {
    if (active === null) return
    if (semantic === undefined) void client.reloadSemantic(active).catch(() => {})
  }, [active, client, semantic])

  useEffect(() => {
    if (active === null || readEligible !== active || web.status !== "live" || currentView === "checkpoint") return
    const state = web.sessions[active]
    if (state === undefined || !state.unread) return
    void webClient
      .command({
        kind: "read.set",
        operationId: randomId(),
        sessionId: active,
        unread: false,
        generation: state.readGeneration,
      })
      .catch(() => {})
    setReadEligible(null)
  }, [active, currentView, readEligible, web, webClient])

  useEffect(() => {
    const key = active === null ? null : `${active}:${currentView}`
    pendingPinRef.current = false
    scrolledPinRef.current = null
    lastSeenUserIdRef.current = null
    setPinnedUserItemId(null)
    setElasticRoomPx(0)
    if (key === null || scroller.current === null) return
    const el = scroller.current
    el.scrollTop = scrolls.current[key] ?? 0
    return () => {
      scrolls.current[key] = el.scrollTop
    }
  }, [active, currentView])

  // Detect newly sent user messages in Chat and pin them near the top with elastic scroll room.
  // Key by the stable first message id (which survives the INPUT_RECEIVED -> RUN_STARTED transition).
  useEffect(() => {
    if (active === null || currentView !== "chat" || view === undefined) return
    let latestUser: UserItem | undefined
    for (let i = view.items.length - 1; i >= 0; i--) {
      const candidate = view.items[i]
      if (candidate !== undefined && candidate.kind === "user") {
        latestUser = candidate
        break
      }
    }
    const stableId = latestUser === undefined ? "" : (latestUser.messages[0]?.id ?? latestUser.id)
    const latestKey = latestUser === undefined ? "" : `${stableId}:${latestUser.messages.length}`
    if (lastSeenUserIdRef.current === null) {
      lastSeenUserIdRef.current = latestKey
      return
    }
    if (latestUser !== undefined && latestKey !== lastSeenUserIdRef.current) {
      lastSeenUserIdRef.current = latestKey
      if (pendingPinRef.current) {
        pendingPinRef.current = false
        scrolledPinRef.current = null
        setPinnedUserItemId(stableId)
      }
    }
  }, [active, currentView, view])

  // Keep elastic bottom room sized so the pinned user bubble stays near the top while the reply streams.
  useEffect(() => {
    if (pinnedUserItemId === null || currentView !== "chat") return
    const scrollerEl = scroller.current
    if (scrollerEl === null) return
    const topGap = 20

    const recompute = () => {
      const bubbleEl = scrollerEl.querySelector<HTMLElement>(`[data-user-message-id='${CSS.escape(pinnedUserItemId)}']`)
      const spacerEl = scrollerEl.querySelector<HTMLElement>("[data-slot='chat-extra-space']")
      if (bubbleEl === null || spacerEl === null) return
      const scrollerRect = scrollerEl.getBoundingClientRect()
      const bubbleRect = bubbleEl.getBoundingClientRect()
      const spacerRect = spacerEl.getBoundingClientRect()
      const headerHeight =
        scrollerEl.parentElement?.querySelector<HTMLElement>("[data-slot='workspace-header']")?.getBoundingClientRect().height ?? 80
      const effectiveTopInset = headerHeight + topGap
      const currentSpacerH = spacerRect.height
      const bubbleTopInContent = bubbleRect.top - scrollerRect.top + scrollerEl.scrollTop
      const spacerTopInContent = spacerRect.top - scrollerRect.top + scrollerEl.scrollTop
      const bottomAfterSpacer = Math.max(0, scrollerEl.scrollHeight - spacerTopInContent - currentSpacerH)
      const exchangeHeight = Math.max(0, spacerTopInContent - bubbleTopInContent)
      const nextRoom = Math.max(
        0,
        Math.ceil(scrollerEl.clientHeight - effectiveTopInset - bottomAfterSpacer - exchangeHeight),
      )

      // Apply synchronously to the spacer and flush layout before scrolling so maxScrollTop is already expanded.
      spacerEl.style.minHeight = `${nextRoom}px`
      setElasticRoomPx((current) => (Math.abs(current - nextRoom) <= 1 ? current : nextRoom))

      if (scrolledPinRef.current !== pinnedUserItemId) {
        scrolledPinRef.current = pinnedUserItemId
        void scrollerEl.offsetHeight
        const targetTop = Math.max(0, bubbleTopInContent - effectiveTopInset)
        scrollerEl.scrollTo({ top: targetTop, behavior: "smooth" })
      }
    }

    recompute()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(recompute)
    const transcriptEl = scrollerEl.querySelector<HTMLElement>("[data-slot='chat-transcript']")
    if (transcriptEl !== null) observer.observe(transcriptEl)
    observer.observe(scrollerEl)
    if (composerDockRef.current !== null) observer.observe(composerDockRef.current)
    return () => observer.disconnect()
  }, [currentView, pinnedUserItemId, view])

  useEffect(() => {
    const key = active === null ? null : `${active}:${currentView}`
    if (key === null || currentView === "checkpoint" || pinnedUserItemId !== null || pendingPinRef.current) return
    const el = scroller.current
    if (el !== null && el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
      el.scrollTop = el.scrollHeight
    }
  }, [view, semantic, active, currentView, pinnedUserItemId])

  useEffect(() => {
    const latestId = semantic?.latestSuccessfulBoundaryId ?? null
    if (latestId === null || active === null) {
      setCheckpoint(null)
      return
    }
    let cancelled = false
    void client
      .semanticBoundary(active, latestId)
      .then(async (manifest) => {
        if (cancelled) return
        const usage = await client.modelUsage(active, [manifest.modelCallId]).catch(() => [])
        if (!cancelled) setCheckpoint({ manifest, usage })
      })
      .catch(() => {
        if (!cancelled) setCheckpoint(null)
      })
    return () => {
      cancelled = true
    }
  }, [active, client, semantic?.latestSuccessfulBoundaryId])

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const cycle =
        shortcuts.viewModifier === "ctrl"
          ? event.ctrlKey || event.metaKey
          : event.altKey && !event.ctrlKey && !event.metaKey
      if (cycle && event.key.toLowerCase() === "i") {
        event.preventDefault()
        if (active === null) return
        const index = VIEWS.findIndex((entry) => entry.value === currentView)
        setSessionView(active, VIEWS[(index + 1) % VIEWS.length]!.value)
        return
      }
      if (event.key === "Escape" && !event.defaultPrevented) {
        if (rewindItem !== null) {
          event.preventDefault()
          setRewindItem(null)
          return
        }
        const target = event.target as HTMLElement | null
        if (target?.closest("select, [role='dialog'], [role='alertdialog'], [role='listbox'], [role='menu'], details[open]")) return
        if (active !== null) setSessionView(active, "chat")
        return
      }
      const target = event.target as HTMLElement | null
      if (!shortcuts.typeToFocus || event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return
      if (settingsOpen || rewindItem !== null) return
      if (target?.closest("input, textarea, select, button, a, [contenteditable='true'], [role='dialog'], [role='alertdialog']")) return
      const composer = document.querySelector<HTMLTextAreaElement>("[aria-label='Message']")
      if (composer === null) return
      composer.focus()
      const start = composer.selectionStart
      const end = composer.selectionEnd
      const next = composer.value.slice(0, start) + event.key + composer.value.slice(end)
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
      if (setter !== undefined) setter.call(composer, next)
      else composer.value = next
      composer.dispatchEvent(new Event("input", { bubbles: true }))
      composer.selectionStart = composer.selectionEnd = start + 1
      event.preventDefault()
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [active, currentView, rewindItem, setSessionView, settingsOpen, shortcuts])

  useEffect(() => {
    saveShortcutPreferences(shortcuts)
  }, [shortcuts])

  const openSession = (sessionId: string, attention: boolean) => {
    setMobileSidebarOpen(false)
    if (!sidebarPinned) setSidebarHoverOpen(false)
    void client.open(sessionId).catch(() => {})
    if (attention) {
      setSessionView(sessionId, "chat")
      setReadEligible(sessionId)
      requestAnimationFrame(() => document.querySelector("[data-attention]")?.scrollIntoView({ block: "center" }))
    } else {
      const next = views[sessionId] ?? savedViews()[sessionId] ?? "chat"
      setViews((current) => ({ ...current, [sessionId]: next }))
      if (next !== "checkpoint") setReadEligible(sessionId)
    }
  }

  const openSessionFromUrl = useCallback(
    async (sessionId: string) => {
      setMobileSidebarOpen(false)
      if (!sidebarPinned) setSidebarHoverOpen(false)
      try {
        await client.open(sessionId)
        const next = savedViews()[sessionId] ?? "chat"
        setViews((current) => (current[sessionId] === undefined ? { ...current, [sessionId]: next } : current))
        if (next !== "checkpoint") setReadEligible(sessionId)
      } catch (failure) {
        suppressPushRef.current = true
        client.close()
        if (window.location.pathname !== "/") {
          window.history.replaceState(null, "", "/")
        }
        toast.error(failure instanceof Error ? failure.message : "Session not found")
      }
    },
    [client, sidebarPinned],
  )

  // Hydrate direct `/sessions/<id>` URL navigation once the harness session list is ready.
  useEffect(() => {
    if (status !== "connected" || !sessionsLoaded || initialUrlHandledRef.current) return
    initialUrlHandledRef.current = true
    let returnPath: string | null = null
    try {
      returnPath = window.sessionStorage.getItem(SIGN_IN_RETURN_PATH_KEY)
      if (returnPath !== null) window.sessionStorage.removeItem(SIGN_IN_RETURN_PATH_KEY)
    } catch {}
    if (active !== null) return
    const directId = parseSessionPath(window.location.pathname)
    const savedId = directId === null && returnPath !== null ? parseSessionPath(returnPath) : null
    const targetId = directId ?? savedId
    if (targetId === null) return
    if (savedId !== null) {
      window.history.replaceState({ sessionId: targetId }, "", sessionPath(targetId))
    }
    suppressPushRef.current = true
    void openSessionFromUrl(targetId)
  }, [active, openSessionFromUrl, sessionsLoaded, status])

  // Follow browser Back / Forward navigation between sessions and the home screen.
  useEffect(() => {
    const onPopState = () => {
      const targetId = parseSessionPath(window.location.pathname)
      suppressPushRef.current = true
      if (targetId === null) {
        client.close()
      } else {
        void openSessionFromUrl(targetId)
      }
    }
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [client, openSessionFromUrl])

  // Keep the browser URL synchronized with the active session id.
  useEffect(() => {
    if (!initialUrlHandledRef.current) return
    const currentUrlId = parseSessionPath(window.location.pathname)
    if (suppressPushRef.current) {
      suppressPushRef.current = false
      if (active !== null && currentUrlId !== active) {
        window.history.replaceState({ sessionId: active }, "", sessionPath(active))
      }
      return
    }
    if (active !== null && currentUrlId !== active) {
      window.history.pushState({ sessionId: active }, "", sessionPath(active))
    } else if (active === null && currentUrlId !== null) {
      window.history.pushState(null, "", "/")
    }
  }, [active])

  const onCommand = (command: Parameters<WebStateClient["command"]>[0]) => {
    void webClient
      .command(command)
      .then((receipt) => {
        if (receipt.outcome !== "confirmed") {
          toast.error(receipt.message ?? `Operation ${receipt.outcome}`)
        } else if (command.kind === "organization.set" || command.kind === "file.manual") {
          const opId = command.operationId
          toast("Session updated", {
            action: {
              label: "Undo",
              onClick: () => {
                void webClient
                  .command({ kind: "undo", operationId: randomId(), undoOf: opId })
                  .then((undoReceipt) => {
                    if (undoReceipt.outcome !== "confirmed") toast.error(undoReceipt.message ?? "Undo refused")
                  })
                  .catch(() => {})
              },
            },
          })
        }
      })
      .catch((failure: unknown) =>
        toast.error(
          failure instanceof UncertainOperation
            ? `Uncertain: ${failure.operationId}`
            : failure instanceof Error
              ? failure.message
              : "Organization update failed",
        ),
      )
  }

  const onNew = () => {
    setMobileSidebarOpen(false)
    if (!sidebarPinned) setSidebarHoverOpen(false)
    setStarterDraft(createStarterDraft())
    if (active !== null) {
      client.close()
    } else if (window.location.pathname !== "/") {
      window.history.pushState(null, "", "/")
    }
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>("[aria-label='Message']")?.focus()
    })
  }

  const reveal = (target: string) => {
    if (active === null) return
    setSessionView(active, "session")
    requestAnimationFrame(() => {
      const separator = target.indexOf(":")
      if (separator <= 0) return
      const kind = target.slice(0, separator)
      const id = target.slice(separator + 1)
      if (kind === "session" || id === "") return
      const selector = kind === "tool" ? `[data-tool-id="${escapeAttr(id)}"]` : `[data-thought-id="${escapeAttr(id)}"]`
      document.querySelector(selector)?.scrollIntoView({ block: "center" })
    })
  }

  const handleToggleSidebar = () => {
    if (window.matchMedia("(max-width: 767px)").matches) {
      setMobileSidebarOpen((open) => !open)
    } else {
      setSidebarPinned((pinned) => !pinned)
    }
  }

  const openSettings = (tab: SettingsTab = "appearance") => {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }

  const session = active === null ? undefined : sessions.find((candidate) => candidate.id === active)
  const attentionCount = sessions.filter(
    (candidate) => web.sessions[candidate.id]?.needsHuman === true || (observations[candidate.id]?.attention.length ?? 0) > 0,
  ).length
  const activeTitle = active === null ? "" : sessionDisplayTitle(session, view, models, active)
  const viewCaughtUp = session !== undefined ? (view?.lastSeq ?? 0) >= session.lastSeq : view !== undefined
  const isEmptyChat =
    active !== null &&
    currentView === "chat" &&
    viewCaughtUp &&
    (view?.items.length ?? 0) === 0 &&
    (view?.pending.length ?? 0) === 0 &&
    (view?.permissions.length ?? 0) === 0 &&
    observation?.execution.activeTurnId == null

  const floatingVisible = !sidebarPinned && (sidebarHoverOpen || sidebarMenuOpen)

  // Track activity signature so newly streamed thoughts/tools float ActivityPreview to the top of SessionNotifications.
  const activitySignature = useMemo(() => {
    if (view === undefined) return `${active ?? ""}:empty`
    let thoughtSig = ""
    let toolSig = ""
    for (let i = view.items.length - 1; i >= 0; i--) {
      const item = view.items[i]
      if (item === undefined || item.kind !== "assistant") continue
      for (let j = item.parts.length - 1; j >= 0; j--) {
        const part = item.parts[j]
        if (part === undefined) continue
        if (thoughtSig === "" && part.type === "reasoning" && part.text.trim() !== "") {
          thoughtSig = `${part.id}:${part.text.length}`
        } else if (toolSig === "" && part.type === "tool") {
          toolSig = `${part.id}:${part.result?.outcome ?? (part.started ? "running" : "idle")}`
        }
        if (thoughtSig !== "" && toolSig !== "") break
      }
      if (thoughtSig !== "" && toolSig !== "") break
    }
    return `${active ?? ""}:${view.runId ?? ""}:${thoughtSig}:${toolSig}`
  }, [active, view])

  useEffect(() => {
    setComposerNotifications(null)
    notificationFirstSeen.current.clear()
    lastActivitySig.current = ""
    setActivityStamp(1)
  }, [active])

  useEffect(() => {
    if (lastActivitySig.current === "") {
      lastActivitySig.current = activitySignature
      return
    }
    if (lastActivitySig.current !== activitySignature) {
      lastActivitySig.current = activitySignature
      setActivityStamp(Date.now())
    }
  }, [activitySignature])

  const sessionNotifications = useMemo<ReadonlyArray<SessionNotificationEntry>>(() => {
    if (active === null) return []
    const seen = notificationFirstSeen.current
    const stamp = (id: string, explicit?: number): number => {
      if (explicit !== undefined && explicit > 0) return explicit
      const existing = seen.get(id)
      if (existing !== undefined) return existing
      const now = Date.now()
      seen.set(id, now)
      return now
    }

    const list: SessionNotificationEntry[] = [
      {
        id: "activity",
        kind: "activity",
        timestamp: activityStamp,
        view,
        onReveal: reveal,
      },
    ]

    if (observation?.execution.canResume === true) {
      list.push({
        id: "resume-turn",
        kind: "notice",
        tone: "info",
        timestamp: stamp("resume-turn"),
        message: "This session has a resumable turn ready to continue.",
        actionLabel: "Continue",
        onAction: () => void client.resumeSession().catch(() => {}),
      })
    }

    if (executionNotice !== null) {
      const id = `execution:${lastFailure?.id ?? executionNotice}`
      list.push({
        id,
        kind: "notice",
        tone: recovered === true ? "info" : "destructive",
        timestamp: stamp(id),
        message: executionNotice,
        actionLabel: "Reveal",
        onAction: () => {
          setSessionView(active, "chat")
          requestAnimationFrame(() => {
            if (lastFailure !== undefined) {
              document.querySelector(`[data-item-id="${escapeAttr(lastFailure.id)}"]`)?.scrollIntoView({ block: "center" })
            }
          })
        },
      })
    }

    const pendingInputs = view?.pending ?? []
    const peerPending = pendingInputs.filter((input) => input.sender.kind === "session")
    const userPending = pendingInputs.filter((input) => input.sender.kind !== "session")
    if (peerPending.length > 0) {
      const id = `pending-peers:${peerPending.length}`
      list.push({
        id,
        kind: "notice",
        tone: "info",
        timestamp: stamp(id),
        message: `${peerPending.length} developer notification(s) waiting`,
        actionLabel: "Reveal in Session",
        onAction: () => setSessionView(active, "session"),
      })
    }
    for (const input of userPending) {
      const id = `pending-user:${input.inputId}`
      list.push({
        id,
        kind: "notice",
        tone: "info",
        timestamp: stamp(id),
        badge: input.mode,
        message: input.text.trim() !== "" ? input.text.trim().slice(0, 120) : "Attachment-only message waiting",
        actionLabel: "Reveal",
        onAction: () => setSessionView(active, "session"),
      })
    }

    for (const candidate of recoverables) {
      const id = `recoverable-tab:${candidate.id}`
      const preview = candidate.text.trim()
      list.push({
        id,
        kind: "notice",
        tone: "warning",
        timestamp: stamp(id, candidate.updatedAt),
        message: "Recoverable draft from another tab",
        detail: preview !== "" ? `${preview.slice(0, 48)}${preview.length > 48 ? "…" : ""} · ${formatRelativeTime(candidate.updatedAt)}` : formatRelativeTime(candidate.updatedAt),
        actionLabel: "Recover",
        onAction: () => {
          if (authority === null || draftsStore === null) return
          draftsStore.recover(authority, active, candidate)
          const record = draftsStore.load(authority, active)
          setDrafts((current) => ({ ...current, [active]: record.active }))
          setRecoverables((current) => current.filter((entry) => entry.id !== candidate.id))
          setRecoveryTick((tick) => tick + 1)
          toast(
            record.active?.source === candidate.id
              ? "Recovered draft into this tab."
              : "Saved as a selectable recovery draft.",
          )
        },
        onDismiss: () => setRecoverables((current) => current.filter((entry) => entry.id !== candidate.id)),
      })
    }

    if (unsupportedDrafts.length > 0) {
      const id = `unsupported-drafts:${unsupportedDrafts.length}`
      list.push({
        id,
        kind: "notice",
        tone: "warning",
        timestamp: stamp(id),
        message: "Unsupported saved drafts are preserved locally.",
        actionLabel: "Export JSON",
        onAction: () => {
          const blob = new Blob([JSON.stringify(unsupportedDrafts, null, 2)], { type: "application/json" })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement("a")
          anchor.href = url
          anchor.download = `ashe-agent-drafts-${Date.now()}.json`
          anchor.click()
          URL.revokeObjectURL(url)
        },
      })
    }

    if (composerNotifications !== null) {
      if (composerNotifications.storageError !== null) {
        list.push({
          id: "composer-storage-error",
          kind: "notice",
          tone: "destructive",
          timestamp: stamp("composer-storage-error", composerNotifications.storageErrorTimestamp),
          message: composerNotifications.storageError,
          actionLabel: "Copy draft",
          onAction: composerNotifications.onCopyDraft,
        })
      }

      if (composerNotifications.statusText !== null) {
        const id = `composer-status:${composerNotifications.statusText}`
        list.push({
          id,
          kind: "notice",
          tone: composerNotifications.statusText.toLowerCase().includes("rejected") || composerNotifications.statusText.toLowerCase().includes("failed")
            ? "destructive"
            : "info",
          timestamp: stamp(id, composerNotifications.statusTimestamp),
          message: composerNotifications.statusText,
        })
      }

      for (const item of composerNotifications.unacceptedSubmissions) {
        const { submission, onRestore } = item
        const id = `submission:${submission.submissionId}:${submission.state}`
        const label =
          submission.state === "unknown"
            ? "Acceptance unknown"
            : submission.state === "rejected"
              ? "Submission rejected"
              : "Sending submission"
        list.push({
          id,
          kind: "notice",
          tone: submission.state === "rejected" ? "destructive" : "warning",
          timestamp: stamp(id, submission.createdAt),
          message: label,
          detail: submission.text.trim().slice(0, 60),
          ...(submission.state === "rejected" ? { actionLabel: "Restore", onAction: onRestore } : {}),
        })
      }

      for (const item of composerNotifications.inTabRecoverables) {
        const id = `recoverable-in-tab:${item.draft.id}`
        list.push({
          id,
          kind: "notice",
          tone: "info",
          timestamp: stamp(id, item.draft.updatedAt),
          message: "Saved recovery draft",
          detail: item.draft.text.trim().slice(0, 48),
          actionLabel: "Use draft",
          onAction: item.onUse,
        })
      }
    }

    if (web.status !== "live") {
      const id = `web-stale:${web.status}`
      list.push({
        id,
        kind: "notice",
        tone: web.status === "incompatible" ? "destructive" : "warning",
        timestamp: stamp(id),
        message: web.error ?? "Shared organization is stale",
        ...(web.status === "incompatible"
          ? { actionLabel: "Reload", onAction: () => window.location.reload() }
          : {}),
      })
    }

    return list.sort((a, b) => b.timestamp - a.timestamp)
  }, [
    active,
    activityStamp,
    authority,
    client,
    composerNotifications,
    draftsStore,
    executionNotice,
    lastFailure,
    observation?.execution.canResume,
    recoverables,
    recovered,
    setSessionView,
    unsupportedDrafts,
    view,
    web.error,
    web.status,
  ])

  return (
    <TooltipProvider delay={300}>
      <div className="bg-background text-foreground relative flex h-svh min-h-0 overflow-hidden">
        {clientError !== null && (
          <div role="alert" className="fixed inset-x-0 top-0 z-50 px-4 pt-2">
            <Alert variant="destructive" className="mx-auto max-w-xl shadow-md">
              <AlertDescription className="flex items-center justify-between gap-2">
                <span>{clientError}</span>
                <Button type="button" size="xs" variant="outline" onClick={() => client.signOut()}>
                  Sign in again
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        )}

        {sidebarPinned ? (
          <div className="hidden h-full md:flex">
            <Sidebar
              web={web}
              active={active}
              onOpen={openSession}
              onCommand={onCommand}
              onNew={onNew}
              onOpenSettings={() => openSettings("appearance")}
              pinned
              onTogglePin={() => setSidebarPinned(false)}
            />
          </div>
        ) : (
          <>
            <div
              data-slot="sidebar-hover-edge"
              aria-hidden="true"
              className="fixed inset-y-0 left-0 z-30 hidden w-3 md:block"
              onMouseEnter={openSidebarPeek}
            />
            {floatingVisible && (
              <div
                data-slot="sidebar-overlay"
                className="fixed inset-y-0 left-0 z-40 hidden shadow-xl md:flex"
                onMouseEnter={openSidebarPeek}
                onMouseLeave={scheduleSidebarPeekClose}
              >
                <Sidebar
                  web={web}
                  active={active}
                  onOpen={openSession}
                  onCommand={onCommand}
                  onNew={onNew}
                  onOpenSettings={() => {
                    setSidebarHoverOpen(false)
                    openSettings("appearance")
                  }}
                  pinned={false}
                  onTogglePin={() => {
                    setSidebarPinned(true)
                    setSidebarHoverOpen(false)
                  }}
                  onMenuOpenChange={handleSidebarMenuOpenChange}
                />
              </div>
            )}
          </>
        )}

        <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
          <SheetContent side="left" showCloseButton={false} className="w-[264px] p-0 sm:max-w-[264px]">
            <Sidebar
              web={web}
              active={active}
              onOpen={openSession}
              onCommand={onCommand}
              onNew={onNew}
              onOpenSettings={() => {
                setMobileSidebarOpen(false)
                openSettings("appearance")
              }}
              showPinControl={false}
              className="w-full border-e-0"
            />
          </SheetContent>
        </Sheet>

        {active === null ? (
          <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
            <div className={sidebarPinned ? "absolute start-3 top-2.5 z-20 flex items-center gap-2 md:hidden" : "absolute start-3 top-2.5 z-20 flex items-center gap-2"}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={sidebarPinned ? "Toggle sidebar" : "Dock sidebar"}
                      onClick={handleToggleSidebar}
                      onMouseEnter={() => {
                        if (!sidebarPinned) openSidebarPeek()
                      }}
                      onMouseLeave={() => {
                        if (!sidebarPinned) scheduleSidebarPeekClose()
                      }}
                    />
                  }
                >
                  {sidebarPinned ? <PanelLeftIcon className="size-4" /> : <PanelLeftDashedIcon className="size-4" />}
                </TooltipTrigger>
                <TooltipContent>{sidebarPinned ? "Toggle sidebar" : "Dock sidebar (hover to preview)"}</TooltipContent>
              </Tooltip>
              {!sidebarPinned && (
                <span
                  className="text-sidebar-primary text-[20px] leading-none tracking-tight select-none"
                  style={{ fontFamily: "var(--font-brand)" }}
                  aria-label="AsheAgent"
                >
                  AA
                </span>
              )}
            </div>
            <main
              data-slot="empty-session-stage"
              className="flex flex-1 flex-col items-center justify-center gap-6 px-4 pb-16"
            >
              <div className="flex items-center justify-center gap-3 text-center">
                <span
                  className="text-sidebar-primary text-[32px] leading-none tracking-tight select-none"
                  style={{ fontFamily: "var(--font-brand)" }}
                  aria-hidden="true"
                >
                  AA
                </span>
                <h2 className="text-[26px] font-normal tracking-tight text-foreground sm:text-[30px]">
                  Start a conversation
                </h2>
              </div>
              <Composer
                key="new-session"
                variant="centered"
                sessionId={null}
                draftStore={draftsStore}
                authority={authority}
                draft={starterDraft}
                onDraft={(next) => setStarterDraft(next ?? createStarterDraft())}
                view={undefined}
                observation={undefined}
                pending={[]}
                onCreateSession={async (selection) => {
                  const created = await client.createSession(selection)
                  setSessionView(created.id, "chat")
                  setReadEligible(created.id)
                  pendingPinRef.current = true
                  return created.id
                }}
                onCreateSessionError={(failure) => {
                  toast.error(failure instanceof Error ? failure.message : "Could not create session")
                }}
              />
            </main>
          </section>
        ) : (
          <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
            <WorkspaceHeader
              title={activeTitle}
              currentView={currentView}
              onViewChange={(next) => setSessionView(active, next)}
              notifications={sessionNotifications}
              semanticEntries={semantic?.entries ?? []}
              checkpointManifest={checkpoint?.manifest ?? null}
              checkpointUsage={checkpoint?.usage ?? []}
              sidebarPinned={sidebarPinned}
              onToggleSidebar={handleToggleSidebar}
              onSidebarPeekStart={openSidebarPeek}
              onSidebarPeekEnd={scheduleSidebarPeekClose}
              attentionCount={attentionCount}
              needsHuman={web.sessions[active]?.needsHuman === true}
              shortcuts={shortcuts}
            />

            <div
              ref={scroller}
              className="scrollbar-main relative flex h-full min-h-0 flex-1 flex-col overflow-y-auto pt-20 scroll-pt-24"
              data-view={currentView}
              onScroll={(event) => {
                const el = event.currentTarget
                setShowScrollBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 220)
              }}
            >
              {isEmptyChat ? (
                <div
                  data-slot="empty-session-stage"
                  className="flex flex-1 flex-col items-center justify-center gap-6 px-4 pb-16"
                >
                  <div className="flex items-center justify-center gap-3 text-center">
                    <span
                      className="text-sidebar-primary text-[32px] leading-none tracking-tight select-none"
                      style={{ fontFamily: "var(--font-brand)" }}
                      aria-hidden="true"
                    >
                      AA
                    </span>
                    <h2 className="text-[26px] font-normal tracking-tight text-foreground sm:text-[30px]">
                      Start a conversation
                    </h2>
                  </div>

                  <Composer
                    key={`${active}:${recoveryTick}`}
                    variant="centered"
                    sessionId={active}
                    draftStore={draftsStore}
                    authority={authority}
                    draft={draft}
                    onDraft={(next) => setDrafts((current) => ({ ...current, [active]: next }))}
                    view={view}
                    observation={observation}
                    pending={view?.pending ?? []}
                    onNotificationsChange={setComposerNotifications}
                    onMessageSent={() => {
                      pendingPinRef.current = true
                      if (currentView !== "chat") setSessionView(active, "chat")
                    }}
                  />
                </div>
              ) : (
                <>
                  <div className="flex-1 pb-6">
                    {currentView === "chat" && (
                      <Chat
                        view={view ?? emptyViewLike(active)}
                        observation={observation}
                        elasticRoomPx={elasticRoomPx}
                        onRewind={(item) => {
                          rewindOperation.current = randomId()
                          setRewindItem(item)
                        }}
                        onEdit={async (item, text) => {
                          if (item.runId === null) return false
                          const operationId = randomId()
                          const selection = draft === null ? {} : draft.selection
                          pendingPinRef.current = true
                          try {
                            await client.rewind(
                              item.runId,
                              text,
                              operationId,
                              Object.keys(selection).length === 0 ? undefined : selection,
                            )
                            if (draft !== null) {
                              const cleared = { ...draft, selection: {}, updatedAt: Date.now() }
                              setDrafts((current) => ({ ...current, [active]: cleared }))
                              if (authority !== null && draftsStore !== null) {
                                draftsStore.save(authority, active, {
                                  text: cleared.text,
                                  mode: cleared.mode,
                                  selection: {},
                                  attachments: cleared.attachments,
                                })
                              }
                            }
                            return true
                          } catch (failure: unknown) {
                            const result = await client.historyResult(active, operationId).catch(() => null)
                            if (result?.kind === "observed") return true
                            pendingPinRef.current = false
                            toast.error(failure instanceof Error ? failure.message : "Edit failed; your changes are kept")
                            return false
                          }
                        }}
                        onFork={(item) => {
                          void client
                            .fork(item.runId!)
                            .then((fork) => {
                              setSessionView(fork.id, "chat")
                              setReadEligible(fork.id)
                            })
                            .catch((failure: unknown) => toast.error(failure instanceof Error ? failure.message : "Fork failed"))
                        }}
                      />
                    )}
                    {currentView === "session" && (
                      <SessionNotebook
                        entries={semantic?.entries ?? []}
                        onOpenSession={(sessionId) => openSession(sessionId, false)}
                      />
                    )}
                    {currentView === "checkpoint" && (
                      <Checkpoint
                        manifest={checkpoint?.manifest ?? null}
                        entries={semantic?.entries ?? []}
                        onOpenSession={(sessionId) => openSession(sessionId, false)}
                      />
                    )}
                  </div>

                  <div ref={composerDockRef} className="pointer-events-none sticky bottom-0 z-10 mt-auto w-full pt-6">
                    {showScrollBottom && currentView !== "checkpoint" && (
                      <button
                        type="button"
                        aria-label="Scroll to latest"
                        className="bg-background/80 hover:bg-accent/80 border-border/80 text-foreground pointer-events-auto absolute -top-3 left-1/2 z-20 inline-flex size-9 -translate-x-1/2 items-center justify-center rounded-full border shadow-md backdrop-blur-sm transition-all hover:shadow-lg"
                        onClick={() => {
                          const el = scroller.current
                          if (el !== null) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
                        }}
                      >
                        <ArrowDownIcon className="size-4" />
                      </button>
                    )}

                    <Composer
                      key={`${active}:${recoveryTick}`}
                      sessionId={active}
                      draftStore={draftsStore}
                      authority={authority}
                      draft={draft}
                      onDraft={(next) => setDrafts((current) => ({ ...current, [active]: next }))}
                      view={view}
                      observation={observation}
                      pending={view?.pending ?? []}
                      onNotificationsChange={setComposerNotifications}
                      onMessageSent={() => {
                        pendingPinRef.current = true
                        if (currentView !== "chat") setSessionView(active, "chat")
                      }}
                    />
                  </div>
                </>
              )}
            </div>

            <RewindDialog
              item={rewindItem}
              removedTurns={(view?.items ?? []).flatMap((item) =>
                item.kind === "user" && rewindItem !== null && item.seq >= rewindItem.seq
                  ? item.messages.map((message) => message.text)
                  : [],
              )}
              pendingInputs={(view?.pending ?? []).map((input) => input.text)}
              attachments={(semantic?.entries ?? []).flatMap((entry) =>
                entry.entry.kind === "user" && rewindItem !== null && entry.entry.turnId === rewindItem.runId
                  ? entry.entry.parts.flatMap((part) => (part.kind === "attachment" ? [part.name] : []))
                  : [],
              )}
              onCancel={() => setRewindItem(null)}
              onSubmit={(text) => {
                if (rewindItem === null) return
                const selection = draft === null ? {} : draft.selection
                void client
                  .rewind(
                    rewindItem.runId!,
                    text,
                    rewindOperation.current,
                    Object.keys(selection).length === 0 ? undefined : selection,
                  )
                  .then(() => {
                    setRewindItem(null)
                    if (draft !== null) {
                      const cleared = { ...draft, selection: {}, updatedAt: Date.now() }
                      setDrafts((current) => ({ ...current, [active]: cleared }))
                      if (authority !== null && draftsStore !== null) {
                        draftsStore.save(authority, active, {
                          text: cleared.text,
                          mode: cleared.mode,
                          selection: {},
                          attachments: cleared.attachments,
                        })
                      }
                    }
                  })
                  .catch(async (failure: unknown) => {
                    const result = await client.historyResult(active, rewindOperation.current).catch(() => null)
                    if (result?.kind === "observed") {
                      setRewindItem(null)
                      return
                    }
                    toast.error(failure instanceof Error ? failure.message : "Rewind failed; the edit is kept")
                  })
              }}
            />
          </section>
        )}

        <SettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          initialTab={settingsTab}
          shortcuts={shortcuts}
          onShortcutsChange={setShortcuts}
          activeSessionId={active}
          session={session}
          view={view}
          onNotify={notify}
        />

        <Toaster theme={theme.resolvedTheme} position="bottom-right" />
      </div>
    </TooltipProvider>
  )
}

export const App = () => {
  const signedIn = useClientState((state) => state.status !== "signedOut" && state.principal !== null)
  const client = useClient()
  const [webClient] = useState(
    () =>
      new WebStateClient(
        new URL("/v1/web-state", window.location.origin).href,
        () => client.accessToken(),
        () => client.renewAccessToken(),
      ),
  )
  useEffect(() => {
    if (!signedIn) {
      webClient.stop()
      return
    }
    webClient.start()
    return () => webClient.stop()
  }, [signedIn, webClient])
  return signedIn ? <Workspace webClient={webClient} /> : <SignIn />
}

export default App

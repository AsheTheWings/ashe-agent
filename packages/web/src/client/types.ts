import type { SessionSummary } from "@ashe-agent/protocol"
import type { SessionView } from "../session/projection.ts"

export type ViewName = "chat" | "session" | "checkpoint"

export const VIEWS: ReadonlyArray<{ readonly value: ViewName; readonly label: string; readonly description: string }> = [
  { value: "chat", label: "Chat", description: "Conversation with inline questions and approvals" },
  { value: "session", label: "Session", description: "Canonical timeline with tools, thoughts, and provenance" },
  { value: "checkpoint", label: "Checkpoint window", description: "Latest model-input boundary, token breakdown, and usage" },
]

const VIEW_KEY = "ashe-agent.web.views.v1"
export const PREFS_KEY = "ashe-agent.web.new-session.v1"
const SHORTCUTS_KEY = "ashe-agent.web.shortcuts.v1"
const SIDEBAR_PINNED_KEY = "ashe-agent.web.sidebar-pinned.v1"

export const loadSidebarPinned = (): boolean => {
  try {
    return window.localStorage.getItem(SIDEBAR_PINNED_KEY) !== "false"
  } catch {
    return true
  }
}

export const saveSidebarPinned = (pinned: boolean): void => {
  try {
    window.localStorage.setItem(SIDEBAR_PINNED_KEY, pinned ? "true" : "false")
  } catch {
    // Preference still applies for this tab when storage is blocked.
  }
}

export type ShortcutPreferences = {
  readonly viewModifier: "ctrl" | "alt"
  readonly typeToFocus: boolean
}

export const loadShortcutPreferences = (): ShortcutPreferences => {
  try {
    const value = JSON.parse(window.localStorage.getItem(SHORTCUTS_KEY) ?? "null") as Partial<ShortcutPreferences> | null
    return {
      viewModifier: value?.viewModifier === "alt" ? "alt" : "ctrl",
      typeToFocus: value?.typeToFocus !== false,
    }
  } catch {
    return { viewModifier: "ctrl", typeToFocus: true }
  }
}

export const saveShortcutPreferences = (prefs: ShortcutPreferences): void => {
  try {
    window.localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(prefs))
  } catch {
    // Preferences still apply for this tab when storage is blocked.
  }
}

export const savedViews = (): Record<string, ViewName> => {
  try {
    return JSON.parse(window.localStorage.getItem(VIEW_KEY) ?? "{}") as Record<string, ViewName>
  } catch {
    return {}
  }
}

export const saveView = (sessionId: string, view: ViewName): void => {
  try {
    window.localStorage.setItem(VIEW_KEY, JSON.stringify({ ...savedViews(), [sessionId]: view }))
  } catch {
    // The view still works for this page; only the next session's default is lost.
  }
}

export const formatFullTime = (value: number): string => new Date(value).toLocaleString()

export const formatRelativeTime = (value: number, now = Date.now()): string => {
  const diff = Math.max(0, now - value)
  const seconds = Math.floor(diff / 1000)
  if (seconds < 45) return "Just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return "Yesterday"
  if (days < 7) return `${days}d ago`
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const decodeBase64 = (value: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(value), (character) => character.charCodeAt(0)))

/** Generates an RFC 4122 v4 UUID using randomUUID when available, else getRandomValues. */
export const randomId = (): `${string}-${string}-${string}-${string}-${string}` => {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const firstUserMessagePreview = (view: SessionView | undefined): string | null => {
  if (view === undefined) return null
  for (const item of view.items) {
    if (item.kind !== "user") continue
    for (const message of item.messages) {
      const line = message.text.trim().split(/\r?\n/)[0]?.trim() ?? ""
      if (line !== "") return line.length > 72 ? `${line.slice(0, 72)}…` : line
    }
  }
  return null
}

export const sessionDisplayTitle = (
  session: SessionSummary | undefined,
  view: SessionView | undefined,
  models: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  fallbackId: string,
): string => {
  const firstMessage = firstUserMessagePreview(view)
  if (firstMessage !== null) return firstMessage
  if (session !== undefined && session.identity.agentTitle !== "untitled") {
    return session.identity.agentTitle
  }
  const modelId = session?.selection.modelSettings.modelId ?? view?.model ?? null
  if (modelId !== null) {
    const known = models.find((candidate) => candidate.id === modelId)
    if (known !== undefined) return known.name
    const leaf = modelId.split("/").at(-1)
    if (leaf !== undefined && leaf !== "") return leaf
    return modelId
  }
  return session?.id ?? fallbackId
}

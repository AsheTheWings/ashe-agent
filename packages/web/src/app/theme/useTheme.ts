import { useSyncExternalStore } from "react"
import { applyThemeColorPreview, applyThemePalette, resolveThemeAppearance, syncBrowserChromeTheme } from "./paint.ts"
import { getThemeColorsForMode, getThemeDefinition, isKnownThemePreference, parseThemeHalves, resolveThemeHalf, subscribeToCustomThemes, type ThemeAppearance, type ThemeHalves, type ThemePreference, type ThemePreferenceMode } from "./library.ts"
import type { ThemeColors } from "./palettes.ts"

export const THEME_STORAGE_KEY = "ashe-agent.web.theme.v1"
const THEME_APPEARANCE_MODE_STORAGE_KEY = "ashe-agent.web.theme-appearance-mode.v1"
const THEME_HALVES_STORAGE_KEY = "ashe-agent.web.theme-halves.v1"
const MEDIA_QUERY = "(prefers-color-scheme: dark)"

export type ThemeSnapshot = {
  theme: ThemePreference
  resolvedTheme: ThemeAppearance
  systemDark: boolean
  appearanceMode: ThemePreferenceMode
  halves: ThemeHalves | null
}

const DEFAULT_THEME_SNAPSHOT: ThemeSnapshot = {
  theme: "system",
  resolvedTheme: "light",
  systemDark: false,
  appearanceMode: "system",
  halves: null,
}

const previewListeners = new Set<() => void>()
let themePreviewAppearance: ThemeAppearance | null = null

export const getThemePreviewAppearance = (): ThemeAppearance | null => themePreviewAppearance

export const subscribeToThemePreview = (listener: () => void): (() => void) => {
  previewListeners.add(listener)
  return () => { previewListeners.delete(listener) }
}

const setThemePreviewAppearance = (appearance: ThemeAppearance | null): void => {
  if (themePreviewAppearance === appearance) return
  themePreviewAppearance = appearance
  for (const listener of previewListeners) listener()
}

/** Previews draft colors on the document. Call clearThemePreview to restore the stored theme. */
export const previewThemeColors = (colors: ThemeColors, appearance: ThemeAppearance): void => {
  applyThemeColorPreview(colors, appearance)
  setThemePreviewAppearance(appearance)
}

export const clearThemePreview = (): void => {
  setThemePreviewAppearance(null)
  refreshTheme()
}

let listeners: Array<() => void> = []
let lastSnapshot: ThemeSnapshot | null = null
let snapshotStale = true
let lastAppliedTheme: Omit<ThemeSnapshot, "resolvedTheme"> | null = null

const emitChange = (): void => {
  snapshotStale = true
  for (const listener of listeners) listener()
}

const getSystemDark = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(MEDIA_QUERY).matches

const isThemePreferenceMode = (value: string | null): value is ThemePreferenceMode =>
  value === "light" || value === "dark" || value === "system"

export const readAppearanceModePreference = (theme: ThemePreference): ThemePreferenceMode => {
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(THEME_APPEARANCE_MODE_STORAGE_KEY)
      if (isThemePreferenceMode(raw)) return raw
    } catch {
      // Blocked storage keeps the in-memory default for this page.
    }
  }
  return theme === "light" || theme === "dark" ? theme : "system"
}

const writeAppearanceModePreference = (appearanceMode: ThemePreferenceMode): boolean => {
  if (typeof window === "undefined") return true
  try {
    window.localStorage.setItem(THEME_APPEARANCE_MODE_STORAGE_KEY, appearanceMode)
    return true
  } catch {
    return false
  }
}

export const readThemePreference = (): ThemePreference => {
  if (typeof window === "undefined") return DEFAULT_THEME_SNAPSHOT.theme
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (raw !== null && isKnownThemePreference(raw)) return raw
  } catch {
    // Blocked storage falls back to the stock theme for this page.
  }
  return DEFAULT_THEME_SNAPSHOT.theme
}

const writeThemePreference = (theme: ThemePreference): boolean => {
  if (typeof window === "undefined") return true
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
    return true
  } catch {
    return false
  }
}

export const readStoredThemeHalves = (): ThemeHalves | null => {
  if (typeof window === "undefined") return null
  try {
    return parseThemeHalves(window.localStorage.getItem(THEME_HALVES_STORAGE_KEY))
  } catch {
    return null
  }
}

const themeHalvesSignature = (halves: ThemeHalves | null): string => `${halves?.light ?? ""}|${halves?.dark ?? ""}`

const applyTheme = (theme: ThemePreference, { suppressTransitions = false, preservePreview = true } = {}): void => {
  if (typeof document === "undefined" || typeof window === "undefined") return
  if (preservePreview && document.documentElement.dataset?.themeId === "__preview") return
  const appearanceMode = readAppearanceModePreference(theme)
  const systemDark = appearanceMode === "system" ? getSystemDark() : false
  const halves = readStoredThemeHalves()
  if (
    lastAppliedTheme?.theme === theme &&
    lastAppliedTheme.systemDark === systemDark &&
    lastAppliedTheme.appearanceMode === appearanceMode &&
    themeHalvesSignature(lastAppliedTheme.halves) === themeHalvesSignature(halves)
  ) {
    syncBrowserChromeTheme()
    return
  }
  if (suppressTransitions) document.documentElement.classList.add("no-transitions")
  const resolvedAppearance = resolveThemeAppearance(theme, systemDark, appearanceMode, halves)
  applyThemePalette(resolveThemeHalf(theme, halves, resolvedAppearance), resolvedAppearance)
  document.documentElement.classList.toggle("dark", resolvedAppearance === "dark")
  document.documentElement.style.colorScheme = resolvedAppearance
  lastAppliedTheme = { theme, systemDark, appearanceMode, halves }
  syncBrowserChromeTheme()
  if (suppressTransitions) {
    void document.documentElement.offsetHeight
    requestAnimationFrame(() => document.documentElement.classList.remove("no-transitions"))
  }
}

/** Re-reads storage and repaints. Call after custom themes change or a preview closes. */
export const refreshTheme = ({ preservePreview = false } = {}): void => {
  lastAppliedTheme = null
  applyTheme(readThemePreference(), { suppressTransitions: true, preservePreview })
  emitChange()
}

const handleSystemAppearanceChange = (): void => {
  if (readAppearanceModePreference(readThemePreference()) === "system") {
    lastAppliedTheme = null
    applyTheme(readThemePreference(), { suppressTransitions: true })
  }
  emitChange()
}

const handleStorageChange = (event: StorageEvent): void => {
  if (event.key === THEME_STORAGE_KEY || event.key === THEME_APPEARANCE_MODE_STORAGE_KEY || event.key === THEME_HALVES_STORAGE_KEY) {
    lastAppliedTheme = null
    applyTheme(readThemePreference(), { suppressTransitions: true })
    emitChange()
  }
}

const handleCustomThemesChange = (): void => {
  lastAppliedTheme = null
  applyTheme(readThemePreference(), { suppressTransitions: true })
  emitChange()
}

const subscribe = (listener: () => void): (() => void) => {
  if (typeof window === "undefined") return () => {}
  listeners.push(listener)
  return () => {
    listeners = listeners.filter((kept) => kept !== listener)
  }
}

const getSnapshot = (): ThemeSnapshot => {
  if (typeof window === "undefined") return DEFAULT_THEME_SNAPSHOT
  if (!snapshotStale && lastSnapshot) return lastSnapshot
  snapshotStale = false
  const theme = readThemePreference()
  const appearanceMode = readAppearanceModePreference(theme)
  const systemDark = appearanceMode === "system" ? getSystemDark() : false
  const halves = readStoredThemeHalves()
  const resolvedTheme = resolveThemeAppearance(theme, systemDark, appearanceMode, halves)
  if (
    lastSnapshot &&
    lastSnapshot.theme === theme &&
    lastSnapshot.resolvedTheme === resolvedTheme &&
    lastSnapshot.systemDark === systemDark &&
    lastSnapshot.appearanceMode === appearanceMode &&
    themeHalvesSignature(lastSnapshot.halves) === themeHalvesSignature(halves)
  ) {
    return lastSnapshot
  }
  lastSnapshot = { theme, resolvedTheme, systemDark, appearanceMode, halves }
  return lastSnapshot
}

const getServerSnapshot = (): ThemeSnapshot => DEFAULT_THEME_SNAPSHOT

export const useTheme = (): ThemeSnapshot => useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

export const getRenderedAppearance = (): ThemeAppearance => getThemePreviewAppearance() ?? getSnapshot().resolvedTheme

/** Selects a whole theme. A whole theme replaces the light/dark mix. Fails closed when storage is blocked. */
export const setTheme = (next: ThemePreference): boolean => {
  if (typeof window === "undefined") return false
  if (next !== "light" && next !== "dark" && next !== "system" && getThemeDefinition(next) === null) return false
  const previousHalvesRaw = (() => {
    try {
      return window.localStorage.getItem(THEME_HALVES_STORAGE_KEY)
    } catch {
      return null
    }
  })()
  let stored = false
  try {
    writeAppearanceModePreference(readAppearanceModePreference(next))
    window.localStorage.removeItem(THEME_HALVES_STORAGE_KEY)
    stored = writeThemePreference(next)
    if (!stored && previousHalvesRaw !== null) {
      try {
        window.localStorage.setItem(THEME_HALVES_STORAGE_KEY, previousHalvesRaw)
      } catch {
        // The mix is already cleared; the stored theme still applies without it.
      }
    }
  } catch {
    stored = false
  }
  lastAppliedTheme = null
  applyTheme(next, { suppressTransitions: true })
  setThemePreviewAppearance(null)
  emitChange()
  return stored
}

export const setAppearanceMode = (nextAppearanceMode: ThemePreferenceMode): boolean => {
  if (typeof window === "undefined") return false
  const stored = writeAppearanceModePreference(nextAppearanceMode)
  lastAppliedTheme = null
  applyTheme(readThemePreference(), { suppressTransitions: true })
  emitChange()
  return stored
}

/** Pins one theme to one appearance of the mix. Single-appearance themes cannot split the mix. */
export const setThemeHalf = (appearance: ThemeAppearance, theme: ThemePreference | null): boolean => {
  if (typeof window === "undefined") return false
  if (theme !== null) {
    const definition = getThemeDefinition(theme)
    if (definition === null || getThemeColorsForMode(definition, appearance) === null) return false
  }
  try {
    const halves = readStoredThemeHalves()
    const next: { light?: string; dark?: string } = { ...halves }
    if (theme === null) delete next[appearance]
    else next[appearance] = theme
    if (next.light === undefined && next.dark === undefined) window.localStorage.removeItem(THEME_HALVES_STORAGE_KEY)
    else window.localStorage.setItem(THEME_HALVES_STORAGE_KEY, JSON.stringify(next))
  } catch {
    return false
  }
  lastAppliedTheme = null
  applyTheme(readThemePreference(), { suppressTransitions: true })
  emitChange()
  return true
}

/** Paints before first render so a stored theme never flashes the stock palette. */
let themeListenersInstalled = false

export const initTheme = (): void => {
  if (typeof document === "undefined" || typeof window === "undefined") return
  applyTheme(readThemePreference(), { suppressTransitions: true, preservePreview: false })
  if (themeListenersInstalled) return
  themeListenersInstalled = true
  const media = typeof window.matchMedia === "function" ? window.matchMedia(MEDIA_QUERY) : null
  media?.addEventListener("change", handleSystemAppearanceChange)
  window.addEventListener("storage", handleStorageChange)
  subscribeToCustomThemes(handleCustomThemesChange)
}

export const resetThemeForTests = (): void => {
  lastSnapshot = null
  lastAppliedTheme = null
  snapshotStale = true
  listeners = []
  setThemePreviewAppearance(null)
}

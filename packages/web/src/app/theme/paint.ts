import { isThemeColor } from "./color.ts"
import { getThemeColorsForMode, getThemeDefinition, type ThemeAppearance, type ThemeColorRole, type ThemeColors, type ThemePreference, type ThemePreferenceMode } from "./library.ts"
import type { ThemeHalves } from "./library.ts"
import { THEME_COLOR_ROLES } from "./palettes.ts"

export const THEME_PREVIEW_ID = "__preview"

const APP_THEME_VARIABLES: Readonly<Record<ThemeColorRole, string>> = {
  canvas: "--app-theme-canvas",
  chrome: "--app-theme-chrome",
  toolbar: "--app-theme-toolbar",
  toolbarForeground: "--app-theme-toolbar-foreground",
  toolbarBorder: "--app-theme-toolbar-border",
  toolbarControl: "--app-theme-toolbar-control",
  toolbarControlForeground: "--app-theme-toolbar-control-foreground",
  toolbarControlHover: "--app-theme-toolbar-control-hover",
  surface: "--app-theme-surface",
  surfaceRaised: "--app-theme-surface-raised",
  surfaceOverlay: "--app-theme-surface-overlay",
  text: "--app-theme-text",
  textMuted: "--app-theme-text-muted",
  border: "--app-theme-border",
  input: "--app-theme-input",
  focus: "--app-theme-focus",
  accent: "--app-theme-accent",
  accentForeground: "--app-theme-accent-foreground",
  secondary: "--app-theme-secondary",
  secondaryForeground: "--app-theme-secondary-foreground",
  muted: "--app-theme-muted",
  mutedForeground: "--app-theme-muted-foreground",
  placeholder: "--app-theme-placeholder",
  secondaryLabel: "--app-theme-secondary-label",
  iconMuted: "--app-theme-icon-muted",
  error: "--app-theme-error",
  errorForeground: "--app-theme-error-foreground",
  errorSurface: "--app-theme-error-surface",
  warning: "--app-theme-warning",
  warningForeground: "--app-theme-warning-foreground",
  warningSurface: "--app-theme-warning-surface",
  update: "--app-theme-update",
  updateForeground: "--app-theme-update-foreground",
  updateSurface: "--app-theme-update-surface",
  accentSurface: "--app-theme-accent-surface",
  accentSurfaceForeground: "--app-theme-accent-surface-foreground",
  messageSurface: "--app-theme-message-surface",
  messageForeground: "--app-theme-message-foreground",
  messageAction: "--app-theme-message-action",
  messageActionForeground: "--app-theme-message-action-foreground",
  messageActionHover: "--app-theme-message-action-hover",
  codeBackground: "--app-theme-code-background",
  codeForeground: "--app-theme-code-foreground",
  searchMatchBackground: "--app-theme-search-match-background",
  searchMatchForeground: "--app-theme-search-match-foreground",
  searchMatchActiveBackground: "--app-theme-search-match-active-background",
  searchMatchActiveForeground: "--app-theme-search-match-active-foreground",
  sidebar: "--app-theme-sidebar",
  sidebarForeground: "--app-theme-sidebar-foreground",
  sidebarMutedForeground: "--app-theme-sidebar-muted-foreground",
  sidebarControlSurface: "--app-theme-sidebar-control-surface",
  sidebarRowHover: "--app-theme-sidebar-row-hover",
  sidebarRowActive: "--app-theme-sidebar-row-active",
  sidebarRowSelected: "--app-theme-sidebar-row-selected",
  sidebarBorder: "--app-theme-sidebar-border",
  terminalBackground: "--app-theme-terminal-background",
  terminalForeground: "--app-theme-terminal-foreground",
  terminalCursor: "--app-theme-terminal-cursor",
  terminalSelection: "--app-theme-terminal-selection-background",
  terminalScrollbar: "--app-theme-terminal-scrollbar",
  terminalScrollbarHover: "--app-theme-terminal-scrollbar-hover",
}

/** Maps the component tokens in index.css onto theme roles so themed palettes repaint the client. */
const COMPONENT_VARIABLES: ReadonlyArray<readonly [variable: string, role: ThemeColorRole]> = [
  ["--background", "canvas"],
  ["--foreground", "text"],
  ["--card", "surfaceRaised"],
  ["--card-foreground", "text"],
  ["--popover", "surfaceOverlay"],
  ["--popover-foreground", "text"],
  ["--primary", "messageAction"],
  ["--primary-foreground", "messageActionForeground"],
  ["--secondary", "secondary"],
  ["--secondary-foreground", "secondaryForeground"],
  ["--muted", "muted"],
  ["--muted-foreground", "mutedForeground"],
  ["--accent", "accentSurface"],
  ["--accent-foreground", "accentSurfaceForeground"],
  ["--destructive", "error"],
  ["--border", "border"],
  ["--input", "input"],
  ["--ring", "focus"],
  ["--sidebar", "sidebar"],
  ["--sidebar-foreground", "sidebarForeground"],
  ["--sidebar-primary", "accent"],
  ["--sidebar-primary-foreground", "accentForeground"],
  ["--sidebar-accent", "accentSurface"],
  ["--sidebar-accent-foreground", "accentSurfaceForeground"],
  ["--sidebar-border", "sidebarBorder"],
  ["--sidebar-ring", "focus"],
]

export const getThemeColorVariable = (role: ThemeColorRole): string => APP_THEME_VARIABLES[role] ?? `--app-theme-${role}`

const paintVariables = (root: HTMLElement, colors: ThemeColors): void => {
  for (const role of THEME_COLOR_ROLES) {
    const value = colors[role]
    if (isThemeColor(value)) root.style.setProperty(getThemeColorVariable(role), value)
  }
  for (const [variable, role] of COMPONENT_VARIABLES) {
    const value = colors[role]
    if (isThemeColor(value)) root.style.setProperty(variable, value)
  }
}

const clearPaintedVariables = (root: HTMLElement): void => {
  delete root.dataset.themeId
  const variables = new Set<string>([...Object.values(APP_THEME_VARIABLES), ...COMPONENT_VARIABLES.map(([variable]) => variable)])
  for (const variable of variables) root.style.removeProperty(variable)
}

/** Callers must restore the stored theme with refreshTheme when the draft closes. */
export const applyThemeColorPreview = (colors: ThemeColors, appearance: ThemeAppearance): void => {
  if (typeof document === "undefined") return
  const root = document.documentElement
  if (!root?.style) return
  root.dataset.themeId = THEME_PREVIEW_ID
  root.classList.toggle("dark", appearance === "dark")
  paintVariables(root, colors)
}

/** Paints a named theme for one appearance. Stock light/dark/system clear overrides back to index.css. */
export const applyThemePalette = (theme: ThemePreference, appearance: ThemeAppearance): void => {
  if (typeof document === "undefined") return
  const root = document.documentElement
  if (!root?.style) return
  if (theme === "light" || theme === "dark" || theme === "system") {
    clearPaintedVariables(root)
    return
  }
  const definition = getThemeDefinition(theme)
  if (definition === null) {
    clearPaintedVariables(root)
    return
  }
  root.dataset.themeId = definition.id
  paintVariables(root, getThemeColorsForMode(definition, appearance) ?? definition.colors)
}

/** Resolves which appearance a preference paints: explicit modes win, system follows the OS, single-appearance themes stay put. */
export const resolveThemeAppearance = (
  theme: ThemePreference,
  systemDark: boolean,
  appearanceMode?: ThemePreferenceMode,
  halves?: ThemeHalves | null,
): ThemeAppearance => {
  const systemAppearance: ThemeAppearance = systemDark ? "dark" : "light"
  const mode = appearanceMode ?? "system"
  if (mode === "system") {
    if (halves?.[systemAppearance] !== undefined) return systemAppearance
    const definition = getThemeDefinition(theme)
    if (definition === null) return systemAppearance
    return getThemeColorsForMode(definition, systemAppearance) === null ? definition.appearance : systemAppearance
  }
  if (halves?.[mode] !== undefined) return mode
  const definition = getThemeDefinition(theme)
  if (definition === null) return mode
  return getThemeColorsForMode(definition, mode) === null ? definition.appearance : mode
}

const THEME_COLOR_META_NAME = "theme-color"

/** Keeps the browser chrome and overscroll sampling the painted surface. */
export const syncBrowserChromeTheme = (): void => {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return
  const background = getComputedStyle(document.body).backgroundColor?.trim() ?? ""
  if (background === "" || background === "transparent" || background === "rgba(0, 0, 0, 0)") return
  document.documentElement.style.backgroundColor = background
  document.body.style.backgroundColor = background
  let meta = document.querySelector<HTMLMetaElement>(`meta[name="${THEME_COLOR_META_NAME}"]`)
  if (!meta) {
    meta = document.createElement("meta")
    meta.name = THEME_COLOR_META_NAME
    document.head.append(meta)
  }
  meta.setAttribute("content", background)
}

import { getDefaultThemeColors, toCanonicalThemeColor } from "./color.ts"
import { BUILT_IN_THEMES, RESERVED_THEME_IDS, THEME_COLOR_ROLES, type ThemeAppearance, type ThemeColorRole, type ThemeColors, type ThemeDefinition, type ThemeVariants } from "./palettes.ts"

export type { ThemeAppearance, ThemeColorRole, ThemeColors, ThemeDefinition, ThemeVariants } from "./palettes.ts"

export const THEME_FILE_VERSION = 1 as const
export const CUSTOM_THEMES_STORAGE_KEY = "ashe-agent.web.custom-themes.v1"

export type ThemePreference = string
export type ThemePreferenceMode = ThemeAppearance | "system"
export type ThemeColorOverrides = Readonly<Partial<Record<ThemeColorRole, string>>>
export type ThemeVariantOverrides = Readonly<Partial<Record<ThemeAppearance, ThemeColorOverrides>>>
export type ThemeCollection = Readonly<{ id: string; label: string }>
export type ThemeHalves = Readonly<{ light?: string; dark?: string }>
export type ThemeFile = Readonly<{
  version: typeof THEME_FILE_VERSION
  id: string
  name: string
  appearance: ThemeAppearance
  colors: ThemeColorOverrides
  variants?: ThemeVariantOverrides
  collection?: ThemeCollection
  managed?: boolean
}>

const THEME_COLOR_ROLE_SET: ReadonlySet<string> = new Set(THEME_COLOR_ROLES)
const customThemeListeners = new Set<() => void>()

type CustomThemeLibrarySnapshot =
  | Readonly<{ status: "ready"; storedThemes: ReadonlyArray<unknown>; themes: ReadonlyArray<ThemeDefinition> }>
  | Readonly<{ status: "unavailable"; reason: "malformed" }>
  | Readonly<{ status: "unavailable"; reason: "storage-unavailable" }>

let customThemeLibrarySnapshot: CustomThemeLibrarySnapshot | null = null

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isThemeAppearance = (value: unknown): value is ThemeAppearance => value === "light" || value === "dark"

export const isThemeId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,47})$/.test(value)

const isThemeLabel = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= 48

const parseThemeCollection = (value: unknown): ThemeCollection | undefined =>
  isRecord(value) &&
  typeof value.id === "string" &&
  /^[a-z0-9][a-z0-9.:-]{0,127}$/i.test(value.id) &&
  isThemeLabel(value.label)
    ? { id: value.id, label: value.label.trim() }
    : undefined

const lenientThemeColorOverrides = (value: Readonly<Record<string, unknown>>): Partial<Record<ThemeColorRole, string>> => {
  const overrides: Partial<Record<ThemeColorRole, string>> = {}
  for (const [role, color] of Object.entries(value)) {
    const normalized = toCanonicalThemeColor(color)
    if (THEME_COLOR_ROLE_SET.has(role) && normalized) {
      overrides[role as ThemeColorRole] = normalized
    }
  }
  return overrides
}

const parseStoredThemeColors = (value: unknown, appearance: ThemeAppearance): ThemeColors | null => {
  if (!isRecord(value)) return null
  return { ...getDefaultThemeColors(appearance), ...lenientThemeColorOverrides(value) }
}

const parseStoredThemeVariants = (value: unknown, baseAppearance: ThemeAppearance): ThemeVariants | null | undefined => {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {}
  for (const [appearance, colors] of Object.entries(value)) {
    if (!isThemeAppearance(appearance)) return null
    if (appearance === baseAppearance) continue
    const parsedColors = parseStoredThemeColors(colors, appearance)
    if (!parsedColors) return null
    variants[appearance] = parsedColors
  }
  return Object.keys(variants).length > 0 ? variants : undefined
}

const parseStoredTheme = (value: unknown): ThemeDefinition | null => {
  if (!isRecord(value)) return null
  if (!isThemeId(value.id) || RESERVED_THEME_IDS.has(value.id)) return null
  if (!isThemeLabel(value.label) || !isThemeAppearance(value.appearance)) return null
  const colors = parseStoredThemeColors(value.colors, value.appearance)
  if (!colors) return null
  const variants = parseStoredThemeVariants(value.variants, value.appearance)
  if (value.variants !== undefined && variants === null) return null
  const collection = parseThemeCollection(value.collection)
  return {
    id: value.id,
    label: (value.label as string).trim(),
    appearance: value.appearance,
    colors,
    ...(variants ? { variants } : {}),
    ...(collection ? { collection } : {}),
    ...(value.managed === true ? { managed: true } : {}),
  }
}

const parseStoredThemes = (storedThemes: ReadonlyArray<unknown>): ReadonlyArray<ThemeDefinition> => {
  const themes: ThemeDefinition[] = []
  for (const value of storedThemes) {
    const theme = parseStoredTheme(value)
    if (theme && !themes.some((existing) => existing.id === theme.id)) themes.push(theme)
  }
  return themes
}

const readCustomThemeLibrarySnapshot = (): CustomThemeLibrarySnapshot => {
  if (typeof window === "undefined") return { status: "ready", storedThemes: [], themes: [] }
  let raw: string | null
  try {
    raw = window.localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY)
  } catch {
    return { status: "unavailable", reason: "storage-unavailable" }
  }
  if (!raw) return { status: "ready", storedThemes: [], themes: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: "unavailable", reason: "malformed" }
  }
  if (!Array.isArray(parsed)) return { status: "unavailable", reason: "malformed" }
  return { status: "ready", storedThemes: parsed, themes: parseStoredThemes(parsed) }
}

const getCustomThemeLibrarySnapshot = (): CustomThemeLibrarySnapshot => {
  if (customThemeLibrarySnapshot === null) customThemeLibrarySnapshot = readCustomThemeLibrarySnapshot()
  return customThemeLibrarySnapshot
}

const notifyCustomThemeListeners = (): void => {
  for (const listener of customThemeListeners) listener()
}

export const invalidateCustomThemes = (): void => {
  customThemeLibrarySnapshot = null
  notifyCustomThemeListeners()
}

const EMPTY_CUSTOM_THEMES: ReadonlyArray<ThemeDefinition> = []

export const getCustomThemes = (): ReadonlyArray<ThemeDefinition> => {
  const snapshot = getCustomThemeLibrarySnapshot()
  return snapshot.status === "ready" ? snapshot.themes : EMPTY_CUSTOM_THEMES
}

export const subscribeToCustomThemes = (listener: () => void): (() => void) => {
  customThemeListeners.add(listener)
  if (typeof window === "undefined") return () => { customThemeListeners.delete(listener) }
  const handleStorage = (event: StorageEvent): void => {
    if (event.key === CUSTOM_THEMES_STORAGE_KEY || event.key === null) invalidateCustomThemes()
  }
  window.addEventListener("storage", handleStorage)
  return () => {
    customThemeListeners.delete(listener)
    window.removeEventListener("storage", handleStorage)
  }
}

export const isReservedThemeId = (themeId: string): boolean => RESERVED_THEME_IDS.has(themeId)

export const themeIdFromName = (name: string): string => {
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48)
  return normalized || "custom-theme"
}

const saveCustomThemes = (storedThemes: ReadonlyArray<unknown>, themes: ReadonlyArray<ThemeDefinition>): void => {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(storedThemes))
    } catch {
      throw new Error(`The theme library at ${CUSTOM_THEMES_STORAGE_KEY} is unavailable: stored themes could not be written.`)
    }
  }
  customThemeLibrarySnapshot = { status: "ready", storedThemes, themes }
  notifyCustomThemeListeners()
}

const getWritableCustomThemeLibrary = (): Extract<CustomThemeLibrarySnapshot, { status: "ready" }> => {
  const snapshot = getCustomThemeLibrarySnapshot()
  if (snapshot.status !== "ready") throw new Error("The theme library is unavailable: stored themes are unreadable.")
  return snapshot
}

const decodeThemeColors = (colors: ThemeColors): ThemeColors =>
  Object.fromEntries(
    THEME_COLOR_ROLES.map((role) => {
      const color = toCanonicalThemeColor(colors[role])
      if (!color) throw new Error(`The color for "${role}" must be a literal CSS color such as #223344 or oklch(0.62 0.2 280).`)
      return [role, color]
    }),
  ) as Record<ThemeColorRole, string>

const canonicalizeThemeDefinition = (theme: ThemeDefinition): ThemeDefinition => ({
  ...theme,
  colors: decodeThemeColors(theme.colors),
  ...(theme.variants
    ? { variants: Object.fromEntries(Object.entries(theme.variants).map(([appearance, colors]) => [appearance, decodeThemeColors(colors)])) as ThemeVariants }
    : {}),
})

/** Looks up built-ins first, then installed custom themes. */
export const getThemeDefinition = (theme: ThemePreference): ThemeDefinition | null =>
  BUILT_IN_THEMES.find((definition) => definition.id === theme) ?? getCustomThemes().find((definition) => definition.id === theme) ?? null

/** Every selection path must check single-appearance themes to keep mix and appearance tiles aligned. */
export const singleAppearanceOf = (theme: ThemeDefinition): ThemeAppearance | null => {
  const modes = getThemeModes(theme)
  return modes.length === 1 ? (modes[0] ?? null) : null
}

export const getThemeColorsForMode = (theme: ThemeDefinition, mode: ThemeAppearance): ThemeColors | null =>
  mode === theme.appearance ? theme.colors : (theme.variants?.[mode] ?? null)

export const getThemeModes = (theme: ThemeDefinition): ReadonlyArray<ThemeAppearance> =>
  (["light", "dark"] as const).filter((mode) => getThemeColorsForMode(theme, mode) !== null)

export const getThemePreferenceMode = (theme: ThemePreference): ThemeAppearance | null => {
  if (theme === "light" || theme === "dark") return theme
  if (theme === "system") return null
  return getThemeDefinition(theme)?.appearance ?? null
}

export const isKnownThemePreference = (value: string): boolean => {
  if (value === "light" || value === "dark" || value === "system") return true
  return getThemeDefinition(value) !== null
}

export const installCustomTheme = (theme: ThemeDefinition): ThemeDefinition => {
  if (RESERVED_THEME_IDS.has(theme.id)) throw new Error(`The theme id "${theme.id}" is reserved.`)
  const library = getWritableCustomThemeLibrary()
  if (BUILT_IN_THEMES.some((existing) => existing.id === theme.id) || library.storedThemes.some((stored) => isRecord(stored) && stored.id === theme.id)) {
    throw new Error(`A theme named "${theme.label}" is already installed.`)
  }
  const canonicalTheme = canonicalizeThemeDefinition(theme)
  const themes = [...library.themes, canonicalTheme]
  saveCustomThemes([...library.storedThemes, canonicalTheme], themes)
  return canonicalTheme
}

export const updateCustomTheme = (theme: ThemeDefinition): ThemeDefinition => {
  if (RESERVED_THEME_IDS.has(theme.id)) throw new Error(`The theme id "${theme.id}" is reserved.`)
  const library = getWritableCustomThemeLibrary()
  const themeIndex = library.themes.findIndex((existing) => existing.id === theme.id)
  if (themeIndex === -1) throw new Error(`The theme "${theme.label}" is not installed.`)
  const canonicalTheme = canonicalizeThemeDefinition(theme)
  const nextThemes = [...library.themes]
  nextThemes[themeIndex] = canonicalTheme
  const nextStoredThemes: unknown[] = []
  let replaced = false
  for (const storedTheme of library.storedThemes) {
    if (!isRecord(storedTheme) || storedTheme.id !== theme.id) {
      nextStoredThemes.push(storedTheme)
    } else if (!replaced) {
      nextStoredThemes.push(canonicalTheme)
      replaced = true
    }
  }
  saveCustomThemes(nextStoredThemes, nextThemes)
  return canonicalTheme
}

export const removeCustomTheme = (themeId: string): void => {
  const library = getWritableCustomThemeLibrary()
  const nextThemes = library.themes.filter((theme) => theme.id !== themeId)
  if (nextThemes.length === library.themes.length) return
  saveCustomThemes(
    library.storedThemes.filter((storedTheme) => !isRecord(storedTheme) || storedTheme.id !== themeId),
    nextThemes,
  )
}

const parseThemeColorOverrides = (value: unknown): ThemeColorOverrides => {
  if (!isRecord(value)) throw new Error("Theme colors must be an object.")
  const overrides: Partial<Record<ThemeColorRole, string>> = {}
  for (const [role, color] of Object.entries(value)) {
    if (!THEME_COLOR_ROLE_SET.has(role)) throw new Error(`"${role}" is not a supported theme color role.`)
    const normalized = toCanonicalThemeColor(color)
    if (!normalized) throw new Error(`The color for "${role}" must be a literal CSS color such as #223344 or oklch(0.62 0.2 280).`)
    overrides[role as ThemeColorRole] = normalized
  }
  if (Object.keys(overrides).length === 0) throw new Error("Add at least one color role to the theme file.")
  return overrides
}

/** Strict parse for imported theme files. Stored libraries parse leniently instead. */
export const parseThemeFile = (value: unknown): ThemeDefinition => {
  if (!isRecord(value)) throw new Error("Theme files must contain a JSON object.")
  if (value.version !== THEME_FILE_VERSION) throw new Error(`This theme file uses an unsupported version. Expected ${THEME_FILE_VERSION}.`)
  const name = value.name
  const appearance = value.appearance
  const rawColors = value.colors
  if (!isThemeLabel(name)) throw new Error("Theme files need a name (48 characters or fewer).")
  if (!isThemeAppearance(appearance)) throw new Error(`Theme files need an appearance of "light" or "dark".`)
  if (!isRecord(rawColors)) throw new Error("Theme files need a colors object.")
  const id = value.id === undefined ? themeIdFromName(name) : value.id
  if (!isThemeId(id)) throw new Error("Theme ids may only contain lowercase letters, numbers, and hyphens.")
  if (RESERVED_THEME_IDS.has(id)) throw new Error(`The theme id "${id}" is reserved.`)
  const overrides = parseThemeColorOverrides(rawColors)
  const collection = parseThemeCollection(value.collection)
  if (value.collection !== undefined && !collection) throw new Error("Theme collections need a valid id and label.")
  const fallback = getDefaultThemeColors(appearance)
  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {}
  if (value.variants !== undefined) {
    if (!isRecord(value.variants)) throw new Error("Theme variants must be an object.")
    for (const [variantAppearance, variantColors] of Object.entries(value.variants)) {
      if (!isThemeAppearance(variantAppearance)) throw new Error(`Theme variants may only be named "light" or "dark".`)
      if (variantAppearance === appearance) throw new Error(`Theme variants must not repeat the base appearance "${appearance}".`)
      variants[variantAppearance] = { ...getDefaultThemeColors(variantAppearance), ...parseThemeColorOverrides(variantColors) }
    }
  }
  return {
    id,
    label: (name as string).trim(),
    appearance,
    colors: { ...fallback, ...overrides },
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
    ...(collection ? { collection } : {}),
    ...(value.managed === true ? { managed: true } : {}),
  }
}

export const serializeThemeFile = (theme: ThemeDefinition): string => {
  const canonicalTheme = canonicalizeThemeDefinition(theme)
  const file: ThemeFile = {
    version: THEME_FILE_VERSION,
    id: canonicalTheme.id,
    name: canonicalTheme.label,
    appearance: canonicalTheme.appearance,
    colors: canonicalTheme.colors,
    ...(canonicalTheme.variants ? { variants: canonicalTheme.variants } : {}),
    ...(canonicalTheme.collection ? { collection: canonicalTheme.collection } : {}),
    ...(canonicalTheme.managed ? { managed: true } : {}),
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

export const parseThemeHalves = (raw: string | null): ThemeHalves | null => {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value)) return null
    const halves: { light?: string; dark?: string } = {}
    for (const appearance of ["light", "dark"] as const) {
      const themeId = value[appearance]
      if (typeof themeId !== "string") continue
      const definition = getThemeDefinition(themeId)
      if (definition && getThemeColorsForMode(definition, appearance) !== null) halves[appearance] = definition.id
    }
    return halves.light !== undefined || halves.dark !== undefined ? halves : null
  } catch {
    return null
  }
}

export const resolveThemeHalf = (theme: ThemePreference, halves: ThemeHalves | null, appearance: ThemeAppearance): ThemePreference =>
  halves?.[appearance] ?? theme

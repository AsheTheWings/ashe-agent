import { beforeEach, describe, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { T3_CHAT_THEME } from "../src/app/theme/palettes.ts"
import {
  CUSTOM_THEMES_STORAGE_KEY,
  getCustomThemes,
  installCustomTheme,
  invalidateCustomThemes,
  parseThemeFile,
  removeCustomTheme,
} from "../src/app/theme/library.ts"
import { applyThemePalette } from "../src/app/theme/paint.ts"
import {
  clearThemePreview,
  initTheme,
  previewThemeColors,
  readStoredThemeHalves,
  readThemePreference,
  refreshTheme,
  resetThemeForTests,
  setAppearanceMode,
  setTheme,
  setThemeHalf,
  THEME_STORAGE_KEY,
} from "../src/app/theme/useTheme.ts"

const installDom = (systemDark = false): Window => {
  const window = new Window({ url: "https://ashe.example" })
  const globals = globalThis as unknown as Record<string, unknown>
  globals.window = window
  globals.document = window.document
  globals.localStorage = window.localStorage
  globals.navigator = window.navigator
  globals.getComputedStyle = window.getComputedStyle.bind(window)
  globals.requestAnimationFrame = (callback: () => void): number => {
    callback()
    return 1
  }
  globals.cancelAnimationFrame = (): void => {}
  window.matchMedia = ((query: string) => ({
    matches: systemDark,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
  resetThemeForTests()
  invalidateCustomThemes()
  return window
}

const root = (): HTMLElement => (globalThis as unknown as { document: Document }).document.documentElement

beforeEach(() => {
  installDom()
})

describe("theme painting", () => {
  test("a named theme paints variables and records its id, stock clears them", () => {
    expect(setTheme("grove")).toBe(true)
    expect(root().dataset.themeId).toBe("grove")
    expect(root().style.getPropertyValue("--background")).not.toBe("")
    expect(root().style.getPropertyValue("--app-theme-accent")).not.toBe("")
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("grove")
    expect(setTheme("system")).toBe(true)
    expect(root().dataset.themeId).toBeUndefined()
    expect(root().style.getPropertyValue("--app-theme-accent")).toBe("")
  })

  test("appearance modes control the dark class", () => {
    setTheme("grove")
    expect(setAppearanceMode("dark")).toBe(true)
    expect(root().classList.contains("dark")).toBe(true)
    expect(setAppearanceMode("light")).toBe(true)
    expect(root().classList.contains("dark")).toBe(false)
  })

  test("system mode follows the operating system", () => {
    installDom(true)
    setTheme("grove")
    setAppearanceMode("system")
    refreshTheme()
    expect(root().classList.contains("dark")).toBe(true)
  })

  test("applyThemePalette is a no-op for stock and a no-match for unknown ids", () => {
    applyThemePalette("grove", "light")
    expect(root().dataset.themeId).toBe("grove")
    applyThemePalette("system", "light")
    expect(root().dataset.themeId).toBeUndefined()
    applyThemePalette("no-such-theme", "light")
    expect(root().dataset.themeId).toBeUndefined()
  })

  test("unknown themes are refused", () => {
    expect(setTheme("no-such-theme")).toBe(false)
    expect(readThemePreference()).toBe("system")
  })
})

describe("theme halves", () => {
  test("a half replaces the theme for its appearance", () => {
    installDom(true)
    setTheme("t3-chat")
    expect(setThemeHalf("dark", "ember")).toBe(true)
    expect(readStoredThemeHalves()).toEqual({ dark: "ember" })
    expect(root().dataset.themeId).toBe("ember")
    expect(setThemeHalf("dark", null)).toBe(true)
    expect(root().dataset.themeId).toBe("t3-chat")
  })

  test("halves reject unknown themes and single-appearance mismatches", () => {
    expect(setThemeHalf("dark", "no-such-theme")).toBe(false)
    expect(setThemeHalf("light", "grove")).toBe(true)
    expect(readStoredThemeHalves()).toEqual({ light: "grove" })
  })

  test("selecting a whole theme clears the mix", () => {
    setThemeHalf("light", "grove")
    setTheme("ocean")
    expect(readStoredThemeHalves()).toBeNull()
    expect(root().dataset.themeId).toBe("ocean")
  })
})

describe("theme previews", () => {
  test("a preview paints under a marker and the stored theme restores after it", () => {
    setTheme("grove")
    previewThemeColors(T3_CHAT_THEME.variants?.dark ?? T3_CHAT_THEME.colors, "dark")
    expect(root().dataset.themeId).toBe("__preview")
    expect(root().classList.contains("dark")).toBe(true)
    clearThemePreview()
    expect(root().dataset.themeId).toBe("grove")
  })
})

describe("custom theme persistence", () => {
  test("installed themes survive a library reload through storage", () => {
    const theme = parseThemeFile({ version: 1, id: "dom-roundtrip", name: "Roundtrip", appearance: "dark", colors: { accent: "#e5489b" } })
    installCustomTheme(theme)
    expect(window.localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY)).toContain("dom-roundtrip")
    invalidateCustomThemes()
    expect(getCustomThemes().some((stored) => stored.id === "dom-roundtrip")).toBe(true)
    expect(setTheme("dom-roundtrip")).toBe(true)
    expect(root().dataset.themeId).toBe("dom-roundtrip")
    removeCustomTheme("dom-roundtrip")
    expect(getCustomThemes()).toHaveLength(0)
  })

  test("malformed stored themes fail closed to an empty library", () => {
    window.localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, "not json")
    invalidateCustomThemes()
    expect(getCustomThemes()).toHaveLength(0)
  })

  test("the stored preference paints on startup", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "ocean")
    initTheme()
    expect(root().dataset.themeId).toBe("ocean")
  })
})

import { describe, expect, test } from "bun:test"
import {
  createVividThemeColors,
  parseThemeColor,
  themeColorToHex,
  themeContrastRatio,
  themeOklchToRgb,
  toCanonicalThemeColor,
  updateThemeColorFamily,
} from "../src/app/theme/color.ts"
import {
  getThemeDefinition,
  getThemeModes,
  getThemePreferenceMode,
  installCustomTheme,
  invalidateCustomThemes,
  isKnownThemePreference,
  parseThemeFile,
  parseThemeHalves,
  removeCustomTheme,
  resolveThemeHalf,
  serializeThemeFile,
  singleAppearanceOf,
  themeIdFromName,
  updateCustomTheme,
} from "../src/app/theme/library.ts"
import { BUILT_IN_THEME_IDS, BUILT_IN_THEMES, THEME_COLOR_ROLES, T3_CHAT_THEME } from "../src/app/theme/palettes.ts"
import { resolveThemeAppearance } from "../src/app/theme/paint.ts"

describe("theme color canonicalization", () => {
  test("hex colors become oklch literals and survive a hex round-trip", () => {
    const canonical = toCanonicalThemeColor("#8e4ec6")!
    expect(canonical).toStartWith("oklch(")
    expect(themeColorToHex(canonical)).toBe("#8e4ec6")
  })

  test("canonical oklch literals pass through unchanged", () => {
    expect(toCanonicalThemeColor("oklch(0.62 0.2 280)")).toBe("oklch(0.62 0.2 280)")
  })

  test("short hex, alpha hex, rgb, and hsl spellings are accepted", () => {
    const red = toCanonicalThemeColor("#ff0000")!
    expect(toCanonicalThemeColor("#f00")).toBe(red)
    expect(toCanonicalThemeColor("#ff000080")!).toContain("/")
    expect(toCanonicalThemeColor("rgb(255, 0, 0)")).toBe(red)
    expect(toCanonicalThemeColor("hsl(0, 100%, 50%)")).toBe(red)
  })

  test("non-colors are rejected", () => {
    for (const value of ["", "banana", "#12", "#gggggg", "oklch(0.6)", null, 42]) {
      expect(toCanonicalThemeColor(value)).toBeNull()
    }
  })

  test("named oklch values convert to the expected hex", () => {
    expect(themeColorToHex("oklch(1 0 0)")).toBe("#ffffff")
    expect(themeColorToHex("oklch(0 0 0)")).toBe("#000000")
  })
})

describe("theme file parsing", () => {
  test("a minimal file fills every role from the appearance defaults", () => {
    const theme = parseThemeFile({ version: 1, name: "Test", appearance: "dark", colors: { accent: "#8e4ec6" } })
    expect(theme.id).toBe("test")
    expect(theme.label).toBe("Test")
    expect(Object.keys(theme.colors)).toHaveLength(THEME_COLOR_ROLES.length)
    expect(theme.colors.accent).toBe(toCanonicalThemeColor("#8e4ec6")!)
    expect(theme.colors.canvas).toBe(T3_CHAT_THEME.variants?.dark?.canvas!)
    expect(theme.variants).toBeUndefined()
  })

  test("explicit variants must add the other appearance only", () => {
    const theme = parseThemeFile({
      version: 1,
      name: "Test",
      appearance: "light",
      colors: { accent: "#8e4ec6" },
      variants: { dark: { accent: "#e5489b" } },
    })
    expect(theme.variants?.dark?.accent).toBe(toCanonicalThemeColor("#e5489b")!)
    expect(() =>
      parseThemeFile({ version: 1, name: "Test", appearance: "light", colors: { accent: "#8e4ec6" }, variants: { light: { accent: "#fff" } } }),
    ).toThrow()
    expect(() =>
      parseThemeFile({ version: 1, name: "Test", appearance: "light", colors: { accent: "#8e4ec6" }, variants: { sepia: { accent: "#fff" } } }),
    ).toThrow()
  })

  test("malformed files fail closed with a reason", () => {
    const base = { version: 1, name: "Test", appearance: "light", colors: { accent: "#8e4ec6" } }
    expect(() => parseThemeFile({ ...base, version: 2 })).toThrow(/version/)
    expect(() => parseThemeFile({ ...base, name: "  " })).toThrow(/name/)
    expect(() => parseThemeFile({ ...base, appearance: "blue" })).toThrow(/appearance/)
    expect(() => parseThemeFile({ ...base, colors: {} })).toThrow()
    expect(() => parseThemeFile({ ...base, colors: { notARole: "#fff" } })).toThrow(/role/)
    expect(() => parseThemeFile({ ...base, colors: { accent: "banana" } })).toThrow()
    expect(() => parseThemeFile({ ...base, id: "dark" })).toThrow(/reserved/)
    expect(() => parseThemeFile({ ...base, id: "UPPER" })).toThrow()
    expect(() => parseThemeFile("nope")).toThrow()
  })

  test("serialization round-trips through the parser", () => {
    const theme = parseThemeFile({ version: 1, name: "Round Trip", appearance: "light", colors: { accent: "#8e4ec6" }, variants: { dark: { accent: "#e5489b" } } })
    const again = parseThemeFile(JSON.parse(serializeThemeFile(theme)) as unknown)
    expect(again).toEqual(theme)
    expect(serializeThemeFile(theme)).toContain(`"version": ${1}`)
  })
})

describe("custom theme library", () => {
  test("install, lookup, update, and remove keep one entry per id", () => {
    invalidateCustomThemes()
    const theme = parseThemeFile({ version: 1, id: "unit-crude", name: "Crude", appearance: "light", colors: { accent: "#8e4ec6" } })
    installCustomTheme(theme)
    expect(getThemeDefinition("unit-crude")?.label).toBe("Crude")
    expect(() => installCustomTheme(theme)).toThrow(/already installed/)
    updateCustomTheme({ ...theme, label: "Refined" })
    expect(getThemeDefinition("unit-crude")?.label).toBe("Refined")
    removeCustomTheme("unit-crude")
    expect(getThemeDefinition("unit-crude")).toBeNull()
  })

  test("reserved and built-in ids are refused", () => {
    invalidateCustomThemes()
    const theme = parseThemeFile({ version: 1, id: "unit-other", name: "Other", appearance: "light", colors: { accent: "#8e4ec6" } })
    expect(() => installCustomTheme({ ...theme, id: "dark" })).toThrow(/reserved/)
    expect(() => installCustomTheme({ ...theme, id: "grove" })).toThrow(/reserved/)
    expect(() => updateCustomTheme({ ...theme, id: "missing" })).toThrow(/not installed/)
  })

  test("built-ins resolve while unknown ids do not", () => {
    invalidateCustomThemes()
    expect(getThemeDefinition("grove")?.label).toBe("Grove")
    expect(getThemeDefinition("no-such-theme")).toBeNull()
    expect(isKnownThemePreference("system")).toBe(true)
    expect(isKnownThemePreference("light")).toBe(true)
    expect(isKnownThemePreference("grove")).toBe(true)
    expect(isKnownThemePreference("no-such-theme")).toBe(false)
    expect(getThemePreferenceMode("system")).toBeNull()
    expect(getThemePreferenceMode("dark")).toBe("dark")
    expect(getThemePreferenceMode("grove")).toBe("light")
    expect(getThemeModes(getThemeDefinition("grove")!)).toEqual(["light", "dark"])
  })

  test("theme ids derive from names", () => {
    expect(themeIdFromName("My Cool Theme!")).toBe("my-cool-theme")
    expect(themeIdFromName("!!!")).toBe("custom-theme")
  })
})

describe("theme appearance resolution", () => {
  test("stock preferences follow the requested mode and the operating system", () => {
    expect(resolveThemeAppearance("system", false, "system", null)).toBe("light")
    expect(resolveThemeAppearance("system", true, "system", null)).toBe("dark")
    expect(resolveThemeAppearance("system", true, "light", null)).toBe("light")
    expect(resolveThemeAppearance("grove", true, "light", null)).toBe("light")
    expect(resolveThemeAppearance("grove", false, "dark", null)).toBe("dark")
  })

  test("halves replace the theme for their appearance", () => {
    expect(resolveThemeHalf("t3-chat", { dark: "ember" }, "dark")).toBe("ember")
    expect(resolveThemeHalf("t3-chat", { dark: "ember" }, "light")).toBe("t3-chat")
    expect(resolveThemeHalf("t3-chat", null, "dark")).toBe("t3-chat")
  })

  test("single-appearance themes stay on their own appearance", () => {
    invalidateCustomThemes()
    const mono = installCustomTheme(parseThemeFile({ version: 1, id: "unit-mono", name: "Mono", appearance: "light", colors: { accent: "#8e4ec6" } }))
    expect(singleAppearanceOf(mono)).toBe("light")
    expect(singleAppearanceOf(getThemeDefinition("grove")!)).toBeNull()
    expect(resolveThemeAppearance("unit-mono", true, "system", null)).toBe("light")
    expect(resolveThemeAppearance("unit-mono", true, "dark", null)).toBe("light")
    removeCustomTheme("unit-mono")
  })

  test("halves only admit resolvable themes", () => {
    expect(parseThemeHalves(JSON.stringify({ light: "grove", dark: "no-such-theme" }))).toEqual({ light: "grove" })
    expect(parseThemeHalves("garbage")).toBeNull()
    expect(parseThemeHalves(null)).toBeNull()
  })
})

describe("guided theme generation", () => {
  test("seeded palettes cover every role with canonical colors and readable text", () => {
    for (const appearance of ["light", "dark"] as const) {
      const colors = createVividThemeColors(appearance, appearance === "dark" ? "#1b0f1e" : "#faf9fb", "#8e4ec6")
      expect(Object.keys(colors)).toHaveLength(THEME_COLOR_ROLES.length)
      for (const value of Object.values(colors)) expect(toCanonicalThemeColor(value)).toBe(value)
      const text = parseThemeColor(colors.text)!
      const canvas = parseThemeColor(colors.canvas)!
      expect(themeContrastRatio(themeOklchToRgb(text.color), themeOklchToRgb(canvas.color))).toBeGreaterThanOrEqual(7)
    }
  })

  test("editing the accent repairs its derived roles", () => {
    const next = updateThemeColorFamily("light", T3_CHAT_THEME.colors, "accent", "#ff0000")
    expect(next.accent).toBe(toCanonicalThemeColor("#ff0000")!)
    expect(next.focus).toBe(next.accent)
    expect(next.update).toBe(next.accent)
    expect(next.terminalCursor).toBe(next.accent)
  })
})

describe("built-in library invariants", () => {
  test("the expected built-ins ship with full palettes", () => {
    expect([...BUILT_IN_THEME_IDS]).toEqual(["t3-chat", "grove", "ocean", "ember", "iris"])
    for (const theme of BUILT_IN_THEMES) {
      expect(Object.keys(theme.colors)).toHaveLength(THEME_COLOR_ROLES.length)
      for (const role of THEME_COLOR_ROLES) {
        expect(toCanonicalThemeColor(theme.colors[role])).toBe(theme.colors[role])
        const variant = theme.variants?.dark ?? theme.variants?.light
        if (variant) expect(toCanonicalThemeColor(variant[role])).toBe(variant[role])
      }
    }
    expect(T3_CHAT_THEME.variants?.dark).toBeDefined()
  })
})

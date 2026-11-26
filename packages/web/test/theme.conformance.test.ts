import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { toCanonicalThemeColor } from "../src/app/theme/color.ts"
import { getThemeModes, parseThemeFile, serializeThemeFile } from "../src/app/theme/library.ts"
import { getThemeColorVariable } from "../src/app/theme/paint.ts"
import { BUILT_IN_THEME_IDS, BUILT_IN_THEMES, THEME_COLOR_ROLES } from "../src/app/theme/palettes.ts"

test("every theme role paints a distinct application variable", () => {
  expect(THEME_COLOR_ROLES).toHaveLength(61)
  expect(new Set(THEME_COLOR_ROLES).size).toBe(THEME_COLOR_ROLES.length)
  const variables = THEME_COLOR_ROLES.map((role) => getThemeColorVariable(role))
  expect(new Set(variables).size).toBe(variables.length)
  for (const variable of variables) expect(variable).toStartWith("--app-theme-")
})

test("the built-in library keeps its pinned identities and full palettes", () => {
  expect([...BUILT_IN_THEME_IDS]).toEqual(["claude", "t3-chat", "grove", "ocean", "ember", "iris"])
  for (const theme of BUILT_IN_THEMES) {
    expect(getThemeModes(theme)).toEqual(["light", "dark"])
    expect(Object.keys(theme.colors)).toHaveLength(THEME_COLOR_ROLES.length)
    for (const role of THEME_COLOR_ROLES) {
      expect(toCanonicalThemeColor(theme.colors[role])).toBe(theme.colors[role])
    }
  }
})

test("exported theme files carry the current file version", () => {
  const theme = parseThemeFile({ version: 1, name: "Pinned", appearance: "light", colors: { accent: "#8e4ec6" } })
  expect(JSON.parse(serializeThemeFile(theme) as string) as { version: unknown }).toEqual(
    expect.objectContaining({ version: 1 }),
  )
})

test("the upstream notice owns the theme adaptation", () => {
  const notice = readFileSync(join(import.meta.dir, "../NOTICE-t3"), "utf8")
  expect(notice).toContain("theme palettes and customization model")
})

test("the client stylesheet keeps the stock variants and the theme transition guard", () => {
  const css = readFileSync(join(import.meta.dir, "../src/index.css"), "utf8")
  expect(css).toContain("@custom-variant dark")
  expect(css).toContain(".no-transitions")
})

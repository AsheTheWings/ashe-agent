import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button.tsx"
import { createVividThemeColors, themeColorToHex, toCanonicalThemeColor, updateThemeColorFamily } from "./color.ts"
import { getThemeColorsForMode, installCustomTheme, isReservedThemeId, isThemeId, serializeThemeFile, themeIdFromName, updateCustomTheme, type ThemeAppearance, type ThemeColors, type ThemeDefinition, type ThemeVariants } from "./library.ts"
import { T3_CHAT_THEME, THEME_COLOR_ROLES, type ThemeColorRole } from "./palettes.ts"
import { clearThemePreview, getRenderedAppearance, previewThemeColors, setTheme } from "./useTheme.ts"

const seedDefaults = (appearance: ThemeAppearance): { canvas: string; accent: string } =>
  appearance === "dark" ? { canvas: "#1b0f1e", accent: "#e5489b" } : { canvas: "#faf9fb", accent: "#8e4ec6" }

const hexInputValue = (color: string): string => themeColorToHex(color)?.slice(0, 7) ?? "#000000"

const RoleRow = ({
  role,
  value,
  onChange,
}: {
  readonly role: ThemeColorRole
  readonly value: string
  readonly onChange: (value: string) => void
}) => (
  <label className="flex items-center gap-2 text-xs">
    <input type="color" className="h-6 w-8 shrink-0 cursor-pointer rounded border p-0.5" value={hexInputValue(value)} onChange={(event) => onChange(event.target.value)} aria-label={`${role} color`} />
    <span className="w-44 shrink-0 truncate font-mono">{role}</span>
    <input
      type="text"
      spellCheck={false}
      className="bg-background min-w-0 flex-1 rounded border px-2 py-1 font-mono"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label={`${role} value`}
    />
  </label>
)

export const ThemeEditor = ({
  initial,
  duplicateOf,
  onClose,
}: {
  readonly initial: ThemeDefinition | null
  readonly duplicateOf: ThemeDefinition | null
  readonly onClose: () => void
}) => {
  const seed = initial ?? duplicateOf
  const [name, setName] = useState(initial?.label ?? (duplicateOf ? `${duplicateOf.label} copy` : "Custom theme"))
  const [appearance, setAppearance] = useState<ThemeAppearance>(seed?.appearance ?? getRenderedAppearance())
  const [colors, setColors] = useState<ThemeColors>(() => seed?.colors ?? T3_CHAT_THEME.colors)
  const [variants, setVariants] = useState<ThemeVariants | undefined>(() => seed?.variants)
  const [tab, setTab] = useState<ThemeAppearance>(seed?.appearance ?? getRenderedAppearance())
  const [seedCanvas, setSeedCanvas] = useState(() => seedDefaults(seed?.appearance ?? getRenderedAppearance()).canvas)
  const [seedAccent, setSeedAccent] = useState(() => seedDefaults(seed?.appearance ?? getRenderedAppearance()).accent)
  const [error, setError] = useState<string | null>(null)

  const tabColors: ThemeColors = useMemo(
    () => (tab === appearance ? colors : (variants?.[tab] ?? getThemeColorsForMode({ id: "", label: "", appearance, colors, ...(variants ? { variants } : {}) }, tab) ?? colors)),
    [tab, appearance, colors, variants],
  )

  useEffect(() => {
    previewThemeColors(tabColors, tab)
  }, [tabColors, tab])

  useEffect(() => () => clearThemePreview(), [])

  const setTabColors = (next: ThemeColors): void => {
    if (tab === appearance) setColors(next)
    else setVariants({ ...variants, [tab]: next })
  }

  const editRole = (role: ThemeColorRole, value: string): void => {
    setTabColors(updateThemeColorFamily(tab, tabColors, role, value))
  }

  const generateFromSeed = (): void => {
    setError(null)
    if (toCanonicalThemeColor(seedCanvas) === null || toCanonicalThemeColor(seedAccent) === null) {
      setError("Seeds must be literal CSS colors such as #8e4ec6 or oklch(0.62 0.2 280).")
      return
    }
    setTabColors(createVividThemeColors(tab, seedCanvas, seedAccent))
  }

  const toggleVariant = (): void => {
    const other: ThemeAppearance = appearance === "light" ? "dark" : "light"
    if (variants?.[other]) {
      const next = { ...variants }
      delete next[other]
      setVariants(Object.keys(next).length > 0 ? next : undefined)
      if (tab === other) setTab(appearance)
    } else {
      setVariants({ ...variants, [other]: createVividThemeColors(other, seedCanvas, seedAccent) })
      setTab(other)
    }
  }

  const changeAppearance = (next: ThemeAppearance): void => {
    setAppearance(next)
    setTab(next)
    if (variants?.[next]) {
      const cleaned = { ...variants }
      delete cleaned[next]
      setVariants(Object.keys(cleaned).length > 0 ? cleaned : undefined)
    }
  }

  const downloadDraft = (): void => {
    const draft: ThemeDefinition = {
      id: initial?.id ?? themeIdFromName(name),
      label: name.trim() || "Custom theme",
      appearance,
      colors,
      ...(variants ? { variants } : {}),
    }
    const url = URL.createObjectURL(new Blob([serializeThemeFile(draft)], { type: "application/json" }))
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${draft.id}.json`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }

  const save = (): void => {
    setError(null)
    const label = name.trim()
    if (label === "" || label.length > 48) {
      setError("Give the theme a name of 48 characters or fewer.")
      return
    }
    try {
      if (initial) {
        updateCustomTheme({
          ...initial,
          label,
          appearance,
          colors,
          ...(variants ? { variants } : {}),
          ...(initial.collection ? { collection: initial.collection } : {}),
        })
        setTheme(initial.id)
      } else {
        let id = themeIdFromName(label)
        if (!isThemeId(id) || isReservedThemeId(id)) id = `custom-${id}`
        let installed: ThemeDefinition | null = null
        for (let attempt = 0; attempt < 10 && installed === null; attempt += 1) {
          const candidate = attempt === 0 ? id : `${id}-${attempt + 1}`
          try {
            installed = installCustomTheme({ id: candidate, label, appearance, colors, ...(variants ? { variants } : {}) })
          } catch (failure) {
            if (!(failure instanceof Error) || !failure.message.includes("already installed")) throw failure
          }
        }
        if (installed === null) throw new Error(`A theme named "${label}" is already installed.`)
        setTheme(installed.id)
      }
      clearThemePreview()
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That theme could not be saved.")
    }
  }

  const other: ThemeAppearance = appearance === "light" ? "dark" : "light"
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex flex-1 items-center gap-2 text-xs">
          Name
          <input type="text" className="bg-background min-w-0 flex-1 rounded border px-2 py-1" value={name} maxLength={48} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-xs">
          Base
          <select className="bg-background rounded border px-2 py-1" value={appearance} onChange={(event) => changeAppearance(event.target.value === "dark" ? "dark" : "light")}>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <div className="flex items-center gap-1 text-xs" role="group" aria-label="Preview appearance">
          {([appearance, ...(variants?.[other] ? [other] as const : [])] as const).map((mode) => (
            <button key={mode} type="button" className={`rounded border px-2 py-1 ${tab === mode ? "bg-accent" : ""}`} onClick={() => setTab(mode)}>
              {tab === mode ? `Viewing ${mode}` : `View ${mode}`}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border p-2">
        <span className="text-xs font-medium">Seed</span>
        <label className="flex items-center gap-1 text-xs">
          Canvas
          <input type="text" spellCheck={false} className="bg-background w-28 rounded border px-2 py-1 font-mono" value={seedCanvas} onChange={(event) => setSeedCanvas(event.target.value)} />
        </label>
        <label className="flex items-center gap-1 text-xs">
          Accent
          <input type="text" spellCheck={false} className="bg-background w-28 rounded border px-2 py-1 font-mono" value={seedAccent} onChange={(event) => setSeedAccent(event.target.value)} />
        </label>
        <Button type="button" size="sm" variant="outline" onClick={generateFromSeed}>Generate {tab} from seed</Button>
        <Button type="button" size="sm" variant="outline" onClick={toggleVariant}>{variants?.[other] ? `Remove ${other} variant` : `Add ${other} variant`}</Button>
      </div>
      <div className="flex flex-col gap-1.5">
        {THEME_COLOR_ROLES.map((role) => (
          <RoleRow key={role} role={role} value={tabColors[role]} onChange={(value) => editRole(role, value)} />
        ))}
      </div>
      {error && <span role="alert" className="text-destructive text-xs">{error}</span>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={save}>{initial ? "Save changes" : "Create theme"}</Button>
        <Button type="button" size="sm" variant="outline" onClick={downloadDraft}>Download file</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => { clearThemePreview(); onClose() }}>Cancel</Button>
      </div>
    </div>
  )
}

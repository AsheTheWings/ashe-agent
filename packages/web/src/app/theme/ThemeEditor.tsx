import { useEffect, useMemo, useState } from "react"
import { DownloadIcon, SparklesIcon } from "lucide-react"
import { Button } from "@/components/ui/button.tsx"
import { Input } from "@/components/ui/input.tsx"
import { Label } from "@/components/ui/label.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx"
import { createVividThemeColors, getDefaultThemeColors, themeColorToHex, toCanonicalThemeColor, updateThemeColorFamily } from "./color.ts"
import { getThemeColorsForMode, installCustomTheme, isReservedThemeId, isThemeId, serializeThemeFile, themeIdFromName, updateCustomTheme, type ThemeAppearance, type ThemeColors, type ThemeDefinition, type ThemeVariants } from "./library.ts"
import { THEME_COLOR_ROLES, type ThemeColorRole } from "./palettes.ts"
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
  <div className="flex items-center gap-2 text-xs">
    <input
      type="color"
      className="border-input bg-background h-7 w-8 shrink-0 cursor-pointer rounded-md border p-0.5"
      value={hexInputValue(value)}
      onChange={(event) => onChange(event.target.value)}
      aria-label={`${role} color`}
    />
    <span className="text-muted-foreground w-40 shrink-0 truncate font-mono text-[11px]">{role}</span>
    <Input
      type="text"
      spellCheck={false}
      className="h-7 min-w-0 flex-1 font-mono text-xs"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label={`${role} value`}
    />
  </div>
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
  const initialAppearance: ThemeAppearance = seed?.appearance ?? getRenderedAppearance()
  const [name, setName] = useState(initial?.label ?? (duplicateOf ? `${duplicateOf.label} copy` : "Custom theme"))
  const [appearance, setAppearance] = useState<ThemeAppearance>(initialAppearance)
  const [colors, setColors] = useState<ThemeColors>(() => seed?.colors ?? getDefaultThemeColors(initialAppearance))
  const [variants, setVariants] = useState<ThemeVariants | undefined>(() => seed?.variants)
  const [tab, setTab] = useState<ThemeAppearance>(initialAppearance)
  const [seedCanvas, setSeedCanvas] = useState(() => seedDefaults(initialAppearance).canvas)
  const [seedAccent, setSeedAccent] = useState(() => seedDefaults(initialAppearance).accent)
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
    setError(null)
    try {
      const draft: ThemeDefinition = {
        id: initial?.id ?? themeIdFromName(name),
        label: name.trim() || "Custom theme",
        appearance,
        colors,
        ...(variants ? { variants } : {}),
      }
      const serialized = serializeThemeFile(draft)
      const url = URL.createObjectURL(new Blob([serialized], { type: "application/json" }))
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = `${draft.id}.json`
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That theme could not be exported.")
    }
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
          id: initial.id,
          label,
          appearance,
          colors,
          ...(variants ? { variants } : {}),
        })
        setTheme(initial.id)
      } else {
        const rawId = themeIdFromName(label)
        const base = (!isThemeId(rawId) || isReservedThemeId(rawId) ? `custom-${rawId}` : rawId).slice(0, 48).replace(/-+$/, "") || "custom-theme"
        let installed: ThemeDefinition | null = null
        for (let attempt = 0; attempt < 10 && installed === null; attempt += 1) {
          const suffix = attempt === 0 ? "" : `-${attempt + 1}`
          const stem = base.slice(0, 48 - suffix.length).replace(/-+$/, "") || "custom"
          const candidate = `${stem}${suffix}`
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
      <div className="grid gap-2.5 sm:grid-cols-[1fr_auto]">
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <Label htmlFor="theme-name" className="text-xs">Name</Label>
            <span className="text-muted-foreground tabular-nums text-[11px]">{name.length}/48</span>
          </div>
          <Input
            id="theme-name"
            type="text"
            className="h-8 text-sm"
            value={name}
            maxLength={48}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Base mode</Label>
          <Select value={appearance} onValueChange={(value) => changeAppearance(value === "dark" ? "dark" : "light")}>
            <SelectTrigger className="w-28">
              <SelectValue>{appearance === "dark" ? "Dark" : "Light"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1" role="group" aria-label="Preview appearance">
          {([appearance, ...(variants?.[other] ? [other] as const : [])] as const).map((mode) => (
            <Button
              key={mode}
              type="button"
              size="xs"
              variant={tab === mode ? "secondary" : "outline"}
              onClick={() => setTab(mode)}
            >
              {tab === mode ? `Editing ${mode}` : `Edit ${mode}`}
            </Button>
          ))}
        </div>
        <Button type="button" size="xs" variant="outline" onClick={toggleVariant}>
          {variants?.[other] ? `Remove ${other} variant` : `Add ${other} variant`}
        </Button>
      </div>

      <div className="bg-muted/40 flex flex-wrap items-end gap-2 rounded-lg border p-2.5">
        <div className="flex flex-col gap-1">
          <Label htmlFor="seed-canvas" className="text-[11px] text-muted-foreground">Canvas seed</Label>
          <Input
            id="seed-canvas"
            type="text"
            spellCheck={false}
            className="h-7 w-28 font-mono text-xs"
            value={seedCanvas}
            onChange={(event) => setSeedCanvas(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="seed-accent" className="text-[11px] text-muted-foreground">Accent seed</Label>
          <Input
            id="seed-accent"
            type="text"
            spellCheck={false}
            className="h-7 w-28 font-mono text-xs"
            value={seedAccent}
            onChange={(event) => setSeedAccent(event.target.value)}
          />
        </div>
        <Button type="button" size="xs" variant="outline" onClick={generateFromSeed}>
          <SparklesIcon className="size-3" />
          Generate {tab}
        </Button>
      </div>

      <div className="scrollbar-compact flex max-h-60 flex-col gap-1.5 overflow-y-auto pr-1">
        {THEME_COLOR_ROLES.map((role) => (
          <RoleRow key={role} role={role} value={tabColors[role]} onChange={(value) => editRole(role, value)} />
        ))}
      </div>

      {error && <p role="alert" className="text-destructive text-xs">{error}</p>}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <Button type="button" size="sm" variant="outline" onClick={downloadDraft}>
          <DownloadIcon className="size-3.5" />
          Export JSON
        </Button>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => { clearThemePreview(); onClose() }}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={save}>
            {initial ? "Save changes" : "Create theme"}
          </Button>
        </div>
      </div>
    </div>
  )
}

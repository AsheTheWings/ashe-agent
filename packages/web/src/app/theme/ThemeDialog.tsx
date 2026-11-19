import { useState, useSyncExternalStore } from "react"
import { Button } from "@/components/ui/button.tsx"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx"
import { themeColorToHex } from "./color.ts"
import { getCustomThemes, getThemeColorsForMode, getThemeModes, installCustomTheme, parseThemeFile, removeCustomTheme, serializeThemeFile, subscribeToCustomThemes, type ThemeAppearance, type ThemeDefinition, type ThemeHalves } from "./library.ts"
import { BUILT_IN_THEMES } from "./palettes.ts"
import { clearThemePreview, setAppearanceMode, setTheme, setThemeHalf, useTheme } from "./useTheme.ts"
import { ThemeEditor } from "./ThemeEditor.tsx"

const previewDot = (theme: ThemeDefinition, mode: ThemeAppearance): { canvas: string; accent: string; action: string } => {
  const colors = getThemeColorsForMode(theme, mode) ?? theme.colors
  return {
    canvas: themeColorToHex(colors.canvas) ?? colors.canvas,
    accent: themeColorToHex(colors.accent) ?? colors.accent,
    action: themeColorToHex(colors.messageAction) ?? colors.messageAction,
  }
}

const downloadThemeFile = (theme: ThemeDefinition): void => {
  const url = URL.createObjectURL(new Blob([serializeThemeFile(theme)], { type: "application/json" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `${theme.id}.json`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

const ThemeCard = ({
  theme,
  mode,
  isActive,
  onUse,
  onEdit,
  onDuplicate,
  onRemove,
}: {
  readonly theme: ThemeDefinition
  readonly mode: ThemeAppearance
  readonly isActive: boolean
  readonly onUse: () => void
  readonly onEdit?: () => void
  readonly onDuplicate?: () => void
  readonly onRemove?: () => void
}) => {
  const dot = previewDot(theme, mode)
  return (
    <div className={`flex items-center gap-2 rounded-lg border p-2 ${isActive ? "border-primary ring-1 ring-ring" : ""}`}>
      <span className="flex shrink-0 items-center" aria-hidden="true">
        <span className="size-5 rounded-full border" style={{ backgroundColor: dot.canvas }} />
        <span className="-ml-2 size-5 rounded-full border" style={{ backgroundColor: dot.accent }} />
        <span className="-ml-2 size-5 rounded-full border" style={{ backgroundColor: dot.action }} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{theme.label}</span>
        <span className="text-muted-foreground block text-xs">{mode === theme.appearance ? mode : `${theme.appearance}+${mode}`}</span>
      </span>
      {isActive ? (
        <span className="text-muted-foreground text-xs">Active</span>
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={onUse}>Use</Button>
      )}
      {onEdit && <button type="button" className="rounded border px-2 py-1 text-xs" onClick={onEdit}>Edit</button>}
      {onDuplicate && <button type="button" className="rounded border px-2 py-1 text-xs" onClick={onDuplicate}>Duplicate</button>}
      <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => downloadThemeFile(theme)}>File</button>
      {onRemove && <button type="button" className="text-destructive rounded border px-2 py-1 text-xs" onClick={onRemove}>Delete</button>}
    </div>
  )
}

const HalvesEditor = ({
  halves,
  resolvedTheme,
  options,
}: {
  readonly halves: ThemeHalves | null
  readonly resolvedTheme: ThemeAppearance
  readonly options: ReadonlyArray<{ id: string; label: string; modes: ReadonlyArray<ThemeAppearance> }>
}) => {
  const slot = (appearance: ThemeAppearance, label: string) => (
    <label className="flex items-center gap-2 text-xs">
      {label}
      <select
        className="bg-background rounded border px-2 py-1"
        value={halves?.[appearance] ?? ""}
        onChange={(event) => setThemeHalf(appearance, event.target.value === "" ? null : event.target.value)}
      >
        <option value="">Follow theme</option>
        {options.filter((option) => option.modes.includes(appearance)).map((option) => (
          <option key={option.id} value={option.id}>{option.label}</option>
        ))}
      </select>
    </label>
  )
  return (
    <div className="flex flex-wrap gap-2">
      {slot("light", "Light uses")}
      {slot("dark", "Dark uses")}
      <span className="text-muted-foreground text-xs">Mix: {resolvedTheme} showing.</span>
    </div>
  )
}

export const ThemeDialog = ({ open, onOpenChange }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) => {
  const snapshot = useTheme()
  const customThemes = useSyncExternalStore(subscribeToCustomThemes, getCustomThemes, () => [])
  const [editorKey, setEditorKey] = useState<number | null>(null)
  const [editing, setEditing] = useState<{ theme: ThemeDefinition | null; duplicateOf: ThemeDefinition | null } | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [customError, setCustomError] = useState<string | null>(null)

  const closeEditor = (): void => {
    clearThemePreview()
    setEditing(null)
  }

  const importFile = (file: File): void => {
    setImportError(null)
    void file.text().then((text) => {
      try {
        const parsed = parseThemeFile(JSON.parse(text) as unknown)
        const installed = installCustomTheme(parsed)
        setTheme(installed.id)
      } catch (failure) {
        setImportError(failure instanceof Error ? failure.message : "That file is not a valid theme.")
      }
    }).catch(() => setImportError("That file could not be read."))
  }

  const duplicateTheme = (theme: ThemeDefinition): void => {
    setCustomError(null)
    setEditing({ theme: null, duplicateOf: theme })
    setEditorKey(Date.now())
  }

  const deleteTheme = (theme: ThemeDefinition): void => {
    setCustomError(null)
    if (!window.confirm(`Delete the theme "${theme.label}"?`)) return
    try {
      if (snapshot.theme === theme.id || snapshot.halves?.light === theme.id || snapshot.halves?.dark === theme.id) setTheme("system")
      removeCustomTheme(theme.id)
    } catch (failure) {
      setCustomError(failure instanceof Error ? failure.message : "That theme could not be deleted.")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Theme</DialogTitle>
          <DialogDescription>Pick a palette and how closely it follows the operating system.</DialogDescription>
        </DialogHeader>
        {editing ? (
          <ThemeEditor
            key={editorKey ?? 0}
            initial={editing.theme}
            duplicateOf={editing.duplicateOf}
            onClose={closeEditor}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium">Appearance</span>
              {(["light", "dark", "system"] as const).map((mode) => (
                <Button key={mode} type="button" size="sm" variant={snapshot.appearanceMode === mode ? "default" : "outline"} onClick={() => setAppearanceMode(mode)}>
                  {mode === "light" ? "Light" : mode === "dark" ? "Dark" : "System"}
                </Button>
              ))}
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium">Library</span>
              <div className={`flex items-center gap-2 rounded-lg border p-2 ${snapshot.theme === "system" ? "border-primary ring-1 ring-ring" : ""}`}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">System stock</span>
                  <span className="text-muted-foreground block text-xs">The built-in monochrome palette</span>
                </span>
                {snapshot.theme === "system" ? (
                  <span className="text-muted-foreground text-xs">Active</span>
                ) : (
                  <Button type="button" size="sm" variant="outline" onClick={() => setTheme("system")}>Use</Button>
                )}
              </div>
              {BUILT_IN_THEMES.map((theme) => (
                <ThemeCard key={theme.id} theme={theme} mode={snapshot.resolvedTheme} isActive={snapshot.theme === theme.id} onUse={() => setTheme(theme.id)} onDuplicate={() => duplicateTheme(theme)} />
              ))}
              {customThemes.map((theme) => (
                <ThemeCard
                  key={theme.id}
                  theme={theme}
                  mode={snapshot.resolvedTheme}
                  isActive={snapshot.theme === theme.id}
                  onUse={() => setTheme(theme.id)}
                  onEdit={() => { setEditing({ theme, duplicateOf: null }); setEditorKey(Date.now()) }}
                  onDuplicate={() => duplicateTheme(theme)}
                  onRemove={() => deleteTheme(theme)}
                />
              ))}
            </div>
            <HalvesEditor
              halves={snapshot.halves}
              resolvedTheme={snapshot.resolvedTheme}
              options={[
                ...BUILT_IN_THEMES.map((theme) => ({ id: theme.id, label: theme.label, modes: getThemeModes(theme) })),
                ...customThemes.map((theme) => ({ id: theme.id, label: theme.label, modes: getThemeModes(theme) })),
              ]}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" onClick={() => { setEditing({ theme: null, duplicateOf: null }); setEditorKey(Date.now()) }}>New custom theme</Button>
              <label className="rounded border px-2 py-1 text-xs">
                Import file
                <input
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ""
                    if (file) importFile(file)
                  }}
                />
              </label>
              {importError && <span role="alert" className="text-destructive text-xs">{importError}</span>}
              {customError && <span role="alert" className="text-destructive text-xs">{customError}</span>}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

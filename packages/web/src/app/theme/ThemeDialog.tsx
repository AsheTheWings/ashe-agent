import { useRef, useState, useSyncExternalStore } from "react"
import { CopyIcon, DownloadIcon, PencilIcon, PlusIcon, Trash2Icon, UploadIcon } from "lucide-react"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog.tsx"
import { Badge } from "@/components/ui/badge.tsx"
import { Button } from "@/components/ui/button.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx"
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
    <div className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-2 transition-colors ${isActive ? "border-primary bg-accent/50" : "hover:bg-muted/40"}`}>
      <span className="flex shrink-0 items-center" aria-hidden="true">
        <span className="size-4 rounded-full border" style={{ backgroundColor: dot.canvas }} />
        <span className="-ml-1.5 size-4 rounded-full border" style={{ backgroundColor: dot.accent }} />
        <span className="-ml-1.5 size-4 rounded-full border" style={{ backgroundColor: dot.action }} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{theme.label}</span>
        <span className="text-muted-foreground block text-[11px]">
          {mode === theme.appearance ? mode : `${theme.appearance} + ${mode}`}
        </span>
      </span>
      <div className="flex shrink-0 items-center gap-1">
        {isActive ? (
          <Badge variant="secondary" className="text-[11px]">Active</Badge>
        ) : (
          <Button type="button" size="xs" variant="outline" onClick={onUse}>Use</Button>
        )}
        {onEdit && (
          <Button type="button" size="icon-xs" variant="ghost" aria-label={`Edit ${theme.label}`} onClick={onEdit}>
            <PencilIcon />
          </Button>
        )}
        {onDuplicate && (
          <Button type="button" size="icon-xs" variant="ghost" aria-label={`Duplicate ${theme.label}`} onClick={onDuplicate}>
            <CopyIcon />
          </Button>
        )}
        <Button type="button" size="icon-xs" variant="ghost" aria-label={`Export ${theme.label}`} onClick={() => downloadThemeFile(theme)}>
          <DownloadIcon />
        </Button>
        {onRemove && (
          <Button type="button" size="icon-xs" variant="ghost" className="text-destructive hover:text-destructive" aria-label={`Delete ${theme.label}`} onClick={onRemove}>
            <Trash2Icon />
          </Button>
        )}
      </div>
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
  const slot = (appearance: ThemeAppearance, label: string) => {
    const eligible = options.filter((option) => option.modes.includes(appearance))
    const currentId = halves?.[appearance] ?? "__follow"
    const currentLabel = currentId === "__follow" ? "Follow theme" : (eligible.find((option) => option.id === currentId)?.label ?? currentId)
    return (
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <Select
          value={currentId}
          onValueChange={(value) => setThemeHalf(appearance, value === "__follow" || value === null ? null : value)}
        >
          <SelectTrigger size="sm" className="w-40 text-xs">
            <SelectValue>{currentLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__follow">Follow theme</SelectItem>
            {eligible.map((option) => (
              <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    )
  }
  return (
    <div className="bg-muted/35 flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">Light &amp; Dark mix</span>
        <span className="text-muted-foreground text-[11px]">Showing {resolvedTheme}</span>
      </div>
      {slot("light", "Light mode uses")}
      {slot("dark", "Dark mode uses")}
    </div>
  )
}

export const ThemeSettingsPanel = () => {
  const snapshot = useTheme()
  const customThemes = useSyncExternalStore(subscribeToCustomThemes, getCustomThemes, () => [])
  const [editorKey, setEditorKey] = useState<number | null>(null)
  const [editing, setEditing] = useState<{ theme: ThemeDefinition | null; duplicateOf: ThemeDefinition | null } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ThemeDefinition | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [customError, setCustomError] = useState<string | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)

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

  const confirmDeleteTheme = (): void => {
    if (pendingDelete === null) return
    const target = pendingDelete
    setPendingDelete(null)
    setCustomError(null)
    try {
      if (snapshot.theme === target.id || snapshot.halves?.light === target.id || snapshot.halves?.dark === target.id) setTheme("system")
      removeCustomTheme(target.id)
    } catch (failure) {
      setCustomError(failure instanceof Error ? failure.message : "That theme could not be deleted.")
    }
  }

  if (editing) {
    return (
      <ThemeEditor
        key={editorKey ?? 0}
        initial={editing.theme}
        duplicateOf={editing.duplicateOf}
        onClose={closeEditor}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Appearance</p>
          <p className="text-muted-foreground text-xs">Match your operating system or lock light or dark mode.</p>
        </div>
        <div className="flex items-center gap-1">
          {(["light", "dark", "system"] as const).map((mode) => (
            <Button
              key={mode}
              type="button"
              size="xs"
              variant={snapshot.appearanceMode === mode ? "default" : "outline"}
              onClick={() => setAppearanceMode(mode)}
            >
              {mode === "light" ? "Light" : mode === "dark" ? "Dark" : "System"}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Palette library</span>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => importInputRef.current?.click()}
            >
              <UploadIcon className="size-3" />
              Import JSON
            </Button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ""
                if (file) importFile(file)
              }}
            />
            <Button
              type="button"
              size="xs"
              onClick={() => { setEditing({ theme: null, duplicateOf: null }); setEditorKey(Date.now()) }}
            >
              <PlusIcon className="size-3" />
              New theme
            </Button>
          </div>
        </div>

        <div className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-2 transition-colors ${snapshot.theme === "system" ? "border-primary bg-accent/50" : "hover:bg-muted/40"}`}>
          <span className="flex shrink-0 items-center" aria-hidden="true">
            <span className="size-4 rounded-full border" style={{ backgroundColor: snapshot.resolvedTheme === "dark" ? "#211f1b" : "#f8f7f3" }} />
            <span className="-ml-1.5 size-4 rounded-full border" style={{ backgroundColor: snapshot.resolvedTheme === "dark" ? "#e5a186" : "#9c462e" }} />
            <span className="-ml-1.5 size-4 rounded-full border" style={{ backgroundColor: snapshot.resolvedTheme === "dark" ? "#403a31" : "#eae6dc" }} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">System stock</span>
            <span className="text-muted-foreground block text-[11px]">Warm paper and charcoal baseline</span>
          </span>
          {snapshot.theme === "system" ? (
            <Badge variant="secondary" className="text-[11px]">Active</Badge>
          ) : (
            <Button type="button" size="xs" variant="outline" onClick={() => setTheme("system")}>Use</Button>
          )}
        </div>

        {BUILT_IN_THEMES.map((theme) => (
          <ThemeCard
            key={theme.id}
            theme={theme}
            mode={snapshot.resolvedTheme}
            isActive={snapshot.theme === theme.id}
            onUse={() => setTheme(theme.id)}
            onDuplicate={() => duplicateTheme(theme)}
          />
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
            onRemove={() => setPendingDelete(theme)}
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

      {importError && <p role="alert" className="text-destructive text-xs">{importError}</p>}
      {customError && <p role="alert" className="text-destructive text-xs">{customError}</p>}

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open) setPendingDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete custom theme?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes “{pendingDelete?.label}” from browser storage. If it is currently active, AsheAgent falls back to System stock.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDeleteTheme}>Delete theme</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

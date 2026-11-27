import { useEffect, useState } from "react"
import { CheckIcon, CopyIcon, KeyboardIcon, PaletteIcon, ShieldCheckIcon, Trash2Icon } from "lucide-react"
import type { SessionSummary } from "@ashe-agent/protocol"
import { useClient } from "@/app/client-context.tsx"
import { ThemeSettingsPanel } from "@/app/theme/ThemeDialog.tsx"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog.tsx"
import { Badge } from "@/components/ui/badge.tsx"
import { Button } from "@/components/ui/button.tsx"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx"
import { Kbd } from "@/components/ui/kbd.tsx"
import { Label } from "@/components/ui/label.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx"
import { Separator } from "@/components/ui/separator.tsx"
import { Switch } from "@/components/ui/switch.tsx"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard.ts"
import type { SessionView } from "@/session/projection.ts"
import { formatAgentLabel, type ShortcutPreferences } from "./types.ts"

export type SettingsTab = "appearance" | "shortcuts" | "session"

export const SettingsDialog = ({
  open,
  onOpenChange,
  initialTab = "appearance",
  shortcuts,
  onShortcutsChange,
  activeSessionId,
  session,
  view,
  onNotify,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly initialTab?: SettingsTab
  readonly shortcuts: ShortcutPreferences
  readonly onShortcutsChange: (next: ShortcutPreferences) => void
  readonly activeSessionId: string | null
  readonly session: SessionSummary | undefined
  readonly view: SessionView | undefined
  readonly onNotify: (message: string) => void
}) => {
  const client = useClient()
  const { isCopied, copyToClipboard } = useCopyToClipboard()
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  const [grants, setGrants] = useState<ReadonlyArray<{ agentTitle: string; permission: string; pattern: string }>>([])
  const [grantTitle, setGrantTitle] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    if (open) setTab(initialTab)
  }, [initialTab, open])

  useEffect(() => {
    setGrants([])
    setGrantTitle(activeSessionId === null ? null : (session?.selection.agentTitle ?? "untitled"))
  }, [activeSessionId, session?.selection.agentTitle])

  useEffect(() => {
    if (!open || activeSessionId === null) return
    let cancelled = false
    void client
      .grants(activeSessionId)
      .then((loaded) => {
        if (cancelled) return
        setGrants(loaded)
        setGrantTitle((current) => current ?? (session?.selection.agentTitle ?? "untitled"))
      })
      .catch(() => {
        if (!cancelled) onNotify("Permissions could not be loaded")
      })
    return () => {
      cancelled = true
    }
  }, [activeSessionId, client, onNotify, open, session?.selection.agentTitle])

  const grantTitles = [...new Set([grantTitle, ...grants.map((grant) => grant.agentTitle)].filter((value): value is string => value !== null))]
  const filteredGrants = grants.filter((grant) => grant.agentTitle === grantTitle)

  const clearGrants = () => {
    if (activeSessionId === null || grantTitle === null) return
    setConfirmClear(false)
    void client.clearGrants(activeSessionId, grantTitle).then((cleared) => {
      setGrants((current) => current.filter((grant) => grant.agentTitle !== grantTitle))
      onNotify(`Cleared ${cleared} grant(s) for ${formatAgentLabel(grantTitle)}`)
    }).catch(() => onNotify("Grants could not be cleared"))
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[85svh] flex-col gap-4 overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>Configure appearance, keyboard behavior, and active session permissions.</DialogDescription>
          </DialogHeader>

          <Tabs value={tab} onValueChange={(value) => setTab(value as SettingsTab)} className="flex min-h-0 flex-1 flex-col gap-3">
            <TabsList className="w-full justify-start">
              <TabsTrigger value="appearance" className="flex-none px-3">
                <PaletteIcon className="size-3.5" />
                Appearance
              </TabsTrigger>
              <TabsTrigger value="shortcuts" className="flex-none px-3">
                <KeyboardIcon className="size-3.5" />
                Shortcuts &amp; Input
              </TabsTrigger>
              <TabsTrigger value="session" className="flex-none px-3">
                <ShieldCheckIcon className="size-3.5" />
                Session
              </TabsTrigger>
            </TabsList>

            <TabsContent value="appearance" className="scrollbar-compact min-h-0 flex-1 overflow-y-auto pr-1">
              <ThemeSettingsPanel />
            </TabsContent>

            <TabsContent value="shortcuts" className="scrollbar-compact min-h-0 flex-1 overflow-y-auto pr-1">
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                  <div className="space-y-0.5">
                    <Label className="text-sm font-medium">View cycle shortcut</Label>
                    <p className="text-muted-foreground text-xs">
                      Cycle between Chat, Session, and Checkpoint window even while the composer has focus.
                    </p>
                  </div>
                  <Select
                    value={shortcuts.viewModifier}
                    onValueChange={(value) =>
                      onShortcutsChange({ ...shortcuts, viewModifier: value === "alt" ? "alt" : "ctrl" })
                    }
                  >
                    <SelectTrigger size="sm" className="w-28">
                      <SelectValue>{shortcuts.viewModifier === "alt" ? "Alt+I" : "Ctrl+I"}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ctrl">Ctrl+I</SelectItem>
                      <SelectItem value="alt">Alt+I</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                  <div className="space-y-0.5">
                    <Label htmlFor="type-to-compose-switch" className="text-sm font-medium">Type to compose</Label>
                    <p className="text-muted-foreground text-xs">
                      Typing printable characters anywhere outside an input automatically focuses the message box.
                    </p>
                  </div>
                  <Switch
                    id="type-to-compose-switch"
                    checked={shortcuts.typeToFocus}
                    onCheckedChange={(checked) => onShortcutsChange({ ...shortcuts, typeToFocus: checked })}
                  />
                </div>

                <div className="bg-muted/35 flex flex-col gap-2 rounded-lg border p-3 text-xs">
                  <p className="font-medium text-foreground">Keyboard reference</p>
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Cycle Chat / Session / Checkpoint</span>
                    <Kbd>{shortcuts.viewModifier === "alt" ? "Alt+I" : "Ctrl+I"}</Kbd>
                  </div>
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Return to Chat view</span>
                    <Kbd>Esc</Kbd>
                  </div>
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Send message / new line</span>
                    <span className="flex items-center gap-1"><Kbd>Enter</Kbd> / <Kbd>Shift+Enter</Kbd></span>
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="session" className="scrollbar-compact min-h-0 flex-1 overflow-y-auto pr-1">
              {activeSessionId === null ? (
                <p className="text-muted-foreground py-8 text-center text-sm">
                  Open a session to inspect its details and manage permission grants.
                </p>
              ) : (
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-2 rounded-lg border p-3 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">Session ID</span>
                      <div className="flex items-center gap-1.5">
                        <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-[11px]">{activeSessionId}</code>
                        <Button type="button" size="icon-xs" variant="ghost" aria-label="Copy session ID" onClick={() => copyToClipboard(activeSessionId)}>
                          {isCopied ? <CheckIcon /> : <CopyIcon />}
                        </Button>
                      </div>
                    </div>
                    <Separator />
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">Applied agent</span>
                      <Badge variant="outline" className="font-mono text-[11px]">{formatAgentLabel(view?.agent ?? session?.selection.agentTitle)}</Badge>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">Applied model</span>
                      <span className="truncate font-mono text-[11px]">{view?.model ?? session?.selection.modelSettings.modelId ?? "none"}</span>
                    </div>
                    {view?.sessionDir && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground shrink-0">Workspace</span>
                        <span className="truncate font-mono text-[11px]" title={view.sessionDir}>{view.sessionDir}</span>
                      </div>
                    )}
                    {view?.forkedFrom && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground shrink-0">Forked from</span>
                        <span className="truncate font-mono text-[11px]">{view.forkedFrom.sessionId}</span>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col gap-2.5 rounded-lg border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">Persisted permission grants</p>
                        <p className="text-muted-foreground text-xs">Always-allow approvals stored per agent profile.</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Select value={grantTitle ?? ""} onValueChange={(value) => setGrantTitle(value)}>
                          <SelectTrigger size="sm" className="w-36 text-xs">
                            <SelectValue placeholder="Agent">
                              {grantTitle !== null ? formatAgentLabel(grantTitle) : "Agent"}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {grantTitles.map((title) => (
                              <SelectItem key={title} value={title}>{formatAgentLabel(title)}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          type="button"
                          size="xs"
                          variant="destructive"
                          disabled={grantTitle === null || filteredGrants.length === 0}
                          onClick={() => setConfirmClear(true)}
                        >
                          <Trash2Icon className="size-3" />
                          Clear all
                        </Button>
                      </div>
                    </div>

                    {filteredGrants.length === 0 ? (
                      <p className="text-muted-foreground py-3 text-center text-xs">
                        No persisted grants for {grantTitle !== null ? formatAgentLabel(grantTitle) : "this agent"}.
                      </p>
                    ) : (
                      <ul className="divide-y rounded-md border">
                        {filteredGrants.map((grant, index) => (
                          <li key={index} className="flex items-center justify-between gap-2 px-2.5 py-1.5 font-mono text-xs">
                            <Badge variant="secondary" className="text-[11px]">{grant.permission}</Badge>
                            <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">{grant.pattern}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear permission grants?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes every persisted “Always allow” approval for “{formatAgentLabel(grantTitle)}”. Future tool calls will prompt for permission again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={clearGrants}>Clear grants</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

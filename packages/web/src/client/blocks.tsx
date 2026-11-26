import {
  AlertTriangleIcon,
  ChevronRightIcon,
  DownloadIcon,
  HelpCircleIcon,
  ShieldAlertIcon,
} from "lucide-react"
import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from "react"
import { cn } from "cn"
import { useClient, useClientState } from "@/app/client-context.tsx"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx"
import { Badge } from "@/components/ui/badge.tsx"
import { Button } from "@/components/ui/button.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.tsx"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx"
import { Textarea } from "@/components/ui/textarea.tsx"
import type { PendingPermission, QuestionsItem, UserItem } from "@/session/projection.ts"
import { PlainText } from "./markdown.tsx"

let renderFailureReporter: (() => void) | null = null
let draftFailureReporter: (() => void) | null = null

export const setRenderFailureReporter = (reporter: (() => void) | null) => {
  renderFailureReporter = reporter
}

export const setDraftFailureReporter = (reporter: (() => void) | null) => {
  draftFailureReporter = reporter
}

export const reportDraftFailure = () => {
  draftFailureReporter?.()
}

export class BlockBoundary extends Component<
  { readonly children: ReactNode; readonly fallback?: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override componentDidCatch(_error: Error, _info: ErrorInfo) {
    renderFailureReporter?.()
  }
  override render() {
    return this.state.failed ? (
      <Alert variant="destructive" className="my-1">
        <AlertTriangleIcon className="size-4" />
        <AlertTitle>Block render error</AlertTitle>
        <AlertDescription className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span>This block failed to render; the rest of the session remains usable.</span>
            <Button type="button" size="xs" variant="outline" onClick={() => this.setState({ failed: false })}>
              Retry
            </Button>
          </div>
          {this.props.fallback !== undefined && <div>{this.props.fallback}</div>}
        </AlertDescription>
      </Alert>
    ) : (
      this.props.children
    )
  }
}

export const DisclosureCard = ({
  summary,
  children,
  defaultOpen = false,
  className,
}: {
  readonly summary: ReactNode
  readonly children: ReactNode
  readonly defaultOpen?: boolean
  readonly className?: string
}) => {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn("bg-card rounded-xl border", className)}>
      <CollapsibleTrigger className="hover:bg-muted/50 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-start text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon className={cn("text-muted-foreground size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="flex min-w-0 flex-1 items-center gap-2">{summary}</span>
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted className={cn("border-t px-3 py-2.5 text-sm", !open && "hidden")}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

export const RetainedMedia = ({
  entry,
}: {
  readonly entry: {
    readonly content: { readonly contentId: string; readonly representationId: string; readonly mediaType: string }
    readonly name: string
  }
}) => {
  const client = useClient()
  const sessionId = useClientState((state) => state.activeSessionId)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setUrl(null)
    setError(null)
    if (sessionId === null) return
    let active = true
    let created: string | null = null
    void client
      .downloadContent(sessionId, entry.content.contentId, entry.content.representationId)
      .then((blob) => {
        if (!active) return
        created = URL.createObjectURL(blob)
        setUrl(created)
      })
      .catch((failure: unknown) => {
        if (!active) return
        setError(failure instanceof Error ? failure.message : "download failed")
      })
    return () => {
      active = false
      if (created !== null) URL.revokeObjectURL(created)
    }
  }, [client, entry.content.contentId, entry.content.representationId, sessionId])

  const safeImage = /^image\/(png|jpeg|webp|gif)$/.test(entry.content.mediaType)
  if (error !== null) return <span className="text-destructive text-xs">{error}</span>
  if (url === null) return <span className="text-muted-foreground text-xs">Loading {entry.name}…</span>
  if (safeImage) return <img src={url} alt={entry.name} className="max-h-96 max-w-full rounded-lg border object-contain" />
  if (entry.content.mediaType === "application/pdf") {
    return (
      <div className="bg-muted/40 inline-flex flex-col gap-1 rounded-lg border p-2.5 text-xs">
        <a className="text-primary inline-flex items-center gap-1.5 font-medium underline underline-offset-2" href={url} download={entry.name}>
          <DownloadIcon className="size-3.5" />
          Download PDF original
        </a>
        <span className="text-muted-foreground">Retained page images are not available for this representation.</span>
      </div>
    )
  }
  return (
    <a className="text-primary inline-flex items-center gap-1.5 text-xs font-medium underline underline-offset-2" href={url} download={entry.name}>
      <DownloadIcon className="size-3.5" />
      Download {entry.name} ({entry.content.mediaType})
    </a>
  )
}

export const PatchDiffPre = ({ patch }: { readonly patch: string }) => (
  <pre className="scrollbar-compact bg-muted/50 max-h-96 overflow-auto rounded-lg border p-2.5 font-mono text-xs leading-relaxed">
    {patch.split("\n").map((line, index) => {
      const tone =
        line.startsWith("+") && !line.startsWith("+++")
          ? "bg-positive-background/70 text-positive"
          : line.startsWith("-") && !line.startsWith("---")
            ? "bg-destructive/10 text-destructive"
            : line.startsWith("@@") || line.startsWith("***")
              ? "text-muted-foreground font-medium"
              : ""
      return (
        <span key={index} className={cn("block px-1", tone)}>
          {line || " "}
        </span>
      )
    })}
  </pre>
)

export const Questions = ({ item }: { readonly item: QuestionsItem }) => {
  const client = useClient()
  const owned = useClientState((state) => state.owned.questions.includes(item.id))
  const [answers, setAnswers] = useState<Record<string, string>>({})
  if (!item.open) {
    return (
      <DisclosureCard
        summary={
          <>
            <HelpCircleIcon className="text-muted-foreground size-3.5 shrink-0" />
            <span className="text-muted-foreground">Questions answered</span>
          </>
        }
      >
        <ul className="flex flex-col gap-2 text-xs">
          {item.questions.map((question) => (
            <li key={question.id} className="flex flex-col gap-0.5">
              <span className="font-medium text-foreground">
                {question.header}: <span className="font-normal text-muted-foreground">{question.question}</span>
              </span>
              <span className="text-foreground">
                {item.answers?.find((answer) => answer.id === question.id)?.selection ?? "Skipped"}
              </span>
            </li>
          ))}
        </ul>
      </DisclosureCard>
    )
  }
  return (
    <section
      className="bg-card flex flex-col gap-3.5 rounded-xl border border-primary/30 p-4 shadow-xs"
      data-attention="question"
    >
      <div className="flex items-center gap-2 text-xs font-medium text-primary">
        <HelpCircleIcon className="size-4" />
        <span>Agent question</span>
      </div>
      {item.feedback !== null && <PlainText text={item.feedback} className="text-xs text-muted-foreground" />}
      {item.questions.map((question) => (
        <fieldset key={question.id} className="flex flex-col gap-2">
          <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {question.header}
          </legend>
          <p className="text-sm text-foreground">{question.question}</p>
          <div className="flex flex-wrap gap-1.5">
            {question.options.map((option) => {
              const selected = answers[question.id] === option.label
              return (
                <Button
                  key={option.label}
                  type="button"
                  size="sm"
                  variant={selected ? "default" : "outline"}
                  aria-pressed={selected}
                  onClick={() => setAnswers({ ...answers, [question.id]: option.label })}
                  title={option.description}
                >
                  {option.label}
                </Button>
              )
            })}
          </div>
        </fieldset>
      ))}
      {owned ? (
        <div className="flex justify-end pt-1">
          <Button
            type="button"
            size="sm"
            onClick={() =>
              void client
                .answerQuestion(
                  item.id,
                  item.questions.map((question) => ({
                    id: question.id,
                    ...(answers[question.id] === undefined ? {} : { selection: answers[question.id] }),
                  })),
                )
                .catch(() => {})
            }
          >
            Send answers
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">This question belongs to another connected browser.</p>
      )}
    </section>
  )
}

const NO_PERMISSIONS: ReadonlyArray<PendingPermission> = []

export const Permissions = () => {
  const client = useClient()
  const permissions = useClientState((state) =>
    state.activeSessionId === null ? NO_PERMISSIONS : (state.views[state.activeSessionId]?.permissions ?? NO_PERMISSIONS),
  )
  const owned = useClientState((state) => state.owned.permissions)
  if (permissions.length === 0) return null
  return (
    <div className="flex flex-col gap-2" data-attention="permission">
      {permissions.map((permission) =>
        owned.includes(permission.requestId) ? (
          <div
            key={permission.requestId}
            className="bg-warning-background/40 border-warning/40 flex flex-wrap items-center gap-2 rounded-xl border p-3 text-sm"
          >
            <ShieldAlertIcon className="text-warning size-4 shrink-0" />
            <Badge variant="outline" className="font-mono text-xs">{permission.permission}</Badge>
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{permission.subjects.join(", ")}</span>
            <div className="flex items-center gap-1.5">
              <Button type="button" size="xs" variant="default" onClick={() => void client.answerPermission(permission.requestId, "once").catch(() => {})}>
                Allow once
              </Button>
              <Button type="button" size="xs" variant="outline" onClick={() => void client.answerPermission(permission.requestId, "always").catch(() => {})}>
                Always allow
              </Button>
              <Button type="button" size="xs" variant="destructive" onClick={() => void client.answerPermission(permission.requestId, "reject").catch(() => {})}>
                Reject
              </Button>
            </div>
          </div>
        ) : (
          <p key={permission.requestId} className="text-muted-foreground text-xs">
            Waiting on another connected browser for {permission.permission}.
          </p>
        ),
      )}
    </div>
  )
}

export const RewindDialog = ({
  item,
  attachments,
  removedTurns,
  pendingInputs,
  onCancel,
  onSubmit,
}: {
  readonly item: UserItem | null
  readonly attachments: ReadonlyArray<string>
  readonly removedTurns: ReadonlyArray<string>
  readonly pendingInputs: ReadonlyArray<string>
  readonly onCancel: () => void
  readonly onSubmit: (text: string) => void
}) => {
  const [text, setText] = useState("")
  useEffect(() => {
    if (item !== null) {
      setText(item.messages.map((message) => message.text).join("\n\n"))
    }
  }, [item])

  return (
    <Dialog open={item !== null} onOpenChange={(open) => { if (!open) onCancel() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Rewind this turn</DialogTitle>
          <DialogDescription>
            Edit the prompt and rerun from here. This removes this turn and every later turn and pending message; external effects and workspace files are not rolled back.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Alert variant="destructive">
            <AlertTriangleIcon className="size-4" />
            <AlertDescription className="text-xs">
              <p className="font-medium">Removes {removedTurns.length} turn(s):</p>
              <ul className="mt-1 list-inside list-disc space-y-0.5">
                {removedTurns.slice(0, 5).map((turn, index) => (
                  <li key={index} className="truncate">{turn}</li>
                ))}
                {removedTurns.length > 5 && <li>…and {removedTurns.length - 5} more</li>}
              </ul>
              {pendingInputs.length > 0 && (
                <>
                  <p className="mt-1.5 font-medium">Pending inputs removed:</p>
                  <ul className="mt-0.5 list-inside list-disc space-y-0.5">
                    {pendingInputs.map((input, index) => (
                      <li key={index} className="truncate">{input}</li>
                    ))}
                  </ul>
                </>
              )}
            </AlertDescription>
          </Alert>

          <Textarea
            autoFocus
            className="min-h-28 text-sm"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />

          {attachments.length > 0 && (
            <p className="text-muted-foreground text-xs">
              Original attachments stay attached and cannot be replaced here: {attachments.join(", ")}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button type="button" onClick={() => onSubmit(text)}>Confirm rewind</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

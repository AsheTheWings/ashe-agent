import { useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  GitForkIcon,
  Loader2Icon,
  MessageSquareIcon,
  PencilIcon,
  RotateCcwIcon,
} from "lucide-react"
import type { SessionObservation } from "@ashe-agent/protocol"
import { cn } from "cn"
import { Alert, AlertDescription } from "@/components/ui/alert.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard.ts"
import type { AssistantItem, SessionView, UserItem } from "@/session/projection.ts"
import { DisclosureCard, Permissions, Questions } from "./blocks.tsx"
import { ClaudeCopyIcon } from "./icons.tsx"
import { MarkdownText, PlainText } from "./markdown.tsx"
import { formatFriendlyRelativeTime, formatFullTime } from "./types.ts"

const USER_MESSAGE_FOLD_PX = 300

const ACTION_BTN_CLASS =
  "text-muted-foreground hover:text-foreground hover:bg-accent/70 focus-visible:ring-ring/60 inline-flex size-6 items-center justify-center rounded-md bg-transparent outline-none transition-colors disabled:pointer-events-none disabled:opacity-40 focus-visible:ring-2"

const AssistantBlock = ({
  item,
  now,
  onInspectModelCall,
}: {
  readonly item: AssistantItem
  readonly now: number
  readonly onInspectModelCall?: ((modelCallId: string) => void) | undefined
}) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard()
  const visibleParts = item.parts.filter((part) => part.type === "text")
  const hasError = item.error !== null || item.status === "cancelled" || item.status === "interrupted"

  if (visibleParts.length === 0 && !hasError) return null

  const copyableText = visibleParts
    .map((part) => part.text)
    .join("\n\n")
    .trim()

  const handlePartClick = (event: React.MouseEvent, modelCallId: string) => {
    if (!event.shiftKey || onInspectModelCall === undefined) return
    const selection = typeof window !== "undefined" ? window.getSelection() : null
    if (selection !== null && !selection.isCollapsed) return
    event.preventDefault()
    onInspectModelCall(modelCallId)
  }

  return (
    <div className="group flex flex-col gap-2" data-run-id={item.runId} data-item-id={item.id}>
      {visibleParts.map((part) => (
        <div
          key={part.id}
          data-model-call-id={part.modelCallId}
          onClick={(event) => handlePartClick(event, part.modelCallId)}
        >
          <MarkdownText text={part.text} className="text-[0.9375rem] text-foreground" />
        </div>
      ))}

      {hasError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{item.error ?? `Execution ${item.status}`}</AlertDescription>
        </Alert>
      )}

      {(copyableText !== "" || item.timestamp !== undefined) && (
        <div
          data-slot="assistant-message-actions"
          className="-ms-1 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
        >
          {copyableText !== "" && (
            <div className="flex items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={isCopied ? "Copied" : "Copy"}
                      className={ACTION_BTN_CLASS}
                      onClick={() => copyToClipboard(copyableText)}
                    />
                  }
                >
                  {isCopied ? <CheckIcon className="size-3.5" /> : <ClaudeCopyIcon className="size-4" />}
                  <span className="sr-only">{isCopied ? "Copied" : "Copy"}</span>
                </TooltipTrigger>
                <TooltipContent>{isCopied ? "Copied" : "Copy"}</TooltipContent>
              </Tooltip>
            </div>
          )}
          {item.timestamp !== undefined && item.timestamp > 0 && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <time
                    dateTime={new Date(item.timestamp).toISOString()}
                    className="text-muted-foreground/60 cursor-default text-[11px] tabular-nums"
                  />
                }
              >
                {formatFriendlyRelativeTime(item.timestamp, now)}
              </TooltipTrigger>
              <TooltipContent>{formatFullTime(item.timestamp)}</TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  )
}

const UserBubble = ({
  item,
  now,
  observation,
  onRewind,
  onEdit,
  onFork,
}: {
  readonly item: UserItem
  readonly now: number
  readonly observation: SessionObservation | undefined
  readonly onRewind: (item: UserItem) => void
  readonly onEdit?: ((item: UserItem, text: string) => Promise<boolean>) | undefined
  readonly onFork: (item: UserItem) => void
}) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard()
  const fullText = item.messages.map((message) => message.text).join("\n\n")
  const [editing, setEditing] = useState(false)
  const [draftText, setDraftText] = useState(fullText)
  const [saving, setSaving] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const editTextareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!editing) setDraftText(fullText)
  }, [editing, fullText])

  // Measure rendered body height to fold long user messages at Claude's 300px threshold.
  useLayoutEffect(() => {
    if (editing) return
    const el = bodyRef.current
    if (el === null) return
    const measure = () => {
      setOverflows(el.scrollHeight > USER_MESSAGE_FOLD_PX + 2)
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [editing, fullText])

  const isWideEdit = draftText.includes("\n") || draftText.length > 60

  // Auto-size inline edit textarea up to 40svh / 24rem matching Claude's message-edit-box.
  useLayoutEffect(() => {
    if (!editing) return
    const el = editTextareaRef.current
    if (el === null) return
    const maxHeight = Math.min(384, Math.max(160, Math.round(window.innerHeight * 0.4)))
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
  }, [draftText, editing, isWideEdit])

  useEffect(() => {
    if (!editing) return
    const el = editTextareaRef.current
    if (el === null) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editing])

  const canModify = item.runId !== null && observation !== undefined && observation.execution.canRewind
  const canSave = !saving && draftText.trim() !== "" && draftText !== fullText

  const submitEdit = async () => {
    if (!canSave) return
    if (onEdit === undefined) {
      setEditing(false)
      onRewind(item)
      return
    }
    setSaving(true)
    try {
      const ok = await onEdit(item, draftText)
      if (ok) setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  const stableMessageId = item.messages[0]?.id ?? item.id
  const userAnchor = item.runId ?? stableMessageId
  const userTimestamp = item.timestamp ?? item.messages[0]?.timestamp

  if (editing) {
    return (
      <div
        data-slot="user-message-edit"
        data-user-item-id={item.id}
        data-user-message-id={stableMessageId}
        data-user-anchor={userAnchor}
        data-run-id={item.runId ?? undefined}
        className="group flex w-full flex-col items-end gap-2"
      >
        <div
          onClick={(event) => {
            if (event.target !== editTextareaRef.current) editTextareaRef.current?.focus()
          }}
          className={cn(
            "bg-background text-foreground max-w-[85%] cursor-text overflow-hidden rounded-[12px] p-0 shadow-[0_0_0_1px_var(--border)] transition-shadow focus-within:shadow-[0_0_0_1px_var(--ring),0_0_6px_1px_color-mix(in_srgb,var(--ring)_40%,transparent)]",
            isWideEdit ? "w-[85%]" : "w-fit min-w-[min(100%,10rem)]",
          )}
        >
          <textarea
            ref={editTextareaRef}
            rows={1}
            dir="auto"
            aria-label="Edit message"
            disabled={saving}
            value={draftText}
            onChange={(event) => setDraftText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                event.stopPropagation()
                if (!saving) {
                  setDraftText(fullText)
                  setEditing(false)
                }
              } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void submitEdit()
              }
            }}
            className={cn(
              "scrollbar-compact block max-h-[min(40svh,24rem)] w-full max-w-full resize-none overflow-y-auto border-0 bg-transparent px-4 py-3 text-[15px] leading-[21px] font-normal text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50",
              !isWideEdit && "[field-sizing:content]",
            )}
          />
        </div>

        <div className="flex items-center justify-end gap-1.5">
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setDraftText(fullText)
              setEditing(false)
            }}
            className="text-foreground hover:bg-accent/70 focus-visible:ring-ring/60 inline-flex h-6 items-center justify-center rounded-[6px] bg-transparent px-2.5 text-xs font-normal outline-none transition-colors disabled:opacity-40 focus-visible:ring-2"
          >
            Cancel
          </button>

          <button
            type="button"
            disabled={!canSave}
            onClick={() => void submitEdit()}
            className={cn(
              "focus-visible:ring-ring/60 inline-flex h-6 items-center justify-center gap-1 rounded-[6px] px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2",
              canSave
                ? "bg-foreground text-background hover:bg-foreground/90"
                : "bg-muted text-muted-foreground/50",
            )}
          >
            {saving && <Loader2Icon className="size-3 animate-spin" />}
            Save
          </button>
        </div>
      </div>
    )
  }

  const folded = overflows && !expanded

  return (
    <div
      data-user-item-id={item.id}
      data-user-message-id={stableMessageId}
      data-user-anchor={userAnchor}
      className="group flex flex-col items-end gap-1.5"
      data-run-id={item.runId ?? undefined}
    >
      <div className="bg-tint text-foreground border-border/70 flex max-w-[85%] flex-col rounded-[12px] border px-4 py-3 text-[15px] leading-[21px]">
        <div
          ref={bodyRef}
          data-slot="user-message-body"
          data-folded={folded ? "true" : "false"}
          style={
            folded
              ? {
                  maxHeight: `${USER_MESSAGE_FOLD_PX}px`,
                  maskImage: "linear-gradient(to bottom, black calc(100% - 3rem), transparent 100%)",
                  WebkitMaskImage: "linear-gradient(to bottom, black calc(100% - 3rem), transparent 100%)",
                }
              : undefined
          }
          className={cn("min-w-0 break-words", folded && "overflow-hidden")}
        >
          {item.messages.map((message) => (
            <PlainText key={message.id} text={message.text} className="leading-[21px]" />
          ))}
        </div>

        {overflows && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
            className="text-muted-foreground hover:text-foreground mt-1.5 inline-flex items-center gap-1 self-start text-xs font-medium transition-colors"
          >
            {expanded ? (
              <>
                <ChevronUpIcon className="size-3.5" />
                <span>Show less</span>
              </>
            ) : (
              <>
                <ChevronDownIcon className="size-3.5" />
                <span>Show more</span>
              </>
            )}
          </button>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {userTimestamp !== undefined && userTimestamp > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <time
                  dateTime={new Date(userTimestamp).toISOString()}
                  className="text-muted-foreground/60 cursor-default text-[11px] tabular-nums"
                />
              }
            >
              {formatFriendlyRelativeTime(userTimestamp, now)}
            </TooltipTrigger>
            <TooltipContent>{formatFullTime(userTimestamp)}</TooltipContent>
          </Tooltip>
        )}
        <div
          data-slot="user-message-actions"
          className="flex items-center justify-end gap-0.5"
        >
        {item.runId !== null && observation !== undefined && (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Rewind"
                    className={ACTION_BTN_CLASS}
                    disabled={!canModify}
                    onClick={() => onRewind(item)}
                  />
                }
              >
                <RotateCcwIcon className="size-3.5" />
                <span className="sr-only">Rewind</span>
              </TooltipTrigger>
              <TooltipContent>Rewind</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Edit"
                    className={ACTION_BTN_CLASS}
                    disabled={!canModify}
                    onClick={() => {
                      setDraftText(fullText)
                      setEditing(true)
                    }}
                  />
                }
              >
                <PencilIcon className="size-3.5" />
                <span className="sr-only">Edit</span>
              </TooltipTrigger>
              <TooltipContent>Edit</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Fork"
                    className={ACTION_BTN_CLASS}
                    disabled={!observation.execution.canFork}
                    onClick={() => onFork(item)}
                  />
                }
              >
                <GitForkIcon className="size-3.5" />
                <span className="sr-only">Fork</span>
              </TooltipTrigger>
              <TooltipContent>Fork</TooltipContent>
            </Tooltip>
          </>
        )}

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={isCopied ? "Copied" : "Copy"}
                className={ACTION_BTN_CLASS}
                onClick={() => copyToClipboard(fullText)}
              />
            }
          >
            {isCopied ? <CheckIcon className="size-3.5" /> : <ClaudeCopyIcon className="size-4" />}
            <span className="sr-only">{isCopied ? "Copied" : "Copy"}</span>
          </TooltipTrigger>
          <TooltipContent>{isCopied ? "Copied" : "Copy"}</TooltipContent>
        </Tooltip>
        </div>
      </div>
    </div>
  )
}

export const Chat = ({
  view,
  observation,
  onRewind,
  onEdit,
  onFork,
  onInspectModelCall,
  elasticRoomPx = 0,
}: {
  readonly view: SessionView
  readonly observation: SessionObservation | undefined
  readonly onRewind: (item: UserItem) => void
  readonly onEdit?: (item: UserItem, text: string) => Promise<boolean>
  readonly onFork: (item: UserItem) => void
  readonly onInspectModelCall?: (modelCallId: string) => void
  readonly elasticRoomPx?: number
}) => {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div data-slot="chat-transcript" className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pt-6 pb-8">
      {view.items.map((item) => {
        if (item.kind === "user") {
          return (
            <UserBubble
              key={item.id}
              item={item}
              now={now}
              observation={observation}
              onRewind={onRewind}
              onEdit={onEdit}
              onFork={onFork}
            />
          )
        }
        if (item.kind === "assistant") {
          return <AssistantBlock key={item.id} item={item} now={now} onInspectModelCall={onInspectModelCall} />
        }
      if (item.kind === "questions") {
        return <Questions key={item.id} item={item} />
      }
      if (item.kind === "error") {
        return (
          <Alert key={item.id} variant="destructive" role="alert">
            <AlertDescription>{item.text}</AlertDescription>
          </Alert>
        )
      }
      if (item.kind === "notice") {
        return (
          <p key={item.id} className="text-muted-foreground text-center text-xs">
            {item.text}
          </p>
        )
      }
      if (item.kind === "mark") {
        return (
          <div key={item.id} className="flex items-center gap-3 py-1">
            <span className="bg-border h-px flex-1" />
            <span className="text-muted-foreground text-[11px] uppercase tracking-wider">
              {item.mark.replaceAll("_", " ")}
            </span>
            <span className="bg-border h-px flex-1" />
          </div>
        )
      }
      if (item.kind === "developer") return null
      if (item.kind === "entry") {
        return (
          <DisclosureCard key={item.id} summary={`${item.entry.kind} #${item.entry.number}`}>
            <PlainText text={Object.values(item.entry.fields).join("\n\n")} className="text-xs" />
          </DisclosureCard>
        )
      }
      return null
    })}
    <Permissions />
    {view.items.length === 0 && (
      <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-center">
        <div className="bg-muted flex size-10 items-center justify-center rounded-xl border">
          <MessageSquareIcon className="size-5" />
        </div>
        <p className="text-sm font-medium text-foreground">Start a conversation</p>
        <p className="max-w-xs text-xs">Send a message below to start this session.</p>
      </div>
    )}
    <div
      aria-hidden="true"
      data-slot="chat-extra-space"
      style={{ minHeight: `${elasticRoomPx}px` }}
      className="shrink-0"
    />
  </div>
  )
}

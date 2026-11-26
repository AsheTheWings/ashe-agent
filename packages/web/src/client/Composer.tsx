import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  AlertTriangleIcon,
  CheckIcon,
  ImageIcon,
  Loader2Icon,
  XIcon,
} from "lucide-react"
import type { SessionObservation } from "@ashe-agent/protocol"
import { cn } from "cn"
import { useClient, useClientState } from "@/app/client-context.tsx"
import { Badge } from "@/components/ui/badge.tsx"
import { Checkbox } from "@/components/ui/checkbox.tsx"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx"
import { ProtocolError } from "@/session/connection.ts"
import type { PendingInput, SessionView } from "@/session/projection.ts"
import { reportDraftFailure } from "./blocks.tsx"
import type { Draft, DraftAttachment, DraftRecord, DraftStore, Submission } from "./drafts.ts"
import { ClaudeArrowUpIcon, ClaudePlusIcon, ClaudeSendIcon, ClaudeStopIcon } from "./icons.tsx"
import { PREFS_KEY, formatBytes, randomId } from "./types.ts"

export type ComposerNotificationReport = {
  readonly statusText: string | null
  readonly statusTimestamp: number
  readonly storageError: string | null
  readonly storageErrorTimestamp: number
  readonly unacceptedSubmissions: ReadonlyArray<{
    readonly submission: Submission
    readonly onRestore: () => void
  }>
  readonly inTabRecoverables: ReadonlyArray<{
    readonly draft: Draft
    readonly onUse: () => void
  }>
  readonly onCopyDraft: () => void
}

type AttachmentPreviewMeta = {
  readonly objectUrl?: string
  readonly lineCount?: number
}

const formatEffortLabel = (value: string | null): string => {
  if (value === null || value === "") return "Default"
  return value.charAt(0).toUpperCase() + value.slice(1)
}

const isImageAttachment = (attachment: DraftAttachment): boolean =>
  /^image\/(png|jpe?g|webp|gif|avif|bmp|svg\+xml)$/i.test(attachment.mediaType) ||
  /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(attachment.name)

const isTextLikeFile = (file: File): boolean =>
  file.type.startsWith("text/") ||
  /^(application\/(json|xml|javascript|typescript|x-yaml))$/i.test(file.type) ||
  /\.(txt|md|markdown|json|ya?ml|toml|csv|ts|tsx|js|jsx|py|rs|go|sh|css|html|xml|sql|log)$/i.test(file.name)

const extensionBadge = (attachment: DraftAttachment): string => {
  const match = /\.([a-zA-Z0-9]{1,6})$/.exec(attachment.name.trim())
  if (match !== null) return match[1]!.toUpperCase()
  const subtype = attachment.mediaType.split("/")[1]
  if (subtype !== undefined && subtype !== "") return subtype.replace(/^x-/, "").slice(0, 6).toUpperCase()
  return "FILE"
}

const AttachmentTile = ({
  attachment,
  preview,
  onRemove,
  onReupload,
}: {
  readonly attachment: DraftAttachment
  readonly preview: AttachmentPreviewMeta | undefined
  readonly onRemove: () => void
  readonly onReupload: () => void
}) => {
  const isImg = isImageAttachment(attachment)
  const needsAttention = attachment.state === "failed" || attachment.state === "expired"
  const subtitle =
    attachment.state === "preparing"
      ? "Uploading…"
      : attachment.state === "failed"
        ? attachment.failure ?? "Upload failed"
        : attachment.state === "expired"
          ? "Expired"
          : preview?.lineCount !== undefined
            ? `${preview.lineCount.toLocaleString()} ${preview.lineCount === 1 ? "line" : "lines"}`
            : formatBytes(attachment.size)

  return (
    <div
      data-slot="attachment-tile"
      data-kind={isImg ? "image" : "document"}
      className="group/tile relative isolate size-[120px] shrink-0 rounded-[10px]"
    >
      {isImg ? (
        <div
          className={cn(
            "bg-background/75 relative flex size-full items-center justify-center overflow-hidden rounded-[10px] border border-border/80 transition-colors",
            needsAttention && "border-destructive/60",
          )}
          title={attachment.name}
        >
          {preview?.objectUrl !== undefined ? (
            <img
              src={preview.objectUrl}
              alt={attachment.name}
              className="size-full rounded-[inherit] object-contain"
            />
          ) : (
            <div className="text-muted-foreground flex flex-col items-center gap-1.5 px-2 text-center">
              <ImageIcon className="size-6 opacity-70" />
              <span className="line-clamp-2 break-words text-[11px] leading-tight text-foreground">
                {attachment.name}
              </span>
            </div>
          )}

          {attachment.state === "preparing" && (
            <div className="bg-background/75 absolute inset-0 flex items-center justify-center backdrop-blur-[1px]">
              <Loader2Icon className="text-foreground size-5 animate-spin" />
            </div>
          )}

          {needsAttention && (
            <div className="bg-background/85 absolute inset-x-1.5 bottom-1.5 flex items-center justify-between gap-1 rounded-md px-1.5 py-1 text-[10px] backdrop-blur-xs">
              <span className="text-destructive inline-flex items-center gap-1 truncate font-medium" title={attachment.failure}>
                <AlertTriangleIcon className="size-3 shrink-0" />
                {attachment.state === "expired" ? "Expired" : "Failed"}
              </span>
              <button
                type="button"
                className="text-primary shrink-0 font-medium underline underline-offset-2"
                onClick={onReupload}
              >
                Retry
              </button>
            </div>
          )}
        </div>
      ) : (
        <div
          className={cn(
            "bg-background/70 hover:bg-background/90 relative flex size-full flex-col justify-between overflow-hidden rounded-[10px] border border-border/80 p-3 text-start transition-colors",
            needsAttention && "border-destructive/60",
          )}
          title={attachment.failure ? `${attachment.name} — ${attachment.failure}` : attachment.name}
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="line-clamp-3 break-words [overflow-wrap:anywhere] text-xs font-normal leading-snug text-foreground">
              {attachment.name}
            </span>
            <span
              className={cn(
                "truncate text-[11px] leading-tight",
                attachment.state === "failed" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {subtitle}
            </span>
          </div>

          <div className="flex items-center justify-between gap-1">
            <span className="bg-muted text-muted-foreground inline-flex h-[18px] max-w-full items-center gap-1 rounded-full px-2 text-[10px] font-medium uppercase tracking-wide">
              {attachment.state === "preparing" && <Loader2Icon className="size-2.5 animate-spin" />}
              <span className="truncate">{extensionBadge(attachment)}</span>
            </span>
            {needsAttention && (
              <button
                type="button"
                className="text-primary shrink-0 text-[10px] font-medium underline underline-offset-2"
                onClick={onReupload}
              >
                Re-upload
              </button>
            )}
          </div>
        </div>
      )}

      <button
        type="button"
        aria-label={`Remove ${attachment.name}`}
        onClick={onRemove}
        className={cn(
          "bg-popover text-muted-foreground hover:text-foreground border-border absolute -end-2 -top-2 z-10 inline-flex size-5 items-center justify-center rounded-full border shadow-xs outline-none transition-opacity focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
          needsAttention ? "opacity-100" : "opacity-0 group-hover/tile:opacity-100 [@media(hover:none)]:opacity-100",
        )}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  )
}

const AttachmentsStrip = ({
  attachments,
  previews,
  onRemove,
  onReupload,
}: {
  readonly attachments: ReadonlyArray<DraftAttachment>
  readonly previews: ReadonlyMap<string, AttachmentPreviewMeta>
  readonly onRemove: (attachment: DraftAttachment) => void
  readonly onReupload: (attachment: DraftAttachment) => void
}) => {
  const rowRef = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState<{ left: boolean; right: boolean }>({ left: false, right: false })

  const updateFade = useCallback(() => {
    const el = rowRef.current
    if (el === null) return
    const left = el.scrollLeft > 4
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4
    setFade((current) => (current.left === left && current.right === right ? current : { left, right }))
  }, [])

  useLayoutEffect(() => {
    updateFade()
    const el = rowRef.current
    if (el === null || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(updateFade)
    observer.observe(el)
    return () => observer.disconnect()
  }, [attachments.length, updateFade])

  const maskImage =
    fade.left && fade.right
      ? "linear-gradient(to right, transparent, black 28px, black calc(100% - 28px), transparent)"
      : fade.right
        ? "linear-gradient(to right, black, black calc(100% - 28px), transparent)"
        : fade.left
          ? "linear-gradient(to right, transparent, black 28px, black)"
          : undefined

  return (
    <div className="px-1 pt-1 pb-1.5">
      <div
        ref={rowRef}
        data-slot="composer-attachments"
        onScroll={updateFade}
        style={maskImage === undefined ? undefined : { maskImage, WebkitMaskImage: maskImage }}
        className="scrollbar-compact -m-2 -mt-2.5 -me-2.5 flex items-end gap-2 overflow-x-auto overscroll-x-contain p-2 pt-2.5 pe-2.5 pb-1.5"
      >
        {attachments.map((attachment) => (
          <AttachmentTile
            key={attachment.uploadId}
            attachment={attachment}
            preview={previews.get(attachment.uploadId) ?? (attachment.stagingUploadId ? previews.get(attachment.stagingUploadId) : undefined)}
            onRemove={() => onRemove(attachment)}
            onReupload={() => onReupload(attachment)}
          />
        ))}
      </div>
    </div>
  )
}

const ModelAndEffortPicker = ({
  models,
  model,
  effort,
  onSelectModel,
  onSelectEffort,
  side = "top",
}: {
  readonly models: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly provider?: string
    readonly reasoningEfforts: ReadonlyArray<string>
  }>
  readonly model: string | null
  readonly effort: string | null
  readonly onSelectModel: (modelId: string | null) => void
  readonly onSelectEffort: (effort: string | null) => void
  readonly side?: "top" | "bottom"
}) => {
  const selected = models.find((candidate) => candidate.id === model)
  const efforts = selected?.reasoningEfforts ?? []
  const displayName = selected?.name ?? model ?? "No model"
  const displayEffort = efforts.length > 0 ? formatEffortLabel(effort) : null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={displayEffort === null ? `Model: ${displayName}` : `Model: ${displayName} ${displayEffort}`}
            className="hover:bg-accent/70 focus-visible:ring-ring/50 inline-flex h-7 max-w-full items-center gap-1.5 rounded-md px-2 text-[13px] leading-5 outline-none transition-colors focus-visible:ring-2"
          />
        }
      >
        <span className="truncate font-medium text-foreground">{displayName}</span>
        {displayEffort !== null && (
          <span className="text-muted-foreground shrink-0 font-normal">{displayEffort}</span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side={side} sideOffset={6} className="w-72 rounded-xl p-1.5 shadow-lg">
        <div className="scrollbar-compact max-h-64 overflow-y-auto">
          {models.map((candidate) => {
            const active = model === candidate.id
            return (
              <DropdownMenuItem
                key={candidate.id}
                className="flex items-start justify-between gap-2 rounded-lg px-2.5 py-2"
                onClick={() => onSelectModel(candidate.id)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-foreground">{candidate.name}</span>
                  <span className="text-muted-foreground block truncate font-mono text-[11px]">{candidate.id}</span>
                </span>
                {active && <CheckIcon className="text-ring mt-0.5 size-4 shrink-0" />}
              </DropdownMenuItem>
            )
          })}
          <DropdownMenuItem
            className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5"
            onClick={() => onSelectModel(null)}
          >
            <span className="text-muted-foreground text-[13px]">No model</span>
            {model === null && <CheckIcon className="text-ring size-4 shrink-0" />}
          </DropdownMenuItem>
        </div>

        {efforts.length > 0 && (
          <>
            <DropdownMenuSeparator className="my-1.5" />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="rounded-lg px-2.5 py-2 text-[13px]">
                <span className="font-medium text-foreground">Effort</span>
                <span className="text-muted-foreground ml-auto pr-1 text-xs">{formatEffortLabel(effort)}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent side="left" sideOffset={6} className="w-56 rounded-xl p-1.5 shadow-lg">
                <p className="text-muted-foreground px-2.5 pt-1.5 pb-2 text-xs leading-snug">
                  Higher effort means more thorough responses, but takes longer.
                </p>
                <DropdownMenuItem
                  className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-[13px]"
                  onClick={() => onSelectEffort(null)}
                >
                  <span>Default</span>
                  {effort === null && <CheckIcon className="text-ring size-4 shrink-0" />}
                </DropdownMenuItem>
                {efforts.map((choice) => (
                  <DropdownMenuItem
                    key={choice}
                    className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-[13px]"
                    onClick={() => onSelectEffort(choice)}
                  >
                    <span>{formatEffortLabel(choice)}</span>
                    {effort === choice && <CheckIcon className="text-ring size-4 shrink-0" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Chooses the single right-hand composer action: Stop while a turn runs unless a ready submission replaces it. */
export const composerPrimaryAction = ({
  isRunning,
  stopping,
  canSend,
}: {
  readonly isRunning: boolean
  readonly stopping: boolean
  readonly canSend: boolean
}): "stop" | "send" => (isRunning && (stopping || !canSend) ? "stop" : "send")

export const Composer = ({
  sessionId,
  draftStore,
  authority,
  draft,
  onDraft,
  view,
  observation,
  pending,
  onNotificationsChange,
  onMessageSent,
  onCreateSession,
  onCreateSessionError,
  variant = "docked",
}: {
  readonly sessionId: string | null
  readonly draftStore: DraftStore | null
  readonly authority: string | null
  readonly draft: Draft | null
  readonly onDraft: (draft: Draft | null) => void
  readonly view: SessionView | undefined
  readonly observation: SessionObservation | undefined
  readonly pending: ReadonlyArray<PendingInput>
  readonly onNotificationsChange?: (report: ComposerNotificationReport) => void
  readonly onMessageSent?: () => void
  readonly onCreateSession?: (options: {
    readonly agent?: string
    readonly model?: string | null
    readonly reasoningEffort?: string | null
  }) => Promise<string>
  readonly onCreateSessionError?: (failure: unknown) => void
  readonly variant?: "docked" | "centered"
}) => {
  const client = useClient()
  const models = useClientState((state) => state.models)
  const agents = useClientState((state) => state.agents)
  const status = useClientState((state) => state.status)
  const [statusNotice, setStatusNotice] = useState<{ readonly text: string | null; readonly at: number }>({ text: null, at: 0 })
  const [stopping, setStopping] = useState<string | null>(null)
  const [creatingSession, setCreatingSession] = useState(false)
  const [storageNotice, setStorageNotice] = useState<{ readonly text: string | null; readonly at: number }>({ text: null, at: 0 })
  const [record, setRecord] = useState<DraftRecord | null>(null)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [wrappedMultiline, setWrappedMultiline] = useState(false)
  const [previews, setPreviews] = useState<ReadonlyMap<string, AttachmentPreviewMeta>>(() => new Map())
  const previewUrlsRef = useRef<Set<string>>(new Set())
  const draftRef = useRef<Draft | null>(draft)
  useEffect(() => {
    draftRef.current = draft
  }, [draft])
  const onDraftRef = useRef(onDraft)
  useEffect(() => {
    onDraftRef.current = onDraft
  }, [onDraft])
  const onNotificationsChangeRef = useRef(onNotificationsChange)
  useEffect(() => {
    onNotificationsChangeRef.current = onNotificationsChange
  }, [onNotificationsChange])
  const fileInput = useRef<HTMLInputElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)

  const setStatusText = useCallback((text: string | null) => {
    setStatusNotice({ text, at: text === null ? 0 : Date.now() })
  }, [])

  const setStorageError = useCallback((text: string | null) => {
    setStorageNotice((current) => (current.text === text ? current : { text, at: text === null ? 0 : Date.now() }))
  }, [])

  // Clean up any blob preview URLs on unmount.
  useEffect(
    () => () => {
      for (const url of previewUrlsRef.current) URL.revokeObjectURL(url)
      previewUrlsRef.current.clear()
    },
    [],
  )

  const connected = status === "connected"
  const isRunning = observation?.execution.activeTurnId != null
  const ready = draft?.attachments.filter((attachment) => attachment.state === "ready") ?? []
  const blocked = draft?.attachments.some((attachment) => attachment.state !== "ready") ?? false
  const canSend = connected && !creatingSession && draft !== null && (draft.text.trim() !== "" || ready.length > 0) && !blocked
  const appliedAgent = view?.agent ?? "untitled"
  const appliedModel = sessionId === null ? (models[0]?.id ?? null) : (view?.model ?? null)
  const appliedEffort = view?.reasoningEffort ?? null
  const requested = draft?.selection ?? {}
  const agent = requested.agentTitle ?? appliedAgent
  const model = requested.modelSettings?.modelId === undefined ? appliedModel : requested.modelSettings.modelId
  const effort = requested.modelSettings?.reasoningEffort === undefined ? appliedEffort : requested.modelSettings.reasoningEffort
  const hasPendingSelectionChange = sessionId !== null && (agent !== appliedAgent || model !== appliedModel || effort !== appliedEffort)

  const centered = variant === "centered"
  const hasAttachments = (draft?.attachments.length ?? 0) > 0
  const hasExplicitNewline = draft?.text.includes("\n") ?? false
  const isMultiline = centered || hasAttachments || hasExplicitNewline || wrappedMultiline

  // Auto-size textarea from its minimum height up to Claude's ~296px / 40dvh cap and detect soft-wrap multiline transition.
  useLayoutEffect(() => {
    const el = textarea.current
    if (el === null) return
    const minHeight = centered ? 56 : 28
    const maxHeight = Math.min(384, Math.max(180, Math.round(window.innerHeight * 0.4)))
    el.style.height = "auto"
    const natural = el.scrollHeight
    el.style.height = `${Math.max(minHeight, Math.min(natural, maxHeight))}px`
    if (centered) return
    if ((draft?.text ?? "") === "") {
      if (wrappedMultiline) setWrappedMultiline(false)
    } else if (!wrappedMultiline && natural > 34) {
      setWrappedMultiline(true)
    }
  }, [centered, draft?.text, isMultiline, wrappedMultiline])

  // Auto-clear transient "Sent." feedback.
  useEffect(() => {
    if (statusNotice.text !== "Sent.") return
    const timer = window.setTimeout(() => setStatusText(null), 2500)
    return () => window.clearTimeout(timer)
  }, [setStatusText, statusNotice.text])

  const save = (change: Partial<Draft>) => {
    const current = draftRef.current
    if (current === null) return
    const next = { ...current, ...change, updatedAt: Date.now() }
    draftRef.current = next
    onDraft(next)
    if (sessionId !== null && draftStore !== null && authority !== null) {
      const result = draftStore.save(authority, sessionId, {
        text: next.text,
        mode: next.mode,
        selection: next.selection,
        attachments: next.attachments,
      })
      setStorageError(result.ok ? null : "Not saved locally: browser storage is unavailable. Copy or export this draft.")
      if (!result.ok) reportDraftFailure()
    }
  }

  useEffect(() => {
    if (sessionId === null || draftStore === null || authority === null) {
      setRecord(null)
      return
    }
    setRecord(draftStore.load(authority, sessionId))
    return draftStore.subscribe((changedAuthority, changedSessionId) => {
      if (changedAuthority === authority && changedSessionId === sessionId) {
        setRecord(draftStore.load(authority, sessionId))
      }
    })
  }, [authority, draftStore, sessionId])

  useEffect(() => {
    if (sessionId === null || status !== "connected" || draftStore === null || authority === null) return
    const current = draftStore.load(authority, sessionId)
    const unknown = current.submissions.filter((submission) => submission.state === "unknown")
    for (const submission of unknown) {
      void client
        .inputReceipt(sessionId, submission.submissionId)
        .then((receipt) => {
          if (receipt !== null) {
            draftStore.updateSubmission(authority, sessionId, submission.submissionId, { state: "accepted" })
            void client.reconcileSubmission(sessionId, submission.submissionId)
          }
          setRecord(draftStore.load(authority, sessionId))
        })
        .catch(() => {})
    }
  }, [authority, client, draftStore, sessionId, status])

  const pendingIdsKey = pending
    .flatMap((input) => (input.submissionId === undefined ? [] : [input.submissionId]))
    .join(",")

  // Report all composer alerts/status/recovery records up to SessionNotifications (zero alerts above composer).
  useEffect(() => {
    const report = onNotificationsChangeRef.current
    if (report === undefined) return
    const pendingSet = new Set(pendingIdsKey === "" ? [] : pendingIdsKey.split(","))
    const unaccepted = (record?.submissions ?? [])
      .filter((submission) => submission.state !== "accepted" && !pendingSet.has(submission.submissionId))
      .map((submission) => ({
        submission,
        onRestore: () => {
          if (sessionId === null || draftStore === null || authority === null) return
          draftStore.restore(authority, sessionId, submission)
          const next = draftStore.load(authority, sessionId)
          setRecord(next)
          if (next.active !== null) onDraftRef.current(next.active)
        },
      }))
    const inTabRecoverables = (record?.recoverable ?? []).map((candidate) => ({
      draft: candidate,
      onUse: () => {
        if (sessionId === null || draftStore === null || authority === null) return
        draftStore.promote(authority, sessionId, candidate.id)
        const next = draftStore.load(authority, sessionId)
        setRecord(next)
        if (next.active !== null) onDraftRef.current(next.active)
      },
    }))
    report({
      statusText: statusNotice.text,
      statusTimestamp: statusNotice.at,
      storageError: storageNotice.text,
      storageErrorTimestamp: storageNotice.at,
      unacceptedSubmissions: unaccepted,
      inTabRecoverables,
      onCopyDraft: () => {
        const current = draftRef.current
        if (current === null) return
        void navigator.clipboard
          ?.writeText(
            JSON.stringify(
              { text: current.text, mode: current.mode, selection: current.selection, attachments: current.attachments },
              null,
              2,
            ),
          )
          .catch(() => {})
      },
    })
  }, [authority, draftStore, pendingIdsKey, record, sessionId, statusNotice, storageNotice])

  const updateSelection = (change: { agentTitle?: string; modelId?: string | null; reasoningEffort?: string | null }) => {
    const selection = {
      ...requested,
      ...(change.agentTitle === undefined ? {} : { agentTitle: change.agentTitle }),
      ...(change.modelId === undefined && change.reasoningEffort === undefined
        ? {}
        : {
            modelSettings: {
              ...(requested.modelSettings ?? {}),
              ...(change.modelId === undefined ? {} : { modelId: change.modelId }),
              ...(change.reasoningEffort === undefined ? {} : { reasoningEffort: change.reasoningEffort }),
            },
          }),
    }
    save({ selection })
    try {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({
          agent: selection.agentTitle ?? appliedAgent,
          model: selection.modelSettings?.modelId === undefined ? appliedModel : selection.modelSettings.modelId,
          reasoningEffort: selection.modelSettings?.reasoningEffort === undefined ? effort : selection.modelSettings.reasoningEffort,
        }),
      )
    } catch {}
  }

  const attach = async (file: File) => {
    const currentDraft = draftRef.current
    if (currentDraft === null) return
    const localId = randomId()
    const local: DraftAttachment = {
      uploadId: localId,
      name: file.name,
      mediaType: file.type,
      size: file.size,
      sha256: null,
      state: "preparing",
    }

    // Build client-side thumbnail preview or text line count for Claude-style attachment cards.
    if (isImageAttachment(local) && typeof URL.createObjectURL === "function") {
      const objectUrl = URL.createObjectURL(file)
      previewUrlsRef.current.add(objectUrl)
      setPreviews((current) => {
        const next = new Map(current)
        next.set(localId, { objectUrl })
        return next
      })
    } else if (isTextLikeFile(file) && file.size <= 512 * 1024) {
      void file
        .text()
        .then((content) => {
          const lineCount = content === "" ? 0 : content.split(/\r?\n/).length
          setPreviews((current) => {
            const next = new Map(current)
            next.set(localId, { ...(next.get(localId) ?? {}), lineCount })
            return next
          })
        })
        .catch(() => {})
    }

    save({ attachments: [...currentDraft.attachments, local] })
    try {
      const ref = await client.uploadFile(file, currentDraft.id)
      const latest = draftRef.current
      if (latest === null) return
      setPreviews((current) => {
        const existing = current.get(localId)
        if (existing === undefined) return current
        const next = new Map(current)
        next.set(ref.attachmentId, existing)
        return next
      })
      save({
        attachments: latest.attachments.map((attachment) =>
          attachment.uploadId === localId
            ? { ...attachment, uploadId: ref.attachmentId, stagingUploadId: localId, sha256: ref.digest, state: "ready", attachment: ref }
            : attachment,
        ),
      })
    } catch (failure) {
      const latest = draftRef.current
      if (latest === null) return
      save({
        attachments: latest.attachments.map((attachment) =>
          attachment.uploadId === localId
            ? { ...attachment, state: "failed", failure: failure instanceof Error ? failure.message : "upload failed" }
            : attachment,
        ),
      })
    }
  }

  const removeAttachment = (attachment: DraftAttachment) => {
    if (draft === null) return
    const meta = previews.get(attachment.uploadId) ?? (attachment.stagingUploadId ? previews.get(attachment.stagingUploadId) : undefined)
    if (meta?.objectUrl !== undefined) {
      URL.revokeObjectURL(meta.objectUrl)
      previewUrlsRef.current.delete(meta.objectUrl)
    }
    setPreviews((current) => {
      const next = new Map(current)
      next.delete(attachment.uploadId)
      if (attachment.stagingUploadId !== undefined) next.delete(attachment.stagingUploadId)
      return next
    })
    save({
      attachments: draft.attachments.filter((candidate) => candidate.uploadId !== attachment.uploadId),
    })
  }

  const send = async () => {
    if (draft === null || !canSend) return
    const isNewSession = sessionId === null
    if (!isNewSession && (draftStore === null || authority === null)) return
    let targetSessionId = sessionId
    if (targetSessionId === null) {
      if (onCreateSession === undefined) return
      setCreatingSession(true)
      try {
        targetSessionId = await onCreateSession({
          agent,
          model,
          reasoningEffort: effort,
        })
      } catch (failure) {
        setCreatingSession(false)
        onCreateSessionError?.(failure)
        return
      }
      setCreatingSession(false)
    }
    const submissionId = randomId()
    const snapshot = {
      submissionId,
      text: draft.text,
      mode: draft.mode,
      selection: isNewSession ? {} : draft.selection,
      attachments: draft.attachments,
    }
    if (draftStore !== null && authority !== null) {
      const detached = draftStore.detach(authority, targetSessionId, snapshot)
      if (!isNewSession) setRecord(draftStore.load(authority, targetSessionId))
      if (!detached.ok) {
        reportDraftFailure()
        if (!isNewSession) {
          setStorageError("Not saved locally: the submission identity could not be stored. Keep this tab open.")
        }
      }
    }
    for (const url of previewUrlsRef.current) URL.revokeObjectURL(url)
    previewUrlsRef.current.clear()
    setPreviews(new Map())
    setWrappedMultiline(false)
    onDraft({ ...draft, text: "", attachments: [], updatedAt: Date.now() })
    onMessageSent?.()
    setStatusText("Sending…")
    try {
      const receipt = await client.submit(targetSessionId, {
        text: snapshot.text,
        mode: snapshot.mode,
        submissionId,
        ...(isNewSession ? {} : { selection: snapshot.selection }),
        ...(ready.length === 0 ? {} : { attachments: ready.map((attachment) => attachment.attachment!) }),
      })
      if (draftStore !== null && authority !== null) {
        draftStore.updateSubmission(authority, targetSessionId, submissionId, {
          state: receipt.disposition === "removed" ? "rejected" : "accepted",
        })
        if (!isNewSession) setRecord(draftStore.load(authority, targetSessionId))
      }
      setStatusText(receipt.disposition === "pending" ? "Accepted; waiting for admission." : "Sent.")
    } catch (failure) {
      const rejected = failure instanceof ProtocolError
      if (draftStore !== null && authority !== null) {
        draftStore.updateSubmission(authority, targetSessionId, submissionId, {
          state: rejected ? "rejected" : "unknown",
          message: failure instanceof Error ? failure.message : "unknown",
        })
        if (!isNewSession) setRecord(draftStore.load(authority, targetSessionId))
      }
      setStatusText(
        rejected
          ? "Submission was rejected; restore or revise the draft."
          : "Acceptance unknown; checking the receipt before retrying.",
      )
      if (rejected) return
      void client
        .inputReceipt(targetSessionId, submissionId)
        .then((receipt) => {
          if (receipt !== null) {
            if (draftStore !== null && authority !== null) {
              draftStore.updateSubmission(authority, targetSessionId, submissionId, { state: "accepted" })
            }
            void client.reconcileSubmission(targetSessionId, submissionId)
          }
          if (!isNewSession && draftStore !== null && authority !== null) {
            setRecord(draftStore.load(authority, targetSessionId))
          }
        })
        .catch(() => {})
    }
  }

  const stop = async () => {
    const turnId = observation?.execution.activeTurnId ?? view?.runId ?? null
    if (turnId === null) return
    setStopping(turnId)
    try {
      const result = await client.cancel(turnId)
      if (result?.outcome === "no_longer_current") setStatusText("That turn already ended; execution reconciled.")
    } catch (failure) {
      setStatusText(failure instanceof Error ? failure.message : "Stop failed; retry.")
      setStopping(null)
    }
  }

  useEffect(() => {
    if (stopping !== null && observation !== undefined && observation.execution.activeTurnId !== stopping) {
      setStopping(null)
    }
  }, [observation, stopping])

  if (draft === null) return null

  const attachButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Attach files"
            className="text-foreground/85 hover:bg-foreground/[0.08] hover:text-foreground active:bg-foreground/[0.12] focus-visible:ring-ring/60 inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-transparent outline-none transition-colors focus-visible:ring-2"
            onClick={() => fileInput.current?.click()}
          />
        }
      >
        <ClaudePlusIcon className="size-5" />
      </TooltipTrigger>
      <TooltipContent>Attach files</TooltipContent>
    </Tooltip>
  )

  const showStop = composerPrimaryAction({ isRunning, stopping: stopping !== null, canSend }) === "stop"
  const dropdownSide = centered ? "bottom" : "top"

  const agentPicker = (
    <Select
      value={agent}
      onValueChange={(value) => {
        if (value !== null) updateSelection({ agentTitle: value })
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="Agent"
        className={cn(
          "text-muted-foreground hover:bg-accent/70 hover:text-foreground border-transparent bg-transparent px-2 text-xs shadow-none dark:bg-transparent dark:hover:bg-accent/70",
          centered ? "h-7 rounded-[8px]" : "h-6",
        )}
      >
        <SelectValue>{agent === "untitled" ? "Default agent" : agent}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start" side={dropdownSide}>
        <SelectItem value="untitled">Default agent</SelectItem>
        {agents.map((candidate) => (
          <SelectItem key={candidate.key} value={candidate.key}>
            {candidate.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  const modelPicker = (
    <ModelAndEffortPicker
      models={models}
      model={model}
      effort={effort}
      side={dropdownSide}
      onSelectModel={(nextModel) => updateSelection({ modelId: nextModel, reasoningEffort: null })}
      onSelectEffort={(nextEffort) => updateSelection({ reasoningEffort: nextEffort })}
    />
  )

  const rightActions = (
    <div className="flex shrink-0 items-center">
      {showStop ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Stop"
                disabled={stopping !== null}
                className="text-foreground hover:bg-foreground/[0.08] active:bg-foreground/[0.12] focus-visible:ring-ring/60 inline-flex size-7 items-center justify-center rounded-[8px] bg-transparent outline-none transition-colors disabled:opacity-40 focus-visible:ring-2"
                onClick={() => void stop()}
              />
            }
          >
            <ClaudeStopIcon className="size-5" />
          </TooltipTrigger>
          <TooltipContent>{stopping !== null ? "Stopping…" : "Stop"}</TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                disabled={!canSend}
                className={cn(
                  "focus-visible:ring-ring/60 inline-flex size-7 items-center justify-center rounded-[8px] outline-none transition-colors focus-visible:ring-2",
                  centered
                    ? canSend
                      ? "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80"
                      : "bg-transparent text-foreground/30"
                    : canSend
                      ? "bg-transparent text-foreground hover:bg-foreground/[0.08] active:bg-foreground/[0.12]"
                      : "bg-transparent text-foreground/30",
                )}
                onClick={() => void send()}
              />
            }
          >
            {centered ? <ClaudeArrowUpIcon className="size-4" /> : <ClaudeSendIcon className="size-5" />}
            <span className="sr-only">Send</span>
          </TooltipTrigger>
          <TooltipContent>{canSend ? "Send message" : connected ? "Write a message to send" : "Reconnect to send"}</TooltipContent>
        </Tooltip>
      )}
    </div>
  )

  const fileInputEl = (
    <input
      ref={fileInput}
      type="file"
      className="hidden"
      multiple
      onChange={(event) => {
        for (const file of event.target.files ?? []) void attach(file)
        event.target.value = ""
      }}
    />
  )

  const attachmentsEl = hasAttachments ? (
    <AttachmentsStrip
      attachments={draft.attachments}
      previews={previews}
      onRemove={removeAttachment}
      onReupload={(attachment) => {
        removeAttachment(attachment)
        fileInput.current?.click()
      }}
    />
  ) : null

  const cardDropProps = {
    onClick: (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null
      if (target?.closest("button, a, [role='button'], input, textarea")) return
      textarea.current?.focus()
    },
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
      if (event.dataTransfer.types.includes("Files")) {
        event.preventDefault()
        setDraggingFiles(true)
      }
    },
    onDragLeave: () => setDraggingFiles(false),
    onDrop: (event: React.DragEvent<HTMLDivElement>) => {
      if (event.dataTransfer.files.length > 0) {
        event.preventDefault()
        setDraggingFiles(false)
        for (const file of event.dataTransfer.files) void attach(file)
      }
    },
  }

  if (centered) {
    return (
      <div data-slot="composer-centered-host" className="w-full max-w-[42rem]">
        <div
          data-slot="composer-card"
          data-variant="centered"
          data-multiline="true"
          data-dragging={draggingFiles ? "true" : "false"}
          {...cardDropProps}
          className={cn(
            "composer-card bg-popover text-popover-foreground flex flex-col gap-y-2 rounded-[16px] px-3.5 pt-3.5 pb-2.5 transition-shadow duration-150",
            draggingFiles && "bg-accent/25",
          )}
        >
          {fileInputEl}
          {attachmentsEl}
          <textarea
            ref={textarea}
            aria-label="Message"
            rows={2}
            className="scrollbar-compact min-h-[56px] max-h-[min(24rem,40dvh)] w-full resize-none overflow-y-auto bg-transparent px-1 py-0.5 text-[15px] leading-[22px] text-foreground outline-none placeholder:text-muted-foreground"
            placeholder={connected ? "How can I help you today?" : "Draft saved here; reconnect to send"}
            value={draft.text}
            onChange={(event) => save({ text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                if (canSend) void send()
              }
            }}
          />
          <div className="mt-1 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1">
              {attachButton}
              {agentPicker}
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
              {modelPicker}
              {rightActions}
            </div>
          </div>
        </div>
        {hasPendingSelectionChange && (
          <div className="mt-2 flex justify-center">
            <Tooltip>
              <TooltipTrigger
                render={<Badge variant="outline" className="cursor-default text-[10px] font-normal">Applies on send</Badge>}
              />
              <TooltipContent>
                Currently applied: {appliedAgent} · {appliedModel ?? "no model"}
              </TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="composer-dock-host pointer-events-auto px-4 pb-2.5">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5">
        <div
          data-slot="composer-card"
          data-variant="docked"
          data-multiline={isMultiline ? "true" : "false"}
          data-dragging={draggingFiles ? "true" : "false"}
          {...cardDropProps}
          className={cn(
            "composer-card bg-popover text-popover-foreground flex flex-col gap-y-2 rounded-[14px] p-2 transition-shadow duration-150",
            draggingFiles && "bg-accent/25",
          )}
        >
          {fileInputEl}
          {attachmentsEl}

          {isMultiline ? (
            <>
              <textarea
                ref={textarea}
                aria-label="Message"
                rows={1}
                className="scrollbar-compact min-h-[28px] max-h-[min(24rem,40dvh)] w-full resize-none overflow-y-auto bg-transparent px-2 py-[3.5px] text-[15px] leading-[21px] text-foreground outline-none placeholder:text-muted-foreground"
                placeholder={connected ? "Write a message…" : "Draft saved here; reconnect to send"}
                value={draft.text}
                onChange={(event) => save({ text: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault()
                    if (canSend) void send()
                  }
                }}
              />
              <div className="flex h-7 items-center justify-between gap-2">
                {attachButton}
                {rightActions}
              </div>
            </>
          ) : (
            <div className="flex items-end gap-2">
              {attachButton}
              <textarea
                ref={textarea}
                aria-label="Message"
                rows={1}
                className="scrollbar-compact min-h-[28px] max-h-[min(24rem,40dvh)] min-w-0 flex-1 resize-none overflow-y-auto bg-transparent py-[3.5px] text-[15px] leading-[21px] text-foreground outline-none placeholder:text-muted-foreground"
                placeholder={connected ? "Write a message…" : "Draft saved here; reconnect to send"}
                value={draft.text}
                onChange={(event) => save({ text: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault()
                    if (canSend) void send()
                  }
                }}
              />
              {rightActions}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {agentPicker}

            {isRunning && (
              <label className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs select-none">
                <Checkbox
                  checked={draft.mode === "queue"}
                  onCheckedChange={(checked) => save({ mode: checked === true ? "queue" : "steer" })}
                />
                <span>Queue</span>
              </label>
            )}

            {hasPendingSelectionChange && (
              <Tooltip>
                <TooltipTrigger
                  render={<Badge variant="outline" className="cursor-default text-[10px] font-normal">Applies on send</Badge>}
                />
                <TooltipContent>
                  Currently applied: {appliedAgent} · {appliedModel ?? "no model"}
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          <div className="ml-auto flex items-center">
            {modelPicker}
          </div>
        </div>
      </div>
    </div>
  )
}

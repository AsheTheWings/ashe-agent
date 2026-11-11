import type {
  InputMode,
  ModelInputManifest,
  SemanticEntry,
  SemanticPageEntry,
  SessionEvent,
  SessionObservation,
  Turn,
} from "@ashe-agent/protocol"
import { Component, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react"
import { useClient, useClientState } from "../app/client-context.tsx"
import { SignIn } from "../app/sign-in.tsx"
import type { ClientState } from "../session/client.ts"
import { ProtocolError } from "../session/connection.ts"
import type { AssistantItem, Item, PendingInput, PendingPermission, QuestionsItem, SessionView, ToolPart, UserItem } from "../session/projection.ts"
import { DraftStore, type Draft, type DraftAttachment, type DraftRecord, type Submission } from "./drafts.ts"
import { UncertainOperation, useWebState, WebStateClient, type WebStateView } from "./web-state-client.ts"

type ViewName = "chat" | "session" | "checkpoint"
const VIEWS: ReadonlyArray<{ readonly value: ViewName; readonly label: string }> = [
  { value: "chat", label: "Chat" },
  { value: "session", label: "Session" },
  { value: "checkpoint", label: "Checkpoint window" },
]
const VIEW_KEY = "ashe-agent.web.views.v1"
const PREFS_KEY = "ashe-agent.web.new-session.v1"

type ShortcutPreferences = { readonly viewModifier: "ctrl" | "alt"; readonly typeToFocus: boolean }
const SHORTCUTS_KEY = "ashe-agent.web.shortcuts.v1"
const shortcutPreferences = (): ShortcutPreferences => {
  try {
    const value = JSON.parse(localStorage.getItem(SHORTCUTS_KEY) ?? "null") as Partial<ShortcutPreferences> | null
    return { viewModifier: value?.viewModifier === "alt" ? "alt" : "ctrl", typeToFocus: value?.typeToFocus !== false }
  } catch {
    return { viewModifier: "ctrl", typeToFocus: true }
  }
}

const className = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ")

const Text = ({ text, className: extra }: { readonly text: string; readonly className?: string }) => (
  <div className={className("whitespace-pre-wrap break-words", extra)}>
    <MediaText text={text} />
  </div>
)

const mediaPattern = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g

/** External images stay inert until their own Load control is used. */
const ExternalImage = ({ alt, url }: { readonly alt: string; readonly url: string }) => {
  const [state, setState] = useState<"idle" | "loading" | "refused">("idle")
  const [src, setSrc] = useState<string | null>(null)
  const load = () => {
    setState("loading")
    void fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", mode: "cors" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`the server answered ${response.status}`)
        const type = response.headers.get("content-type") ?? ""
        if (!/^image\/(png|jpeg|webp|gif)/.test(type)) throw new Error("the response is not a raster image")
        const limit = 10 * 1024 * 1024
        if (Number(response.headers.get("content-length") ?? 0) > limit) throw new Error("the image is too large")
        const reader = response.body?.getReader()
        if (reader === undefined) throw new Error("the image has no body")
        const chunks: Array<ArrayBuffer> = []
        let size = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > limit) {
            await reader.cancel()
            throw new Error("the image is too large")
          }
          chunks.push(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer)
        }
        return new Blob(chunks, { type })
      })
      .then((blob) => setSrc(URL.createObjectURL(blob)))
      .catch(() => setState("refused"))
  }
  useEffect(() => () => { if (src !== null) URL.revokeObjectURL(src) }, [src])
  return (
    <span className="my-2 flex flex-col gap-1 rounded border p-2 text-xs">
      <span>External image: {alt || url}</span>
      <span className="text-muted-foreground break-all">{url}</span>
      {src === null ? (
        <button type="button" className="self-start rounded border px-2 py-1" disabled={state === "loading"} onClick={load}>
          {state === "loading" ? "Loading…" : "Load"}
        </button>
      ) : (
        <img src={src} alt={alt} className="max-h-96 max-w-full rounded object-contain" />
      )}
      {state === "refused" && <a href={url} target="_blank" rel="noreferrer noopener" className="underline">Open image instead</a>}
    </span>
  )
}

/** Plain text with markdown image destinations rendered only as consent placeholders. */
const MediaText = ({ text }: { readonly text: string }) => {
  const parts: Array<ReactNode> = []
  let offset = 0
  for (const match of text.matchAll(mediaPattern)) {
    const index = match.index ?? 0
    if (index > offset) parts.push(text.slice(offset, index))
    parts.push(<ExternalImage key={`${index}:${match[2]}`} alt={match[1] ?? ""} url={match[2]!} />)
    offset = index + match[0].length
  }
  if (parts.length === 0) return <>{text}</>
  if (offset < text.length) parts.push(text.slice(offset))
  return <>{parts}</>
}

let renderFailureReporter: (() => void) | null = null
let draftFailureReporter: (() => void) | null = null

export const setRenderFailureReporter = (reporter: (() => void) | null) => { renderFailureReporter = reporter }
export const setDraftFailureReporter = (reporter: (() => void) | null) => { draftFailureReporter = reporter }

class BlockBoundary extends Component<{ readonly children: ReactNode; readonly fallback?: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  override componentDidCatch(_error: Error, _info: ErrorInfo) { renderFailureReporter?.() }
  override render() {
    return this.state.failed ? (
      <div role="alert" className="text-destructive rounded border p-2 text-sm">
        This block failed to render; the rest of the session remains usable.
        <button type="button" className="ml-2 underline" onClick={() => this.setState({ failed: false })}>Retry</button>
        {this.props.fallback === undefined ? null : <div className="mt-2">{this.props.fallback}</div>}
      </div>
    ) : this.props.children
  }
}

const Disclosure = ({ summary, children, start = false }: { readonly summary: ReactNode; readonly children: ReactNode; readonly start?: boolean }) => (
  <details className="rounded-lg border px-3 py-2" open={start}>
    <summary className="cursor-pointer text-sm">{summary}</summary>
    <div className="mt-2 text-sm">{children}</div>
  </details>
)

const savedViews = (): Record<string, ViewName> => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(VIEW_KEY) ?? "{}") as Record<string, ViewName>
    return parsed
  } catch {
    return {}
  }
}

const saveView = (sessionId: string, view: ViewName) => {
  try {
    window.localStorage.setItem(VIEW_KEY, JSON.stringify({ ...savedViews(), [sessionId]: view }))
  } catch {
    // The view still works for this page; only the next session's default is lost.
  }
}

const time = (value: number) => new Date(value).toLocaleString()

const decodeBase64 = (value: string) => new TextDecoder().decode(Uint8Array.from(atob(value), (character) => character.charCodeAt(0)))

const RetainedMedia = ({ entry }: { readonly entry: { readonly content: { readonly contentId: string; readonly representationId: string; readonly mediaType: string }; readonly name: string } }) => {
  const client = useClient()
  const sessionId = useClientState((state) => state.activeSessionId)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
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
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "download failed"))
    return () => {
      active = false
      if (created !== null) URL.revokeObjectURL(created)
    }
  }, [client, entry.content.contentId, entry.content.representationId, sessionId])
  const safeImage = /^image\/(png|jpeg|webp|gif)$/.test(entry.content.mediaType)
  if (error !== null) return <span className="text-destructive text-xs">{error}</span>
  if (url === null) return <span className="text-muted-foreground text-xs">Loading {entry.name}…</span>
  if (safeImage) return <img src={url} alt={entry.name} className="max-h-96 max-w-full rounded border object-contain" />
  if (entry.content.mediaType === "application/pdf") return (
    <div className="flex flex-col gap-1 text-xs">
      <a className="text-primary underline" href={url} download={entry.name}>Download PDF original</a>
      <span className="text-muted-foreground">Retained page images are not available for this representation.</span>
    </div>
  )
  return (
    <a className="text-primary text-sm underline" href={url} download={entry.name}>
      Download {entry.name} ({entry.content.mediaType})
    </a>
  )
}

const GenericToolCall = ({ part }: { readonly part: ToolPart }) => (
  <BlockBoundary fallback={<pre className="max-h-80 overflow-auto whitespace-pre-wrap">{part.argsText}{"\n\n"}{part.result?.content ?? "No retained result."}</pre>}>
    <Disclosure
      summary={
        <span className="flex items-center gap-2">
          <span className="font-mono text-xs">{part.name}</span>
          <span className="text-muted-foreground text-xs">{part.result?.outcome ?? (part.started ? "running" : "not run")}</span>
        </span>
      }
    >
      <div className="grid gap-2 md:grid-cols-2">
        <div>
          <div className="text-muted-foreground mb-1 text-xs">Input</div>
          <pre className="bg-muted/50 max-h-80 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">{part.argsText || "{}"}</pre>
        </div>
        <div>
          <div className="text-muted-foreground mb-1 text-xs">Result</div>
          <pre className="bg-muted/50 max-h-80 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">
            {part.result?.content ?? "No retained result yet."}
          </pre>
        </div>
      </div>
    </Disclosure>
  </BlockBoundary>
)

const FilePatchCall = ({ part }: { readonly part: ToolPart }) => (
  <BlockBoundary fallback={<pre className="max-h-80 overflow-auto whitespace-pre-wrap">{part.argsText}{"\n\n"}{part.result?.content ?? "No retained patch result."}</pre>}>
    <Disclosure summary={<span className="font-mono text-xs">FilePatch · {part.name} · {part.result?.outcome ?? "pending"}</span>} start>
      <pre className="bg-muted/50 max-h-96 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">{part.argsText}{"\n\n"}{part.result?.content ?? "No retained patch result yet."}</pre>
    </Disclosure>
  </BlockBoundary>
)

const toolRenderers: Readonly<Record<string, (part: ToolPart) => ReactNode>> = {
  file_patch: (part) => <FilePatchCall part={part} />,
}

export const ToolCall = ({ part }: { readonly part: ToolPart }) => toolRenderers[part.name]?.(part) ?? <GenericToolCall part={part} />

const AssistantBlock = ({ item, showTools = true }: { readonly item: AssistantItem; readonly showTools?: boolean }) => (
  <div className="flex flex-col gap-2" data-run-id={item.runId} data-item-id={item.id}>
    {item.parts.map((part) => {
      if (part.type === "text") return <Text key={part.id} text={part.text} className="text-[0.95rem] leading-6" />
      if (part.type === "reasoning")
        return (
          <Disclosure key={part.id} summary={<span className="text-muted-foreground">Thoughts</span>}>
            <Text text={part.text} />
          </Disclosure>
        )
      return showTools ? <ToolCall key={part.id} part={part} /> : null
    })}
    {(item.error !== null || item.status === "cancelled" || item.status === "interrupted") && (
      <p role="alert" className="text-destructive text-sm">
        {item.error ?? `Execution ${item.status}`}
      </p>
    )}
  </div>
)

const UserBubble = ({
  item,
  observation,
  onRewind,
  onFork,
}: {
  readonly item: UserItem
  readonly observation: SessionObservation | undefined
  readonly onRewind: (item: UserItem) => void
  readonly onFork: (item: UserItem) => void
}) => (
  <div className="flex flex-col items-end gap-1" data-run-id={item.runId ?? undefined}>
    <div className="bg-primary text-primary-foreground max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2">
      {item.messages.map((message) => (
        <Text key={message.id} text={message.text} />
      ))}
    </div>
    {item.runId !== null && observation !== undefined && (
      <div className="flex gap-1 text-xs">
        <button
          type="button"
          className="hover:bg-accent rounded px-2 py-1 disabled:opacity-40"
          disabled={!observation.execution.canRewind}
          onClick={() => onRewind(item)}
        >
          Rewind
        </button>
        <button
          type="button"
          className="hover:bg-accent rounded px-2 py-1 disabled:opacity-40"
          disabled={!observation.execution.canFork}
          onClick={() => onFork(item)}
        >
          Fork
        </button>
      </div>
    )}
  </div>
)

const Questions = ({ item }: { readonly item: QuestionsItem }) => {
  const client = useClient()
  const owned = useClientState((state) => state.owned.questions.includes(item.id))
  const [answers, setAnswers] = useState<Record<string, string>>({})
  if (!item.open) {
    return (
      <Disclosure summary={<span className="text-muted-foreground">Questions answered</span>}>
        <ul className="flex flex-col gap-2">
          {item.questions.map((question) => (
            <li key={question.id}>
              <strong>{question.header}:</strong> {question.question}{" "}
              {item.answers?.find((answer) => answer.id === question.id)?.selection ?? "Skipped"}
            </li>
          ))}
        </ul>
      </Disclosure>
    )
  }
  return (
    <section className="bg-muted/40 flex flex-col gap-3 rounded-lg border p-3" data-attention="question">
      {item.feedback !== null && <Text text={item.feedback} />}
      {item.questions.map((question) => (
        <fieldset key={question.id} className="flex flex-col gap-1">
          <legend className="font-medium">{question.header}</legend>
          <p>{question.question}</p>
          <div className="flex flex-wrap gap-1">
            {question.options.map((option) => (
              <button
                key={option.label}
                type="button"
                aria-pressed={answers[question.id] === option.label}
                className={className("hover:bg-accent rounded border px-2 py-1 text-start text-sm", answers[question.id] === option.label && "border-primary bg-accent")}
                onClick={() => setAnswers({ ...answers, [question.id]: option.label })}
                title={option.description}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>
      ))}
      {owned ? (
        <button
          type="button"
          className="bg-primary text-primary-foreground self-end rounded px-3 py-1 text-sm"
          onClick={() =>
            void client
              .answerQuestion(
                item.id,
                item.questions.map((question) => ({ id: question.id, ...(answers[question.id] === undefined ? {} : { selection: answers[question.id] }) })),
              )
              .catch(() => {})
          }
        >
          Send answers
        </button>
      ) : (
        <p className="text-muted-foreground text-sm">This question belongs to another connected browser.</p>
      )}
    </section>
  )
}

const NO_PERMISSIONS: ReadonlyArray<PendingPermission> = []

const Permissions = () => {
  const client = useClient()
  const permissions = useClientState((state) => (state.activeSessionId === null ? NO_PERMISSIONS : (state.views[state.activeSessionId]?.permissions ?? NO_PERMISSIONS)))
  const owned = useClientState((state) => state.owned.permissions)
  if (permissions.length === 0) return null
  return (
    <div className="flex flex-col gap-2" data-attention="permission">
      {permissions.map((permission) =>
        owned.includes(permission.requestId) ? (
          <div key={permission.requestId} className="flex flex-wrap items-center gap-2 rounded-lg border p-2 text-sm">
            <span className="font-mono text-xs">{permission.permission}</span>
            <span className="min-w-0 flex-1 truncate">{permission.subjects.join(", ")}</span>
            <button type="button" className="rounded border px-2 py-1" onClick={() => void client.answerPermission(permission.requestId, "once").catch(() => {})}>
              Allow once
            </button>
            <button type="button" className="rounded border px-2 py-1" onClick={() => void client.answerPermission(permission.requestId, "always").catch(() => {})}>
              Always allow
            </button>
            <button type="button" className="text-destructive rounded border px-2 py-1" onClick={() => void client.answerPermission(permission.requestId, "reject").catch(() => {})}>
              Reject
            </button>
          </div>
        ) : (
          <p key={permission.requestId} className="text-muted-foreground text-sm">
            Waiting on another connected browser for {permission.permission}.
          </p>
        ),
      )}
    </div>
  )
}

export const ActivityPreview = ({ view, onReveal }: { readonly view: SessionView; readonly onReveal: (target: string) => void }) => {
  const active = view.runId !== null
  const segment = [...view.items].reverse().find((item): item is AssistantItem => item.kind === "assistant" && item.runId === view.runId)
  const thought = segment === undefined ? undefined : [...segment.parts].reverse().find((part) => part.type === "reasoning")
  const tool = segment === undefined ? undefined : [...segment.parts].reverse().find((part): part is ToolPart => part.type === "tool" && part.started)
  if (!active || (thought === undefined && tool === undefined)) return null
  return (
    <div className="flex flex-col gap-1 border-b px-4 py-2 text-xs">
      {thought !== undefined && thought.type === "reasoning" && (
        <button type="button" className="text-muted-foreground hover:text-foreground truncate text-start" onClick={() => onReveal(`thought:${thought.id}`)}>
          {thought.text.split("\n")[0] || "Thinking…"}
        </button>
      )}
      {tool !== undefined && (
        <button type="button" className="hover:text-foreground truncate text-start" onClick={() => onReveal(`tool:${tool.id}`)}>
          {tool.started ? "●" : "○"} {tool.name} · {(tool.argsText || "no input").split("\n")[0]}
        </button>
      )}
    </div>
  )
}

const PendingStrip = ({ pending, full = true, onReveal }: { readonly pending: ReadonlyArray<PendingInput>; readonly full?: boolean; readonly onReveal?: () => void }) => {
  if (pending.length === 0) return null
  const peers = pending.filter((input) => input.sender.kind === "session")
  const visible = full ? pending : pending.filter((input) => input.sender.kind !== "session")
  return (
    <section aria-label="Waiting messages" className="flex flex-col gap-1 border-b px-4 py-2">
      {!full && peers.length > 0 && (
        <button type="button" className="text-muted-foreground text-start text-xs underline" onClick={onReveal}>
          {peers.length} developer notification(s) waiting · reveal in Session
        </button>
      )}
      {visible.map((input) => (
        <Disclosure key={input.inputId} summary={<span><span className="font-mono text-xs">{input.mode}</span> · {input.text.slice(0, 100) || "attachment only"}</span>}>
          <Text text={input.text} />
        </Disclosure>
      ))}
    </section>
  )
}

export const Chat = ({
  view,
  observation,
  pending,
  onRewind,
  onFork,
  onReveal,
}: {
  readonly view: SessionView
  readonly observation: SessionObservation | undefined
  readonly pending: ReadonlyArray<PendingInput>
  readonly onRewind: (item: UserItem) => void
  readonly onFork: (item: UserItem) => void
  readonly onReveal: (target: string) => void
}) => (
  <>
    <ActivityPreview view={view} onReveal={onReveal} />
    <PendingStrip pending={pending} full={false} onReveal={() => onReveal("session")} />
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-5">
      {view.items.map((item) => {
        if (item.kind === "user") return <UserBubble key={item.id} item={item} observation={observation} onRewind={onRewind} onFork={onFork} />
        if (item.kind === "assistant") return <AssistantBlock key={item.id} item={item} showTools={false} />
        if (item.kind === "questions") return <Questions key={item.id} item={item} />
        if (item.kind === "error") return <p key={item.id} role="alert" className="text-destructive">{item.text}</p>
        if (item.kind === "notice") return <p key={item.id} className="text-muted-foreground text-center text-xs">{item.text}</p>
        if (item.kind === "mark") return <p key={item.id} className="text-muted-foreground text-center text-xs">{item.mark.replaceAll("_", " ")}</p>
        if (item.kind === "developer") return null
        if (item.kind === "entry") return <Disclosure key={item.id} summary={`${item.entry.kind} #${item.entry.number}`}><Text text={Object.values(item.entry.fields).join("\n\n")} /></Disclosure>
        return null
      })}
      <Permissions />
      {view.items.length === 0 && <p className="text-muted-foreground text-center text-sm">Send a message to start this session.</p>}
    </div>
  </>
)

type SemanticToolEntry = Extract<SemanticEntry, { kind: "agent-tool" }>

const semanticToolRenderers: Readonly<Record<string, (entry: SemanticToolEntry) => ReactNode>> = {
  file_patch: (entry) => {
    const value = entry.tool.arguments.value
    const patch = value !== null && typeof value === "object" && "patch" in value && typeof value.patch === "string" ? value.patch : null
    const paths = patch === null ? [] : [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((match) => match[1]!)
    return (
      <section className="rounded border p-2" aria-label="File patch">
        <div className="mb-1 font-mono text-xs">FilePatch · {paths.length === 0 ? "patch" : paths.join(", ")}</div>
        {patch !== null && <pre className="bg-muted/50 mb-2 max-h-96 overflow-auto rounded p-2 font-mono text-xs">{patch}</pre>}
        <pre className="bg-muted/50 max-h-96 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">
          {entry.tool.result?.content.map((part) => part.kind === "text" ? part.text : `[${part.name} ${part.content.mediaType}]`).join("\n") ?? "No retained patch result yet."}
        </pre>
      </section>
    )
  },
}

const SemanticTool = ({ entry }: { readonly entry: SemanticToolEntry }) => {
  const client = useClient()
  const sessionId = useClientState((state) => state.activeSessionId)
  const [capture, setCapture] = useState<{ name: string; data: string; offset: number; byteLength: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3" data-content-id={entry.contentId}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs">{entry.tool.name}</span>
        <span className="text-muted-foreground text-xs">{entry.tool.outcome ?? "not settled"}</span>
        <span className="text-muted-foreground text-xs">{entry.ownership.kind}</span>
      </div>
      <Disclosure summary="Input and result">
        <div className="grid gap-2 md:grid-cols-2">
          <pre className="bg-muted/50 max-h-80 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">{JSON.stringify(entry.tool.arguments.value, null, 2)}</pre>
          <pre className="bg-muted/50 max-h-80 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">
            {entry.tool.result?.content.map((part) => (part.kind === "text" ? part.text : `[${part.name} ${part.content.mediaType}]`)).join("\n") ?? "No retained result."}
          </pre>
        </div>
        {entry.tool.result?.content.map((part) =>
          part.kind === "media" ? <RetainedMedia key={part.id} entry={part} /> : null,
        )}
      </Disclosure>
      {semanticToolRenderers[entry.tool.name]?.(entry)}
      {entry.tool.captures.length > 0 && (
        <div className="flex flex-col gap-1 text-xs">
          {entry.tool.captures.map((captureRef) => (
            <div key={captureRef.contentId} className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{captureRef.name}</span>
              <span className="text-muted-foreground">{captureRef.mediaType} · {captureRef.byteLength} bytes{captureRef.captureLossBytes > 0 ? ` · ${captureRef.captureLossBytes} lost` : ""}</span>
              <button
                type="button"
                className="rounded border px-2 py-1"
                onClick={() => {
                  if (sessionId === null) return
                  void client
                    .capture(sessionId, entry.id, captureRef.contentId, 0, 65_536)
                    .then((result) => setCapture({ name: result.name, data: decodeBase64(result.data), offset: result.offset, byteLength: result.byteLength }))
                    .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "capture read failed"))
                }}
              >
                Preview
              </button>
            </div>
          ))}
          {error !== null && <p className="text-destructive">{error}</p>}
          {capture !== null && (
            <pre className="bg-muted/50 max-h-80 overflow-auto rounded p-2 whitespace-pre-wrap">{capture.data}</pre>
          )}
        </div>
      )}
    </div>
  )
}

const SessionBlock = ({ item }: { readonly item: SemanticPageEntry }) => {
  const client = useClient()
  const sessionId = useClientState((state) => state.activeSessionId)
  const [full, setFull] = useState<SemanticEntry | null>(null)
  const entry = full ?? item.entry
  if (full === null && item.body !== null && sessionId !== null) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
        <span className="text-muted-foreground">This {entry.kind} block keeps its larger body in retained content ({item.body.byteLength} bytes).</span>
        <button
          type="button"
          className="self-start rounded border px-2 py-1 text-xs"
          onClick={() => {
            void client.semanticBody(sessionId, entry.id, item.body!.contentId).then(setFull).catch(() => {})
          }}
        >
          Load body
        </button>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1" data-content-id={entry.contentId} data-tool-id={entry.kind === "agent-tool" ? entry.tool.id : undefined} data-thought-id={entry.kind === "agent-thought" ? entry.id : undefined}>
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono">{entry.kind}</span>
        <span>{entry.authorship.agentTitle}</span>
        {entry.ownership.kind === "inherited" && <span>inherited from {entry.ownership.sourceSessionId}</span>}
      </div>
      {entry.kind === "system" && <Text text={entry.content.text} className="bg-muted/40 rounded-lg border p-3" />}
      {entry.kind === "developer" && (
        <Disclosure summary={entry.components.map((component) => component.heading).join(", ") || "Developer message"}>
          {entry.components.map((component) => (
            <div key={component.id} className="mb-2">
              <div className="font-medium">{component.heading}</div>
              <Text text={component.text} />
            </div>
          ))}
        </Disclosure>
      )}
      {entry.kind === "user" && (
        <div className="bg-muted/40 rounded-lg border p-3">
          {entry.parts.map((part, index) =>
            part.kind === "text" ? <Text key={index} text={part.text} /> : <div key={index}><span className="font-mono text-xs">{part.name}</span> <RetainedMedia entry={part} /></div>,
          )}
        </div>
      )}
      {entry.kind === "agent" && (
        <div className="flex flex-col gap-2">
          {entry.parts.map((part, index) =>
            part.kind === "text" ? <Text key={index} text={part.text} /> : <RetainedMedia key={index} entry={part} />,
          )}
        </div>
      )}
      {entry.kind === "agent-thought" && <Disclosure summary="Thoughts"><Text text={entry.text} /></Disclosure>}
      {entry.kind === "agent-tool" && <SemanticTool entry={entry} />}
      {item.body !== null && <p className="text-muted-foreground text-xs">Loaded retained body.</p>}
    </div>
  )
}

export const SessionNotebook = ({ entries }: { readonly entries: ReadonlyArray<SemanticPageEntry> }) => (
  <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-5">
    {entries.map((entry) => <BlockBoundary key={entry.entry.id} fallback={<pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(entry.entry).slice(0, 4_096)}{typeof entry.body === "string" ? entry.body : entry.body === null ? "" : "\n" + JSON.stringify(entry.body)}</pre>}><SessionBlock item={entry} /></BlockBoundary>)}
    {entries.length === 0 && <p className="text-muted-foreground text-sm">No canonical history yet.</p>}
  </div>
)

const Contribution = ({ contribution }: { readonly contribution: ModelInputManifest["contributions"][number] }) => {
  const client = useClient()
  const sessionId = useClientState((state) => state.activeSessionId)
  const [content, setContent] = useState<string | null>(null)
  const sourceEntryId = contribution.kind === "placeholder" ? null : contribution.kind === "tool-definition" ? null : (contribution.sourceEntryId ?? contribution.sourceEntryIds[0] ?? null)
  const label =
    contribution.kind === "tool-definition"
      ? `tool definition · ${contribution.name}`
      : contribution.kind === "placeholder"
        ? `placeholder · ${contribution.reason}`
        : `${contribution.kind}${contribution.sourceEntryId === null ? "" : ` · ${contribution.sourceEntryId}`}`
  return (
    <li className="rounded border p-2 text-sm">
      <div className="flex flex-wrap justify-between gap-2">
        <span>{label}</span>
        <span className="text-muted-foreground font-mono text-xs">#{contribution.position}</span>
      </div>
      {contribution.kind !== "placeholder" && (
        <div className="text-muted-foreground mt-1 text-xs">
          {contribution.rendered.mediaType} · {contribution.rendered.byteLength} bytes · {contribution.rendered.renderer}
          {contribution.kind !== "tool-definition" && contribution.transformation !== null ? ` · ${contribution.transformation}` : ""}
        </div>
      )}
      {contribution.kind === "tool-definition" && (
        <details className="mt-2"><summary className="text-muted-foreground text-xs">Offered definition</summary><pre className="bg-muted/50 max-h-72 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">{contribution.description}\n{JSON.stringify(contribution.parameters, null, 2)}</pre></details>
      )}
      {sourceEntryId !== null && contribution.kind !== "tool-definition" && contribution.kind !== "placeholder" && (
        <div className="mt-2">
          {content === null ? (
            <button type="button" className="text-xs underline" onClick={() => {
              if (sessionId === null) return
              void client.capture(sessionId, sourceEntryId, contribution.rendered.contentId, 0, Math.min(contribution.rendered.byteLength, 65_536)).then((capture) => {
                setContent(decodeBase64(capture.data))
              }).catch(() => setContent("The retained representation could not be loaded."))
            }}>Load recorded content</button>
          ) : (
            <pre className="bg-muted/50 max-h-72 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">{content}</pre>
          )}
        </div>
      )}
    </li>
  )
}

export const Checkpoint = ({ manifest, usage }: { readonly manifest: ModelInputManifest | null; readonly usage: ReadonlyArray<{ readonly modelCallId: string; readonly providerUsage: unknown }> }) => {
  if (manifest === null)
    return <p className="text-muted-foreground px-4 py-5 text-sm">No successful model request is retained for this session yet.</p>
  const unavailable = manifest.measurement.unavailable.length
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-5">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Best-effort model input</h2>
        <p className="text-muted-foreground text-xs">Boundary {manifest.id} · window {manifest.windowPosition} · {time(manifest.committedAt)}</p>
      </header>
      <section className="rounded-lg border p-3">
        <h3 className="font-medium">Estimated context</h3>
        <p className="text-sm">
          {manifest.measurement.knownSubtotal.toLocaleString()} known tokens · {manifest.measurement.coverage} coverage
          {unavailable > 0 ? ` · ${unavailable} unavailable contribution(s)` : ""}
        </p>
        <Disclosure summary="Per-contribution measurements">
          <ul className="flex flex-col gap-1">
            {manifest.measurement.contributions.map((measurement) => (
              <li key={measurement.contributionPosition} className="flex justify-between gap-2">
                <span>#{measurement.contributionPosition} · {measurement.basis}</span>
                <span>{measurement.tokens === null ? "unavailable" : `${measurement.tokens.toLocaleString()} tokens`}</span>
              </li>
            ))}
          </ul>
        </Disclosure>
      </section>
      <section className="rounded-lg border p-3">
        <h3 className="font-medium">Provider usage</h3>
        {usage.length === 0 ? <p className="text-muted-foreground text-sm">Unknown; the provider reported no usage.</p> : (
          <ul className="flex flex-col gap-1 text-sm">
            {usage.map((entry) => (
              <li key={entry.modelCallId} className="font-mono text-xs">{entry.modelCallId}: {JSON.stringify(entry.providerUsage)}</li>
            ))}
          </ul>
        )}
      </section>
      <ol className="flex flex-col gap-1">
        {manifest.contributions.map((contribution) => <Contribution key={contribution.position} contribution={contribution} />)}
      </ol>
    </div>
  )
}

const RewindEditor = ({
  item,
  attachments,
  removedTurns,
  pendingInputs,
  onCancel,
  onSubmit,
}: {
  readonly item: UserItem
  readonly attachments: ReadonlyArray<string>
  readonly removedTurns: ReadonlyArray<string>
  readonly pendingInputs: ReadonlyArray<string>
  readonly onCancel: () => void
  readonly onSubmit: (text: string) => void
}) => {
  const [text, setText] = useState(item.messages.map((message) => message.text).join("\n\n"))
  return (
    <div className="bg-background mx-auto flex w-full max-w-3xl flex-col gap-2 rounded-lg border p-3 shadow">
      <p className="text-sm font-medium">Rewind this turn</p>
      <p className="text-destructive text-xs">
        This removes this turn and every later turn and pending message, then reruns immediately. External effects and workspace files are not rolled back.
      </p>
      <div className="text-muted-foreground text-xs">
        <p>Removes {removedTurns.length} turn(s):</p>
        <ul className="list-inside list-disc">{removedTurns.map((turn, index) => <li key={index} className="truncate">{turn}</li>)}</ul>
        {pendingInputs.length > 0 && <><p className="mt-1">Pending inputs removed:</p><ul className="list-inside list-disc">{pendingInputs.map((input, index) => <li key={index} className="truncate">{input}</li>)}</ul></>}
      </div>
      <textarea autoFocus className="min-h-24 rounded border p-2 text-sm" value={text} onChange={(event) => setText(event.target.value)} />
      {attachments.length > 0 && (
        <p className="text-muted-foreground text-xs">Original attachments stay attached and cannot be replaced here: {attachments.join(", ")}</p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded border px-3 py-1 text-sm" onClick={onCancel}>Cancel</button>
        <button type="button" className="bg-primary text-primary-foreground rounded px-3 py-1 text-sm" onClick={() => onSubmit(text)}>Confirm rewind</button>
      </div>
    </div>
  )
}

const FileChip = ({ attachment, onRemove, onReupload }: { readonly attachment: DraftAttachment; readonly onRemove: () => void; readonly onReupload: () => void }) => (
  <span className="bg-muted flex items-center gap-2 rounded-full px-3 py-1 text-xs">
    <span className="max-w-48 truncate">{attachment.name}</span>
    <span className="text-muted-foreground" title={attachment.failure}>{attachment.state === "failed" ? `failed: ${attachment.failure ?? "preparation failed"}` : attachment.state}</span>
    {(attachment.state === "expired" || attachment.state === "failed") && <button type="button" className="underline" onClick={onReupload}>Re-upload</button>}
    <button type="button" aria-label={`Remove ${attachment.name}`} onClick={onRemove}>×</button>
  </span>
)

const Composer = ({
  sessionId,
  draftStore,
  authority,
  draft,
  onDraft,
  view,
  observation,
  pending,
}: {
  readonly sessionId: string
  readonly draftStore: DraftStore | null
  readonly authority: string | null
  readonly draft: Draft | null
  readonly onDraft: (draft: Draft | null) => void
  readonly view: SessionView | undefined
  readonly observation: SessionObservation | undefined
  readonly pending: ReadonlyArray<PendingInput>
}) => {
  const client = useClient()
  const models = useClientState((state) => state.models)
  const agents = useClientState((state) => state.agents)
  const status = useClientState((state) => state.status)
  const error = useClientState((state) => state.error)
  const [statusText, setStatusText] = useState<string | null>(null)
  const [stopping, setStopping] = useState<string | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null)
  const [record, setRecord] = useState<DraftRecord | null>(null)
  const draftRef = useRef<Draft | null>(draft)
  useEffect(() => { draftRef.current = draft }, [draft])
  const fileInput = useRef<HTMLInputElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const connected = status === "connected"
  const ready = draft?.attachments.filter((attachment) => attachment.state === "ready") ?? []
  const blocked = draft?.attachments.some((attachment) => attachment.state !== "ready") ?? false
  const canSend = connected && draft !== null && (draft.text.trim() !== "" || ready.length > 0) && !blocked
  const pendingSubmissions = new Set(pending.flatMap((input) => input.submissionId === undefined ? [] : [input.submissionId]))
  const appliedAgent = view?.agent ?? "untitled"
  const appliedModel = view?.model ?? null
  const requested = draft?.selection ?? {}
  const title = requested.agentTitle ?? appliedAgent
  const model = requested.modelSettings?.modelId === undefined ? appliedModel : requested.modelSettings.modelId
  const effort = requested.modelSettings?.reasoningEffort === undefined ? (view?.reasoningEffort ?? null) : requested.modelSettings.reasoningEffort
  const modelEntry = models.find((candidate) => candidate.id === model)
  const save = (change: Partial<Draft>) => {
    const current = draftRef.current
    if (current === null) return
    const next = { ...current, ...change, updatedAt: Date.now() }
    draftRef.current = next
    onDraft(next)
    if (draftStore !== null && authority !== null) {
      const result = draftStore.save(authority, sessionId, {
        text: next.text,
        mode: next.mode,
        selection: next.selection,
        attachments: next.attachments,
      })
      setStorageError(result.ok ? null : "Not saved locally: browser storage is unavailable. Copy or export this draft.")
      if (!result.ok) draftFailureReporter?.()
    }
  }
  useEffect(() => {
    if (draftStore === null || authority === null) return
    setRecord(draftStore.load(authority, sessionId))
  }, [authority, draftStore, sessionId])
  useEffect(() => {
    if (status !== "connected" || draftStore === null || authority === null) return
    const current = draftStore.load(authority, sessionId)
    const unknown = current.submissions.filter((submission) => submission.state === "unknown")
    for (const submission of unknown) {
      void client.inputReceipt(sessionId, submission.submissionId).then((receipt) => {
        if (receipt !== null) {
          draftStore.updateSubmission(authority, sessionId, submission.submissionId, { state: "accepted" })
          void client.reconcileSubmission(sessionId, submission.submissionId)
        }
        setRecord(draftStore.load(authority, sessionId))
      }).catch(() => {})
    }
  }, [authority, client, draftStore, sessionId, status])
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
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        agent: selection.agentTitle ?? appliedAgent,
        model: selection.modelSettings?.modelId === undefined ? appliedModel : selection.modelSettings.modelId,
        reasoningEffort: selection.modelSettings?.reasoningEffort === undefined ? effort : selection.modelSettings.reasoningEffort,
      }))
    } catch {}
  }
  const attach = async (file: File) => {
    const currentDraft = draftRef.current
    if (currentDraft === null) return
    const local: DraftAttachment = { uploadId: crypto.randomUUID(), name: file.name, mediaType: file.type, size: file.size, sha256: null, state: "preparing" }
    save({ attachments: [...currentDraft.attachments, local] })
    try {
      const ref = await client.uploadFile(file, currentDraft.id)
      const latest = draftRef.current
      if (latest === null) return
      save({ attachments: latest.attachments.map((attachment) => attachment.uploadId === local.uploadId ? { ...attachment, uploadId: ref.attachmentId, stagingUploadId: local.uploadId, sha256: ref.digest, state: "ready", attachment: ref } : attachment) })
    } catch (failure) {
      const latest = draftRef.current
      if (latest === null) return
      save({ attachments: latest.attachments.map((attachment) => attachment.uploadId === local.uploadId ? { ...attachment, state: "failed", failure: failure instanceof Error ? failure.message : "upload failed" } : attachment) })
    }
  }
  const send = async () => {
    if (draft === null || draftStore === null || authority === null || !canSend) return
    const submissionId = crypto.randomUUID()
    const snapshot = {
      submissionId,
      text: draft.text,
      mode: draft.mode,
      selection: draft.selection,
      attachments: draft.attachments,
    }
    const detached = draftStore.detach(authority, sessionId, snapshot)
    setRecord(draftStore.load(authority, sessionId))
    if (!detached.ok) setStorageError("Not saved locally: the submission identity could not be stored. Keep this tab open.")
    onDraft({ ...draft, text: "", attachments: [], updatedAt: Date.now() })
    setStatusText("Sending…")
    try {
      const receipt = await client.submit(sessionId, {
        text: snapshot.text,
        mode: snapshot.mode,
        submissionId,
        selection: snapshot.selection,
        ...(ready.length === 0 ? {} : { attachments: ready.map((attachment) => attachment.attachment!) }),
      })
      draftStore.updateSubmission(authority, sessionId, submissionId, { state: receipt.disposition === "removed" ? "rejected" : "accepted" })
      setRecord(draftStore.load(authority, sessionId))
      setStatusText(receipt.disposition === "pending" ? "Accepted; waiting for admission." : "Sent.")
    } catch (failure) {
      const rejected = failure instanceof ProtocolError
      draftStore.updateSubmission(authority, sessionId, submissionId, { state: rejected ? "rejected" : "unknown", message: failure instanceof Error ? failure.message : "unknown" })
      setRecord(draftStore.load(authority, sessionId))
      setStatusText(rejected ? "Submission was rejected; restore or revise the draft." : "Acceptance unknown; checking the receipt before retrying.")
      if (rejected) return
      void client.inputReceipt(sessionId, submissionId).then((receipt) => {
        if (receipt !== null) {
          draftStore.updateSubmission(authority, sessionId, submissionId, { state: "accepted" })
          void client.reconcileSubmission(sessionId, submissionId)
        }
        setRecord(draftStore.load(authority, sessionId))
      }).catch(() => {})
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
    if (stopping !== null && observation !== undefined && observation.execution.activeTurnId !== stopping) setStopping(null)
  }, [observation, stopping])
  if (draft === null) return null
  return (
    <div className="bg-background border-t p-3">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        <div className="flex flex-wrap gap-1">
          {(record?.submissions ?? []).filter((submission) => submission.state !== "accepted" && !pendingSubmissions.has(submission.submissionId)).map((submission) => (
            <span key={submission.submissionId} className="bg-muted flex items-center gap-2 rounded-full px-3 py-1 text-xs">
              <span>{submission.state === "unknown" ? "Acceptance unknown" : submission.state === "rejected" ? "Rejected" : "Sending"}</span>
              <span className="max-w-48 truncate">{submission.text}</span>
              {submission.state === "rejected" && (
                <button type="button" className="underline" onClick={() => {
                  if (draftStore === null || authority === null) return
                  draftStore.restore(authority, sessionId, submission)
                  const next = draftStore.load(authority, sessionId)
                  setRecord(next)
                  if (next.active !== null) onDraft(next.active)
                }}>Restore draft</button>
              )}
            </span>
          ))}
          {(record?.recoverable ?? []).map((candidate) => (
            <button key={candidate.id} type="button" className="bg-muted rounded-full px-3 py-1 text-xs underline" onClick={() => {
              if (draftStore === null || authority === null) return
              draftStore.promote(authority, sessionId, candidate.id)
              const next = draftStore.load(authority, sessionId)
              setRecord(next)
              if (next.active !== null) onDraft(next.active)
            }}>Use recovered draft · {candidate.text.slice(0, 24)}</button>
          ))}
          {draft.attachments.map((attachment) => (
            <FileChip
              key={attachment.uploadId}
              attachment={attachment}
              onRemove={() => save({ attachments: draft.attachments.filter((candidate) => candidate.uploadId !== attachment.uploadId) })}
              onReupload={() => {
                save({ attachments: draft.attachments.filter((candidate) => candidate.uploadId !== attachment.uploadId) })
                fileInput.current?.click()
              }}
            />
          ))}
        </div>
        <div className="flex items-end gap-2">
          <textarea
            ref={textarea}
            aria-label="Message"
            className="bg-muted/40 min-h-20 flex-1 resize-y rounded-lg border p-3 text-sm"
            placeholder={connected ? "Message AsheAgent" : "Draft saved here; reconnect to send"}
            value={draft.text}
            onChange={(event) => save({ text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                if (canSend) void send()
              }
            }}
          />
          <div className="flex flex-col gap-1">
            <button type="button" className="bg-primary text-primary-foreground rounded px-4 py-2 text-sm disabled:opacity-40" disabled={!canSend} onClick={() => void send()}>
              Send
            </button>
            {observation?.execution.activeTurnId != null && (
              <button type="button" className="rounded border px-4 py-2 text-sm" disabled={stopping !== null} onClick={() => void stop()}>
                {stopping !== null ? "Stopping…" : "Stop"}
              </button>
            )}
            {observation?.execution.canResume === true && (
              <button type="button" className="rounded border px-3 py-1 text-xs" onClick={() => void client.resumeSession().catch(() => {})}>Continue</button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={draft.mode === "queue"} onChange={(event) => save({ mode: event.target.checked ? "queue" : "steer" })} />
            Queue after the turn
          </label>
          <label>Title
            <select className="bg-background ml-1 rounded border px-1 py-0.5" value={title} onChange={(event) => updateSelection({ agentTitle: event.target.value })}>
              <option value="untitled">Untitled</option>
              {agents.map((agent) => <option key={agent.key} value={agent.key}>{agent.title}</option>)}
            </select>
          </label>
          <label>Model
            <select className="bg-background ml-1 rounded border px-1 py-0.5" value={model ?? "__none"} onChange={(event) => updateSelection({ modelId: event.target.value === "__none" ? null : event.target.value, reasoningEffort: null })}>
              <option value="__none">No model</option>
              {models.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </select>
          </label>
          {modelEntry !== undefined && modelEntry.reasoningEfforts.length > 0 && (
            <label>Effort
              <select className="bg-background ml-1 rounded border px-1 py-0.5" value={effort ?? ""} onChange={(event) => updateSelection({ reasoningEffort: event.target.value === "" ? null : event.target.value })}>
                <option value="">Default</option>
                {modelEntry.reasoningEfforts.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
              </select>
            </label>
          )}
          <span className="text-muted-foreground">Applied: {appliedAgent} · {appliedModel ?? "no model"}</span>
          <button type="button" className="rounded border px-2 py-0.5" onClick={() => fileInput.current?.click()}>Attach</button>
          <input ref={fileInput} type="file" className="hidden" multiple onChange={(event) => { for (const file of event.target.files ?? []) void attach(file); event.target.value = "" }} />
        </div>
        <div aria-live="polite" className="text-muted-foreground flex min-h-4 items-center gap-2 text-xs">
          {storageError !== null && <span className="text-destructive">{storageError}
            <button type="button" className="ml-2 underline" onClick={() => void navigator.clipboard?.writeText(JSON.stringify({ text: draft.text, mode: draft.mode, selection: draft.selection, attachments: draft.attachments }, null, 2)).catch(() => {})}>Copy draft</button>
          </span>}
          {statusText !== null && <span>{statusText}</span>}
          {error !== null && <span className="text-destructive">{error}</span>}
        </div>
      </div>
    </div>
  )
}

const SidebarRow = ({
  sessionId,
  title,
  web,
  active,
  onOpen,
  onCommand,
}: {
  readonly sessionId: string
  readonly title: string
  readonly web: WebStateView
  readonly active: boolean
  readonly onOpen: (attention: boolean) => void
  readonly onCommand: (command: Parameters<WebStateClient["command"]>[0]) => void
}) => {
  const state = web.sessions[sessionId]
  const [open, setOpen] = useState(false)
  return (
    <li
      draggable
      onDragStart={(event) => event.dataTransfer.setData("text/session", sessionId)}
      className={className("group relative rounded-md", active && "bg-accent")}
    >
      <button type="button" className="flex w-full items-start gap-2 px-2 py-2 text-start" onClick={() => onOpen(state?.needsHuman === true)}>
        {state?.unread === true && <span className="bg-primary mt-1.5 size-2 shrink-0 rounded-full" aria-label="Unread" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{title}</span>
          <span className="text-muted-foreground block truncate text-xs">
            {state?.working === true ? "working" : state?.needsHuman === true ? "needs you" : state?.filed === true ? "filed" : time(state?.lastReturnAt ?? Date.now())}
          </span>
        </span>
        {state?.needsHuman === true && <span className="bg-destructive mt-1 size-2 rounded-full" aria-label="Needs human input" />}
      </button>
      <button type="button" aria-label="Session actions" className="absolute end-1 top-1 rounded px-1 opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => setOpen(!open)}>⋯</button>
      {open && (
        <div className="bg-background absolute end-1 top-8 z-10 flex w-44 flex-col gap-1 rounded border p-1 text-sm shadow">
          <button className="hover:bg-accent rounded px-2 py-1 text-start" onClick={() => onCommand({ kind: "organization.set", operationId: crypto.randomUUID(), sessionId, patch: { pinned: !state?.pinned } })}>{state?.pinned ? "Unpin" : "Pin"}</button>
          <button className="hover:bg-accent rounded px-2 py-1 text-start" onClick={() => onCommand({ kind: "read.set", operationId: crypto.randomUUID(), sessionId, unread: !state?.unread, ...(state === undefined ? {} : { generation: state.readGeneration }) })}>{state?.unread ? "Mark read" : "Mark unread"}</button>
          <button className="hover:bg-accent rounded px-2 py-1 text-start" onClick={() => onCommand({ kind: "organization.set", operationId: crypto.randomUUID(), sessionId, patch: { snoozedUntil: Date.now() + 3_600_000 } })}>Snooze 1 hour</button>
          <button
            className="hover:bg-accent rounded px-2 py-1 text-start"
            onClick={() => {
              if (state?.filed === true) onCommand({ kind: "organization.set", operationId: crypto.randomUUID(), sessionId, patch: { filed: false } })
              else if (state !== undefined) onCommand({ kind: "file.manual", operationId: crypto.randomUUID(), sessionId, observedCursor: state.sourceCursor, observedRevision: state.revision })
            }}
          >
            {state?.filed ? "Reopen" : "File"}
          </button>
          <button className="hover:bg-accent rounded px-2 py-1 text-start" onClick={() => onCommand({ kind: "organization.set", operationId: crypto.randomUUID(), sessionId, patch: { optedOut: !state?.optedOut } })}>{state?.optedOut ? "Enable inactivity filing" : "Opt out of filing"}</button>
        </div>
      )}
    </li>
  )
}

const Sidebar = ({
  client,
  web,
  active,
  onOpen,
  onCommand,
  onNew,
}: {
  readonly client: ReturnType<typeof useClient>
  readonly web: WebStateView
  readonly active: string | null
  readonly onOpen: (sessionId: string, attention: boolean) => void
  readonly onCommand: (command: Parameters<WebStateClient["command"]>[0]) => void
  readonly onNew: () => void
}) => {
  const sessions = useClientState((state) => state.sessions)
  const observations = useClientState((state) => state.observations)
  const rows = sessions.map((session) => {
    const state = web.sessions[session.id]
    const observation = observations[session.id]
    return {
      session,
      working: state?.working === true || observation?.execution.activity === "working" || (observation?.pending.length ?? 0) > 0,
      attention: state?.needsHuman === true || (observation?.attention.length ?? 0) > 0,
      pinned: state?.pinned === true,
      returnAt: state?.lastReturnAt ?? session.createdAt,
      submittedAt: state?.lastSubmissionAt ?? session.createdAt,
    }
  })
  const working = rows.filter((row) => row.working || row.attention)
  const inbox = rows.filter((row) => !row.working && !row.attention)
  return (
    <aside className="bg-muted/20 flex min-h-0 w-72 shrink-0 flex-col border-e max-md:absolute max-md:z-20 max-md:h-full max-md:w-60">
      <div className="flex items-center justify-between p-3">
        <h1 className="font-semibold">AsheAgent</h1>
        <div className="flex gap-1">
          <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => void client.refreshSessions().catch(() => {})}>Refresh</button>
          <button type="button" className="bg-primary text-primary-foreground rounded px-2 py-1 text-xs" onClick={onNew}>New</button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <h2 className="text-muted-foreground px-2 py-1 text-xs uppercase">Working</h2>
        <ul className="flex flex-col gap-0.5">
          {working.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.submittedAt - a.submittedAt || a.returnAt - b.returnAt).map((row) => (
            <SidebarRow key={row.session.id} sessionId={row.session.id} title={row.session.identity.agentTitle === "untitled" ? row.session.selection.modelSettings.modelId ?? row.session.id : row.session.identity.agentTitle} web={web} active={active === row.session.id} onOpen={(attention) => onOpen(row.session.id, attention)} onCommand={onCommand} />
          ))}
        </ul>
        <h2 className="text-muted-foreground mt-3 px-2 py-1 text-xs uppercase">Inbox</h2>
        <ul className="flex flex-col gap-0.5">
          {inbox.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.returnAt - a.returnAt).map((row) => (
            <SidebarRow key={row.session.id} sessionId={row.session.id} title={row.session.identity.agentTitle === "untitled" ? row.session.selection.modelSettings.modelId ?? row.session.id : row.session.identity.agentTitle} web={web} active={active === row.session.id} onOpen={(attention) => onOpen(row.session.id, attention)} onCommand={onCommand} />
          ))}
        </ul>
        <div
          className="text-muted-foreground mt-4 rounded border border-dashed p-3 text-center text-xs"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            const sessionId = event.dataTransfer.getData("text/session")
            if (sessionId !== "") onCommand({ kind: "organization.set", operationId: crypto.randomUUID(), sessionId, patch: { filed: true } })
          }}
        >
          Drop here to file
        </div>
      </div>
      <button type="button" className="border-t p-2 text-xs" onClick={() => client.signOut()}>Sign out</button>
    </aside>
  )
}

const Workspace = ({ webClient }: { readonly webClient: WebStateClient }) => {
  const client = useClient()
  const web = useWebState(webClient)
  const clientError = useClientState((state) => state.error)
  const sessions = useClientState((state) => state.sessions)
  const active = useClientState((state) => state.activeSessionId)
  const view = useClientState((state) => (state.activeSessionId === null ? undefined : state.views[state.activeSessionId]))
  const lastFailure = view === undefined ? undefined : [...view.items].reverse().find((item): item is AssistantItem => item.kind === "assistant" && (item.error !== null || item.status === "failed" || item.status === "cancelled" || item.status === "interrupted"))
  const recovered = lastFailure === undefined || view === undefined ? undefined : [...view.items].some((item) => item.kind === "assistant" && item.status === "finished" && item.seq > lastFailure.seq)
  const executionNotice = lastFailure === undefined ? null : recovered === true ? "Execution recovered after an earlier failure" : lastFailure.error ?? (lastFailure.status === "cancelled" ? "Execution cancelled" : `Execution ${lastFailure.status}`)
  const observation = useClientState((state) => (state.activeSessionId === null ? undefined : state.observations[state.activeSessionId]))
  const observations = useClientState((state) => state.observations)
  const semantic = useClientState((state) => (state.activeSessionId === null ? undefined : state.semantic[state.activeSessionId]))
  const [views, setViews] = useState<Record<string, ViewName>>(savedViews)
  const currentView = active === null ? "chat" : (views[active] ?? "chat")
  const [drafts, setDrafts] = useState<Record<string, Draft | null>>({})
  const [toast, setToast] = useState<string | null>(null)
  const [undoOperation, setUndoOperation] = useState<string | null>(null)
  const [unsupportedDrafts, setUnsupportedDrafts] = useState<ReadonlyArray<{ readonly key: string; readonly raw: string }>>([])
  const [recoverables, setRecoverables] = useState<ReadonlyArray<Draft>>([])
  const [recoveryTick, setRecoveryTick] = useState(0)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [shortcuts, setShortcuts] = useState<ShortcutPreferences>(shortcutPreferences)
  const [grants, setGrants] = useState<ReadonlyArray<{ agentTitle: string; permission: string; pattern: string }>>([])
  const [grantTitle, setGrantTitle] = useState<string | null>(null)
  const [readEligible, setReadEligible] = useState<string | null>(null)
  const [rewindItem, setRewindItem] = useState<UserItem | null>(null)
  const rewindOperation = useRef(crypto.randomUUID())
  const [checkpoint, setCheckpoint] = useState<{ manifest: ModelInputManifest; usage: ReadonlyArray<{ modelCallId: string; providerUsage: unknown }> } | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const scrolls = useRef<Record<string, number>>({})
  const draftsStore = useMemo(() => {
    try {
      return new DraftStore(window.localStorage, window.localStorage)
    } catch {
      return null
    }
  }, [])
  const authority = web.harnessId !== null && web.principal !== null ? `${web.harnessId}:${web.principal}` : null
  const draft = active === null ? null : (drafts[active] ?? null)
  const setSessionView = (sessionId: string, next: ViewName) => {
    setViews((current) => ({ ...current, [sessionId]: next }))
    saveView(sessionId, next)
  }
  useEffect(() => {
    if (active === null || authority === null || draftsStore === null) return
    const record = draftsStore.load(authority, active)
    setDrafts((current) => current[active] === undefined ? { ...current, [active]: record.active } : current)
    for (const attachment of record.active?.attachments ?? []) {
      if (attachment.state !== "ready" || attachment.stagingUploadId === undefined) {
        if (attachment.state === "ready" && attachment.stagingUploadId === undefined) {
          draftsStore.expireAttachment(authority, active, attachment.uploadId)
          setDrafts((current) => ({ ...current, [active]: draftsStore.load(authority, active).active }))
        }
        continue
      }
      void client.uploadStatus(attachment.stagingUploadId).then((status) => {
        if (status.attachmentId === undefined) {
          draftsStore.expireAttachment(authority, active, attachment.stagingUploadId!)
          const refreshed = draftsStore.load(authority, active)
          setDrafts((current) => ({ ...current, [active]: refreshed.active }))
        }
      }).catch(() => {
        draftsStore.expireAttachment(authority, active, attachment.stagingUploadId!)
        setDrafts((current) => ({ ...current, [active]: draftsStore.load(authority, active).active }))
      })
    }
  }, [active, authority, client, draftsStore])
  useEffect(() => {
    setRenderFailureReporter(() => webClient.reportDiagnostic("web.render_failure", { "web.error_type": "component_error" }))
    setDraftFailureReporter(() => webClient.reportDiagnostic("web.draft", { "web.operation": "save", "web.outcome": "unavailable" }))
    return () => { setRenderFailureReporter(null); setDraftFailureReporter(null) }
  }, [webClient])
  useEffect(() => {
    if (active === null || authority === null || draftsStore === null) return
    const unsupported = draftsStore.unsupported(authority, active)
    setUnsupportedDrafts(unsupported)
    setRecoverables(draftsStore.candidates(authority, active))
    if (unsupported.length > 0) setToast(`${unsupported.length} saved draft record(s) use an unsupported format.`)
  }, [active, authority, draftsStore])
  useEffect(() => {
    if (active === null) return
    if (semantic === undefined) void client.reloadSemantic(active).catch(() => {})
  }, [active, client, semantic])
  useEffect(() => {
    if (active === null || readEligible !== active || web.status !== "live" || currentView === "checkpoint") return
    const state = web.sessions[active]
    if (state === undefined || !state.unread) return
    void webClient.command({ kind: "read.set", operationId: crypto.randomUUID(), sessionId: active, unread: false, generation: state.readGeneration }).catch(() => {})
    setReadEligible(null)
  }, [active, currentView, readEligible, web, webClient])
  useEffect(() => {
    const key = active === null ? null : `${active}:${currentView}`
    if (key === null || scroller.current === null) return
    const el = scroller.current
    el.scrollTop = scrolls.current[key] ?? 0
    return () => { scrolls.current[key] = el.scrollTop }
  }, [active, currentView])
  useEffect(() => {
    const key = active === null ? null : `${active}:${currentView}`
    if (key === null || currentView === "checkpoint") return
    const el = scroller.current
    if (el !== null && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
  }, [view, semantic, active, currentView])
  useEffect(() => {
    const latestId = semantic?.latestSuccessfulBoundaryId ?? null
    if (latestId === null || active === null) { setCheckpoint(null); return }
    let cancelled = false
    void client.semanticBoundary(active, latestId).then(async (manifest) => {
      if (cancelled) return
      const usage = await client.modelUsage(active, [manifest.modelCallId]).catch(() => [])
      if (!cancelled) setCheckpoint({ manifest, usage })
    }).catch(() => { if (!cancelled) setCheckpoint(null) })
    return () => { cancelled = true }
  }, [active, client, semantic?.latestSuccessfulBoundaryId])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const cycle = shortcuts.viewModifier === "ctrl" ? event.ctrlKey || event.metaKey : event.altKey && !event.ctrlKey && !event.metaKey
      if (cycle && event.key.toLowerCase() === "i") {
        event.preventDefault()
        if (active === null) return
        const index = VIEWS.findIndex((entry) => entry.value === currentView)
        setSessionView(active, VIEWS[(index + 1) % VIEWS.length]!.value)
        return
      }
      if (event.key === "Escape" && !event.defaultPrevented) {
        if (rewindItem !== null) {
          event.preventDefault()
          setRewindItem(null)
          return
        }
        const target = event.target as HTMLElement | null
        if (target?.closest("select, [role='dialog'], details[open]")) return
        if (active !== null) setSessionView(active, "chat")
        return
      }
      const target = event.target as HTMLElement | null
      if (!shortcuts.typeToFocus || active === null || event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return
      if (target?.closest("input, textarea, select, button, a, [contenteditable='true']")) return
      const composer = document.querySelector<HTMLTextAreaElement>("[aria-label='Message']")
      if (composer === null) return
      composer.focus()
      const start = composer.selectionStart
      const end = composer.selectionEnd
      const next = composer.value.slice(0, start) + event.key + composer.value.slice(end)
      composer.value = next
      composer.dispatchEvent(new Event("input", { bubbles: true }))
      composer.selectionStart = composer.selectionEnd = start + 1
      event.preventDefault()
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [active, currentView, rewindItem, shortcuts])
  useEffect(() => {
    try { localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(shortcuts)) } catch {}
  }, [shortcuts])
  const openSession = (sessionId: string, attention: boolean) => {
    if (window.matchMedia("(max-width: 767px)").matches) setSidebarOpen(false)
    void client.open(sessionId).catch(() => {})
    if (attention) {
      setSessionView(sessionId, "chat")
      setReadEligible(sessionId)
      requestAnimationFrame(() => document.querySelector("[data-attention]")?.scrollIntoView({ block: "center" }))
    } else {
      const next = views[sessionId] ?? savedViews()[sessionId] ?? "chat"
      setViews((current) => ({ ...current, [sessionId]: next }))
      if (next !== "checkpoint") setReadEligible(sessionId)
    }
  }
  useEffect(() => {
    if (!detailsOpen || active === null) return
    void client.grants(active).then((loaded) => {
      setGrants(loaded)
      setGrantTitle((current) => current ?? (sessions.find((session) => session.id === active)?.selection.agentTitle ?? "untitled"))
    }).catch(() => setToast("Permissions could not be loaded"))
  }, [active, client, detailsOpen, sessions])
  const onCommand = (command: Parameters<WebStateClient["command"]>[0]) => {
    void webClient.command(command).then((receipt) => {
      if (receipt.outcome !== "confirmed") setToast(receipt.message ?? `Operation ${receipt.outcome}`)
      else if (command.kind === "organization.set" || command.kind === "file.manual") {
        setUndoOperation(command.operationId)
        setToast("Organization updated")
      }
    }).catch((failure: unknown) => setToast(failure instanceof UncertainOperation ? `Uncertain: ${failure.operationId}` : failure instanceof Error ? failure.message : "Organization update failed"))
  }
  const onNew = () => {
    const raw = window.localStorage.getItem(PREFS_KEY)
    const prefs = raw === null ? {} : (JSON.parse(raw) as { model?: string | null; agent?: string; reasoningEffort?: string | null })
    void client.createSession({
      ...(prefs.model === undefined ? {} : { model: prefs.model }),
      ...(prefs.agent === undefined ? {} : { agent: prefs.agent }),
      ...(prefs.reasoningEffort === undefined ? {} : { reasoningEffort: prefs.reasoningEffort }),
    }).then((session) => {
      setSessionView(session.id, "chat")
      setReadEligible(session.id)
    }).catch(() => {})
  }
  const reveal = (target: string) => {
    if (active === null) return
    setSessionView(active, "session")
    requestAnimationFrame(() => {
      const [kind, id] = target.split(":")
      const selector = kind === "tool" ? `[data-tool-id='${id}']` : `[data-thought-id='${id}']`
      document.querySelector(selector)?.scrollIntoView({ block: "center" })
    })
  }
  if (active === null) return <div className="flex min-h-svh"><Sidebar client={client} web={web} active={active} onOpen={openSession} onCommand={onCommand} onNew={onNew} /><main className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Open a session or create one.</main></div>
  const session = sessions.find((candidate) => candidate.id === active)
  const attentionCount = sessions.filter((candidate) => web.sessions[candidate.id]?.needsHuman === true || (observations[candidate.id]?.attention.length ?? 0) > 0).length
  return (
    <div className="flex h-svh min-h-0">
      {clientError !== null && (
        <div role="alert" className="fixed start-0 end-0 top-0 z-40 flex items-center justify-center gap-2 bg-red-50 px-4 py-2 text-sm text-red-900">
          {clientError}
          <button type="button" className="underline" onClick={() => client.signOut()}>Sign in again</button>
        </div>
      )}
      {sidebarOpen && <button type="button" aria-label="Close sidebar" className="fixed inset-0 z-10 bg-black/20 md:hidden" onClick={() => setSidebarOpen(false)} />}
      {sidebarOpen && <Sidebar client={client} web={web} active={active} onOpen={openSession} onCommand={onCommand} onNew={onNew} />}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <button type="button" className="relative rounded border px-2 py-1 text-xs" aria-label="Toggle sidebar" onClick={() => setSidebarOpen(!sidebarOpen)}>
            ☰
            {attentionCount > 0 && <span className="bg-destructive text-destructive-foreground absolute -end-1 -top-1 rounded-full px-1 text-[10px]">{attentionCount}</span>}
          </button>
          <span className="font-mono text-xs">{active}</span>
          {web.sessions[active]?.needsHuman === true && <span role="status" className="bg-destructive text-destructive-foreground rounded px-2 py-1 text-xs">Needs you</span>}
          {web.status !== "live" && <span role="status" className="text-destructive text-xs">{web.error ?? "Shared organization is stale"}
            {web.status === "incompatible" && <button type="button" className="ml-2 underline" onClick={() => window.location.reload()}>Reload</button>}
          </span>}
          <span className="flex-1" />
          <label className="text-xs">View
            <select className="bg-background ml-1 rounded border px-2 py-1" value={currentView} onChange={(event) => setSessionView(active, event.target.value as ViewName)}>
              {VIEWS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
            </select>
          </label>
          <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => setDetailsOpen(!detailsOpen)}>Session details</button>
          <label className="text-xs">View key
            <select className="bg-background ml-1 rounded border px-2 py-1" value={shortcuts.viewModifier} onChange={(event) => setShortcuts({ ...shortcuts, viewModifier: event.target.value === "alt" ? "alt" : "ctrl" })}>
              <option value="ctrl">Ctrl+I</option>
              <option value="alt">Alt+I</option>
            </select>
          </label>
          <label className="text-xs"><input type="checkbox" className="mr-1" checked={shortcuts.typeToFocus} onChange={(event) => setShortcuts({ ...shortcuts, typeToFocus: event.target.checked })} />Type to compose</label>
        </header>
        {detailsOpen && (
          <section className="border-b p-3 text-sm" aria-label="Session details">
            <div className="flex flex-wrap items-center gap-2">
              <strong>Permissions</strong>
              <label>Title
                <select className="bg-background ml-1 rounded border px-2 py-1" value={grantTitle ?? ""} onChange={(event) => setGrantTitle(event.target.value)}>
                  {[...new Set([grantTitle, ...grants.map((grant) => grant.agentTitle)].filter((value): value is string => value !== null))].map((title) => <option key={title} value={title}>{title}</option>)}
                </select>
              </label>
              <button
                type="button"
                className="text-destructive rounded border px-2 py-1"
                disabled={grantTitle === null}
                onClick={() => {
                  if (grantTitle === null || !window.confirm(`Clear every persisted approval for ${grantTitle}?`)) return
                  void client.clearGrants(active, grantTitle).then((cleared) => {
                    setGrants((current) => current.filter((grant) => grant.agentTitle !== grantTitle))
                    setToast(`Cleared ${cleared} grant(s) for ${grantTitle}`)
                  }).catch(() => setToast("Grants could not be cleared"))
                }}
              >Clear all for this title</button>
            </div>
            <ul className="mt-2 flex flex-col gap-1">
              {grants.filter((grant) => grant.agentTitle === grantTitle).map((grant, index) => (
                <li key={index} className="font-mono text-xs">{grant.permission}: {grant.pattern}</li>
              ))}
              {grants.every((grant) => grant.agentTitle !== grantTitle) && <li className="text-muted-foreground text-xs">No grants for this title.</li>}
            </ul>
          </section>
        )}
        {currentView !== "chat" && <PendingStrip pending={view?.pending ?? []} full={currentView === "session"} onReveal={() => setSessionView(active!, "session")} />}
        {recoverables.length > 0 && (
          <div className="bg-muted border-b px-4 py-2 text-xs">
            <span className="text-muted-foreground">Recoverable drafts from another tab:</span>
            {recoverables.map((candidate) => (
              <button key={candidate.id} type="button" className="ml-2 underline" onClick={() => {
                if (authority === null || draftsStore === null) return
                draftsStore.recover(authority, active!, candidate)
                const record = draftsStore.load(authority, active!)
                setDrafts((current) => ({ ...current, [active!]: record.active }))
                setRecoverables(record.recoverable.filter((draft) => draft.source !== candidate.id))
                setRecoveryTick((tick) => tick + 1)
                setToast(record.active?.source === candidate.id ? "Recovered draft into this tab." : "Saved as a selectable recovery draft.")
              }}>{candidate.updatedAt.toString()}</button>
            ))}
          </div>
        )}
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto" data-view={currentView}>
          {currentView === "chat" && (
            <Chat view={view ?? { ...emptyViewLike(active) }} observation={observation} pending={view?.pending ?? []} onRewind={(item) => { rewindOperation.current = crypto.randomUUID(); setRewindItem(item) }} onFork={(item) => { void client.fork(item.runId!).then((fork) => { setSessionView(fork.id, "chat"); setReadEligible(fork.id) }).catch((failure: unknown) => setToast(failure instanceof Error ? failure.message : "Fork failed")) }} onReveal={reveal} />
          )}
          {currentView === "session" && <SessionNotebook entries={semantic?.entries ?? []} />}
          {currentView === "checkpoint" && <Checkpoint manifest={checkpoint?.manifest ?? null} usage={checkpoint?.usage ?? []} />}
        </div>
        {rewindItem !== null && (
          <RewindEditor
            item={rewindItem}
            removedTurns={(view?.items ?? []).flatMap((item) => item.kind === "user" && item.seq >= rewindItem.seq ? item.messages.map((message) => message.text) : [])}
            pendingInputs={(view?.pending ?? []).map((input) => input.text)}
            attachments={(semantic?.entries ?? []).flatMap((entry) => entry.entry.kind === "user" && entry.entry.turnId === rewindItem.runId ? entry.entry.parts.flatMap((part) => part.kind === "attachment" ? [part.name] : []) : [])}
            onCancel={() => setRewindItem(null)}
            onSubmit={(text) => {
              const selection = draft === null ? {} : draft.selection
              void client
                .rewind(rewindItem.runId!, text, rewindOperation.current, Object.keys(selection).length === 0 ? undefined : selection)
                .then(() => {
                  setRewindItem(null)
                  if (draft !== null) setDrafts((current) => ({ ...current, [active]: { ...draft, selection: {} } }))
                })
                .catch(async (failure: unknown) => {
                  const result = await client.historyResult(active, rewindOperation.current).catch(() => null)
                  if (result?.kind === "observed") {
                    setRewindItem(null)
                    return
                  }
                  setToast(failure instanceof Error ? failure.message : "Rewind failed; the edit is kept")
                })
            }}
          />
        )}
        {executionNotice !== null && (
          <div role="status" className="border-t bg-red-50 px-4 py-1 text-xs text-red-900">
            {executionNotice}
            <button type="button" className="ml-2 underline" onClick={() => { setSessionView(active!, "chat"); requestAnimationFrame(() => { if (lastFailure !== undefined) document.querySelector(`[data-item-id='${lastFailure.id}']`)?.scrollIntoView({ block: "center" }) }) }}>Reveal</button>
          </div>
        )}
        <Composer key={`${active}:${recoveryTick}`} sessionId={active} draftStore={draftsStore} authority={authority} draft={draft} onDraft={(next) => setDrafts((current) => ({ ...current, [active]: next }))} view={view} observation={observation} pending={view?.pending ?? []} />
        {toast !== null && <div role="status" className="bg-background absolute bottom-4 end-4 rounded border px-3 py-2 text-sm shadow">{toast}
          {undoOperation !== null && <button type="button" className="ml-2 underline" onClick={() => { const operationId = crypto.randomUUID(); void webClient.command({ kind: "undo", operationId, undoOf: undoOperation }).then((receipt) => { if (receipt.outcome !== "confirmed") setToast(receipt.message ?? "Undo refused"); setUndoOperation(null) }).catch(() => {}) }}>Undo</button>}
          <button type="button" className="ml-2 underline" onClick={() => { setToast(null); setUndoOperation(null) }}>Dismiss</button>
        </div>}
        {unsupportedDrafts.length > 0 && (
          <div className="bg-muted absolute top-12 end-4 flex items-center gap-2 rounded border px-3 py-2 text-xs shadow">
            Unsupported saved drafts are preserved.
            <button type="button" className="underline" onClick={() => {
              const blob = new Blob([JSON.stringify(unsupportedDrafts, null, 2)], { type: "application/json" })
              const url = URL.createObjectURL(blob)
              const anchor = document.createElement("a")
              anchor.href = url
              anchor.download = `ashe-agent-drafts-${Date.now()}.json`
              anchor.click()
              URL.revokeObjectURL(url)
            }}>Export</button>
          </div>
        )}
      </section>
    </div>
  )
}

const emptyViewLike = (sessionId: string): SessionView => ({
  sessionId,
  lastSeq: 0,
  events: [],
  sessionDir: null,
  agent: null,
  model: null,
  reasoningEffort: null,
  forkedFrom: null,
  runId: null,
  activeSelection: null,
  items: [],
  pending: [],
  permissions: [],
  segments: {},
  streams: {},
  settled: [],
})

export const App = () => {
  const signedIn = useClientState((state) => state.status !== "signedOut" && state.principal !== null)
  const client = useClient()
  const [webClient] = useState(() => new WebStateClient(new URL("/v1/web-state", window.location.origin).href, () => client.accessToken(), () => client.renewAccessToken()))
  useEffect(() => {
    if (!signedIn) { webClient.stop(); return }
    webClient.start()
    return () => webClient.stop()
  }, [signedIn, webClient])
  return signedIn ? <Workspace webClient={webClient} /> : <SignIn />
}

export default App

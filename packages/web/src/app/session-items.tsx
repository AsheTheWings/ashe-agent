import { useAuiState } from "@assistant-ui/react"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type { EntryItem, Item, Mark, PendingInput, QuestionsItem } from "@/session/projection.ts"
import { useClient, useClientState } from "./client-context.tsx"

/** The fields of an entry kind in the order the timelines render them. */
const FIELDS: Record<EntryItem["entry"]["kind"], ReadonlyArray<string>> = {
  open: ["Text"],
  done: ["Text"],
  decision: ["Decision", "Rationale"],
  problem: ["Text"],
  compaction: ["Text"],
  research: ["FileName", "Change", "Summary"],
  answer: ["Question", "Selection", "UserNote"],
  handoff: ["Text"],
}

const BLOCK_TEXT = new Set(["compaction", "handoff"])

/** The most characters a note holds, as `session.answerQuestion` counts them: in code points, once trimmed. */
const NOTE_MAX = 2_000
const noteLength = (note: string) => [...note.trim()].length

/** A timeline entry where it was recorded: its kind and number, its fields, and what resolved it. */
const Entry = ({ item }: { item: EntryItem }) => {
  const { entry } = item
  return (
    <div className="bg-muted/40 flex flex-col gap-1 rounded-lg border px-3 py-2 text-start" data-entry={entry.number}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono">
          [{entry.kind.toUpperCase()} #{entry.number}]
        </Badge>
        {item.resolvedBy !== null && <Badge variant="secondary">resolved by #{item.resolvedBy}</Badge>}
        {entry.resolves.length > 0 && (
          <span className="text-muted-foreground">resolves {entry.resolves.map((number) => `#${number}`).join(", ")}</span>
        )}
      </div>
      {BLOCK_TEXT.has(entry.kind) ? (
        <p className="text-foreground whitespace-pre-wrap">{entry.fields.Text}</p>
      ) : (
        <dl className="text-foreground grid grid-cols-[auto_1fr] gap-x-2">
          {FIELDS[entry.kind]
            .filter((field) => entry.fields[field] !== undefined)
            .map((field) => (
              <div key={field} className="contents">
                <dt className="text-muted-foreground">{field}</dt>
                <dd className="whitespace-pre-wrap">{entry.fields[field]}</dd>
              </div>
            ))}
        </dl>
      )}
    </div>
  )
}

const markText = (mark: Mark): string => {
  switch (mark.mark) {
    case "context_turn":
      return mark.trigger === "limit"
        ? "Context turn: the checkpoint window reached its limit"
        : "Context turn: the checkpoint window ran short"
    case "clearing":
      return `Clearing ${mark.attempt} of 3 freed about ${mark.tokensFreed.toLocaleString()} tokens of old tool results`
    case "window":
      return `Checkpoint window ${mark.window} begins`
    case "continuation":
      return "Continuation turn"
    case "developer_turn":
      return "Turn started by a developer message"
    case "validation_failed":
      return `Context check ${mark.attempt} failed`
  }
}

const MarkLine = ({ mark }: { mark: Mark }) => (
  <div className="flex flex-col items-center gap-1">
    <div className="flex w-full items-center gap-2">
      <span className="bg-border h-px flex-1" />
      <span>{markText(mark)}</span>
      <span className="bg-border h-px flex-1" />
    </div>
    {mark.mark === "validation_failed" && (
      <ul className="text-start">
        {mark.violations.map((violation, index) => (
          <li key={index}>{violation}</li>
        ))}
      </ul>
    )}
  </div>
)

type Draft = { readonly selection: string | null; readonly note: string; readonly skipped: boolean }
const EMPTY: Draft = { selection: null, note: "", skipped: false }

/** An open question set: each question with its options, a note, and skip. */
const OpenQuestions = ({ item }: { item: QuestionsItem }) => {
  const client = useClient()
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [busy, setBusy] = useState(false)
  const draft = (id: string) => drafts[id] ?? EMPTY
  const change = (id: string, next: Partial<Draft>) => setDrafts({ ...drafts, [id]: { ...draft(id), ...next } })
  const tooLong = item.questions.some((question) => !draft(question.id).skipped && noteLength(draft(question.id).note) > NOTE_MAX)
  const send = () => {
    setBusy(true)
    const answers = item.questions.map((question) => {
      const { selection, note, skipped } = draft(question.id)
      const trimmed = note.trim()
      return {
        id: question.id,
        ...(skipped || selection === null ? {} : { selection }),
        ...(skipped || trimmed === "" ? {} : { note: trimmed }),
      }
    })
    void client
      .answerQuestion(item.id, answers)
      .catch(() => {})
      .finally(() => setBusy(false))
  }
  return (
    <>
      {item.questions.map((question) => {
        const current = draft(question.id)
        const length = noteLength(current.note)
        return (
          <fieldset key={question.id} className="flex flex-col gap-2" disabled={busy}>
            <legend className="flex items-center gap-2">
              <Badge variant="outline">{question.header}</Badge>
              <span className="text-foreground">{question.question}</span>
            </legend>
            <div className="flex flex-col gap-1">
              {question.options.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={current.selection === option.label}
                  disabled={current.skipped}
                  onClick={() => change(question.id, { selection: current.selection === option.label ? null : option.label })}
                  className={cn(
                    "hover:bg-accent flex flex-col rounded-md border px-2 py-1 text-start disabled:opacity-50",
                    current.selection === option.label && "border-primary bg-accent",
                  )}
                >
                  <span className="text-foreground font-medium">{option.label}</span>
                  <span>{option.description}</span>
                </button>
              ))}
            </div>
            <Textarea
              aria-label={`Note on ${question.header}`}
              placeholder="Note (optional)"
              rows={2}
              disabled={current.skipped}
              value={current.note}
              onChange={(event) => change(question.id, { note: event.target.value })}
            />
            {!current.skipped && length > NOTE_MAX && (
              <p role="alert" className="text-destructive">
                The note holds {length.toLocaleString("en-US")} characters; a note holds at most {NOTE_MAX.toLocaleString("en-US")}.
              </p>
            )}
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={current.skipped} onChange={(event) => change(question.id, { skipped: event.target.checked })} />
              Skip this question
            </label>
          </fieldset>
        )
      })}
      <Button size="sm" className="self-end" disabled={busy || tooLong} onClick={send}>
        Send answers
      </Button>
    </>
  )
}

/** An answered or ended question set as the session's history keeps it. */
const SettledQuestions = ({ item }: { item: QuestionsItem }) => (
  <dl className="flex flex-col gap-1">
    {item.questions.map((question) => {
      const answer = item.answers?.find((candidate) => candidate.id === question.id)
      const parts = [answer?.selection, answer?.note].filter((part) => part !== undefined)
      return (
        <div key={question.id}>
          <dt className="text-foreground">
            <Badge variant="outline">{question.header}</Badge> {question.question}
          </dt>
          <dd>{item.answers === null ? "Not answered: the call ended" : parts.length === 0 ? "Skipped" : parts.join(" · ")}</dd>
        </div>
      )
    })}
  </dl>
)

/** A question set: its feedback first, then the open form or the settled answers. */
const Questions = ({ item }: { item: QuestionsItem }) => (
  <section aria-label="Questions" className="bg-muted/40 flex flex-col gap-3 rounded-lg border px-3 py-2 text-start">
    {item.feedback !== null && <p className="text-foreground whitespace-pre-wrap">{item.feedback}</p>}
    {item.open ? <OpenQuestions item={item} /> : <SettledQuestions item={item} />}
  </section>
)

const SessionItem = ({ item }: { item: Item }) => {
  switch (item.kind) {
    case "notice":
      return <p>{item.text}</p>
    case "error":
      return (
        <p role="alert" className="text-destructive">
          {item.text}
        </p>
      )
    case "entry":
      return <Entry item={item} />
    case "mark":
      return <MarkLine mark={item} />
    case "questions":
      return <Questions item={item} />
    case "developer":
      return (
        <details className="text-start">
          <summary className="cursor-pointer">Developer message: {item.components.map((component) => component.heading).join(", ")}</summary>
          {item.components.map((component, index) => (
            <pre key={index} className="bg-muted/40 mt-1 overflow-x-auto rounded-md p-2 whitespace-pre-wrap">
              {component.text}
            </pre>
          ))}
        </details>
      )
    case "user":
    case "assistant":
      return null
  }
}

/** The content of a system message: the session item it carries. */
export const SystemItem = () => {
  const item = useAuiState((s) => (s.message.metadata.custom as { item?: Item }).item ?? null)
  return item === null ? null : <SessionItem item={item} />
}

const NO_PENDING: ReadonlyArray<PendingInput> = []

/** The user messages waiting for a turn, until a turn takes them. */
export const PendingInputs = () => {
  const pending = useClientState((state) =>
    state.activeSessionId === null ? NO_PENDING : (state.views[state.activeSessionId]?.pending ?? NO_PENDING),
  )
  if (pending.length === 0) return null
  return (
    <section aria-label="Waiting messages" className="flex flex-col gap-1">
      {pending.map((input) => (
        <div key={input.inputId} className="bg-muted/30 text-muted-foreground flex items-start gap-2 rounded-lg border border-dashed px-3 py-1.5 text-sm">
          <Badge variant="outline">{input.mode === "queue" ? "queued" : "waiting"}</Badge>
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{input.text}</span>
        </div>
      ))}
    </section>
  )
}

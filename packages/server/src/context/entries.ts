import { APPEND_MAX_ENTRIES, ENTRY_FIELD_MAX_LENGTH, RESEARCH_SUMMARY_MAX_LENGTH, RESOLVES_MAX_ENTRIES } from "./constants.ts"

/** What an entry records. The agent appends the first four kinds; the harness writes the rest. */
export type EntryKind = "open" | "done" | "decision" | "problem" | "compaction" | "research" | "answer" | "handoff"

/** One timeline entry as stored, numbered in the session's one sequence. */
export interface Entry {
  readonly number: number
  readonly kind: EntryKind
  /** Field values by name; a compaction or handoff entry's text is its `Text`. */
  readonly fields: Readonly<Record<string, string>>
  /** The open and problem entries a done entry resolves. */
  readonly resolves: ReadonlyArray<number>
  /** Whether the entry was trimmed from the primary timeline. */
  readonly trimmed: boolean
  readonly runId: string
  /** The checkpoint window that was current when the entry, or a compaction entry's text, was recorded. */
  readonly windowPosition: number
}

/** An entry about to be recorded: its kind, fields, and resolved entries. */
export interface NewEntry {
  readonly kind: EntryKind
  readonly fields: Readonly<Record<string, string>>
  readonly resolves?: ReadonlyArray<number>
}

/** Each kind's fields, in the order an entry renders them. */
const FIELDS: Readonly<Record<EntryKind, ReadonlyArray<string>>> = {
  open: ["Text"],
  done: ["Text"],
  decision: ["Decision", "Rationale"],
  problem: ["Text"],
  compaction: ["Text"],
  research: ["FileName", "Change", "Summary"],
  answer: ["Question", "Selection", "UserNote"],
  handoff: ["Text"],
}

/** The number of Unicode code points of `text`. */
export const codePoints = (text: string) => [...text].length

/** An entry's header line, `[<KIND> #<n>]`. */
export const entryHeader = (kind: EntryKind, number: number) => `[${kind.toUpperCase()} #${number}]`

const HEADER = /^\[(OPEN|DONE|DECISION|PROBLEM|COMPACTION|RESEARCH|ANSWER|HANDOFF) #([1-9][0-9]*)\]$/
/** A line that reads as a header: escaped inside an entry, so only header lines start entries. */
const HEADER_LIKE = /^\[[A-Z]+ #[0-9]+\]/

/** The kind and number of an entry header line, or null for any other line. */
export const parseHeader = (line: string): { readonly kind: EntryKind; readonly number: number } | null => {
  const match = HEADER.exec(line)
  return match === null ? null : { kind: match[1]!.toLowerCase() as EntryKind, number: Number(match[2]) }
}

const escapeLines = (text: string) =>
  text
    .split("\n")
    .map((line) => (HEADER_LIKE.test(line) ? `\\${line}` : line))
    .join("\n")

type Lookup = (number: number) => Pick<Entry, "kind" | "fields"> | undefined

/**
 * An entry as one block: its header line, then each field as
 * `<Field>: <value>` on its own line, or for a compaction or handoff entry
 * its text, with every text line that reads as a header escaped by a
 * leading backslash. A done entry restates each entry it resolves, as
 * `lookup` gives it, as `Resolves: #<n> [<KIND>] <text>`.
 */
export const renderEntry = (entry: Pick<Entry, "number" | "kind" | "fields" | "resolves">, lookup: Lookup): string => {
  const lines = [entryHeader(entry.kind, entry.number)]
  if (entry.kind === "compaction" || entry.kind === "handoff") {
    lines.push(escapeLines(entry.fields.Text ?? ""))
  } else {
    for (const field of FIELDS[entry.kind]) {
      const value = entry.fields[field]
      if (value !== undefined) lines.push(escapeLines(`${field}: ${value}`))
    }
  }
  for (const number of entry.resolves) {
    const target = lookup(number)
    lines.push(`Resolves: #${number} [${(target?.kind ?? "open").toUpperCase()}] ${target?.fields.Text ?? ""}`)
  }
  return lines.join("\n")
}

/** Renders entries against the stored entries `all`, which every resolved entry is among. */
export const entryRenderer = (all: ReadonlyArray<Pick<Entry, "number" | "kind" | "fields">>) => {
  const byNumber = new Map(all.map((entry) => [entry.number, entry]))
  return (entry: Pick<Entry, "number" | "kind" | "fields" | "resolves">) => renderEntry(entry, (number) => byNumber.get(number))
}

/** An entry the `context_append` tool takes, as its arguments decode. */
export type AppendInput =
  | { readonly kind: "open" | "problem"; readonly Text: string }
  | { readonly kind: "done"; readonly Text: string; readonly resolves?: ReadonlyArray<number> }
  | { readonly kind: "decision"; readonly Decision: string; readonly Rationale: string }

const fieldProblem = (index: number, field: string, value: string): string | null => {
  const length = codePoints(value)
  if (length < 1 || length > ENTRY_FIELD_MAX_LENGTH) return `entry ${index + 1}: ${field} holds ${length} characters, not 1 to ${ENTRY_FIELD_MAX_LENGTH}`
  if (/[\r\n]/.test(value)) return `entry ${index + 1}: ${field} holds a line break`
  return null
}

/**
 * Validates a `context_append` batch against the session's entries: 1 to
 * 16 entries, each field of 1 to 120 code points on one line, and each
 * `resolves` of 1 to 16 numbers naming an unresolved open or problem entry
 * of the session that no other `resolves` of the batch names. Returns the
 * entries to record, or every problem found.
 */
export const validateAppend = (
  inputs: ReadonlyArray<AppendInput>,
  lookup: (number: number) => Pick<Entry, "kind"> | undefined,
  resolved: (number: number) => boolean,
): { readonly ok: true; readonly entries: ReadonlyArray<NewEntry> } | { readonly ok: false; readonly problems: ReadonlyArray<string> } => {
  const problems: Array<string> = []
  if (inputs.length < 1 || inputs.length > APPEND_MAX_ENTRIES) problems.push(`a call appends 1 to ${APPEND_MAX_ENTRIES} entries, not ${inputs.length}`)
  const named = new Set<number>()
  const entries = inputs.map((input, index): NewEntry => {
    const fields: Record<string, string> =
      input.kind === "decision" ? { Decision: input.Decision, Rationale: input.Rationale } : { Text: input.Text }
    for (const [field, value] of Object.entries(fields)) {
      const problem = fieldProblem(index, field, value)
      if (problem !== null) problems.push(problem)
    }
    const resolves = input.kind === "done" ? (input.resolves ?? []) : []
    if (input.kind === "done" && input.resolves !== undefined && (resolves.length < 1 || resolves.length > RESOLVES_MAX_ENTRIES)) {
      problems.push(`entry ${index + 1}: resolves lists ${resolves.length} entries, not 1 to ${RESOLVES_MAX_ENTRIES}`)
    }
    for (const number of resolves) {
      const target = lookup(number)
      if (target === undefined) problems.push(`entry ${index + 1}: resolves #${number}, which is no entry of this session`)
      else if (target.kind !== "open" && target.kind !== "problem") {
        problems.push(`entry ${index + 1}: resolves #${number}, a ${target.kind} entry, not an open or problem entry`)
      } else if (resolved(number)) problems.push(`entry ${index + 1}: resolves #${number}, which is already resolved`)
      else if (named.has(number)) problems.push(`entry ${index + 1}: resolves #${number}, which another resolves of this call names`)
      named.add(number)
    }
    return { kind: input.kind, fields, ...(resolves.length === 0 ? {} : { resolves }) }
  })
  return problems.length === 0 ? { ok: true, entries } : { ok: false, problems }
}

/** The open and problem entries that a done entry among `entries` resolves. */
export const resolvedNumbers = (entries: ReadonlyArray<Pick<Entry, "kind" | "resolves">>): ReadonlySet<number> =>
  new Set(entries.flatMap((entry) => (entry.kind === "done" ? entry.resolves : [])))

/** The open and problem entries no done entry among `entries` resolves, oldest first. */
export const openItems = <E extends Pick<Entry, "kind" | "resolves" | "number">>(entries: ReadonlyArray<E>): ReadonlyArray<E> => {
  const resolved = resolvedNumbers(entries)
  return entries.filter((entry) => (entry.kind === "open" || entry.kind === "problem") && !resolved.has(entry.number))
}

/**
 * A research entry's summary: the call's output on one line, cut at its
 * last word boundary and ended with `…` when over 240 code points; null for
 * an empty output.
 */
export const researchSummary = (output: string): string | null => {
  const text = output.replace(/\s+/g, " ").trim()
  if (text === "") return null
  const points = [...text]
  if (points.length <= RESEARCH_SUMMARY_MAX_LENGTH) return text
  const head = points.slice(0, RESEARCH_SUMMARY_MAX_LENGTH - 1).join("")
  const boundary = head.lastIndexOf(" ")
  return `${(boundary > 0 ? head.slice(0, boundary) : head).trimEnd()}…`
}

/** Text cut to `keep` characters from each end, marking the cut, when longer than both ends. */
export const clipMiddle = (text: string, keep: number) =>
  text.length <= keep * 2 ? text : `${text.slice(0, keep)}[… ${text.length - keep * 2} characters cut …]${text.slice(-keep)}`

/** The `description:` of a Markdown file's YAML frontmatter, or null when it has none. */
export const frontmatterDescription = (text: string): { readonly description: string | null; readonly bodyLine: number } | null => {
  const lines = text.split("\n")
  if (lines[0] !== "---") return null
  const end = lines.indexOf("---", 1)
  if (end === -1) return null
  let description: string | null = null
  for (const line of lines.slice(1, end)) {
    const match = /^description:\s*(.*)$/.exec(line)
    if (match === null) continue
    const value = match[1]!.trim()
    const quoted = /^(["'])(.*)\1$/.exec(value)
    description = quoted === null ? value : quoted[2]!
  }
  return { description, bodyLine: end + 1 }
}

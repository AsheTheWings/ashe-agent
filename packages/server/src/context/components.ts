import type { FileMetadata } from "../agents/titles.ts"
import { block, escapeTags, lowerHeadings } from "../agent/blocks.ts"
import harness from "./harness.md" with { type: "text" }

/** How a developer component is injected: rendered at construction, riding on a delivery, or steered into a turn. */
export type ComponentType = "seed" | "state" | "notification"

/** A source whose state reconciliation compares with what a checkpoint window knows. */
export type SourceName =
  | "userInstructions"
  | "skillCatalog"
  | "codeModeCatalog"
  | "identity"
  | "dates"
  | "scratchGeneration"
  | "memoryRestoreGeneration"

/** The user instructions a checkpoint window knows: none, or a version of the title or global file. */
export type InstructionsState =
  | { readonly kind: "none" }
  | { readonly kind: "title" | "global"; readonly path: string; readonly sha256: string; readonly metadata: FileMetadata }

/** The server's and the user's dates, each with its time zone. */
export interface Dates {
  readonly serverDate: string
  readonly serverWeekday: string
  readonly serverZone: string
  readonly userDate: string
  readonly userWeekday: string
  readonly userZone: string
}

/** The state each source has, as components establish it. */
export interface SourceStates {
  readonly userInstructions?: InstructionsState
  readonly skillCatalog?: { readonly text: string | null }
  readonly codeModeCatalog?: { readonly text: string | null }
  readonly identity?: { readonly sessionId: string }
  readonly dates?: Dates
  /** How often the session's scratch target was found lost. */
  readonly scratchGeneration?: number
  /** How often the session's memory was republished after a mismatch. */
  readonly memoryRestoreGeneration?: number
}

/** One unit of harness content under its own `#` heading, and the source states it establishes. */
export interface Component {
  readonly type: ComponentType
  /** What the component is, such as `user_instructions` or `rewind`. */
  readonly name: string
  readonly heading: string
  /** The component as the model reads it, its heading line included. */
  readonly text: string
  readonly sources: SourceStates
}

const component = (type: ComponentType, name: string, heading: string, body: string, sources: SourceStates = {}): Component => ({
  type,
  name,
  heading,
  text: `# ${heading}\n\n${body.trim()}`,
  sources,
})

/** Content placed in a component: reserved tags escaped and headings lowered below the component's own. */
const content = (text: string) => lowerHeadings(escapeTags(text.trim()))

/** The harness instructions of a server whose sessions live in `sessionsDir`. */
export const harnessInstructions = (sessionsDir: string) => harness.trim().replace("{{sessionsDir}}", escapeTags(sessionsDir))

/** Adjoining components as one `<developer>` block, the developer message they form. */
export const developerBlock = (components: ReadonlyArray<Pick<Component, "text">>) =>
  block("developer", components.map((part) => part.text).join("\n\n"))

/** The system block of harness instructions. */
export const systemBlock = (instructions: string) => block("system", instructions)

const fromTitle = (title: string | null) => (title === null ? "" : `, as written for your title, ${escapeTags(title)}`)

/** The user instructions seed component; null for empty instructions, which have none. */
export const userInstructionsSeed = (text: string, title: string | null, state: InstructionsState): Component | null =>
  text.trim() === ""
    ? null
    : component(
        "seed",
        "user_instructions",
        "User Instructions",
        `The user's standing instructions for this session${state.kind === "title" ? fromTitle(title) : ""}.\n\n${content(text)}`,
        { userInstructions: state },
      )

/** The skill catalog seed component; null without skills. */
export const skillCatalogSeed = (catalog: string | null): Component | null =>
  catalog === null
    ? null
    : component(
        "seed",
        "skill_catalog",
        "Skill Catalog",
        `Skills you can load with the \`skill\` tool. Load one before starting a task its description matches.\n\n${content(catalog)}`,
        { skillCatalog: { text: catalog } },
      )

/** The code mode catalog seed component, followed by the catalog's own instructions; null without code mode. */
export const codeModeCatalogSeed = (catalog: string | null): Component | null =>
  catalog === null
    ? null
    : component("seed", "code_mode_catalog", "Code Mode Catalog", `Tools a program passed to \`execute\` can call.\n\n${content(catalog)}`, {
        codeModeCatalog: { text: catalog },
      })

const dateLines = (dates: Dates) =>
  `- Server date: ${dates.serverDate}, ${dates.serverWeekday} (${dates.serverZone})\n- User date: ${dates.userDate}, ${dates.userWeekday} (${dates.userZone})`

/** The session facts seed component: identity and dates, and no path. */
export const sessionFacts = (facts: {
  readonly sessionId: string
  readonly title: string | null
  readonly dates: Dates
  readonly scratchGeneration: number
  readonly memoryRestoreGeneration: number
}): Component =>
  component(
    "seed",
    "session_facts",
    "Session Facts",
    [
      "This session's facts as of when this checkpoint window was built. Run `date` for the current time.",
      "",
      `- Session id: \`${facts.sessionId}\``,
      ...(facts.title === null ? [] : [`- Your title: ${escapeTags(facts.title)}`]),
      dateLines(facts.dates),
    ].join("\n"),
    {
      identity: { sessionId: facts.sessionId },
      dates: facts.dates,
      scratchGeneration: facts.scratchGeneration,
      memoryRestoreGeneration: facts.memoryRestoreGeneration,
    },
  )

/** A backtick run longer than any in `text`, so a fence around it cannot close early. */
const fenceFor = (text: string) => "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((run) => run[0].length + 1)))

/** The state component of instructions that changed within their source: one unified diff. */
export const instructionsDiff = (diff: string, state: InstructionsState): Component => {
  const fence = fenceFor(diff)
  return component(
    "state",
    "user_instructions_changed",
    "User Instructions Changed",
    `The user instructions changed since this conversation last showed them. Follow them as this diff leaves them:\n\n${fence}diff\n${escapeTags(diff.trimEnd())}\n${fence}`,
    { userInstructions: state },
  )
}

const sourceName = (state: InstructionsState, title: string | null) =>
  state.kind === "title"
    ? `the instructions for your title${title === null ? "" : `, ${escapeTags(title)}`}`
    : state.kind === "global"
      ? "the global user instructions"
      : "no user instructions"

/** The state component of instructions that switched source: the new source and its full content. */
export const instructionsSwitched = (
  text: string,
  state: InstructionsState,
  previous: InstructionsState,
  title: string | null,
): Component => {
  const sources = { userInstructions: state }
  const heading = "User Instructions Changed"
  if (state.kind === "none") {
    return component(
      "state",
      "user_instructions_changed",
      heading,
      `There are no user instructions now, in place of ${sourceName(previous, title)}; set the earlier ones aside.`,
      sources,
    )
  }
  if (text.trim() === "") {
    return component(
      "state",
      "user_instructions_changed",
      heading,
      `The user instructions are now ${sourceName(state, title)}, which are empty, in place of ${sourceName(previous, title)}; set the earlier ones aside.`,
      sources,
    )
  }
  const instead =
    previous.kind === "none"
      ? "this conversation showed none before. Follow them:"
      : `in place of ${sourceName(previous, title)}. Follow these instead of the earlier ones:`
  return component("state", "user_instructions_changed", heading, `The user instructions are now ${sourceName(state, title)}, ${instead}\n\n${content(text)}`, sources)
}

/** The state component of a changed skill catalog, as it stands now. */
export const skillCatalogChanged = (catalog: string | null): Component =>
  component(
    "state",
    "skill_catalog_changed",
    "Skill Catalog Changed",
    `The skill catalog changed; use it as it stands now.\n\n${catalog === null ? "No skills are available now." : content(catalog)}`,
    { skillCatalog: { text: catalog } },
  )

/** The state component of a changed code mode catalog, as it stands now. */
export const codeModeCatalogChanged = (catalog: string | null): Component =>
  component(
    "state",
    "code_mode_catalog_changed",
    "Code Mode Catalog Changed",
    `The code mode catalog changed; use it as it stands now.\n\n${catalog === null ? "No tools are available to programs now." : content(catalog)}`,
    { codeModeCatalog: { text: catalog } },
  )

/** The state component of changed dates. */
export const datesChanged = (dates: Dates): Component =>
  component("state", "dates_changed", "Dates Changed", `The dates changed since this conversation last showed them.\n\n${dateLines(dates)}`, { dates })

/** The fork state component, which reconciles the session identity; `skipped` counts the scratch entries the copy left out. */
export const forkComponent = (source: string, target: string, skipped = 0): Component =>
  component(
    "state",
    "fork",
    "Fork",
    `This session was forked: session \`${target}\` is a copy of session \`${source}\` through the turns above. It has its own session directory, with \`research/\` and \`memory/\` as they stood at that point and a copy of \`scratch/\`${skipped === 0 ? "" : `, without ${skipped} sockets, FIFOs, and devices`}. Absolute paths above, and files in \`scratch/\`, may still refer to the source's directory; arrange what the work needs. Other files, processes, and effects of the source's turns may persist.`,
    { identity: { sessionId: target } },
  )

/** The rewind notification component. */
export const rewindComponent = (): Component =>
  component(
    "notification",
    "rewind",
    "Rewind",
    "The user rewound this session: later turns were removed from the conversation, and the next message starts again from here. `research/` and `memory/` are back to their state at this point; `scratch/` and other files, processes, and effects of the removed turns may persist.",
  )

/**
 * The scratch lost notification component, establishing the scratch
 * generation it reports; `recomputed` when a rewind or fork queues it
 * again, since scratch may then hold files of turns no longer in the
 * history.
 */
export const scratchLost = (generation: number, recomputed: boolean): Component =>
  component(
    "notification",
    "scratch_lost",
    "Scratch Lost",
    `The contents of \`scratch/\` were lost, so files you wrote there earlier are gone. ${recomputed ? "It may hold files written later by turns no longer in your history; check what is there before relying on it. " : ""}Recreate what you need from \`research/\`, \`memory/\`, or the original sources.`,
    { scratchGeneration: generation },
  )

/**
 * The memory restored notification component, establishing the memory
 * restore generation it reports: naming the paths a republish put back,
 * or, queued again by a rewind or fork, naming none.
 */
export const memoryRestored = (generation: number, paths: ReadonlyArray<string> | null): Component =>
  component(
    "notification",
    "memory_restored",
    "Memory Restored",
    paths === null
      ? "`memory/` may differ from what turns in your history wrote there; it holds the secondary timelines as last checked."
      : `These files in \`memory/\` changed outside a context turn: ${paths.map((path) => `\`${escapeTags(path)}\``).join(", ")}. The harness put back the secondary timelines as last checked; they change only through \`memory-draft/\` in a context turn.`,
    { memoryRestoreGeneration: generation },
  )

/** The day and weekday of `at` in `timeZone`, with the zone's name. */
const dayIn = (at: Date, timeZone: string) => {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at)
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(at)
  return { date, weekday }
}

/** The server's and the user's dates at `now`, in the server's own time zone and `userZone`. */
export const currentDates = (now: number, userZone: string, serverZone = Intl.DateTimeFormat().resolvedOptions().timeZone): Dates => {
  const at = new Date(now)
  const server = dayIn(at, serverZone)
  const user = dayIn(at, userZone)
  return { serverDate: server.date, serverWeekday: server.weekday, serverZone, userDate: user.date, userWeekday: user.weekday, userZone }
}

/** Whether two date states name the same days in the same zones. */
export const sameDates = (a: Dates, b: Dates) =>
  a.serverDate === b.serverDate && a.serverZone === b.serverZone && a.userDate === b.userDate && a.userZone === b.userZone

/** What started a context turn: the reserve running short, or the context limit. */
export type ContextTrigger = "threshold" | "limit"

/** A list item of `lines` under a bullet, indented one level. */
const subList = (lines: ReadonlyArray<string>) => lines.map((line) => `  - ${line}`).join("\n")

/**
 * The context turn notification component: what makes the rest of the turn
 * a context turn, the state to record, the research and memory violations
 * found at its start, a draft over the file limit, and how the context
 * turn ends.
 */
export const contextTurnComponent = (options: {
  readonly trigger: ContextTrigger
  readonly reserve: number
  readonly violations: ReadonlyArray<string>
  readonly count: number
  readonly maxFiles: number
}): Component => {
  const opening =
    options.trigger === "threshold"
      ? `Less than ${options.reserve.toLocaleString("en-US")} tokens are left in this checkpoint window, so the rest of this turn is a context turn. Leave the task until the next checkpoint window and put your context in order:`
      : "This checkpoint window reached its limit, so the harness replaced the oldest tool results with placeholders, and the rest of this turn is a context turn. Only `context_append`, `context_get_open_items`, `shell_exec_command`, `shell_write_stdin`, `file_read`, and `file_patch` remain. If the checkpoint window fills up twice more, the harness summarizes it into a handoff entry and ends this turn, so organize first and inspect only what you need."
  const steps = [
    "- Record your current state in the primary timeline with `context_append`: `done` entries resolving what you finished, `open` entries for what remains, and what the checkpoint will not show.",
    "- Make any change to the secondary timelines in `memory-draft/`, a writable copy of `memory/` that replaces it once the check passes.",
    ...(options.violations.length === 0 ? [] : [`- Fix these problems in \`research/\` and \`memory-draft/\`:\n${subList(options.violations.map(escapeTags))}`]),
    ...(options.count > options.maxFiles ? [`- \`memory-draft/\` holds ${options.count} files; merge them into at most ${options.maxFiles}.`] : []),
  ]
  return component(
    "notification",
    "context_turn",
    "Context Turn",
    `${opening}\n\n${steps.join("\n")}\n\n## Ending the Context Turn\n\nWhen the work is done, reply in one line without calling a tool. If the primary timeline is then over its allowance, the harness trims its oldest entries and asks you to file them. Otherwise it checks \`research/\` and \`memory-draft/\`; when something is wrong, a component lists it and the context turn continues, for at most three checks. Messages that arrive meanwhile wait for the next checkpoint window.`,
  )
}

const SECONDARY_TIMELINE_FORMAT = `## Secondary Timelines

A secondary timeline is a file in \`memory-draft/\` grouping related entries, such as the work on one component:

\`\`\`markdown
---
description: Parser rewrite, its decisions and steps
---

[DECISION #14]
Decision: Parse with a hand-written lexer
Rationale: The grammar needs context the generator cannot express

[DONE #17]
Text: Lexer passes the fixture suite
Resolves: #15 [OPEN] Make the lexer pass the fixture suite
\`\`\`

Its body holds only entries copied exactly as recorded, in ascending number order, separated by blank lines. Each trimmed entry is in exactly one file. Its \`description:\` says what its entries cover. The path and the description hold at most 120 characters each. Create, merge, split, rename, and delete files freely while these rules hold, and keep at most 64 files. \`research/\` and \`memory-draft/\` hold only Markdown files directly inside them, no subdirectories and no symlinks, and each research file has a \`description:\` of at most 120 characters too.`

/**
 * The timelines trimmed notification component: the range an idle trimmed,
 * the stored text of trimmed entries the checkpoint window cannot show,
 * and the secondary timeline format and its rules.
 */
export const timelinesTrimmed = (first: number, last: number, entries: ReadonlyArray<string>): Component =>
  component(
    "notification",
    "timelines_trimmed",
    "Timelines Trimmed",
    `The primary timeline is over its allowance, so the harness trimmed entries #${first} to #${last} from it. Copy each into exactly one secondary timeline in \`memory-draft/\`, then reply in one line without calling a tool.${
      entries.length === 0
        ? ""
        : `\n\nThese trimmed entries were written after this checkpoint window began, so nothing above shows them as stored; copy them from here:\n\n${entries.map(escapeTags).join("\n\n")}`
    }\n\n${SECONDARY_TIMELINE_FORMAT}`,
  )

/** The failed validation notification component: the check's attempt and every violation. */
export const validationFailed = (attempt: number, attempts: number, violations: ReadonlyArray<string>): Component =>
  component(
    "notification",
    "validation_failed",
    "Context Check Failed",
    `\`research/\` and \`memory-draft/\` failed check ${attempt} of ${attempts}, so the context turn continues. Fix each problem, then reply in one line without calling a tool:\n\n${violations.map((line) => `- ${escapeTags(line)}`).join("\n")}\n\nAfter a third failed check, \`memory-draft/\` replaces \`memory/\` if its secondary timelines pass; otherwise \`memory/\` stays as it was when this context turn started, with the trimmed entries added in one unsorted file. Problems left in \`research/\` wait for a later context turn.`,
  )

/**
 * The continuation notification component, which starts the continuation
 * turn after the seed: after a handoff it names the handoff entry, and
 * after the fallback it names the unsorted file.
 */
export const continuationComponent = (options: {
  readonly handoff?: number
  readonly unsorted?: { readonly first: number; readonly last: number; readonly path: string }
}): Component =>
  component(
    "notification",
    "continuation",
    "Continuation",
    [
      "This checkpoint window continues the session after a context turn. Continue the task from the checkpoint, or tell the user it is done.",
      ...(options.handoff === undefined
        ? []
        : [`The previous checkpoint window filled up before its context turn finished; \`[HANDOFF #${options.handoff}]\` summarizes it.`]),
      ...(options.unsorted === undefined
        ? []
        : [
            `The secondary timelines failed three checks, so \`memory/\` kept its earlier state, with entries #${options.unsorted.first} to #${options.unsorted.last} added in \`${escapeTags(options.unsorted.path)}\`. Sort them into secondary timelines in a later context turn.`,
          ]),
    ].join("\n\n"),
  )

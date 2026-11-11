import { escapeTags } from "../agent/blocks.ts"
import { renderTranscript } from "../agent/window.ts"
import type { Item } from "../sessions/conversation.ts"
import primaryExplanation from "./checkpoint/primary-timeline.md" with { type: "text" }
import recentExplanation from "./checkpoint/recent-transcript.md" with { type: "text" }
import secondaryExplanation from "./checkpoint/secondary-timelines.md" with { type: "text" }
import type { Component } from "./components.ts"
import { estimateTokens, RECENT_TRANSCRIPT_ALLOWANCE, TIMELINES_ALLOWANCE } from "./constants.ts"
import { openItems, type Entry } from "./entries.ts"

/** A secondary timeline as the checkpoint lists it: its path and description. */
export interface SecondaryTimeline {
  readonly path: string
  readonly description: string
}

const heading = (sessionId: string) =>
  `# Session Checkpoint\n\nThis checkpoint window continues session \`${sessionId}\`. Earlier checkpoint windows are gone from your context; this checkpoint carries what they recorded.\n\n`

const secondarySection = (timelines: ReadonlyArray<SecondaryTimeline>) =>
  `## Secondary Timelines\n\n${secondaryExplanation.trim()}\n\n${timelines
    .map((timeline) => `- \`${escapeTags(timeline.path)}\`: ${escapeTags(timeline.description)}\n`)
    .join("")}${timelines.length === 0 ? "" : "\n"}`

const primaryHeading = (trimmedOpen: number) =>
  `## Primary Timeline\n\n${primaryExplanation.trim()}\n\n${
    trimmedOpen === 0 ? "" : `${trimmedOpen} open items are only in secondary timelines; \`context_get_open_items\` lists them.\n\n`
  }`

const transcriptHeading = () => `## Recent Transcript\n\n${recentExplanation.trim()}\n\n`

/** An entry as the checkpoint holds it, with the blank line after it. */
const entryPart = (rendered: string) => `${escapeTags(rendered)}\n\n`

/** An item as the recent transcript holds it, with the line break after it. */
const itemPart = (item: Item) => `${renderTranscript([item])}\n`

/** The estimated tokens of the checkpoint text the timelines allowance covers, the entries excluded. */
export const timelinesOverhead = (sessionId: string, timelines: ReadonlyArray<SecondaryTimeline>, trimmedOpen: number) =>
  estimateTokens(heading(sessionId)) + estimateTokens(secondarySection(timelines)) + estimateTokens(primaryHeading(trimmedOpen))

/** The estimated tokens of the primary timeline's entries in the checkpoint. */
export const entriesTokens = (rendered: ReadonlyArray<string>) => rendered.reduce((sum, text) => sum + estimateTokens(entryPart(text)), 0)

/**
 * The oldest entries of the primary timeline to trim so that it, with the
 * secondary timelines section and the checkpoint text the timelines
 * allowance covers, the line counting trimmed open items included when the
 * trim leaves any, fits the timelines allowance. `entries` are all the
 * session's entries, in number order.
 */
export const trimPlan = (
  sessionId: string,
  entries: ReadonlyArray<Entry>,
  timelines: ReadonlyArray<SecondaryTimeline>,
  render: (entry: Entry) => string,
): ReadonlyArray<number> => {
  const primary = entries.filter((entry) => !entry.trimmed)
  const tokens = primary.map((entry) => estimateTokens(entryPart(render(entry))))
  const open = new Set(openItems(entries).map((entry) => entry.number))
  let trimmedOpen = entries.filter((entry) => entry.trimmed && open.has(entry.number)).length
  let remaining = tokens.reduce((sum, value) => sum + value, 0)
  let count = 0
  while (count < primary.length && timelinesOverhead(sessionId, timelines, trimmedOpen) + remaining > TIMELINES_ALLOWANCE) {
    remaining -= tokens[count]!
    if (open.has(primary[count]!.number)) trimmedOpen += 1
    count += 1
  }
  return primary.slice(0, count).map((entry) => entry.number)
}

/**
 * The recent transcript of a checkpoint window's items before its context
 * turn, seed components excluded: the whole items after its last user
 * message, newest first up to the recent transcript allowance less its
 * section's heading and explanation, in their order; none when the last of
 * those items other than a developer component is a user message.
 */
export const recentTranscript = (items: ReadonlyArray<Item>): ReadonlyArray<Item> => {
  const last = items.findLast((item) => item.kind !== "component")
  if (last === undefined || last.kind === "user") return []
  const after = items.slice(items.findLastIndex((item) => item.kind === "user") + 1)
  let budget = RECENT_TRANSCRIPT_ALLOWANCE - estimateTokens(transcriptHeading())
  let first = after.length
  while (first > 0) {
    const tokens = estimateTokens(itemPart(after[first - 1]!))
    if (tokens > budget) break
    budget -= tokens
    first -= 1
  }
  return after.slice(first)
}

/** What the session checkpoint holds. */
export interface CheckpointSources {
  readonly sessionId: string
  readonly timelines: ReadonlyArray<SecondaryTimeline>
  /** Every entry of the session, in number order. */
  readonly entries: ReadonlyArray<Entry>
  readonly render: (entry: Entry) => string
  readonly transcript: ReadonlyArray<Item>
}

/**
 * The session checkpoint component: its heading and introduction, the
 * secondary timelines, the primary timeline with the count of trimmed open
 * items, and the recent transcript when there is one.
 */
export const checkpointComponent = (sources: CheckpointSources): Component => {
  const open = new Set(openItems(sources.entries).map((entry) => entry.number))
  const trimmedOpen = sources.entries.filter((entry) => entry.trimmed && open.has(entry.number)).length
  const timelines = [
    heading(sources.sessionId),
    secondarySection(sources.timelines),
    primaryHeading(trimmedOpen),
    ...sources.entries.filter((entry) => !entry.trimmed).map((entry) => entryPart(sources.render(entry))),
  ].join("")
  const transcript = sources.transcript.length === 0 ? "" : `${transcriptHeading()}${sources.transcript.map(itemPart).join("")}`
  return {
    type: "seed",
    name: "session_checkpoint",
    heading: "Session Checkpoint",
    text: `${timelines}${transcript}`.trimEnd(),
    sources: {},
  }
}

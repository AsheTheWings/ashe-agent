import { renderTranscript, toolContentText } from "../agent/window.ts"
import type { Item } from "../sessions/conversation.ts"
import { CHAT_BOUNDARY_CLOSE, CLEARING_SHARES, estimateTokens, IMAGE_TOKENS } from "./constants.ts"

type Result = Extract<Item, { kind: "result" }>

const images = (item: Item) =>
  item.kind === "result" && typeof item.content !== "string" ? item.content.filter((part) => part.type === "image").length : 0

/** The estimated tokens of an item as recorded, a cleared result counted whole, each image as one image's estimate. */
export const itemTokens = (item: Item) =>
  estimateTokens(renderTranscript([item.kind === "result" ? { ...item, cleared: false } : item])) + images(item) * IMAGE_TOKENS

/** The estimated tokens of a result's content, which its clearing frees. */
export const resultTokens = (item: Result) => estimateTokens(toolContentText(item.content)) + images(item) * IMAGE_TOKENS

const isSeed = (item: Item) => item.kind === "component" && item.component.type === "seed"

/**
 * Whether an item counts in a chat boundary's size: neither a seed
 * component nor an item of a context turn from its context turn component
 * on. `contextItem` gives a turn's context turn component position, or
 * null for a turn that is no context turn.
 */
export const countsInBoundary = (item: Item, contextItem: (runId: string) => number | null) => {
  if (isSeed(item)) return false
  const position = item.runId === null ? null : contextItem(item.runId)
  return position === null || item.position < position
}

/** The size of a chat boundary's items: the estimated tokens of the items that count in it. */
export const boundarySize = (items: ReadonlyArray<Item>, contextItem: (runId: string) => number | null) =>
  items.reduce((sum, item) => sum + (countsInBoundary(item, contextItem) ? itemTokens(item) : 0), 0)

/** Whether a chat boundary of these items closes: its size has reached 60,000 tokens. */
export const boundaryCloses = (items: ReadonlyArray<Item>, contextItem: (runId: string) => number | null) =>
  boundarySize(items, contextItem) >= CHAT_BOUNDARY_CLOSE

/**
 * The results a context turn's clearing `attempt` clears, oldest first,
 * and the tokens they free: results until the tokens freed by every
 * clearing so far, `freedBefore`, reach the attempt's share of
 * `clearable`, the clearable results' tokens before the first clearing.
 */
export const clearingPlan = (results: ReadonlyArray<Result>, attempt: 1 | 2 | 3, clearable: number, freedBefore: number) => {
  const target = Math.ceil(CLEARING_SHARES[attempt - 1]! * clearable)
  const positions: Array<number> = []
  let freed = 0
  for (const item of results) {
    if (freedBefore + freed >= target) break
    positions.push(item.position)
    freed += resultTokens(item)
  }
  return { positions, freed }
}

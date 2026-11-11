import {
  estimateContributions,
  type EstimatorOptions,
} from "@ashe-agent/protocol"
import { renderTranscript, toolContentText } from "../agent/window.ts"
import type { Item } from "../sessions/conversation.ts"
import { CHAT_BOUNDARY_CLOSE, CLEARING_SHARES } from "./constants.ts"

type Result = Extract<Item, { kind: "result" }>

export interface ItemMedia {
  readonly images: number
  readonly pdfs: number
  readonly textTokens?: number
}

export type ItemMediaFor = (item: Item, model?: string | null) => ItemMedia | undefined

const sourceMedia = (item: Item): ItemMedia => {
  if (item.kind === "user") {
    let images = 0
    let pdfs = 0
    for (const attachment of item.attachments ?? []) {
      if (attachment.mediaType.startsWith("image/")) images += 1
      else if (attachment.mediaType === "application/pdf" || attachment.name.toLowerCase().endsWith(".pdf")) pdfs += 1
    }
    return { images, pdfs }
  }
  if (item.kind !== "result" || typeof item.content === "string") return { images: 0, pdfs: 0 }
  return {
    images: item.content.filter((part) => part.type === "image").length,
    pdfs: item.content.filter((part) => part.type === "pdf").length,
  }
}

/** The media a model receives after capability projection, counted without reading the source. */
export const projectedItemMedia = (
  item: Item,
  capabilities: { readonly image: boolean; readonly pdf: boolean },
  pagesPerWindow = 8,
  previewBytes = 50 * 1024,
): ItemMedia => {
  const source = sourceMedia(item)
  return {
    images: capabilities.image ? source.images + (capabilities.pdf ? 0 : source.pdfs * pagesPerWindow) : 0,
    pdfs: capabilities.pdf ? source.pdfs : 0,
    ...(capabilities.pdf || source.pdfs === 0
      ? {}
      : { textTokens: source.pdfs * Math.ceil(previewBytes / 4) }),
  }
}

/** The estimated tokens of an item as recorded, a cleared result counted whole, each media part or attachment through its configured allowance. */
export const itemTokens = (item: Item, options: EstimatorOptions = {}, projected?: ItemMediaFor) => {
  const found = projected?.(item) ?? sourceMedia(item)
  return estimateContributions([
    {
      position: 0,
      kind: "text",
      text: `${renderTranscript([item.kind === "result" ? { ...item, cleared: false } : item])}${found.textTokens === undefined ? "" : "\n" + "x".repeat(found.textTokens * 4)}`,
    },
    ...(found.images === 0 ? [] : [{ position: 1, kind: "image" as const, count: found.images }]),
    ...(found.pdfs === 0 ? [] : [{ position: 2, kind: "native-pdf" as const, count: found.pdfs }]),
  ], options).knownSubtotal
}

/** The estimated tokens of a result's content, which its clearing frees. */
export const resultTokens = (item: Result, options: EstimatorOptions = {}, projected?: ItemMediaFor) => {
  const found = projected?.(item) ?? sourceMedia(item)
  return estimateContributions([
    {
      position: 0,
      kind: "text",
      text: `${toolContentText(item.content)}${found.textTokens === undefined ? "" : "\n" + "x".repeat(found.textTokens * 4)}`,
    },
    ...(found.images === 0 ? [] : [{ position: 1, kind: "image" as const, count: found.images }]),
    ...(found.pdfs === 0 ? [] : [{ position: 2, kind: "native-pdf" as const, count: found.pdfs }]),
  ], options).knownSubtotal
}

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
export const boundarySize = (
  items: ReadonlyArray<Item>,
  contextItem: (runId: string) => number | null,
  options: EstimatorOptions = {},
  projected?: ItemMediaFor,
) => items.reduce((sum, item) => sum + (countsInBoundary(item, contextItem) ? itemTokens(item, options, projected) : 0), 0)

/** Whether a chat boundary of these items closes: its size has reached 60,000 tokens. */
export const boundaryCloses = (
  items: ReadonlyArray<Item>,
  contextItem: (runId: string) => number | null,
  options: EstimatorOptions = {},
  projected?: ItemMediaFor,
) => boundarySize(items, contextItem, options, projected) >= CHAT_BOUNDARY_CLOSE

/**
 * The results a context turn's clearing `attempt` clears, oldest first,
 * and the tokens they free: results until the tokens freed by every
 * clearing so far, `freedBefore`, reach the attempt's share of
 * `clearable`, the clearable results' tokens before the first clearing.
 */
export const clearingPlan = (
  results: ReadonlyArray<Result>,
  attempt: 1 | 2 | 3,
  clearable: number,
  freedBefore: number,
  options: EstimatorOptions = {},
  projected?: ItemMediaFor,
) => {
  const target = Math.ceil(CLEARING_SHARES[attempt - 1]! * clearable)
  const positions: Array<number> = []
  let freed = 0
  for (const item of results) {
    if (freedBefore + freed >= target) break
    positions.push(item.position)
    freed += resultTokens(item, options, projected)
  }
  return { positions, freed }
}

import { createHash } from "node:crypto"
import { HumanMessage } from "@langchain/core/messages"
import { block, escapeTags, REQUEST_INSTRUCTIONS } from "./blocks.ts"
import type { ModelPort } from "./model.ts"
import prompt from "./summary-prompt.md" with { type: "text" }
import { estimateWindow, renderText, tailStart, type Window } from "./window.ts"

/** The tokens left in the usable window below which a model call compacts first. */
export const COMPACT_WHEN_LEFT = 60_000
/** The estimated tokens of recent entries a compacted window keeps verbatim. */
export const RAW_TAIL_TOKENS = 20_000
/** The most output tokens a summary may take. */
export const SUMMARY_MAX_TOKENS = 8_000
/** The characters a summarized tool result keeps from each end. */
const RESULT_CLIP = 2_000

/** The revision of the summary prompt: the start of its SHA-256. */
export const SUMMARY_PROMPT_REVISION = createHash("sha256").update(prompt).digest("hex").slice(0, 12)

/** Whether a call by `model` with this window leaves fewer than 60,000 tokens of `usable`. */
export const needsCompaction = (window: Window, first: string, model: string, usable: number) =>
  usable - estimateWindow(window, first, model) < COMPACT_WHEN_LEFT

/** The summary call's single user message: the prompt, the previous summary, and the transcript. */
export const summaryRequest = (window: Window, end: number) => {
  const parts = [prompt.trim()]
  if (window.summary !== null) parts.push(block("previous_summary", escapeTags(window.summary.trim())))
  parts.push(block("transcript", renderText(window.entries.slice(0, end), RESULT_CLIP)))
  return parts.join("\n\n")
}

export interface Compaction {
  readonly window: Window
  readonly tokensBefore: number
  readonly tokensAfter: number
}

/**
 * Summarizes the window's entries before its raw tail in one call to
 * `model`, and returns the compacted window: the summary and the tail.
 * Returns null when every entry fits in the raw tail, so compaction cannot
 * shrink the window. The summary call's failure is thrown.
 */
export const compact = async (
  port: ModelPort,
  window: Window,
  first: string,
  model: string,
  signal: AbortSignal,
): Promise<Compaction | null> => {
  const tokensBefore = estimateWindow(window, first, model)
  const end = tailStart(window.entries, RAW_TAIL_TOKENS)
  if (end === 0) return null
  let summary = ""
  const call = {
    model,
    instructions: REQUEST_INSTRUCTIONS,
    messages: [new HumanMessage(summaryRequest(window, end))],
    tools: [],
    maxOutputTokens: SUMMARY_MAX_TOKENS,
  }
  for await (const chunk of port.stream(call, signal)) {
    if (typeof chunk.content === "string") summary += chunk.content
    else for (const part of chunk.content) if (part.type === "text" && typeof part.text === "string") summary += part.text
  }
  if (summary.trim() === "") throw new Error("the summary call returned no text")
  const compacted: Window = { summary: summary.trim(), entries: window.entries.slice(end), usage: null }
  return { window: compacted, tokensBefore, tokensAfter: estimateWindow(compacted, first, model) }
}

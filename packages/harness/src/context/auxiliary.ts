import { createHash } from "node:crypto"
import { HumanMessage } from "@langchain/core/messages"
import type { ModelPort } from "../agent/model.ts"
import { renderTranscript, toolContentText } from "../agent/window.ts"
import type { CallSettings } from "../models/registry.ts"
import type { Item } from "../sessions/conversation.ts"
import { estimateTokens, HANDOFF_TOOL_OUTPUT_CLIP, RESEARCH_INPUT_CLIP } from "./constants.ts"
import { clipMiddle } from "./entries.ts"
import compactionText from "./prompts/compaction.md" with { type: "text" }
import handoffText from "./prompts/handoff.md" with { type: "text" }
import researchText from "./prompts/research.md" with { type: "text" }

/** A versioned prompt file's text and its revision: the first 12 hex digits of the text's SHA-256. */
export interface Prompt {
  readonly text: string
  readonly revision: string
}

const prompt = (text: string): Prompt => ({ text: text.trim(), revision: createHash("sha256").update(text.trim()).digest("hex").slice(0, 12) })

export const COMPACTION_PROMPT = prompt(compactionText)
export const RESEARCH_PROMPT = prompt(researchText)
export const HANDOFF_PROMPT = prompt(handoffText)

/** The tags an auxiliary call's input uses, escaped in the content placed in them. */
const inputTag = /<(\/?)(user|agent|no_reply|primary_timeline|conversation|transcript|file|description|diff|content|created|deleted)\b/g

const escapeInput = (text: string) => text.replace(inputTag, "&lt;$1$2")

const attribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")

/**
 * Runs one auxiliary call: `prompt` as the instructions and `input` as its
 * one user message, with no tools. Returns the reply's text and whether
 * the reply stopped at its output limit.
 */
export const auxiliaryCall = async (
  port: ModelPort,
  call: {
    readonly model: string
    readonly settings: CallSettings
    readonly prompt: Prompt
    readonly input: string
    readonly maxOutputTokens?: number
  },
  signal: AbortSignal,
): Promise<{ readonly text: string; readonly truncated: boolean }> => {
  let text = ""
  let truncated = false
  const stream = port.stream(
    {
      model: call.model,
      instructions: call.prompt.text,
      messages: [new HumanMessage(call.input)],
      tools: [],
      ...(call.maxOutputTokens === undefined ? {} : { maxOutputTokens: call.maxOutputTokens }),
      ...call.settings,
    },
    signal,
  )
  for await (const chunk of stream) {
    const parts = typeof chunk.content === "string" ? [{ type: "text", text: chunk.content }] : chunk.content
    for (const part of parts) if (part.type === "text" && typeof part.text === "string") text += part.text
    if ((chunk.response_metadata as { status?: unknown } | undefined)?.status === "incomplete") truncated = true
  }
  return { text: text.trim(), truncated }
}

/** One message a compaction call summarizes, or the marker of a turn that ended without a final message. */
export type BoundaryMessage =
  | { readonly kind: "user" | "agent"; readonly text: string }
  | { readonly kind: "no_reply"; readonly reason: "canceled" | "rejected" | "failed" | "restarted" }

/** A compaction call's input: the primary timeline, then the boundary's messages in order. */
export const compactionInput = (timeline: ReadonlyArray<string>, messages: ReadonlyArray<BoundaryMessage>) =>
  [
    "<primary_timeline>",
    escapeInput(timeline.join("\n\n")),
    "</primary_timeline>",
    "<conversation>",
    ...messages.map((message) =>
      message.kind === "no_reply" ? `<no_reply reason="${message.reason}"/>` : `<${message.kind}>${escapeInput(message.text)}</${message.kind}>`,
    ),
    "</conversation>",
  ].join("\n")

/**
 * A research call's input: the file's name, change, and description, its
 * diff from the baseline version or its full content when created, cut to
 * 16,000 characters from each end, and the other files created and deleted.
 */
export const researchInput = (file: {
  readonly name: string
  readonly change: "created" | "changed"
  readonly description: string
  readonly body: string
  readonly created: ReadonlyArray<string>
  readonly deleted: ReadonlyArray<string>
}) => {
  const tag = file.change === "created" ? "content" : "diff"
  return [
    `<file name="${attribute(file.name)}" change="${file.change}">`,
    `<description>${escapeInput(file.description)}</description>`,
    `<${tag}>${escapeInput(clipMiddle(file.body, RESEARCH_INPUT_CLIP))}</${tag}>`,
    "</file>",
    ...file.created.map((name) => `<created>${escapeInput(name)}</created>`),
    ...file.deleted.map((name) => `<deleted>${escapeInput(name)}</deleted>`),
  ].join("\n")
}

/** A handoff call's input: the primary timeline, then the transcript. */
export const handoffInput = (timeline: ReadonlyArray<string>, transcript: string) =>
  ["<primary_timeline>", escapeInput(timeline.join("\n\n")), "</primary_timeline>", "<transcript>", transcript, "</transcript>"].join("\n")

/** How far an exchange of a handoff transcript is shortened: not, tool outputs cut, tool outputs left out, user text only. */
type Level = 0 | 1 | 2 | 3

/** An exchange at a level; a cleared result keeps its placeholder at every level but the last. */
const atLevel = (items: ReadonlyArray<Item>, level: Level): ReadonlyArray<Item> => {
  if (level === 0) return items
  if (level === 3) return items.filter((item) => item.kind === "user")
  return items.map((item) => {
    if (item.kind !== "result" || item.cleared === true) return item
    return { ...item, content: level === 1 ? clipMiddle(toolContentText(item.content), HANDOFF_TOOL_OUTPUT_CLIP) : "[output left out]" }
  })
}

/**
 * A handoff transcript of `items` that fits `budget` estimated tokens, as
 * a transcript component renders them: whole, else shortened oldest
 * exchange first, an exchange starting at each user message, by levels:
 * tool outputs cut to 2,000 characters from each end, then left out, then
 * user text only. Null when it does not fit at the last level.
 */
export const handoffTranscript = (items: ReadonlyArray<Item>, budget: number): string | null => {
  const exchanges: Array<Array<Item>> = []
  for (const item of items) {
    if (exchanges.length === 0 || item.kind === "user") exchanges.push([])
    exchanges.at(-1)!.push(item)
  }
  const rendered = new Map<string, string>()
  const render = (index: number, level: Level) => {
    const key = `${index}:${level}`
    let text = rendered.get(key)
    if (text === undefined) {
      text = `${renderTranscript(atLevel(exchanges[index]!, level))}\n`
      rendered.set(key, text)
    }
    return text
  }
  const levels: Array<Level> = exchanges.map(() => 0)
  const fits = () => levels.reduce<number>((sum, level, index) => sum + estimateTokens(render(index, level)), 0) <= budget
  if (fits()) return levels.map((level, index) => render(index, level)).join("").trimEnd()
  for (const level of [1, 2, 3] as const) {
    for (let index = 0; index < exchanges.length; index += 1) {
      levels[index] = level
      if (fits()) return levels.map((value, at) => render(at, value)).join("").trimEnd()
    }
  }
  return null
}

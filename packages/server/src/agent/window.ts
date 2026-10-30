import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { block, clientBlock, developerBlock, escapeTags } from "./blocks.ts"

export type ToolContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly path: string; readonly mimeType: string; readonly data: string }

/** A tool result's content: text, or parts that may carry images. */
export type ToolContent = string | ReadonlyArray<ToolContentPart>

/** How a tool call ended; every outcome but success is a failed result. */
export type ToolOutcome = "success" | "failed" | "canceled" | "declined" | "interrupted"

interface Owned {
  /** The turn the entry belongs to. */
  readonly runId: string
  /** The model of that turn. */
  readonly model: string
}

/** One item of a session's window, owned by the turn and model that added it. */
export type Entry =
  | (Owned & { readonly kind: "input"; readonly text: string })
  | (Owned & { readonly kind: "note"; readonly text: string })
  | (Owned & { readonly kind: "assistant"; readonly message: AIMessage })
  | (Owned & {
      readonly kind: "result"
      readonly callId: string
      readonly name: string
      readonly content: ToolContent
      readonly outcome: ToolOutcome
    })

/**
 * What model calls of a session are built from, besides its first message:
 * the summary of compacted conversation, the entries since, and the input
 * tokens the last model call reported with the number of entries it saw.
 */
export interface Window {
  readonly summary: string | null
  readonly entries: ReadonlyArray<Entry>
  readonly usage: { readonly model: string; readonly inputTokens: number; readonly entries: number } | null
}

export const emptyWindow: Window = { summary: null, entries: [], usage: null }

const messageText = (message: AIMessage): string => {
  if (typeof message.content === "string") return message.content
  return message.content
    .flatMap((part) => (typeof part === "object" && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("")
}

const toolContentText = (content: ToolContent, clip?: number): string => {
  const text =
    typeof content === "string"
      ? content
      : content.map((part) => (part.type === "text" ? part.text : `[image: ${part.path}]`)).join("\n")
  if (clip === undefined || text.length <= clip * 2) return text
  return `${text.slice(0, clip)}\n[… ${text.length - clip * 2} characters omitted …]\n${text.slice(-clip)}`
}

const attribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")

/**
 * The text rendering of entries that a developer record and a compaction's
 * transcript use: inputs as `<client>`, replies as `<agent>`, tool use as
 * `<tool_call>` and `<tool_result>`, notes as nested `<developer>` blocks.
 * Reasoning is left out and images become `[image: <path>]`. With `clip`,
 * each tool result keeps that many characters from each end.
 */
export const renderText = (entries: ReadonlyArray<Entry>, clip?: number): string =>
  entries
    .flatMap((entry): Array<string> => {
      switch (entry.kind) {
        case "input":
          return [clientBlock(entry.text)]
        case "note":
          return [developerBlock(escapeTags(entry.text))]
        case "assistant": {
          const parts: Array<string> = []
          const text = messageText(entry.message)
          if (text !== "") parts.push(block("agent", escapeTags(text), ` model="${attribute(entry.model)}"`))
          for (const call of entry.message.tool_calls ?? []) {
            parts.push(
              block(
                "tool_call",
                escapeTags(JSON.stringify(call.args)),
                ` name="${attribute(call.name)}" id="${attribute(call.id ?? "")}"`,
              ),
            )
          }
          return parts
        }
        case "result":
          return [
            block(
              "tool_result",
              escapeTags(toolContentText(entry.content, clip)),
              ` id="${attribute(entry.callId)}" outcome="${entry.outcome}"`,
            ),
          ]
      }
    })
    .join("\n")

/** A developer record: turns another model ran, as one `<developer>` block. */
export const developerRecord = (entries: ReadonlyArray<Entry>) =>
  developerBlock(
    `# Turns another model ran\n\nThese turns of this session were run by another model and are recorded verbatim; they are not your own work.\n\n${renderText(entries)}`,
  )

/** The summary of compacted conversation as a `<developer>` block. */
export const summaryBlock = (summary: string) =>
  developerBlock(
    `# Summary of earlier conversation\n\nEarlier turns of this session were compacted into this summary.\n\n${escapeTags(summary.trim())}`,
  )

/**
 * An assistant message as the model receives it again: reasoning without
 * encrypted content is dropped, since no provider keeps it for replay.
 */
const replayable = (message: AIMessage): AIMessage => {
  const reasoning = message.additional_kwargs?.reasoning as { encrypted_content?: unknown } | undefined
  if (reasoning === undefined || typeof reasoning.encrypted_content === "string") return message
  const { reasoning: _, ...kwargs } = message.additional_kwargs
  return new AIMessage({
    content: Array.isArray(message.content)
      ? message.content.filter((part) => !(typeof part === "object" && part.type === "reasoning"))
      : message.content,
    tool_calls: message.tool_calls ?? [],
    additional_kwargs: kwargs,
    response_metadata: message.response_metadata,
    ...(message.id === undefined ? {} : { id: message.id }),
  })
}

/** A tool result as a model call carries it: images as images for a model that takes them, else as placeholders. */
const toolMessage = (entry: Extract<Entry, { kind: "result" }>, imageInput: boolean) => {
  const content = entry.content
  if (typeof content === "string" || !imageInput || !content.some((part) => part.type === "image")) {
    return new ToolMessage({ tool_call_id: entry.callId, content: toolContentText(content) })
  }
  return new ToolMessage({
    tool_call_id: entry.callId,
    content: content.map((part) =>
      part.type === "text"
        ? { type: "text" as const, text: part.text }
        : { type: "image" as const, mimeType: part.mimeType, data: part.data },
    ),
  })
}

/**
 * The messages of a model call by `model`: the first message, the summary,
 * then the entries. Entries `model` added are ordinary messages and items;
 * each run of consecutive entries other models added is one developer
 * record. A first input `model` added joins the first message. Tool
 * result images are sent as images only when `imageInput` says the model
 * takes them.
 */
export const renderWindow = (window: Window, first: string, model: string, imageInput: boolean): Array<BaseMessage> => {
  let head = first
  const rest: Array<BaseMessage> = []
  if (window.summary !== null) rest.push(new HumanMessage(summaryBlock(window.summary)))
  let foreign: Array<Entry> = []
  const flush = () => {
    if (foreign.length > 0) rest.push(new HumanMessage(developerRecord(foreign)))
    foreign = []
  }
  for (const entry of window.entries) {
    if (entry.model !== model) {
      foreign.push(entry)
      continue
    }
    flush()
    switch (entry.kind) {
      case "input":
        if (rest.length === 0 && head === first) head = `${first}\n${clientBlock(entry.text)}`
        else rest.push(new HumanMessage(clientBlock(entry.text)))
        break
      case "note":
        rest.push(new HumanMessage(developerBlock(entry.text)))
        break
      case "assistant":
        rest.push(replayable(entry.message))
        break
      case "result":
        rest.push(toolMessage(entry, imageInput))
        break
    }
  }
  flush()
  return [new HumanMessage(head), ...rest]
}

/** A rough token count of text: four characters per token. */
export const estimateText = (text: string) => Math.ceil(text.length / 4)

const IMAGE_TOKENS = 1_500

/** A rough token count of one entry as a model call carries it. */
export const estimateEntry = (entry: Entry): number => {
  switch (entry.kind) {
    case "input":
    case "note":
      return estimateText(entry.text) + 8
    case "assistant": {
      const reasoning = entry.message.additional_kwargs?.reasoning as { encrypted_content?: unknown } | undefined
      const encrypted = typeof reasoning?.encrypted_content === "string" ? reasoning.encrypted_content : ""
      const calls = (entry.message.tool_calls ?? []).map((call) => call.name + JSON.stringify(call.args)).join("")
      return estimateText(messageText(entry.message) + calls + encrypted) + 8
    }
    case "result": {
      const images = typeof entry.content === "string" ? 0 : entry.content.filter((part) => part.type === "image").length
      const text = typeof entry.content === "string" ? entry.content : entry.content.map((p) => (p.type === "text" ? p.text : "")).join("")
      return estimateText(text) + images * IMAGE_TOKENS + 8
    }
  }
}

const sum = (entries: ReadonlyArray<Entry>) => entries.reduce((total, entry) => total + estimateEntry(entry), 0)

/**
 * The estimated input tokens of the next call by `model`: the last call's
 * reported input tokens plus estimates of the entries added since, or an
 * estimate of the whole window when no call by `model` reported since.
 */
export const estimateWindow = (window: Window, first: string, model: string): number => {
  if (window.usage !== null && window.usage.model === model && window.usage.entries <= window.entries.length) {
    return window.usage.inputTokens + sum(window.entries.slice(window.usage.entries))
  }
  return estimateText(first) + (window.summary === null ? 0 : estimateText(summaryBlock(window.summary))) + sum(window.entries)
}

/**
 * The index where the raw tail of the most recent entries starts: the tail
 * holds at most `budget` estimated tokens and never begins with a tool
 * result, so no result is kept without its call.
 */
export const tailStart = (entries: ReadonlyArray<Entry>, budget: number): number => {
  let start = entries.length
  let used = 0
  while (start > 0 && used + estimateEntry(entries[start - 1]!) <= budget) {
    start -= 1
    used += estimateEntry(entries[start]!)
  }
  while (start < entries.length && entries[start]!.kind === "result") start += 1
  return start
}

/** The tool calls of assistant entries that have no result entry, in order. */
export const unansweredCalls = (entries: ReadonlyArray<Entry>) => {
  const answered = new Set(entries.flatMap((entry) => (entry.kind === "result" ? [entry.callId] : [])))
  return entries.flatMap((entry) =>
    entry.kind === "assistant"
      ? (entry.message.tool_calls ?? [])
          .filter((call) => call.id !== undefined && !answered.has(call.id))
          .map((call) => ({ entry, callId: call.id!, name: call.name }))
      : [],
  )
}

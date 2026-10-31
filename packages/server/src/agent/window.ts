import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { developerBlock, systemBlock } from "../context/components.ts"
import type { Item } from "../sessions/conversation.ts"
import { block, escapeTags, userBlock } from "./blocks.ts"

export type ToolContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly path: string; readonly mimeType: string; readonly data: string }

/** A tool result's content: text, or parts that may carry images. */
export type ToolContent = string | ReadonlyArray<ToolContentPart>

/** How a tool call ended; every outcome but success is a failed result. */
export type ToolOutcome = "success" | "failed" | "canceled" | "declined" | "interrupted"

type ResultItem = Extract<Item, { kind: "result" }>

export const messageText = (message: AIMessage): string => {
  if (typeof message.content === "string") return message.content
  return message.content
    .flatMap((part) => (typeof part === "object" && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("")
}

/** A tool result's content as text, images as `[image: <path>]`. */
export const toolContentText = (content: ToolContent): string =>
  typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : `[image: ${part.path}]`)).join("\n")

const attribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")

/**
 * The transcript rendering of items: user messages as `<user>`, replies as
 * `<agent>`, tool use as `<tool_call>` and `<tool_result>`, and developer
 * components as nested `<developer>` blocks. Reasoning is left out and
 * images become `[image: <path>]`.
 */
export const renderTranscript = (items: ReadonlyArray<Item>): string =>
  items
    .flatMap((item): Array<string> => {
      switch (item.kind) {
        case "user":
          return [userBlock(item.text)]
        case "component":
          return [block("developer", escapeTags(item.component.text))]
        case "assistant": {
          const parts: Array<string> = []
          const text = messageText(item.message)
          if (text !== "") parts.push(block("agent", escapeTags(text), ` model="${attribute(item.model ?? "")}"`))
          for (const call of item.message.tool_calls ?? []) {
            parts.push(
              block("tool_call", escapeTags(JSON.stringify(call.args)), ` name="${attribute(call.name)}" id="${attribute(call.id ?? "")}"`),
            )
          }
          return parts
        }
        case "result":
          return [block("tool_result", escapeTags(toolContentText(item.content)), ` id="${attribute(item.callId)}" outcome="${item.outcome}"`)]
      }
    })
    .join("\n")

/** The transcript component of a run of items another model owns. */
export const transcriptComponent = (items: ReadonlyArray<Item>) =>
  `# Transcript\n\nTurns another model ran in this session, recorded verbatim; they are not your own work.\n\n${renderTranscript(items)}`

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
const toolMessage = (item: ResultItem, imageInput: boolean) => {
  const content = item.content
  if (typeof content === "string" || !imageInput || !content.some((part) => part.type === "image")) {
    return new ToolMessage({ tool_call_id: item.callId, content: toolContentText(content) })
  }
  return new ToolMessage({
    tool_call_id: item.callId,
    content: content.map((part) =>
      part.type === "text" ? { type: "text" as const, text: part.text } : { type: "image" as const, mimeType: part.mimeType, data: part.data },
    ),
  })
}

/**
 * The messages of a model call by `model` in a checkpoint window: its
 * harness instructions as the `<system>` block of the first user input,
 * then its items. Consecutive input items form one user input, in which
 * adjoining developer components form one `<developer>` block. Items
 * `model` owns, and those of no turn, are ordinary messages and items; each
 * run of consecutive items another model owns is one transcript component.
 * Tool result images are sent as images only when `imageInput` says the
 * model takes them.
 */
export const renderWindow = (harness: string, items: ReadonlyArray<Item>, model: string, imageInput: boolean): Array<BaseMessage> => {
  const messages: Array<BaseMessage> = []
  let blocks: Array<string> = [systemBlock(harness)]
  let components: Array<{ text: string }> = []
  let foreign: Array<Item> = []
  const closeComponents = () => {
    if (components.length > 0) blocks.push(developerBlock(components))
    components = []
  }
  const closeForeign = () => {
    if (foreign.length > 0) components.push({ text: transcriptComponent(foreign) })
    foreign = []
  }
  const flush = () => {
    closeForeign()
    closeComponents()
    if (blocks.length > 0) messages.push(new HumanMessage(blocks.join("\n")))
    blocks = []
  }
  for (const item of items) {
    if (item.model !== null && item.model !== model) {
      foreign.push(item)
      continue
    }
    closeForeign()
    switch (item.kind) {
      case "component":
        components.push(item.component)
        break
      case "user":
        closeComponents()
        blocks.push(userBlock(item.text))
        break
      case "assistant":
        flush()
        messages.push(replayable(item.message))
        break
      case "result":
        flush()
        messages.push(toolMessage(item, imageInput))
        break
    }
  }
  flush()
  return messages
}

/** The tool calls of the assistant items that have no result item, in order. */
export const unansweredCalls = (items: ReadonlyArray<Item>) => {
  const answered = new Set(items.flatMap((item) => (item.kind === "result" ? [item.callId] : [])))
  return items.flatMap((item) =>
    item.kind === "assistant"
      ? (item.message.tool_calls ?? [])
          .filter((call) => call.id !== undefined && !answered.has(call.id))
          .map((call) => ({ item, callId: call.id!, name: call.name }))
      : [],
  )
}

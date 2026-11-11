import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import type { RepresentationRef } from "@ashe-agent/protocol"
import { developerBlock, systemBlock } from "../context/components.ts"
import type { Item } from "../sessions/conversation.ts"
import type { ProjectedAttachment } from "../content/media.ts"
import { measureCall } from "./measurement.ts"
import { block, escapeTags, userBlock } from "./blocks.ts"
import type { ToolSpec } from "./model.ts"

export type ToolContentPart =
  | {
      readonly type: "text"
      readonly text: string
      readonly representation?: RepresentationRef
      readonly metadata?: Readonly<Record<string, unknown>>
    }
  | {
      readonly type: "image"
      readonly path: string
      readonly mimeType: string
      readonly data: string
      readonly representation?: RepresentationRef
      readonly metadata?: Readonly<Record<string, unknown>>
    }
  | {
      readonly type: "pdf"
      readonly path: string
      readonly mimeType: "application/pdf"
      readonly filename: string
      readonly data: string
      readonly representation?: RepresentationRef
      readonly metadata?: Readonly<Record<string, unknown>>
    }

/** A tool result's content: text, or parts that may carry images. */
export type ToolContent = string | ReadonlyArray<ToolContentPart>

/** How a tool call ended; every outcome but success is a failed result. */
export type ToolOutcome = "success" | "failed" | "canceled" | "declined" | "interrupted"

type ResultItem = Extract<Item, { kind: "result" }>

/** The text a cleared tool result reads as. */
export const CLEARED_RESULT = "[Result cleared to free context. Run the call again if you need it.]"

/** A result item's content as a model call carries it: the placeholder once cleared. */
const resultContent = (item: ResultItem): ToolContent => (item.cleared === true ? CLEARED_RESULT : item.content)

export const messageText = (message: AIMessage): string => {
  if (typeof message.content === "string") return message.content
  return message.content
    .flatMap((part) => (typeof part === "object" && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("")
}

/** A tool result's content as text, images as `[image: <path>]`. */
export const toolContentText = (content: ToolContent): string =>
  typeof content === "string"
    ? content
    : content.map((part) =>
        part.type === "text" ? part.text : part.type === "image" ? `[image: ${part.path}]` : `[pdf: ${part.filename}]`,
      ).join("\n")

const attribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")

/**
 * The transcript rendering of items: user messages as `<user>`, replies as
 * `<agent>`, tool use as `<tool_call>` and `<tool_result>`, and developer
 * components as nested `<developer>` blocks. Reasoning is left out and
 * images become `[image: <path>]`.
 */
export const renderTranscript = (
  items: ReadonlyArray<Item>,
  projected?: ReadonlyMap<string, ProjectedAttachment>,
): string =>
  items
    .flatMap((item): Array<string> => {
      switch (item.kind) {
        case "user": {
          const projection = projected?.get(item.entryId)
          const available = projection?.contributions.some(
            (contribution) => contribution.transformation !== "attachment-placeholder",
          ) === true
          const retained = (item.attachments ?? []).map((attachment) =>
            available
              ? `[Attachment ${attachment.name} (${attachment.mediaType}) is retained and follows this transcript.]`
              : `[Attachment ${attachment.name} (${attachment.mediaType}) is retained but unavailable to this model in the transcript.]`)
          return [userBlock([item.text, ...retained].join("\n\n"))]
        }
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
          return [block("tool_result", escapeTags(toolContentText(resultContent(item))), ` id="${attribute(item.callId)}" outcome="${item.outcome}"`)]
      }
    })
    .join("\n")

/** The transcript component of a run of items another model owns. */
export const transcriptComponent = (items: ReadonlyArray<Item>, projected?: ReadonlyMap<string, ProjectedAttachment>) => {
  const source = items[0]
  const origin =
    source === undefined
      ? ""
      : `\n\nSource session: \`${escapeTags(source.authorshipSessionId)}\`; title: \`${escapeTags(source.agentTitle)}\`; model: ${source.model === null ? "none" : `\`${escapeTags(source.model)}\``}.`
  return `# Transcript\n\nTurns another model ran in this session, recorded verbatim; they are not your own work.${origin}\n\n${renderTranscript(items, projected)}`
}

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

/** The native assistant message a provider receives for retained own-history. */
export const renderNativeMessage = (message: AIMessage): AIMessage => replayable(message)

/** A tool result as a model call carries it: images as images for a model that takes them, else as placeholders. */
const toolMessage = (item: ResultItem, imageInput: boolean, pdfInput: boolean, projected?: ToolContent) => {
  const content = projected ?? resultContent(item)
  if (typeof content === "string") {
    return new ToolMessage({ tool_call_id: item.callId, content: toolContentText(content) })
  }
  const supported = content.some((part) =>
    part.type === "image" ? imageInput : part.type === "pdf" ? pdfInput : false,
  )
  if (!supported) return new ToolMessage({ tool_call_id: item.callId, content: toolContentText(content) })
  const mediaRepresentations = content.flatMap((part) => part.representation === undefined
    ? []
    : [{
        representationId: part.representation.representationId,
        mediaType: part.representation.mediaType,
        transformation: part.representation.transformation,
        ...(part.metadata === undefined ? {} : { metadata: part.metadata }),
      }])
  if (content.some((part) => part.type === "pdf")) {
    return new ToolMessage({
      tool_call_id: item.callId,
      content: content.flatMap((part): Array<Record<string, unknown>> => {
        if (part.type === "text") return [{ type: "input_text", text: part.text }]
        if (part.type === "image") {
          return imageInput
            ? [{ type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}`, detail: "auto" }]
            : []
        }
        return pdfInput
          ? [{
              type: "input_file",
              file_data: `data:application/pdf;base64,${part.data}`,
              filename: part.filename,
            }]
          : []
      }) as never,
      additional_kwargs: { mediaRepresentations },
    })
  }
  return new ToolMessage({
    tool_call_id: item.callId,
    content: content.flatMap((part): Array<Record<string, unknown>> => {
      if (part.type === "text") {
        return [{
          type: "text" as const,
          text: part.text,
          ...(part.representation === undefined ? {} : { representation: part.representation }),
          ...(part.metadata === undefined ? {} : { metadata: part.metadata }),
        }]
      }
      if (part.type === "image") {
        return imageInput
          ? [{
              type: "image" as const,
              mimeType: part.mimeType,
              data: part.data,
              ...(part.representation === undefined ? {} : { representation: part.representation }),
              ...(part.metadata === undefined ? {} : { metadata: part.metadata }),
            }]
          : []
      }
      return pdfInput
        ? [{
            type: "file" as const,
            source_type: "base64",
            mime_type: "application/pdf",
            data: part.data,
            ...(part.representation === undefined ? {} : { representation: part.representation }),
            metadata: { filename: part.filename, ...part.metadata },
          }]
        : []
    }) as never,
    additional_kwargs: { mediaRepresentations },
  })
}

/** The provider tool message a retained result renders to. */
export const renderToolResultMessage = (item: ResultItem, imageInput: boolean, pdfInput = false): ToolMessage =>
  toolMessage(item, imageInput, pdfInput)

/**
 * The messages of a model call by `model` in a checkpoint window: its
 * harness instructions as the `<system>` block of the first user input,
 * then its items. Consecutive input items form one user input, in which
 * adjoining developer components form one `<developer>` block. Items
 * `model` owns, those of no turn, and seed components are ordinary
 * messages and items; each run of consecutive items another model owns is
 * one transcript component. A cleared tool result reads as its placeholder.
 * Tool result images are sent as images only when `imageInput` says the
 * model takes them.
 */
export const renderWindow = (
  harness: string,
  items: ReadonlyArray<Item>,
  model: string,
  imageInput: boolean,
  agentTitle = items[0]?.agentTitle ?? "untitled",
  observe?: (sourceEntryIds: ReadonlyArray<string>, rendered: string) => void,
  attachments?: ReadonlyMap<string, ProjectedAttachment>,
  pdfInput = false,
  projectedResults?: ReadonlyMap<string, ToolContent>,
  observeMessage?: (sourceEntryIds: ReadonlyArray<string>, rendered: string) => void,
): Array<BaseMessage> => {
  const messages: Array<BaseMessage> = []
  let blocks: Array<string> = [systemBlock(harness)]
  let blockEvidence: Array<{ sourceEntryIds: ReadonlyArray<string>; rendered: string }> = []
  let components: Array<{ text: string; sourceEntryIds: ReadonlyArray<string> }> = []
  let foreign: Array<Item> = []
  let foreignContent: Array<Record<string, unknown>> = []
  let foreignRepresentations: Array<Record<string, unknown>> = []
  let inputOwner: string | null | undefined
  const closeComponents = () => {
    if (components.length > 0) {
      const rendered = developerBlock(components)
      blocks.push(rendered)
      blockEvidence.push({ sourceEntryIds: components.flatMap((component) => component.sourceEntryIds), rendered })
      observe?.(components.flatMap((component) => component.sourceEntryIds), rendered)
    }
    components = []
  }
  const closeForeign = () => {
    if (foreign.length > 0) {
      const rendered = transcriptComponent(foreign, attachments)
      components.push({ text: rendered, sourceEntryIds: foreign.map((item) => item.entryId) })
      for (const item of foreign) {
        const projected = item.kind === "user" ? attachments?.get(item.entryId)?.parts : undefined
        const result = item.kind === "result" ? projectedResults?.get(item.entryId) : undefined
        const parts = projected ?? (typeof result === "string" || result === undefined ? [] : result)
        for (const part of parts) {
          if (part.representation !== undefined) {
            foreignRepresentations.push({
              representationId: part.representation.representationId,
              mediaType: part.representation.mediaType,
              transformation: part.representation.transformation,
              ...(part.metadata === undefined ? {} : { metadata: part.metadata }),
            })
          }
          if (part.type === "text") {
            foreignContent.push({
              type: "text",
              text: part.text,
              ...(part.representation === undefined ? {} : { representation: part.representation }),
              ...(part.metadata === undefined ? {} : { metadata: part.metadata }),
            })
          } else if (part.type === "image") {
            if (!imageInput) continue
            foreignContent.push({
              type: "input_image",
              image_url: `data:${part.mimeType};base64,${part.data}`,
              detail: "auto",
            })
          }
          else if (pdfInput) {
            foreignContent.push({
              type: "file",
              source_type: "base64",
              mime_type: part.mimeType,
              data: part.data,
              ...(part.representation === undefined ? {} : { representation: part.representation }),
              metadata: { filename: part.filename, ...part.metadata },
            })
          }
        }
      }
    }
    foreign = []
  }
  const flush = () => {
    closeForeign()
    closeComponents()
    if (blocks.length > 0) {
      messages.push(foreignContent.length === 0
        ? new HumanMessage(blocks.join("\n"))
        : new HumanMessage({
            content: [{ type: "text", text: blocks.join("\n") }, ...foreignContent] as never,
            additional_kwargs: { mediaRepresentations: foreignRepresentations },
          }))
      observeMessage?.(
        blockEvidence.flatMap((entry) => entry.sourceEntryIds),
        blocks.join("\n"),
      )
    }
    blocks = []
    blockEvidence = []
    foreignContent = []
    foreignRepresentations = []
  }
  for (const item of items) {
    const seed = item.kind === "component" && item.component.type === "seed"
    const oldTitleSeed =
      seed && item.kind === "component" && item.component.sources.userInstructions?.kind === "title" && item.agentTitle !== agentTitle
    if (oldTitleSeed) continue
    if (!seed && item.runId !== null && (item.model !== model || item.agentTitle !== agentTitle)) {
      const previous = foreign.at(-1)
      if (
        previous !== undefined &&
        (previous.authorshipSessionId !== item.authorshipSessionId ||
          previous.agentTitle !== item.agentTitle ||
          previous.model !== item.model)
      ) {
        closeForeign()
      }
      foreign.push(item)
      continue
    }
    closeForeign()
    const input = !seed && (item.kind === "component" || item.kind === "user")
    if (input && item.runId !== null && inputOwner !== undefined && inputOwner !== null && item.runId !== inputOwner) flush()
    if (input && item.runId !== null) inputOwner = item.runId
    switch (item.kind) {
      case "component":
        components.push({ ...item.component, sourceEntryIds: [item.entryId] })
        break
      case "user": {
        closeComponents()
        const projected = attachments?.get(item.entryId)
        if (projected === undefined || projected.parts.length === 0) {
          const rendered = userBlock(item.text)
          blocks.push(rendered)
          blockEvidence.push({ sourceEntryIds: [item.entryId], rendered })
          observe?.([item.entryId], rendered)
          break
        }
        flush()
        const content: Array<Record<string, unknown>> = [{ type: "text", text: userBlock(item.text) }]
        const renderedParts: Array<string> = []
        for (const part of projected.parts) {
          if (part.type === "text") {
            content.push({ type: "text", text: part.text })
            renderedParts.push(part.text)
          } else if (part.type === "image") {
            content.push({
              type: "input_image",
              image_url: `data:${part.mimeType};base64,${part.data}`,
              detail: "auto",
            })
            renderedParts.push(`[image: ${part.representation.representationId}]`)
          } else {
            content.push({
              type: "file",
              source_type: "base64",
              mime_type: part.mimeType,
              data: part.data,
              metadata: { filename: part.filename },
            })
            renderedParts.push(`[pdf: ${part.filename}]`)
          }
        }
        messages.push(new HumanMessage({ content: content as never }))
        const rendered = [userBlock(item.text), ...renderedParts].join("\n")
        observe?.([item.entryId], rendered)
        observeMessage?.([item.entryId], rendered)
        break
      }
      case "assistant":
        flush()
        messages.push(replayable(item.message))
        const assistantRendered = JSON.stringify(replayable(item.message))
        observe?.([item.entryId], assistantRendered)
        observeMessage?.([item.entryId], assistantRendered)
        break
      case "result":
        flush()
        const message = toolMessage(item, imageInput, pdfInput, projectedResults?.get(item.entryId))
        messages.push(message)
        const resultRendered = JSON.stringify(message)
        observe?.([item.entryId], resultRendered)
        observeMessage?.([item.entryId], resultRendered)
        break
    }
  }
  flush()
  return messages
}

/**
 * The estimated input tokens of a model call: its instructions, the text
 * of its messages, an assistant message's tool calls and reasoning
 * summaries included, each image at a fixed estimate, and the offered
 * tool definitions.
 */
export const estimateCall = (
  instructions: string,
  messages: ReadonlyArray<BaseMessage>,
  tools: ReadonlyArray<ToolSpec>,
  options: { readonly imageTokens?: number; readonly pdfTokens?: number } = {},
): number => measureCall(instructions, messages, tools, options).knownSubtotal

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

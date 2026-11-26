import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import type { ContextMediaProjection, ModelCallContextItem, RepresentationRef } from "@ashe-agent/protocol"
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

export interface ReplayedReasoningInfo {
  readonly present: boolean
  readonly opaque: boolean
  readonly plaintext: string
}

/**
 * Inspects a replayed assistant message's provider reasoning items across
 * Responses API archetypes: opaque encrypted/signed items (`encrypted_content`)
 * vs. plaintext-only reasoning items (empty/absent `encrypted_content`).
 */
export const inspectReplayedReasoning = (message: BaseMessage): ReplayedReasoningInfo => {
  const output = (message.response_metadata as { readonly output?: unknown } | undefined)?.output
  if (Array.isArray(output)) {
    const reasoningItems = output.filter(
      (item): item is {
        readonly type: "reasoning"
        readonly encrypted_content?: unknown
        readonly summary?: ReadonlyArray<{ readonly text?: unknown }>
        readonly content?: ReadonlyArray<{ readonly text?: unknown }>
      } => typeof item === "object" && item !== null && (item as { type?: unknown }).type === "reasoning",
    )
    if (reasoningItems.length > 0) {
      const opaque = reasoningItems.some(
        (item) => typeof item.encrypted_content === "string" && item.encrypted_content.trim() !== "",
      )
      if (opaque) return { present: true, opaque: true, plaintext: "" }
      const plaintext = reasoningItems
        .flatMap((item) => {
          const summaryText = Array.isArray(item.summary)
            ? item.summary.flatMap((part) => (typeof part?.text === "string" ? [part.text] : [])).join("")
            : ""
          if (summaryText !== "") return [summaryText]
          const contentText = Array.isArray(item.content)
            ? item.content.flatMap((part) => (typeof part?.text === "string" ? [part.text] : [])).join("")
            : ""
          return contentText !== "" ? [contentText] : []
        })
        .join("\n")
      return { present: plaintext !== "", opaque: false, plaintext }
    }
  }
  const reasoning = (message.additional_kwargs as { readonly reasoning?: unknown } | undefined)?.reasoning as
    | { readonly encrypted_content?: unknown; readonly summary?: ReadonlyArray<{ readonly text?: unknown }> }
    | undefined
  if (reasoning !== undefined) {
    const opaque = typeof reasoning.encrypted_content === "string" && reasoning.encrypted_content.trim() !== ""
    if (opaque) return { present: true, opaque: true, plaintext: "" }
    const summaryText = Array.isArray(reasoning.summary)
      ? reasoning.summary.flatMap((part) => (typeof part?.text === "string" ? [part.text] : [])).join("")
      : ""
    if (summaryText !== "") return { present: true, opaque: false, plaintext: summaryText }
  }
  if (Array.isArray(message.content)) {
    const plaintext = message.content
      .flatMap((part) =>
        typeof part === "object" && part !== null && part.type === "reasoning" && typeof part.reasoning === "string"
          ? [part.reasoning]
          : [],
      )
      .join("")
    if (plaintext !== "") return { present: true, opaque: false, plaintext }
  }
  return { present: false, opaque: false, plaintext: "" }
}

/** The native assistant message a provider receives for retained own-history. */
export const renderNativeMessage = (message: AIMessage): AIMessage => message

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

const mediaKindForType = (mediaType: string): "text" | "image" | "pdf" =>
  mediaType.startsWith("image/") ? "image" : mediaType === "application/pdf" ? "pdf" : "text"

const userAttachmentsProjection = (
  item: Extract<Item, { kind: "user" }>,
  projected?: ProjectedAttachment,
): ReadonlyArray<ContextMediaProjection> => {
  if (projected !== undefined && projected.contributions.length > 0) {
    return projected.contributions.map((contribution) => {
      if (contribution.transformation === "attachment-placeholder") {
        return {
          kind: "placeholder" as const,
          name:
            item.attachments?.find((att) => att.contentId === contribution.representation.contentId)?.name ??
            item.attachments?.[0]?.name ??
            "attachment",
          reason: "attachment unavailable to selected model",
        }
      }
      const matchingPart = projected.parts.find(
        (part) => part.representation?.representationId === contribution.representation.representationId,
      )
      const byteLength =
        matchingPart === undefined
          ? 0
          : matchingPart.type === "text"
            ? Buffer.byteLength(matchingPart.text)
            : Buffer.from(matchingPart.data, "base64").byteLength
      const name =
        matchingPart !== undefined && matchingPart.type === "pdf"
          ? matchingPart.filename
          : (item.attachments?.find((att) => att.contentId === contribution.representation.contentId)?.name ??
            item.attachments?.[0]?.name ??
            "attachment")
      return {
        kind: "representation" as const,
        name,
        content: contribution.representation,
        byteLength,
        mediaKind: mediaKindForType(contribution.representation.mediaType),
      }
    })
  }
  return (item.attachments ?? []).map((attachment) => ({
    kind: "representation" as const,
    name: attachment.name,
    content: {
      representationId: attachment.representationId,
      contentId: attachment.contentId,
      mediaType: attachment.mediaType,
      digest: attachment.digest,
      transformation: "attachment-original",
    },
    byteLength: 0,
    mediaKind: mediaKindForType(attachment.mediaType),
  }))
}

const toolResultContextProjection = (
  item: ResultItem,
  imageInput: boolean,
  pdfInput: boolean,
  projected?: ToolContent,
): { readonly resultByteLength: number; readonly resultMedia: ReadonlyArray<ContextMediaProjection> } => {
  if (item.cleared === true) {
    return { resultByteLength: Buffer.byteLength(CLEARED_RESULT), resultMedia: [] }
  }
  const content = projected ?? item.content
  if (typeof content === "string") {
    return { resultByteLength: Buffer.byteLength(content), resultMedia: [] }
  }
  let textBytes = 0
  const media: Array<ContextMediaProjection> = []
  for (const part of content) {
    if (part.type === "text") {
      textBytes += Buffer.byteLength(part.text)
      continue
    }
    if (part.type === "image") {
      if (imageInput) {
        const bytes = Buffer.from(part.data, "base64")
        const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
        media.push({
          kind: "representation",
          name: part.path,
          content: part.representation ?? {
            representationId: digest,
            contentId: digest,
            mediaType: part.mimeType,
            digest,
            transformation: null,
          },
          byteLength: bytes.byteLength,
          mediaKind: "image",
        })
      } else {
        textBytes += Buffer.byteLength(`[image: ${part.path}]`)
        media.push({ kind: "placeholder", name: part.path, reason: "image input unavailable for selected model" })
      }
      continue
    }
    if (pdfInput) {
      const bytes = Buffer.from(part.data, "base64")
      const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
      media.push({
        kind: "representation",
        name: part.filename,
        content: part.representation ?? {
          representationId: digest,
          contentId: digest,
          mediaType: part.mimeType,
          digest,
          transformation: null,
        },
        byteLength: bytes.byteLength,
        mediaKind: "pdf",
      })
    } else {
      textBytes += Buffer.byteLength(`[pdf: ${part.filename}]`)
      media.push({ kind: "placeholder", name: part.filename, reason: "pdf input unavailable for selected model" })
    }
  }
  return { resultByteLength: textBytes, resultMedia: media }
}

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
  observeContext?: (item: ModelCallContextItem) => void,
  thoughtEntryIds?: ReadonlyMap<string, string>,
): Array<BaseMessage> => {
  const messages: Array<BaseMessage> = []
  let blocks: Array<string> = [systemBlock(harness)]
  let blockEvidence: Array<{ sourceEntryIds: ReadonlyArray<string>; rendered: string }> = []
  let components: Array<{ text: string; sourceEntryIds: ReadonlyArray<string> }> = []
  let foreign: Array<Item> = []
  let foreignContent: Array<Record<string, unknown>> = []
  let foreignRepresentations: Array<Record<string, unknown>> = []
  let inputOwner: string | null | undefined
  const toolArgsByCallId = new Map<string, unknown>()
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
      const sourceEntryIds = foreign.map((item) => item.entryId)
      components.push({ text: rendered, sourceEntryIds })
      observeContext?.({
        kind: "developer-message",
        sourceEntryIds,
        transcript: {
          id: `transcript:${sourceEntryIds[0]!}`,
          type: "transcript",
          heading: "Transcript",
          text: rendered,
        },
        byteLength: Buffer.byteLength(rendered),
      })
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
        observeContext?.({
          kind: "developer-message",
          sourceEntryIds: [item.entryId],
          transcript: null,
          byteLength: Buffer.byteLength(item.component.text),
        })
        break
      case "user": {
        closeComponents()
        const projected = attachments?.get(item.entryId)
        observeContext?.({
          kind: "user-message",
          sourceEntryId: item.entryId,
          byteLength: Buffer.byteLength(item.text),
          attachments: userAttachmentsProjection(item, projected),
        })
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
      case "assistant": {
        flush()
        const native = renderNativeMessage(item.message)
        messages.push(native)
        for (const call of native.tool_calls ?? []) {
          if (call.id !== undefined) toolArgsByCallId.set(call.id, call.args)
        }
        const reasoning = inspectReplayedReasoning(native)
        if (reasoning.present) {
          observeContext?.({
            kind: "agent-thought",
            sourceEntryId: item.modelCallId !== null ? (thoughtEntryIds?.get(item.modelCallId) ?? null) : null,
            modelCallId: item.modelCallId,
            opaque: reasoning.opaque,
            byteLength: reasoning.opaque ? 0 : Buffer.byteLength(reasoning.plaintext),
          })
        }
        const visibleText = messageText(native)
        if (visibleText !== "" || (!reasoning.present && (native.tool_calls?.length ?? 0) === 0)) {
          observeContext?.({
            kind: "agent-message",
            sourceEntryId: item.entryId,
            modelCallId: item.modelCallId,
            byteLength: Buffer.byteLength(visibleText),
          })
        }
        const assistantRendered = JSON.stringify(native)
        observe?.([item.entryId], assistantRendered)
        observeMessage?.([item.entryId], assistantRendered)
        break
      }
      case "result": {
        flush()
        const message = toolMessage(item, imageInput, pdfInput, projectedResults?.get(item.entryId))
        messages.push(message)
        const args = toolArgsByCallId.get(item.callId)
        const inputByteLength = Buffer.byteLength(JSON.stringify({ name: item.name, arguments: args ?? null }))
        const { resultByteLength, resultMedia } = toolResultContextProjection(
          item,
          imageInput,
          pdfInput,
          projectedResults?.get(item.entryId),
        )
        observeContext?.({
          kind: "agent-tool",
          sourceEntryId: item.entryId,
          modelCallId: item.modelCallId,
          resultCleared: item.cleared === true,
          inputByteLength,
          resultByteLength,
          resultMedia,
        })
        const resultRendered = JSON.stringify(message)
        observe?.([item.entryId], resultRendered)
        observeMessage?.([item.entryId], resultRendered)
        break
      }
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

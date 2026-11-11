import type { BaseMessage } from "@langchain/core/messages"
import {
  estimateContributions,
  type EstimatorContribution,
  type EstimatorOptions,
  type Measurement,
} from "@ashe-agent/protocol"
import type { ProjectedAttachment } from "../content/media.ts"
import type { Item } from "../sessions/conversation.ts"
import type { ToolSpec } from "./model.ts"
import type { ToolContent } from "./window.ts"

/** Representation identities the recorded model-facing request carries. */
export interface MeasurementEvidence {
  readonly instruction?: string
  readonly messages?: ReadonlyArray<ReadonlyArray<string>>
  readonly tools?: ReadonlyArray<string>
}

export interface RenderedMessage {
  readonly sourceEntryIds: ReadonlyArray<string>
}

export const contentDigest = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")

/**
 * Representation identities of rendered provider messages: the actual
 * message bytes, the harness system block on the first message, each source
 * item, and every projected attachment or tool-result representation.
 */
export const renderedMessageEvidence = (options: {
  readonly harness: string
  readonly messages: ReadonlyArray<BaseMessage>
  readonly rendered: ReadonlyArray<RenderedMessage>
  readonly items: ReadonlyArray<Item>
  readonly attachments?: ReadonlyMap<string, ProjectedAttachment>
  readonly results?: ReadonlyMap<string, ToolContent>
  readonly imageInput?: boolean
  readonly pdfInput?: boolean
}): ReadonlyArray<ReadonlyArray<string>> => {
  const byEntry = new Map(options.items.map((item) => [item.entryId, item]))
  return options.rendered.map((message, index) => {
    const ids = new Set<string>([
      contentDigest(JSON.stringify(options.messages[index])),
      ...(index === 0 ? [contentDigest(options.harness)] : []),
    ])
    for (const entryId of message.sourceEntryIds) {
      const item = byEntry.get(entryId)
      if (item === undefined) continue
      ids.add(item.representationId)
      if (item.kind === "user") {
        const projected = options.attachments?.get(entryId)?.contributions
        for (const attachment of projected ?? []) ids.add(attachment.representation.representationId)
        for (const attachment of projected === undefined ? item.attachments ?? [] : []) ids.add(attachment.representationId)
      } else if (item.kind === "result") {
        const content = item.cleared === true
          ? undefined
          : options.results?.get(entryId) ?? item.content
        if (typeof content !== "string" && content !== undefined) {
          for (const part of content) {
            if (options.results?.has(entryId) !== true) {
              if (part.type === "image" && options.imageInput !== true) continue
              if (part.type === "pdf" && options.pdfInput !== true) continue
            }
            if (part.representation !== undefined) ids.add(part.representation.representationId)
          }
        }
      }
    }
    return [...ids]
  })
}

const contentText = (message: BaseMessage): string => {
  if (typeof message.content === "string") return message.content
  return message.content.flatMap((part) => {
    if (typeof part !== "object") return []
    if (part.type === "text" && typeof part.text === "string") return [part.text]
    if (part.type === "input_text" && typeof part.text === "string") return [part.text]
    if (part.type === "reasoning" && typeof part.reasoning === "string") return [part.reasoning]
    return []
  }).join("")
}

const media = (message: BaseMessage): { images: number; pdfs: number } => {
  if (typeof message.content === "string") return { images: 0, pdfs: 0 }
  let images = 0
  let pdfs = 0
  for (const part of message.content) {
    if (typeof part !== "object") continue
    if (part.type === "image" || part.type === "image_url" || part.type === "input_image") images += 1
    if (part.type === "file" && (part as { mime_type?: unknown }).mime_type === "application/pdf") pdfs += 1
    const fileData = (part as { file_data?: unknown }).file_data
    if (part.type === "input_file" && (
      (part as { mime_type?: unknown }).mime_type === "application/pdf" ||
      typeof fileData === "string" && fileData.startsWith("data:application/pdf;base64,")
    )) {
      pdfs += 1
    }
  }
  return { images, pdfs }
}

const opaqueProviderState = (message: BaseMessage): boolean => {
  const kwargs = message.additional_kwargs ?? {}
  const reasoning = kwargs.reasoning as { readonly encrypted_content?: unknown } | undefined
  if (reasoning?.encrypted_content !== undefined) return true
  return Object.keys(kwargs).some((key) => key !== "reasoning" && key !== "tool_calls" && key !== "mediaRepresentations")
}

/** The shared estimate of one model call's recorded model-facing contributions. */
export const measureCall = (
  instructions: string,
  messages: ReadonlyArray<BaseMessage>,
  tools: ReadonlyArray<ToolSpec>,
  options: EstimatorOptions = {},
  evidence: MeasurementEvidence = {},
): Measurement => {
  const contributions: Array<EstimatorContribution> = [
    {
      position: 0,
      kind: "text",
      text: instructions,
      ...(evidence.instruction === undefined ? {} : { representationIds: [evidence.instruction] }),
    },
  ]
  let position = 1
  for (const [index, message] of messages.entries()) {
    const representationIds = evidence.messages?.[index]
    const text = contentText(message)
    const toolCalls = "tool_calls" in message && Array.isArray(message.tool_calls) && message.tool_calls.length > 0
      ? JSON.stringify(message.tool_calls)
      : ""
    if (text !== "" || toolCalls !== "") {
      contributions.push({
        position,
        kind: "text",
        text: `${text}${toolCalls}`,
        ...(representationIds === undefined || representationIds.length === 0 ? {} : { representationIds }),
      })
      position += 1
    }
    const found = media(message)
    if (found.images > 0) {
      contributions.push({
        position,
        kind: "image",
        count: found.images,
        ...(representationIds === undefined || representationIds.length === 0 ? {} : { representationIds }),
      })
      position += 1
    }
    if (found.pdfs > 0) {
      contributions.push({
        position,
        kind: "native-pdf",
        count: found.pdfs,
        ...(representationIds === undefined || representationIds.length === 0 ? {} : { representationIds }),
      })
      position += 1
    }
    if (opaqueProviderState(message)) {
      contributions.push({
        position,
        kind: "unavailable",
        reason: "opaque provider replay state is not measured",
        ...(representationIds === undefined || representationIds.length === 0 ? {} : { representationIds }),
      })
      position += 1
    }
  }
  for (const [index, tool] of tools.entries()) {
    const representationId = evidence.tools?.[index]
    contributions.push({
      position,
      kind: "structured",
      value: { name: tool.name, description: tool.description, parameters: tool.parameters },
      ...(representationId === undefined ? {} : { representationIds: [representationId] }),
    })
    position += 1
  }
  return estimateContributions(contributions, options)
}

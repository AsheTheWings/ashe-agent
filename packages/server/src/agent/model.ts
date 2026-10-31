import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages"
import { ChatOpenAI } from "@langchain/openai"

/** A function tool as the model is offered it, with a draft-07 JSON Schema of its arguments. */
export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

/** One model call: the Responses `instructions`, the input messages, and the offered tools. */
export interface ModelCall {
  /** The `<provider>/<model>` id of the configured model the call goes to. */
  readonly model: string
  readonly instructions: string
  readonly messages: ReadonlyArray<BaseMessage>
  readonly tools: ReadonlyArray<ToolSpec>
  readonly maxOutputTokens?: number
  /** The sampling temperature, sent only when set. */
  readonly temperature?: number
  /** The Responses `reasoning` field, sent only when set. */
  readonly reasoning?: { readonly effort?: string; readonly summary: "auto" }
}

/** A failed model call; `overflow` marks a request larger than the model's context window. */
export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly overflow: boolean,
  ) {
    super(message)
  }
}

/**
 * The model behind a session: streams one call's output as LangChain message
 * chunks and fails with `ModelCallError`. Aborting `signal` aborts the call.
 */
export interface ModelPort {
  readonly stream: (call: ModelCall, signal: AbortSignal) => AsyncIterable<AIMessageChunk>
}

const overflowPattern =
  /context[ _-]?(length|window)|maximum context|too many (input )?tokens|prompt is too long|input is too long|exceeds? the (model'?s )?(context|maximum)/i

/** Whether a provider's error says the request exceeded the model's context window. */
export const isContextOverflow = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false
  const record = error as { code?: unknown; message?: unknown; error?: { code?: unknown; message?: unknown } }
  const code = record.code ?? record.error?.code
  if (code === "context_length_exceeded") return true
  const message = [record.message, record.error?.message].filter((part) => typeof part === "string").join(" ")
  return overflowPattern.test(message)
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Where a model's calls go: its provider's base URL and API key, and the provider's id of the model. */
export interface Endpoint {
  readonly baseURL: string
  readonly apiKey: string
  readonly upstream: string
}

/**
 * The model port over each provider's OpenAI Responses API, through
 * LangChain's `ChatOpenAI`; `endpoint` gives a model id's provider
 * endpoint. Calls are not stored by the provider, so each replays its whole
 * input; reasoning is requested with its encrypted content so later calls
 * of the same model can send it back. The `reasoning` field goes in the
 * request body as given, whatever LangChain guesses of the model's name.
 */
export const responsesModelPort = (endpoint: (model: string) => Endpoint | undefined): ModelPort => ({
  async *stream(call, signal) {
    const target = endpoint(call.model)
    if (target === undefined) throw new ModelCallError(`no provider serves ${call.model}`, false)
    const chat = new ChatOpenAI({
      model: target.upstream,
      apiKey: target.apiKey,
      configuration: { baseURL: target.baseURL },
      useResponsesApi: true,
      streaming: true,
      zdrEnabled: true,
      maxRetries: 2,
      ...(call.maxOutputTokens === undefined ? {} : { maxTokens: call.maxOutputTokens }),
      ...(call.temperature === undefined ? {} : { temperature: call.temperature }),
      modelKwargs: { instructions: call.instructions, ...(call.reasoning === undefined ? {} : { reasoning: call.reasoning }) },
    })
    const runnable =
      call.tools.length === 0
        ? chat
        : chat.bindTools(
            call.tools.map((tool) => ({
              type: "function" as const,
              function: { name: tool.name, description: tool.description, parameters: tool.parameters },
            })),
          )
    try {
      const stream = await runnable.stream([...call.messages], { signal, include: ["reasoning.encrypted_content"] })
      for await (const chunk of stream) yield chunk
    } catch (error) {
      if (signal.aborted) throw error
      throw new ModelCallError(errorMessage(error), isContextOverflow(error))
    }
  },
})

import { describe, expect, test } from "bun:test"
import { HumanMessage } from "@langchain/core/messages"
import { REQUEST_INSTRUCTIONS } from "../src/agent/blocks.ts"
import { ModelCallError, responsesModelPort } from "../src/agent/model.ts"
import { AgentHarness, configuredModel } from "./support/agent.ts"

type Captured = { readonly path: string; readonly authorization: string | null; readonly body: Record<string, any> }

const sse = (events: ReadonlyArray<Record<string, unknown>>) =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")

const response = (id: string) => ({ id, object: "response", status: "completed", model: "m", output: [], usage: { input_tokens: 1234, output_tokens: 5, total_tokens: 1239 } })

/** The first reply: reasoning with encrypted content, streamed text, and one call to `echo`. */
const toolReply = [
  { type: "response.created", response: { ...response("resp_1"), status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
  { type: "response.reasoning_summary_part.added", item_id: "rs_1", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } },
  { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "thinking" },
  { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking" }], encrypted_content: "ENC" } },
  { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } },
  { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: "Hel" },
  { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: "lo" },
  { type: "response.output_item.done", output_index: 1, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello", annotations: [] }] } },
  { type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "echo", arguments: "" } },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 2, delta: '{"text":' },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 2, delta: '"a"}' },
  { type: "response.output_item.done", output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "echo", arguments: '{"text":"a"}', status: "completed" } },
  { type: "response.completed", response: response("resp_1") },
]

const textReply = [
  { type: "response.created", response: { ...response("resp_2"), status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_2", role: "assistant", status: "in_progress", content: [] } },
  { type: "response.output_text.delta", item_id: "msg_2", output_index: 0, content_index: 0, delta: "done" },
  { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_2", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] } },
  { type: "response.completed", response: response("resp_2") },
]

/** A Responses API on a loopback port that answers each request with the next scripted reply. */
const fakeResponsesApi = (replies: Array<() => Response>) => {
  const captured: Array<Captured> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, any>
      captured.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization"), body })
      const reply = replies.shift()
      return reply === undefined ? new Response("no reply scripted", { status: 500 }) : reply()
    },
  })
  return { captured, baseUrl: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

const stream = (events: ReadonlyArray<Record<string, unknown>>) => () => new Response(sse(events), { headers: { "content-type": "text/event-stream" } })

describe("the Responses model port", () => {
  test("a turn's calls reach the configured endpoint with the fixed instructions and the protocol's own tool items", async () => {
    const api = fakeResponsesApi([stream(toolReply), stream(textReply)])
    const models = [configuredModel("test/alpha", { efforts: ["low", "high"], settings: { reasoningEffort: "high" } })]
    const endpoint = (id: string) => (id === "test/alpha" ? { baseURL: api.baseUrl, apiKey: "synthetic-key", upstream: "alpha" } : undefined)
    const harness = new AgentHarness({ port: responsesModelPort(endpoint), models })
    try {
      const id = harness.create()
      harness.input(id, "hello")
      await harness.turnsEnded(id, 1)
      expect(harness.types(id).at(-1)).toBe("RUN_FINISHED")
      const deltas = harness.events(id).flatMap((event) => (event.event.type === "TEXT_MESSAGE_CONTENT" ? [event.event.delta] : []))
      expect(deltas).toEqual(["Hel", "lo", "done"])
      expect(api.captured.map((request) => request.path)).toEqual(["/v1/responses", "/v1/responses"])
      for (const { authorization, body } of api.captured) {
        expect(authorization).toBe("Bearer synthetic-key")
        // The provider receives its own model id, and the reasoning field goes in the body whatever the model's name.
        expect(body).toMatchObject({ model: "alpha", instructions: REQUEST_INSTRUCTIONS, store: false, stream: true })
        expect(body.reasoning).toEqual({ effort: "high", summary: "auto" })
        expect(body.include).toEqual(["reasoning.encrypted_content"])
        expect(body.tools.map((tool: any) => [tool.type, tool.name])).toEqual([
          ["function", "echo"],
          ["function", "wait"],
          ["function", "refuse"],
          ["function", "touch"],
          ["function", "pair"],
          ["function", "context_append"],
          ["function", "context_get_open_items"],
          ["function", "context_ask_question"],
        ])
      }
      const [first, second] = api.captured.map((request) => request.body.input as Array<Record<string, any>>)
      expect(first).toHaveLength(1)
      expect(first![0]).toMatchObject({ type: "message", role: "user" })
      expect(JSON.stringify(first![0]!.content)).toContain("<system>")
      expect(second!.map((item) => item.type)).toEqual(["message", "reasoning", "message", "function_call", "function_call_output"])
      expect(second![1]).toMatchObject({ encrypted_content: "ENC" })
      expect(second![3]).toMatchObject({ call_id: "call_1", name: "echo", arguments: '{"text":"a"}' })
      expect(second![4]).toMatchObject({ call_id: "call_1", output: "echoed a" })
    } finally {
      await harness.cleanup()
      api.stop()
    }
  })

  test("a provider's context window error is reported as an overflow", async () => {
    const api = fakeResponsesApi([
      () =>
        Response.json(
          { error: { message: "Your input exceeds the context window of this model.", type: "invalid_request_error", code: "context_length_exceeded" } },
          { status: 400 },
        ),
    ])
    try {
      const port = responsesModelPort(() => ({ baseURL: api.baseUrl, apiKey: "synthetic-key", upstream: "m" }))
      const call = { model: "p/m", instructions: REQUEST_INSTRUCTIONS, messages: [new HumanMessage("hi")], tools: [] }
      let failure: unknown
      try {
        for await (const _ of port.stream(call, new AbortController().signal)) {
        }
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(ModelCallError)
      expect((failure as ModelCallError).overflow).toBe(true)
      expect(api.captured).toHaveLength(1)
    } finally {
      api.stop()
    }
  })
})

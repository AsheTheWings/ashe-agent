import { describe, expect, test } from "bun:test"
import { AIMessage } from "@langchain/core/messages"
import { measureCall } from "../src/agent/measurement.ts"
import { inspectReplayedReasoning } from "../src/agent/window.ts"

describe("replayed reasoning inspection and measurement", () => {
  test("detects opaque vs plaintext reasoning across response_metadata, additional_kwargs, and content", () => {
    const outputOpaque = new AIMessage({
      content: "done",
      response_metadata: {
        output: [{ type: "reasoning", encrypted_content: "ENC_BLOB", summary: [{ text: "plan" }] }],
      },
    })
    expect(inspectReplayedReasoning(outputOpaque)).toEqual({ present: true, opaque: true, plaintext: "" })

    const outputPlainSummary = new AIMessage({
      content: "done",
      response_metadata: {
        output: [{ type: "reasoning", encrypted_content: "", summary: [{ text: "step 1" }] }],
      },
    })
    expect(inspectReplayedReasoning(outputPlainSummary)).toEqual({ present: true, opaque: false, plaintext: "step 1" })

    const outputPlainContent = new AIMessage({
      content: "done",
      response_metadata: {
        output: [{ type: "reasoning", content: [{ text: "thought body" }] }],
      },
    })
    expect(inspectReplayedReasoning(outputPlainContent)).toEqual({ present: true, opaque: false, plaintext: "thought body" })

    const kwargsOpaque = new AIMessage({
      content: "done",
      additional_kwargs: { reasoning: { encrypted_content: "ENC", summary: [{ text: "hidden" }] } },
    })
    expect(inspectReplayedReasoning(kwargsOpaque)).toEqual({ present: true, opaque: true, plaintext: "" })

    const kwargsPlain = new AIMessage({
      content: "done",
      additional_kwargs: { reasoning: { summary: [{ text: "visible summary" }] } },
    })
    expect(inspectReplayedReasoning(kwargsPlain)).toEqual({ present: true, opaque: false, plaintext: "visible summary" })

    const contentPlain = new AIMessage({
      content: [
        { type: "reasoning", reasoning: "inline reasoning" },
        { type: "text", text: "answer" },
      ],
    })
    expect(inspectReplayedReasoning(contentPlain)).toEqual({ present: true, opaque: false, plaintext: "inline reasoning" })

    const none = new AIMessage({ content: "plain answer" })
    expect(inspectReplayedReasoning(none)).toEqual({ present: false, opaque: false, plaintext: "" })
  })

  test("measures plaintext replayed reasoning completely and marks opaque encrypted_content as partial", () => {
    const plainMessage = new AIMessage({
      content: "ok",
      response_metadata: {
        output: [{ type: "reasoning", summary: [{ text: "a".repeat(80) }] }],
      },
    })
    const plainMeasurement = measureCall("sys", [plainMessage], [])
    expect(plainMeasurement.coverage).toBe("complete")
    expect(plainMeasurement.unavailable).toEqual([])
    expect(plainMeasurement.knownSubtotal).toBeGreaterThanOrEqual(20)

    const opaqueMessage = new AIMessage({
      content: "ok",
      response_metadata: {
        output: [{ type: "reasoning", encrypted_content: "OPAQUE_STATE" }],
      },
    })
    const opaqueMeasurement = measureCall("sys", [opaqueMessage], [])
    expect(opaqueMeasurement.coverage).toBe("partial")
    expect(opaqueMeasurement.unavailable).toHaveLength(1)
  })
})

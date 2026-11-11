import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { convertMessagesToResponsesInput } from "@langchain/openai"
import { analyzeContributions, canonicalJson, estimateContributions } from "@ashe-agent/protocol"
import { builtinTool } from "../src/agent/tools.ts"
import { contentDigest, measureCall, renderedMessageEvidence } from "../src/agent/measurement.ts"
import { renderToolResultMessage, renderWindow, type ToolContent } from "../src/agent/window.ts"
import type { ConversionPort, PdfConversionJob } from "../src/content/conversion.ts"
import { observeToolResult, type ContentPolicy } from "../src/content/retention.ts"
import type { Item } from "../src/sessions/conversation.ts"
import { fileReadTool } from "../src/tools/file/read-tool.ts"
import { AgentHarness, callTools, configuredModel, say } from "./support/agent.ts"

const policy: ContentPolicy = { collectionBytes: 1_024, previewLines: 2, previewBytes: 32 }

const upload = (h: AgentHarness, prefix: string, name: string, mimeType: string, bytes: Uint8Array) => {
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  const made = h.hub.attachments.create("login:component", prefix, name, mimeType, bytes.byteLength, Date.now())
  h.hub.attachments.append("login:component", made.uploadId, 0, Buffer.from(bytes).toString("base64"), Date.now())
  h.hub.attachments.finalize("login:component", made.uploadId, bytes.byteLength, digest, Date.now())
  const attachmentId = h.hub.store.db.query<{ attachment_id: string }, [string]>(
    "SELECT attachment_id FROM uploads WHERE owner_id = 'login:component' AND upload_id = ?",
  ).get(made.uploadId)!.attachment_id
  return { attachmentId, contentId: digest, representationId: digest, name, mediaType: mimeType, digest }
}

class FakeConverter implements ConversionPort {
  readonly calls: Array<PdfConversionJob> = []
  constructor(private readonly pages = 9, private readonly text = "Extracted PDF text") {}
  async convert(job: PdfConversionJob) {
    this.calls.push(job)
    await job.load()
    return {
      total: this.pages,
      text: this.text,
      pages: Array.from({ length: Math.min(this.pages, job.window.limit) }, (_, index) => ({
        page: job.window.offset + index,
        total: this.pages,
        png: readFileSync("packages/harness/test/fixtures/documents/red.png"),
        width: 1,
        height: 1,
      })),
    }
  }
}

describe("content measurement and retention", () => {
  test("the shared estimator measures text, structured definitions, media allowances, and unknown coverage", () => {
    const first = estimateContributions([
      { position: 0, kind: "text", text: "abcd" },
      { position: 1, kind: "structured", value: { b: 2, a: 1 } },
      { position: 2, kind: "image", count: 2 },
      { position: 3, kind: "native-pdf" },
      { position: 4, kind: "unavailable", reason: "opaque replay" },
    ])
    const second = estimateContributions([
      { position: 0, kind: "text", text: "abcd" },
      { position: 1, kind: "structured", value: { a: 1, b: 2 } },
      { position: 2, kind: "image", count: 2 },
      { position: 3, kind: "native-pdf" },
      { position: 4, kind: "unavailable", reason: "opaque replay" },
    ])
    expect(first).toEqual(second)
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
    expect(first).toMatchObject({ method: "ashe-agent-estimator", methodVersion: 1, coverage: "partial" })
    expect(first.contributions).toContainEqual(expect.objectContaining({ basis: "configured-image-allowance", tokens: 3_000 }))
    expect(first.contributions).toContainEqual(expect.objectContaining({ basis: "configured-pdf-allowance", tokens: 2_000 }))
    expect(first.unavailable).toEqual(expect.arrayContaining([
      { contributionPosition: 3, reason: "provider page expansion is not measured" },
      { contributionPosition: 4, reason: "opaque replay" },
    ]))
    expect(first.knownSubtotal).toBeGreaterThan(5_000)
    expect(measureCall("instructions", [], [{ name: "z", description: "d", parameters: { type: "object" } }]))
      .toMatchObject({ methodVersion: 1, coverage: "complete" })
  })

  test("alternative analysis is labelled separately from the execution estimate", () => {
    const contributions = [
      { position: 0, kind: "text" as const, text: "abcd" },
      { position: 1, kind: "image" as const, count: 2 },
    ]
    const execution = estimateContributions(contributions)
    const analysis = analyzeContributions(contributions, { imageTokens: 10 })
    expect(execution.purpose).toBe("execution")
    expect(analysis).toMatchObject({ purpose: "analysis", knownSubtotal: 21 })
    expect(analysis.knownSubtotal).not.toBe(execution.knownSubtotal)
  })

  test("measurement names recorded representations and marks opaque provider state unavailable", () => {
    const opaque = new AIMessage({
      content: "visible",
      additional_kwargs: { reasoning: { encrypted_content: "provider-opaque" } },
    })
    const measurement = measureCall(
      "instructions",
      [opaque],
      [{ name: "tool", description: "d", parameters: { type: "object" } }],
      {},
      { instruction: "instruction-ref", messages: [["message-ref"]], tools: ["tool-ref"] },
    )
    expect(measurement.coverage).toBe("partial")
    expect(measurement.contributions).toContainEqual(expect.objectContaining({
      representationIds: ["instruction-ref"],
    }))
    expect(measurement.contributions).toContainEqual(expect.objectContaining({
      basis: "ashe-agent-text-v1",
      representationIds: ["message-ref"],
    }))
    expect(measurement.contributions).toContainEqual(expect.objectContaining({
      basis: "unavailable",
      representationIds: ["message-ref"],
      unavailableReason: "opaque provider replay state is not measured",
    }))
    expect(measurement.contributions).toContainEqual(expect.objectContaining({
      representationIds: ["tool-ref"],
    }))
  })

  test("rendered coalesced messages and projected pages supply the measurement identities", () => {
    const base = (entryId: string, position: number, representationId: string) => ({
      entryId,
      position,
      runId: "run",
      model: "model",
      agentTitle: "untitled",
      contentId: representationId,
      modelCallId: null,
      authorshipSessionId: "session",
      ownershipKind: "local" as const,
      sourceSessionId: null,
      contentFormat: "text/plain",
      representationId,
    })
    const first = {
      ...base("user-one", 1, "user-one-ref"),
      kind: "user" as const,
      inputId: "input-one",
      text: "one",
      sender: { kind: "login" as const, loginId: "owner" },
    }
    const second = {
      ...base("user-two", 2, "user-two-ref"),
      kind: "user" as const,
      inputId: "input-two",
      text: "two",
      sender: { kind: "login" as const, loginId: "owner" },
    }
    const resultItem = {
      ...base("result-page", 3, "result-ref"),
      kind: "result" as const,
      callId: "call",
      name: "file_read",
      outcome: "success" as const,
      content: [{
        type: "image" as const,
        path: "report.pdf#page=1",
        mimeType: "image/png",
        data: "AAAA",
        representation: {
          representationId: "page-ref",
          contentId: "page-content",
          mediaType: "image/png",
          digest: "page-content",
          transformation: "pdf-page-image",
        },
      }],
    }
    const items: Array<Item> = [first, second, resultItem]
    const results: ReadonlyMap<string, ToolContent> = new Map([["result-page", resultItem.content]])
    const rendered: Array<{ sourceEntryIds: ReadonlyArray<string> }> = []
    const messages = renderWindow(
      "harness body",
      items,
      "model",
      true,
      "untitled",
      undefined,
      undefined,
      false,
      results,
      (sourceEntryIds) => rendered.push({ sourceEntryIds: [...sourceEntryIds] }),
    )
    expect(rendered).toHaveLength(2)
    expect(JSON.stringify(messages[0])).toContain("one")
    expect(JSON.stringify(messages[0])).toContain("two")
    const evidence = renderedMessageEvidence({
      harness: "harness body",
      messages,
      rendered,
      items,
      results,
    })
    const measurement = measureCall("instructions", messages, [], {}, {
      instruction: contentDigest("instructions"),
      messages: evidence,
    })
    const ids = measurement.contributions.flatMap((contribution) => contribution.representationIds ?? [])
    expect(ids).toContain(contentDigest(JSON.stringify(messages[0])))
    expect(ids).toContain(contentDigest("harness body"))
    expect(ids).toEqual(expect.arrayContaining(["user-one-ref", "user-two-ref", "page-ref"]))
    expect(measurement.contributions.find((contribution) => contribution.basis === "configured-image-allowance"))
      .toMatchObject({ representationIds: expect.arrayContaining(["result-ref", "page-ref"]) })
  })

  test("a current result's media identity is measured without false opaque coverage", async () => {
    const tool = builtinTool({
      name: "picture",
      permission: null,
      description: "Return an image.",
      args: Schema.Record(Schema.String, Schema.Never),
      run: async () => ({
        outcome: "success",
        content: [{
          type: "image" as const,
          path: "page.png",
          mimeType: "image/png",
          data: "AAAA",
          representation: {
            representationId: "current-page-ref",
            contentId: "current-page",
            mediaType: "image/png",
            digest: "current-page",
            transformation: "image-original",
          },
        }],
      }),
    })
    const h = new AgentHarness({
      tools: [tool],
      models: [configuredModel("test/vision", { imageInput: true })],
    })
    try {
      const session = h.create()
      h.model.next(callTools([{ name: "picture", args: {} }]), say("seen"))
      h.input(session, "look")
      await h.turnsEnded(session, 1)
      const manifest = h.hub.store.conversation.successfulManifests(session).at(-1)!.manifest as any
      expect(manifest.measurement.coverage).toBe("complete")
      expect(manifest.measurement.unavailable).toEqual([])
      expect(
        manifest.measurement.contributions.flatMap((part: any) => part.representationIds ?? []),
      ).toContain("current-page-ref")
    } finally {
      await h.cleanup()
    }
  })

  test("cleared and unsupported current results do not measure absent media", () => {
    const resultItem = (cleared: boolean): Item => ({
      kind: "result",
      entryId: "result",
      position: 1,
      runId: "run",
      model: "model",
      agentTitle: "untitled",
      contentId: "result-ref",
      modelCallId: null,
      authorshipSessionId: "session",
      ownershipKind: "local",
      sourceSessionId: null,
      contentFormat: "application/json",
      representationId: "result-ref",
      callId: "call",
      name: "picture",
      outcome: "success",
      ...(cleared ? { cleared: true } : {}),
      content: [{
        type: "image",
        path: "page.png",
        mimeType: "image/png",
        data: "AAAA",
        representation: {
          representationId: "page-ref",
          contentId: "page-content",
          mediaType: "image/png",
          digest: "page-content",
          transformation: "image-original",
        },
      }],
    })
    for (const { cleared, imageInput } of [
      { cleared: true, imageInput: true },
      { cleared: false, imageInput: false },
    ]) {
      const item = resultItem(cleared)
      const rendered: Array<{ sourceEntryIds: ReadonlyArray<string> }> = []
      const messages = renderWindow(
        "harness",
        [item],
        "model",
        imageInput,
        "untitled",
        undefined,
        undefined,
        false,
        undefined,
        (sourceEntryIds) => rendered.push({ sourceEntryIds: [...sourceEntryIds] }),
      )
      const evidence = renderedMessageEvidence({
        harness: "harness",
        messages,
        rendered,
        items: [item],
        imageInput,
      })
      const measurement = measureCall("instructions", messages, [], {}, { messages: evidence })
      const ids = measurement.contributions.flatMap((contribution) => contribution.representationIds ?? [])
      expect(ids).not.toContain("page-ref")
      expect(measurement.contributions.some((contribution) => contribution.basis === "configured-image-allowance")).toBe(false)
    }
  })

  test("a native PDF contribution lowers through the Responses adapter to a sanitized input_file", () => {
    const converted = convertMessagesToResponsesInput({
      messages: [new HumanMessage({
        content: [{
          type: "file",
          source_type: "base64",
          mime_type: "application/pdf",
          data: "JVBERi0=",
          metadata: { filename: "report.pdf" },
        }] as never,
      })],
      zdrEnabled: true,
      model: "m",
    })
    expect(converted).toEqual([{
      type: "message",
      role: "user",
      content: [{
        type: "input_file",
        file_data: "data:application/pdf;base64,JVBERi0=",
        filename: "report.pdf",
      }],
    }])
  })

  test("a native PDF tool result measures its input_file allowance and representation", () => {
    const message = renderToolResultMessage({
      kind: "result",
      entryId: "result",
      position: 1,
      runId: "run",
      model: "model",
      agentTitle: "untitled",
      contentId: "result-ref",
      modelCallId: null,
      authorshipSessionId: "session",
      ownershipKind: "local",
      sourceSessionId: null,
      contentFormat: "application/json",
      representationId: "result-ref",
      callId: "call",
      name: "file_read",
      outcome: "success",
      content: [
        { type: "text", text: "report" },
        {
          type: "pdf",
          path: "report.pdf",
          mimeType: "application/pdf",
          filename: "report.pdf",
          data: "JVBERi0=",
          representation: {
            representationId: "pdf-ref",
            contentId: "pdf-content",
            mediaType: "application/pdf",
            digest: "pdf-content",
            transformation: "file-native-pdf",
          },
        },
      ],
    }, false, true)
    const measurement = measureCall("instructions", [message], [], { pdfTokens: 7_000 }, {
      messages: [["pdf-ref"]],
    })
    expect(measurement.contributions).toContainEqual(expect.objectContaining({
      basis: "configured-pdf-allowance",
      tokens: 7_000,
      representationIds: ["pdf-ref"],
    }))
    expect(measurement.contributions).toContainEqual(expect.objectContaining({
      basis: "ashe-agent-text-v1",
      representationIds: ["pdf-ref"],
    }))
    expect(measurement.coverage).toBe("partial")
  })

  test("the collection cap bounds retained bytes and reports its loss without emptying a long line", () => {
    const source = "x".repeat(256)
    const observed = observeToolResult(
      { outcome: "success", content: "bounded", capturedText: source },
      { collectionBytes: 64, previewLines: 1, previewBytes: 32 },
      "collection-cap",
    )
    expect(observed.retention).toBeDefined()
    expect(Buffer.byteLength(observed.retention!.text)).toBeLessThanOrEqual(64)
    expect(observed.retention!.captureLossBytes).toBeGreaterThan(0)
    expect(String(observed.content)).toContain("x".repeat(16))
    expect(String(observed.content)).toContain("Capture loss:")
  })

  test("multi-part text is bounded while image parts stay intact", () => {
    const image = { type: "image" as const, path: "image.png", mimeType: "image/png", data: "AAAA" }
    const observed = observeToolResult({
      outcome: "success",
      content: [{ type: "text", text: "x".repeat(100) }, image],
      captureLossBytes: 3,
    }, { collectionBytes: 1_000, previewLines: 1, previewBytes: 10 }, "multi")
    expect(typeof observed.content).not.toBe("string")
    if (typeof observed.content === "string") throw new Error("expected parts")
    expect(observed.content).toContainEqual(image)
    const text = observed.content.filter((part) => part.type === "text").map((part) => part.text).join("")
    expect(new TextEncoder().encode(text).length).toBeLessThan(300)
    expect(text).toContain("Full captured text is retained at references/")
    expect(observed.retention?.text).toBe("x".repeat(100))
    expect(observed.retention?.captureLossBytes).toBe(3)
  })

  test("a multipart result retains its distinct captured text and file_read retrieves it", async () => {
    const captured = `bounded preview\n${"y".repeat(2_000)}\nTAIL-RETAINED`
    const image = { type: "image" as const, path: "image.png", mimeType: "image/png", data: "AAAA" }
    const tool = builtinTool({
      name: "multi-capture",
      permission: null,
      description: "Return a bounded observation with captured text.",
      args: Schema.Record(Schema.String, Schema.Never),
      run: async () => ({
        outcome: "success",
        content: [{ type: "text", text: "bounded observation" }, image],
        capturedText: captured,
      }),
    })
    const h = new AgentHarness({
      tools: [tool, fileReadTool()],
      contentPolicy: { collectionBytes: 10_000, previewLines: 1, previewBytes: 20 },
      models: [configuredModel("test/vision", { imageInput: true })],
    })
    try {
      const session = h.create()
      h.model.next(callTools([{ name: "multi-capture", args: {} }]), say("first"))
      h.input(session, "capture")
      await h.turnsEnded(session, 1)
      const rendered = JSON.stringify(h.model.last().messages)
      expect(rendered).toContain("Full captured text is retained at references/")
      expect(rendered).not.toContain("TAIL-RETAINED")
      const reference = h.db.query<{ name: string }, [string]>(
        "SELECT name FROM content_references WHERE session_id = ?",
      ).get(session)!
      expect(readFileSync(join(h.sessionDir(session), "references", reference.name), "utf8")).toBe(captured)
      h.model.next(
        callTools([{ name: "file_read", args: { path: `references/${reference.name}` } }]),
        say("retrieved"),
      )
      h.input(session, "read it")
      await h.turnsEnded(session, 2)
      const result = h.events(session)
        .map((event) => event.event)
        .filter((event) => event.type === "TOOL_CALL_RESULT")
        .at(-1)
      expect(String(result?.content)).toContain("TAIL-RETAINED")
    } finally {
      await h.cleanup()
    }
  })

  test("an already-windowed shell observation keeps its metadata and requested cap", () => {
    const result = {
      outcome: "success" as const,
      content: `Wall time: 1.0000 seconds\nProcess exited with code 0\nOriginal token count: 999\nOutput:\ntruncated`,
      capturedText: "x".repeat(10_000),
      alreadyBounded: true,
    }
    expect(observeToolResult(result, { collectionBytes: 10, previewLines: 1, previewBytes: 10 }, "shell")).toBe(result)
  })

  test("a tool result with text and an image reaches the next model bounded without losing the image", async () => {
    const image = { type: "image" as const, path: "image.png", mimeType: "image/png", data: "AAAA" }
    const tool = builtinTool({
      name: "multi",
      permission: null,
      description: "Return text and an image.",
      args: Schema.Record(Schema.String, Schema.Never),
      run: async () => ({ outcome: "success", content: [{ type: "text", text: "x".repeat(100) }, image] }),
    })
    const h = new AgentHarness({
      tools: [tool],
      models: [configuredModel("test/vision", { imageInput: true })],
      contentPolicy: { collectionBytes: 80, previewLines: 1, previewBytes: 10 },
    })
    try {
      const id = h.create({ model: "test/vision" })
      h.model.next(callTools([{ name: "multi", args: {} }]), say("done"))
      h.input(id, "multi")
      await h.turnsEnded(id, 1)
      const content = JSON.stringify(h.model.last().messages)
      expect(content).toContain("Full captured text is retained at references/")
      expect(content).toContain('"type":"image"')
      expect(content).not.toContain("x".repeat(100))
    } finally {
      await h.cleanup()
    }
  })

  test("a bounded model observation retains oversized captured output and file_read can retrieve it", async () => {
    const captured = Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n")
    const tool = builtinTool({
      name: "oversized",
      permission: null,
      description: "Return oversized captured output.",
      args: Schema.Record(Schema.String, Schema.Never),
      run: async () => ({ outcome: "success", content: "bounded", capturedText: captured }),
    })
    const h = new AgentHarness({ tools: [tool], contentPolicy: policy })
    try {
      const session = h.create()
      h.model.next(callTools([{ name: "oversized", args: {} }]), say("done"))
      h.input(session, "retain")
      await h.turnsEnded(session, 1)
      const result = h.events(session).find(({ event }) => event.type === "TOOL_CALL_RESULT")!.event as {
        content: unknown
        outcome: string
      }
      expect(result).toMatchObject({ outcome: "success" })
      expect(String(result.content)).toContain("Full captured text is retained at references/")
      const reference = h.db.query<{ name: string; content_sha256: string }, [string]>(
        "SELECT name, content_sha256 FROM content_references WHERE session_id = ?",
      ).get(session)!
      expect(readFileSync(join(h.sessionDir(session), "references", reference.name), "utf8")).toBe(captured)
      expect(h.hub.store.conversation.content(reference.content_sha256)).toBe(captured)
    } finally {
      await h.cleanup()
    }
  })

  test("a fork keeps retained output readable after source rewind reclaims it", async () => {
    const text = "retained fork output " + "x".repeat(200)
    const tool = builtinTool({
      name: "write",
      permission: null,
      description: "Write output.",
      args: Schema.Record(Schema.String, Schema.Never),
      run: async () => ({ outcome: "success", content: "bounded", capturedText: text }),
    })
    const h = new AgentHarness({ tools: [tool], contentPolicy: policy })
    try {
      const session = h.create()
      h.model.next(callTools([{ name: "write", args: {} }]), say("done"))
      h.input(session, "produce retained output")
      await h.turnsEnded(session, 1)
      const run = h.events(session).flatMap((event) => event.event.type === "RUN_STARTED" ? [event.event.runId] : [])[0]!
      const row = h.db.query<{ entry_id: string; name: string }, [string]>(
        "SELECT entry_id, name FROM content_references WHERE session_id = ?",
      ).get(session)!
      const fork = h.hub.fork(session, run).id
      expect(existsSync(join(h.sessionDir(fork), "references", row.name))).toBe(true)
      await h.hub.rewind(session, run, undefined, h.sender)
      expect(h.db.query("SELECT 1 FROM content_references WHERE session_id = ?").get(session)).toBeNull()
      const sourceReferences = join(h.sessionDir(session), "references")
      expect(existsSync(sourceReferences) ? readdirSync(sourceReferences) : []).toEqual([])
      expect(h.db.query<{ name: string }, [string]>(
        "SELECT name FROM content_references WHERE session_id = ?",
      ).get(fork)).toMatchObject({ name: row.name })
      expect(readFileSync(join(h.sessionDir(fork), "references", row.name), "utf8")).toBe(text)
    } finally {
      await h.cleanup()
    }
  })

  test("a PDF attachment is lowered to page images and text for an image model", async () => {
    const converter = new FakeConverter()
    const h = new AgentHarness({
      models: [configuredModel("test/vision", { imageInput: true })],
      conversion: converter,
      contentMediaOptions: { dpi: 144, maxLongEdge: 2_048, maxPixelsPerPage: 4_194_304, pagesPerWindow: 8, previewBytes: 1_024 },
    })
    try {
      const session = h.create()
      const ref = upload(h, "pdf", "report.pdf", "application/pdf", readFileSync("packages/harness/test/fixtures/documents/orchard.pdf"))
      h.model.next(say("read it"))
      h.hub.input(session, "inspect", "steer", h.sender, { attachments: [ref] })
      await h.turnsEnded(session, 1)
      expect(converter.calls).toHaveLength(1)
      const content = h.model.last().messages.flatMap((message) => typeof message.content === "string" ? [] : message.content)
      expect(content.some((part) => typeof part === "object" && part.type === "input_image")).toBe(true)
      const transformations = h.db.query<{ transformation: string }, [string]>(
        "SELECT transformation FROM attachment_representations WHERE attachment_id = ? ORDER BY transformation",
      ).all(ref.attachmentId).map((row) => row.transformation)
      expect([...new Set(transformations)]).toEqual(["pdf-page-image", "pdf-text"])
      const ids = h.db.query<{ representation_id: string }, [string]>(
        "SELECT representation_id FROM attachment_representations WHERE attachment_id = ?",
      ).all(ref.attachmentId).map((row) => row.representation_id)
      expect(new Set(ids).size).toBe(9)
      expect(ids.some((id) => id.startsWith("pdf-text:1:"))).toBe(true)
      expect(ids.some((id) => id.startsWith("pdf-page-image:8:"))).toBe(true)
    } finally {
      await h.cleanup()
    }
  })

  test("unsupported historical media uses a retained placeholder without reconversion", async () => {
    const converter = new FakeConverter(2, "")
    const h = new AgentHarness({
      models: [configuredModel("test/vision", { imageInput: true }), configuredModel("test/text")],
      conversion: converter,
      contentMediaOptions: { dpi: 144, maxLongEdge: 2_048, maxPixelsPerPage: 4_194_304, pagesPerWindow: 8, previewBytes: 1_024 },
    })
    try {
      const session = h.create()
      const ref = upload(h, "old-scan", "old-scan.pdf", "application/pdf", readFileSync("packages/harness/test/fixtures/documents/scan.pdf"))
      h.model.next(say("image model"))
      h.hub.input(session, "inspect", "steer", h.sender, { attachments: [ref] })
      await h.turnsEnded(session, 1)
      h.model.next(say("text history"))
      h.hub.input(session, "switch", "steer", h.sender, { selection: { modelSettings: { modelId: "test/text" } } })
      await h.turnsEnded(session, 2)
      expect(converter.calls).toHaveLength(1)
      expect(JSON.stringify(h.model.last().messages)).toContain("retained but unavailable to this model")
      expect(h.hub.attachments.attachment(ref.attachmentId)).not.toBeNull()
    } finally {
      await h.cleanup()
    }
  })

  test("historical media stays available when the next model declares the same capability", async () => {
    const h = new AgentHarness({
      models: [configuredModel("test/vision-a", { imageInput: true }), configuredModel("test/vision-b", { imageInput: true })],
    })
    try {
      const session = h.create({ model: "test/vision-a" })
      const ref = upload(h, "historical-image", "red.png", "image/png", readFileSync("packages/harness/test/fixtures/documents/red.png"))
      h.model.next(say("first"))
      h.hub.input(session, "inspect", "steer", h.sender, { attachments: [ref] })
      await h.turnsEnded(session, 1)
      h.model.next(say("second"))
      h.hub.input(session, "switch", "steer", h.sender, { selection: { modelSettings: { modelId: "test/vision-b" } } })
      await h.turnsEnded(session, 2)
      const messages = JSON.stringify(h.model.last().messages)
      expect(messages).toContain('"type":"input_image"')
      expect(messages).not.toContain("retained but unavailable to this model")
    } finally {
      await h.cleanup()
    }
  })

  test("historical text attachments follow the transcript without an unavailable label", async () => {
    const h = new AgentHarness({
      models: [configuredModel("test/text-a"), configuredModel("test/text-b")],
    })
    try {
      const session = h.create({ model: "test/text-a" })
      const ref = upload(h, "historical-text", "notes.txt", "text/plain", Buffer.from("readable historical text"))
      h.model.next(say("first"))
      h.hub.input(session, "inspect", "steer", h.sender, { attachments: [ref] })
      await h.turnsEnded(session, 1)
      h.model.next(say("second"))
      h.hub.input(session, "switch", "steer", h.sender, { selection: { modelSettings: { modelId: "test/text-b" } } })
      await h.turnsEnded(session, 2)
      const messages = JSON.stringify(h.model.last().messages)
      expect(messages).toContain("readable historical text")
      expect(messages).toContain("is retained and follows this transcript")
      expect(messages).not.toContain("is retained but unavailable to this model in the transcript")
    } finally {
      await h.cleanup()
    }
  })

  test("unsupported current PDF input fails explicitly and preserves the original", async () => {
    const h = new AgentHarness({ models: [configuredModel("test/text")], conversion: null })
    try {
      const session = h.create()
      const ref = upload(h, "pdf-unsupported", "scan.pdf", "application/pdf", readFileSync("packages/harness/test/fixtures/documents/scan.pdf"))
      h.model.next(say("must not run"))
      h.hub.input(session, "inspect", "steer", h.sender, { attachments: [ref] })
      await h.turnsEnded(session, 1)
      expect(h.events(session).some(({ event }) => event.type === "RUN_ERROR")).toBe(true)
      expect(h.db.query<{ n: number }, [string]>( "SELECT count(*) AS n FROM attachment_references WHERE session_id = ?" ).get(session)).toEqual({ n: 1 })
      expect(h.hub.attachments.attachment(ref.attachmentId)).not.toBeNull()
    } finally {
      await h.cleanup()
    }
  })
})

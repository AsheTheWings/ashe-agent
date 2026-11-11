import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { builtinTool } from "../src/agent/tools.ts"
import { BoundedPdfConverter, type ConversionPort, type PdfConversionJob } from "../src/content/conversion.ts"
import { fileReadTool } from "../src/tools/file/read-tool.ts"
import { AgentHarness, callTools, configuredModel, responsesInput, say } from "./support/agent.ts"

const main = join(import.meta.dir, "../src/main.ts")
const limits = {
  prlimitPath: "/usr/bin/prlimit",
  dataBytes: 512 * 1024 ** 2,
  stackBytes: 8 * 1024 ** 2,
  cpuSeconds: 20,
  wallMs: 30_000,
  outputBytes: 128 * 1024 ** 2,
  activeWorkers: 2,
  queuedJobs: 16,
  inputBytes: 32 * 1024 ** 2,
}
const geometry = { dpi: 144, maxLongEdge: 2_048, maxPixelsPerPage: 4_194_304 }
const converter = () => new BoundedPdfConverter(limits, { executable: process.execPath, args: [main, "conversion-worker"] })

const upload = (h: AgentHarness, name: string, bytes: Uint8Array, mediaType = "application/pdf") => {
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  const made = h.hub.attachments.create("login:component", name, name, mediaType, bytes.byteLength, Date.now())
  h.hub.attachments.append("login:component", made.uploadId, 0, Buffer.from(bytes).toString("base64"), Date.now())
  h.hub.attachments.finalize("login:component", made.uploadId, bytes.byteLength, digest, Date.now())
  const attachmentId = h.hub.store.db.query<{ attachment_id: string }, [string]>(
    "SELECT attachment_id FROM uploads WHERE owner_id = 'login:component' AND upload_id = ?",
  ).get(made.uploadId)!.attachment_id
  return { attachmentId, contentId: digest, representationId: digest, name, mediaType, digest }
}

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures/documents", name))

const imageOnly = () => {
  const calls: Array<PdfConversionJob> = []
  const port: ConversionPort = {
    async convert(job) {
      calls.push(job)
      await job.load()
      return {
        total: 1,
        text: "",
        pages: [{ page: 1, total: 1, png: fixture("red.png"), width: 1, height: 1 }],
      }
    },
  }
  return { port, calls }
}


const resultEvents = (h: AgentHarness, session: string) => h.events(session)
  .flatMap(({ event }) => event.type === "TOOL_CALL_RESULT" ? [event as { content: unknown; outcome: string }] : [])

  test("file_read retrieves full captured shell output from its retained reference", async () => {
    const captured = `retained-${"0".repeat(10_000)}`
    const capture = builtinTool({
      name: "capture",
      permission: null,
      description: "Capture output.",
      args: Schema.Record(Schema.String, Schema.Never),
      run: async () => ({ outcome: "success", content: "bounded", capturedText: captured }),
    })
    const h = new AgentHarness({
      tools: [capture, fileReadTool()],
      contentPolicy: { collectionBytes: 1_000_000, previewLines: 2, previewBytes: 32 },
    })
    try {
      const session = h.create()
      h.model.next(
        callTools([{ name: "capture", args: {} }]),
        say("captured"),
      )
      h.input(session, "capture output")
      await h.turnsEnded(session, 1)
      const row = h.db.query<{ name: string }, [string]>(
        "SELECT name FROM content_references WHERE session_id = ?",
      ).get(session)!
      h.model.next(
        callTools([{ name: "file_read", args: { path: `references/${row.name}` } }]),
        say("read"),
      )
      h.input(session, "read the retained output")
      await h.turnsEnded(session, 2)
      const replay = JSON.stringify(h.model.last().messages)
      expect(replay).toContain("retained-")
      expect(replay).toContain("0".repeat(1_900))
      expect(replay).toContain("continue line 1 from offset 1, column 2001")
    } finally {
      await h.cleanup()
    }
  }, 30_000)

  test("a current user image reaches the Responses input as an input_image", async () => {
    const h = new AgentHarness({
      models: [configuredModel("test/vision", { imageInput: true })],
    })
    try {
      const session = h.create()
      const ref = upload(h, "red.png", fixture("red.png"), "image/png")
      h.model.next(say("seen"))
      h.hub.input(session, "inspect", "steer", h.sender, { attachments: [ref] })
      await h.turnsEnded(session, 1)
      expect(JSON.stringify(responsesInput(h.model.last()))).toContain('"type":"input_image"')
    } finally {
      await h.cleanup()
    }
  }, 30_000)

  test("historical image-only PDFs become placeholders without reconversion", async () => {
    const fake = imageOnly()
    const h = new AgentHarness({
      models: [configuredModel("test/vision", { imageInput: true }), configuredModel("test/text")],
      conversion: fake.port,
    })
    try {
      const session = h.create()
      const ref = upload(h, "scan.pdf", fixture("scan.pdf"))
      h.model.next(say("vision turn"))
      h.hub.input(session, "inspect", "steer", h.sender, { attachments: [ref] })
      await h.turnsEnded(session, 1)
      h.model.next(say("historical turn"))
      h.hub.input(session, "switch", "steer", h.sender, { selection: { modelSettings: { modelId: "test/text" } } })
      await h.turnsEnded(session, 2)
      expect(JSON.stringify(h.model.last().messages)).toContain("retained but unavailable to this model")
      expect(h.hub.attachments.attachment(ref.attachmentId)).not.toBeNull()
      expect(fake.calls).toHaveLength(1)
    } finally {
      await h.cleanup()
    }
  }, 30_000)

  test("retained output survives restart and stays readable in a fork after source rewind", async () => {
    const text = "retained across restart " + "x".repeat(2_000)
    const capture = builtinTool({
      name: "capture",
      permission: null,
      description: "Capture output.",
      args: Schema.Record(Schema.String, Schema.Never),
      run: async () => ({ outcome: "success", content: "bounded", capturedText: text }),
    })
    const h = new AgentHarness({
      tools: [capture],
      contentPolicy: { collectionBytes: 1_000_000, previewLines: 1, previewBytes: 32 },
    })
    try {
      const session = h.create()
      h.model.next(callTools([{ name: "capture", args: {} }]), say("captured"))
      h.input(session, "capture")
      await h.turnsEnded(session, 1)
      const run = h.events(session).flatMap(({ event }) => event.type === "RUN_STARTED" ? [event.runId] : [])[0]!
      const row = h.db.query<{ name: string }, [string]>(
        "SELECT name FROM content_references WHERE session_id = ?",
      ).get(session)!
      const fork = h.hub.fork(session, run).id
      await h.restart()
      expect(existsSync(join(h.sessionDir(fork), "references", row.name))).toBe(true)
      await h.hub.rewind(session, run, undefined, h.sender)
      expect(h.db.query("SELECT 1 FROM content_references WHERE session_id = ?").get(session)).toBeNull()
      expect(h.db.query<{ name: string }, [string]>(
        "SELECT name FROM content_references WHERE session_id = ?",
      ).get(fork)).toMatchObject({ name: row.name })
      expect(readFileSync(join(h.sessionDir(fork), "references", row.name), "utf8")).toBe(text)
      const forkRun = h.hub.store.turns(fork).at(-1)!.runId
      h.model.next(say("fork rewound"))
      await h.hub.rewind(fork, forkRun, undefined, h.sender)
      await h.turnsEnded(fork, 1)
      expect(h.db.query("SELECT 1 FROM content_references WHERE session_id = ?").get(fork)).toBeNull()
      expect(existsSync(join(h.sessionDir(fork), "references", row.name))).toBe(false)
    } finally {
      await h.cleanup()
    }
  }, 30_000)

  test("retention failure preserves the true effect and continues with explicit loss", async () => {
    const tool = builtinTool({
      name: "oversized",
      permission: null,
      description: "Return oversized captured output.",
      args: Schema.Record(Schema.String, Schema.Never),
      run: async () => ({ outcome: "success", content: "bounded", capturedText: "x".repeat(100) }),
    })
    const failing = {
      attach: () => { throw new Error("injected retention failure") },
      cleanup: () => {},
      copyFiles: () => {},
    }
    const h = new AgentHarness({
      tools: [tool],
      contentPolicy: { collectionBytes: 1_024, previewLines: 2, previewBytes: 32 },
      contentReferences: failing as never,
    })
    try {
      const session = h.create()
      h.model.next(callTools([{ name: "oversized", args: {} }]), say("continued"))
      h.input(session, "retain")
      await h.turnsEnded(session, 1)
      const result = h.events(session).find(({ event }) => event.type === "TOOL_CALL_RESULT")!.event as {
        content: unknown
        outcome: string
      }
      expect(result).toMatchObject({ outcome: "success" })
      expect(String(result.content)).toContain("was not retained")
      expect(JSON.stringify(h.model.last().messages)).toContain("was not retained")
      expect(JSON.stringify(h.model.last().messages)).not.toContain("is retained at references/")
      const canonical = h.hub.store.conversation.items(session, 1).find((item) => item.kind === "result")
      expect(JSON.stringify(canonical)).toContain("was not retained")
      expect(JSON.stringify(canonical)).not.toContain("is retained at references/")
      expect(h.db.query("SELECT count(*) AS n FROM content_references").get()).toEqual({ n: 0 })
    } finally {
      await h.cleanup()
    }
  })

  test("a canonical result-store failure after an effect starts no later effect", async () => {
    const marker = (name: string) => join(h.dir, name)
    let h!: AgentHarness
    const effect = (name: string) => builtinTool({
      name,
      permission: null,
      description: "Record one effect.",
      args: Schema.Record(Schema.String, Schema.Never),
      run: async () => {
        writeFileSync(marker(name), name)
        return { outcome: "success", content: name }
      },
    })
    h = new AgentHarness({ tools: [effect("first_effect"), effect("second_effect")] })
    try {
      const session = h.create()
      h.db.run(`CREATE TRIGGER fail_result BEFORE INSERT ON events
        WHEN json_extract(NEW.body, '$.type') = 'TOOL_CALL_RESULT'
        BEGIN SELECT RAISE(ABORT, 'injected canonical failure'); END`)
      h.model.next(callTools([
        { name: "first_effect", args: {} },
        { name: "second_effect", args: {} },
      ]))
      h.input(session, "run effects")
      await h.turnsEnded(session, 1)
      expect(existsSync(marker("first_effect"))).toBe(true)
      expect(existsSync(marker("second_effect"))).toBe(false)
      expect(h.hub.store.turns(session)[0]!.status).toBe("failed")
    } finally {
      await h.cleanup()
    }
  })

describe("real PDF conversion and retained content", () => {
  test("an image model receives ordered raster pages and text from a PDF attachment", async () => {
    const h = new AgentHarness({
      models: [configuredModel("test/vision", { imageInput: true })],
      conversion: converter(),
      contentMediaOptions: { ...geometry, pagesPerWindow: 8, previewBytes: 50 * 1024 },
    })
    try {
      const session = h.create()
      const ref = upload(h, "orchard.pdf", fixture("orchard.pdf"))
      h.model.next(say("read it"))
      h.hub.input(session, "inspect", "steer", h.sender, { attachments: [ref] })
      await h.turnsEnded(session, 1, 60_000)
      expect(h.events(session).some(({ event }) => event.type === "RUN_ERROR")).toBe(false)
      const rows = h.db.query<{ transformation: string; metadata: string }, [string]>(
        "SELECT transformation, metadata FROM attachment_representations WHERE attachment_id = ? ORDER BY transformation, metadata",
      ).all(ref.attachmentId)
      expect(rows.map((row) => row.transformation)).toEqual(["pdf-page-image", "pdf-page-image", "pdf-text"])
      const pages = rows.filter((row) => row.transformation === "pdf-page-image").map((row) => JSON.parse(row.metadata))
      expect(pages.map((page) => page.page)).toEqual([1, 2])
      expect(pages.every((page) => page.width <= geometry.maxLongEdge && page.height <= geometry.maxLongEdge)).toBe(true)
      expect(pages.every((page) => page.width * page.height <= geometry.maxPixelsPerPage)).toBe(true)
      const parts = h.model.last().messages.flatMap((message) => typeof message.content === "string" ? [] : message.content)
      expect(parts.filter((part) => typeof part === "object" && part.type === "input_image")).toHaveLength(2)
      expect(JSON.stringify(responsesInput(h.model.last()))).toContain('"type":"input_image"')
      expect(JSON.stringify(h.model.last().messages)).toContain("Pages 1-2 of 2")
    } finally {
      await h.cleanup()
    }
  }, 60_000)

  test("file_read pages a retained PDF and reports out-of-range windows without fabricated pages", async () => {
    const pdf = converter()
    const read = fileReadTool({ conversion: pdf, pdfGeometry: geometry, pdfPagesPerWindow: 8 })
    const h = new AgentHarness({
      models: [configuredModel("test/vision", { imageInput: true })],
      tools: [read],
    })
    try {
      const session = h.create()
      h.model.next(
        callTools([{ name: "file_read", args: { path: join(import.meta.dir, "fixtures/documents/orchard.pdf"), pageOffset: 2, pageLimit: 1 } }]),
        callTools([{ name: "file_read", args: { path: join(import.meta.dir, "fixtures/documents/orchard.pdf"), pageOffset: 99, pageLimit: 1 } }]),
        say("done"),
      )
      h.input(session, "read pages")
      await h.turnsEnded(session, 1, 60_000)
      const results = resultEvents(h, session)
      expect(results.map((result) => result.outcome)).toEqual(["success", "failed"])
      expect(String(results[0]!.content)).toContain("PDF pages 2-2 of 2")
      expect(String(results[1]!.content)).toContain("past the PDF's 2 pages")
      const turn = h.hub.store.conversation.turnItems(session, h.hub.store.turns(session)[0]!.runId)
      const result = turn.find((item) => item.kind === "result")
      expect(result?.kind).toBe("result")
      if (result?.kind === "result") expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image" })]))
    } finally {
      await h.cleanup()
    }
  }, 60_000)

  test("file_read sends a native PDF without conversion, while a mislabeled PDF still uses the worker", async () => {
    const real = converter()
    let conversions = 0
    const counting = {
      convert: (job: PdfConversionJob) => {
        conversions += 1
        return real.convert(job)
      },
    }
    const path = join(import.meta.dir, "fixtures/documents/orchard.pdf")
    const native = new AgentHarness({
      models: [configuredModel("test/native", { pdfInput: true })],
      tools: [fileReadTool({ conversion: counting, pdfGeometry: geometry, pdfPagesPerWindow: 8 })],
    })
    try {
      const session = native.create()
      native.model.next(
        callTools([{ name: "file_read", args: { path } }]),
        callTools([{ name: "file_read", args: { path, pageOffset: 2, pageLimit: 1 } }]),
        say("done"),
      )
      native.input(session, "read native")
      await native.turnsEnded(session, 1, 60_000)
      const results = resultEvents(native, session)
      expect(results.map((result) => result.outcome)).toEqual(["success", "success"])
      expect(conversions).toBe(1)
      expect(JSON.stringify(native.model.calls[1]!.call.messages)).toContain('"type":"input_file"')
      const providerOutput = responsesInput(native.model.calls[1]!.call)
        .filter((item) => item.type === "function_call_output")
        .at(-1)!
      expect(providerOutput.output).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "input_file" }),
      ]))

      const textOnly = new AgentHarness({
        models: [configuredModel("test/text")],
        conversion: counting,
      })
      try {
        const session = textOnly.create()
        const mislabeled = upload(textOnly, "orchard.pdf", fixture("orchard.pdf"), "text/plain")
        textOnly.model.next(say("converted"))
        textOnly.hub.input(session, "inspect", "steer", textOnly.sender, { attachments: [mislabeled] })
        await textOnly.turnsEnded(session, 1, 60_000)
        expect(conversions).toBe(2)
      } finally {
        await textOnly.cleanup()
      }
    } finally {
      await native.cleanup()
    }
  }, 60_000)

  test("a historical native PDF tool result is lowered for a later image-capable model", async () => {
    const real = converter()
    let conversions = 0
    const counting = {
      convert: (job: PdfConversionJob) => {
        conversions += 1
        return real.convert(job)
      },
    }
    const h = new AgentHarness({
      models: [configuredModel("test/native", { pdfInput: true }), configuredModel("test/vision", { imageInput: true })],
      conversion: counting,
      tools: [fileReadTool({ conversion: counting, pdfGeometry: geometry, pdfPagesPerWindow: 8 })],
      contentMediaOptions: { ...geometry, pagesPerWindow: 1, previewBytes: 50 * 1024 },
    })
    try {
      const session = h.create({ model: "test/native" })
      h.model.next(
        callTools([{ name: "file_read", args: { path: join(import.meta.dir, "fixtures/documents/orchard.pdf") } }]),
        say("native"),
      )
      h.input(session, "read")
      await h.turnsEnded(session, 1, 60_000)
      expect(conversions).toBe(0)
      h.model.next(say("switched"))
      h.hub.input(session, "switch", "steer", h.sender, { selection: { modelSettings: { modelId: "test/vision" } } })
      await h.turnsEnded(session, 2, 60_000)
      expect(conversions).toBeGreaterThan(0)
      const messages = JSON.stringify(h.model.last().messages)
      expect(messages).toContain('"type":"input_image"')
      expect(JSON.stringify(responsesInput(h.model.last()))).toContain('"type":"input_image"')
      expect(messages).toContain("pageOffset=2")
      expect(messages).toContain('"windowOffset":1')
      expect(messages).toContain('"windowLimit":1')
      expect(messages).toContain('"transformation":"pdf-page-image"')
      expect(messages).toContain('"transformation":"pdf-page-text"')
    } finally {
      await h.cleanup()
    }
  }, 60_000)

  test("a historical image tool result reaches a later image-capable model", async () => {
    const h = new AgentHarness({
      models: [configuredModel("test/vision-one", { imageInput: true }), configuredModel("test/vision-two", { imageInput: true })],
      tools: [fileReadTool()],
    })
    try {
      const session = h.create({ model: "test/vision-one" })
      h.model.next(
        callTools([{ name: "file_read", args: { path: join(import.meta.dir, "fixtures/documents/red.png") } }]),
        say("image"),
      )
      h.input(session, "read")
      await h.turnsEnded(session, 1, 60_000)
      h.model.next(say("switched"))
      h.hub.input(session, "switch", "steer", h.sender, { selection: { modelSettings: { modelId: "test/vision-two" } } })
      await h.turnsEnded(session, 2, 60_000)
      const messages = JSON.stringify(h.model.last().messages)
      expect(messages).toContain('"type":"input_image"')
      expect(messages).toContain('"representationId"')
      expect(JSON.stringify(responsesInput(h.model.last()))).toContain('"type":"input_image"')
    } finally {
      await h.cleanup()
    }
  }, 60_000)

  test("a historical PDF tool result without extractable content becomes an explicit placeholder", async () => {
    let conversions = 0
    const h = new AgentHarness({
      models: [configuredModel("test/native", { pdfInput: true }), configuredModel("test/text")],
      conversion: {
        convert: async () => {
          conversions += 1
          return { total: 2, text: "", pages: [] }
        },
      },
      tools: [fileReadTool({ pdfGeometry: geometry, pdfPagesPerWindow: 8 })],
    })
    try {
      const session = h.create({ model: "test/native" })
      h.model.next(
        callTools([{ name: "file_read", args: { path: join(import.meta.dir, "fixtures/documents/orchard.pdf") } }]),
        say("native"),
      )
      h.input(session, "read")
      await h.turnsEnded(session, 1, 60_000)
      expect(conversions).toBe(0)
      h.model.next(say("switched"))
      h.hub.input(session, "switch", "steer", h.sender, { selection: { modelSettings: { modelId: "test/text" } } })
      await h.turnsEnded(session, 2, 60_000)
      expect(conversions).toBe(1)
      const messages = JSON.stringify(h.model.last().messages)
      expect(messages).toContain("PDF orchard.pdf has no extractable text or rendered pages for this model.")
      expect(messages).not.toContain('"type":"input_image"')
    } finally {
      await h.cleanup()
    }
  }, 60_000)

  test("an uploaded PDF continuation retrieves later pages after restart", async () => {
    const h = new AgentHarness({
      models: [configuredModel("test/vision", { imageInput: true })],
      conversion: converter(),
      tools: [fileReadTool({ conversion: converter(), pdfGeometry: geometry, pdfPagesPerWindow: 8 })],
      contentMediaOptions: { ...geometry, pagesPerWindow: 1, previewBytes: 50 * 1024 },
    })
    try {
      const session = h.create()
      const ref = upload(h, "orchard.pdf", fixture("orchard.pdf"))
      h.model.next(say("first page"))
      h.hub.input(session, "inspect", "steer", h.sender, { attachments: [ref] })
      await h.turnsEnded(session, 1, 60_000)
      const first = JSON.stringify(h.model.last().messages)
      expect(first).toContain(`file_read attachmentId=\\"${ref.attachmentId}\\" pageOffset=2`)
      await h.restart()
      h.model.next(
        callTools([{ name: "file_read", args: { attachmentId: ref.attachmentId, pageOffset: 2, pageLimit: 1 } }]),
        say("continued"),
      )
      h.input(session, "continue pages")
      await h.turnsEnded(session, 2, 60_000)
      const result = resultEvents(h, session).at(-1)
      expect(result).toMatchObject({ outcome: "success", content: expect.stringContaining("PDF pages 2-2 of 2") })
      const items = h.hub.store.conversation.items(session, 1)
      expect(items.some((item) => item.kind === "result" && typeof item.content !== "string" && item.content.some((part) => part.type === "image"))).toBe(true)
    } finally {
      await h.cleanup()
    }
  }, 60_000)

  test("text and document attachments use the configured preview and expose their full retained original", async () => {
    const h = new AgentHarness({
      models: [configuredModel("test/text")],
      tools: [fileReadTool()],
      contentMediaOptions: { ...geometry, pagesPerWindow: 8, previewLines: 1, previewBytes: 8 },
    })
    try {
      const inputs = [
        { name: "notes.txt", mediaType: "text/plain", bytes: Buffer.from(`HEAD\n${"x".repeat(20_000)}\nTAIL-UNIQUE`) },
        { name: "prices.csv", mediaType: "text/csv", bytes: Buffer.concat([fixture("prices.csv"), Buffer.from(`\n${"y".repeat(20_000)}\nTAIL-CSV`)] ) },
        { name: "report.docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: fixture("report.docx") },
      ]
      for (const input of inputs) {
        const session = h.create()
        const ref = upload(h, input.name, new Uint8Array(input.bytes), input.mediaType)
        h.model.next(say("preview"))
        h.hub.input(session, "inspect", "steer", h.sender, { attachments: [ref] })
        await h.turnsEnded(session, 1, 60_000)
        const messages = JSON.stringify(h.model.last().messages)
        expect(messages).toContain("Text window:")
        expect(messages).toContain(`file_read attachmentId=\\"${ref.attachmentId}\\"`)
        if (input.name === "notes.txt") {
          expect(messages).not.toContain("TAIL-UNIQUE")
          h.model.next(callTools([{ name: "file_read", args: { attachmentId: ref.attachmentId } }]), say("full"))
          h.input(session, "retrieve full")
          await h.turnsEnded(session, 2, 60_000)
          expect(String(resultEvents(h, session).at(-1)?.content)).toContain("TAIL-UNIQUE")
        }
      }
    } finally {
      await h.cleanup()
    }
  }, 60_000)

  test("a text-only model receives extractable PDF text and rejects scanned OCR input", async () => {
    const h = new AgentHarness({
      models: [configuredModel("test/text")],
      conversion: converter(),
      contentMediaOptions: { ...geometry, pagesPerWindow: 8, previewBytes: 50 * 1024 },
    })
    try {
      const text = h.create()
      const orchard = upload(h, "orchard.pdf", fixture("orchard.pdf"))
      h.model.next(say("read text"))
      h.hub.input(text, "inspect", "steer", h.sender, { attachments: [orchard] })
      await h.turnsEnded(text, 1, 60_000)
      expect(JSON.stringify(h.model.last().messages)).toContain("Orchard report")

      const scanned = h.create()
      const scan = upload(h, "scan.pdf", fixture("scan.pdf"))
      h.model.next(say("must not run"))
      h.hub.input(scanned, "inspect", "steer", h.sender, { attachments: [scan] })
      await h.turnsEnded(scanned, 1, 60_000)
      const error = h.events(scanned).find(({ event }) => event.type === "RUN_ERROR")!.event as { message: string }
      expect(error.message).toContain("OCR is not enabled")
      expect(h.hub.attachments.attachment(scan.attachmentId)).not.toBeNull()
    } finally {
      await h.cleanup()
    }
  }, 60_000)

  test("malformed PDF input fails explicitly while its retained original remains available", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ashe-agent-pdf-bad-"))
    const path = join(dir, "bad.pdf")
    writeFileSync(path, "%PDF-1.7\nnot a document")
    const h = new AgentHarness({ conversion: converter() })
    try {
      const session = h.create()
      const ref = upload(h, "bad.pdf", readFileSync(path))
      h.hub.input(session, "inspect", "steer", h.sender, { attachments: [ref] })
      await h.turnsEnded(session, 1, 60_000)
      expect(h.events(session).some(({ event }) => event.type === "RUN_ERROR")).toBe(true)
      expect(h.hub.attachments.attachment(ref.attachmentId)).not.toBeNull()
      h.model.next(say("server still serves"))
      h.input(session, "continue without the attachment")
      await h.turnsEnded(session, 2, 60_000)
      expect(h.events(session).filter(({ event }) => event.type === "RUN_FINISHED")).toHaveLength(1)
    } finally {
      await h.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

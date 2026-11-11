import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Schema } from "effect"
import { builtinTool } from "../src/agent/tools.ts"
import { BoundedPdfConverter } from "../src/content/conversion.ts"
import type { ContentPolicy } from "../src/content/retention.ts"
import { AgentHarness, callTools, configuredModel, say } from "./support/agent.ts"
import { exportedText, memoryTelemetry, offCatalog, type MemoryTelemetry } from "./support/telemetry.ts"

const policy: ContentPolicy = { collectionBytes: 1_024, previewLines: 1, previewBytes: 16 }
let telemetry: MemoryTelemetry
beforeEach(() => { telemetry = memoryTelemetry() })
afterEach(async () => { await telemetry.stop() })

const upload = (h: AgentHarness, name: string, bytes: Uint8Array) => {
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  const made = h.hub.attachments.create("login:component", name, name, "application/pdf", bytes.byteLength, Date.now())
  h.hub.attachments.append("login:component", made.uploadId, 0, Buffer.from(bytes).toString("base64"), Date.now())
  h.hub.attachments.finalize("login:component", made.uploadId, bytes.byteLength, digest, Date.now())
  const attachmentId = h.hub.store.db.query<{ attachment_id: string }, [string]>(
    "SELECT attachment_id FROM uploads WHERE owner_id = 'login:component' AND upload_id = ?",
  ).get(made.uploadId)!.attachment_id
  return { attachmentId, contentId: digest, representationId: digest, name, mediaType: "application/pdf", digest }
}

describe("content telemetry", () => {
  test("retention failure and communication remain bounded catalog signals", async () => {
    const secret = "private captured payload that must not be exported"
    const tool = builtinTool({
      name: "oversized",
      permission: null,
      description: "Return content.",
      args: Schema.Record(Schema.String, Schema.Never),
      run: async () => ({ outcome: "success", content: "bounded", capturedText: secret.repeat(4) }),
    })
    const h = new AgentHarness({ tools: [tool], contentPolicy: policy })
    try {
      h.db.run("DROP TABLE content_references")
      const session = h.create()
      h.model.next(
        callTools([{ name: "oversized", args: {} }]),
        callTools([{ name: "session_list", args: {} }]),
        say("continued"),
      )
      h.input(session, "exercise telemetry")
      await h.turnsEnded(session, 1)
      const names = telemetry.spans().map((span) => span.name)
      expect(names).toContain("ashe_agent.content_retention")
      expect(names).toContain("ashe_agent.communication")
      expect(telemetry.spans().find((span) => span.name === "ashe_agent.content_retention")?.attributes)
        .toMatchObject({ "ashe_agent.content.outcome": "failed" })
      expect(telemetry.spans().find((span) => span.name === "ashe_agent.communication")?.attributes)
        .toMatchObject({ "ashe_agent.communication.action": "list" })
      expect(telemetry.logs().some((record) => record.eventName === "ashe_agent.content.retention_failed")).toBe(true)
      expect(await offCatalog(telemetry)).toEqual([])
      expect(await exportedText(telemetry)).not.toContain(secret)
    } finally {
      await h.cleanup()
    }
  }, 30_000)

  test("conversion and projection failures do not export PDF content or paths", async () => {
    const limits = {
      prlimitPath: "/definitely/missing/prlimit",
      dataBytes: 512 * 1024 ** 2,
      stackBytes: 8 * 1024 ** 2,
      cpuSeconds: 20,
      wallMs: 1_000,
      outputBytes: 1024,
      activeWorkers: 1,
      queuedJobs: 1,
      inputBytes: 32 * 1024 ** 2,
    }
    const h = new AgentHarness({
      models: [configuredModel("test/vision", { imageInput: true })],
      conversion: new BoundedPdfConverter(limits, { executable: "/missing/worker", args: [] }),
    })
    try {
      const session = h.create()
      const ref = upload(h, "private-report.pdf", readFileSync("packages/harness/test/fixtures/documents/orchard.pdf"))
      h.model.next(say("must not run"))
      h.hub.input(session, "inspect attachment", "steer", h.sender, { attachments: [ref] })
      await h.turnsEnded(session, 1)
      expect(telemetry.spans()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "ashe_agent.conversion",
          attributes: expect.objectContaining({ "ashe_agent.conversion.outcome": "unsupported" }),
        }),
        expect.objectContaining({ name: "ashe_agent.media_projection" }),
      ]))
      expect(await offCatalog(telemetry)).toEqual([])
      const exported = await exportedText(telemetry)
      expect(exported).not.toContain("private-report.pdf")
      expect(exported).not.toContain("Orchard report")
    } finally {
      await h.cleanup()
    }
  }, 30_000)
})

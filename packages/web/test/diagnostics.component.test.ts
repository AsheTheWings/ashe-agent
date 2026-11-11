import { expect, test } from "bun:test"
import { SeverityNumber } from "@opentelemetry/api-logs"
import { memoryTelemetry, offCatalog } from "../../harness/test/support/telemetry.ts"
import { diagnosticNames, exportDiagnostics, parseDiagnostics } from "../src/backend/diagnostics.ts"

test("web diagnostics expose catalog bodies and severities to the real log SDK", async () => {
  const telemetry = memoryTelemetry()
  try {
    exportDiagnostics(parseDiagnostics({
      records: diagnosticNames.map((name) => ({ name, attributes: {} })),
    }))
    const records = telemetry.logs()
    expect(records).toHaveLength(diagnosticNames.length)
    for (const record of records) {
      expect(record.body).toBe(record.eventName)
      const warning = record.eventName === "web.draft" || record.eventName === "web.render_failure"
      expect(record.severityText).toBe(warning ? "WARN" : "INFO")
      expect(record.severityNumber).toBe(warning ? SeverityNumber.WARN : SeverityNumber.INFO)
      expect(record.attributes).toEqual({})
    }
    expect(await offCatalog(telemetry)).toEqual([])
  } finally {
    await telemetry.stop()
  }
})

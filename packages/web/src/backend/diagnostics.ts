import { logs, SeverityNumber } from "@opentelemetry/api-logs"
import { LOGS } from "../../../harness/src/telemetry/signals.ts"
import type { DiagnosticRecord } from "../shared/web-state.ts"

export const diagnosticNames = ["web.sync", "web.interaction", "web.render_failure", "web.draft", "web.auth"] as const
export type DiagnosticName = (typeof diagnosticNames)[number]

const attributeAllowlist = new Set([
  "web.operation",
  "web.outcome",
  "web.view",
  "web.error_type",
  "web.revision_gap",
  "web.queue_depth",
  "web.protocol_version",
])

export const diagnosticAttributes: Readonly<Record<DiagnosticName, ReadonlyArray<string>>> = {
  "web.sync": ["web.operation", "web.outcome", "web.revision_gap", "web.protocol_version"],
  "web.interaction": ["web.operation", "web.outcome", "web.view"],
  "web.render_failure": ["web.error_type", "web.view"],
  "web.draft": ["web.operation", "web.outcome"],
  "web.auth": ["web.operation", "web.outcome"],
}

export class DiagnosticError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DiagnosticError"
  }
}

const value = (item: unknown): item is string | number | boolean | ReadonlyArray<string> =>
  typeof item === "string" || typeof item === "number" || typeof item === "boolean" ||
  (Array.isArray(item) && item.every((entry) => typeof entry === "string"))

/** Validates an allowlisted, bounded browser diagnostic batch. */
export const parseDiagnostics = (body: unknown): ReadonlyArray<DiagnosticRecord> => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new DiagnosticError("the body must be an object")
  const records = (body as { records?: unknown }).records
  if (!Array.isArray(records)) throw new DiagnosticError("records must be an array")
  if (records.length === 0 || records.length > 100) throw new DiagnosticError("records must contain 1 to 100 entries")
  return records.map((record) => {
    if (record === null || typeof record !== "object" || Array.isArray(record)) throw new DiagnosticError("a record must be an object")
    const known = record as { name?: unknown; attributes?: unknown; timeUnixNano?: unknown; body?: unknown }
    if (typeof known.name !== "string" || !diagnosticNames.includes(known.name as DiagnosticName)) {
      throw new DiagnosticError("the signal name is not in the web catalog")
    }
    if (known.body !== undefined) throw new DiagnosticError("diagnostic bodies are not accepted")
    if (known.timeUnixNano !== undefined && typeof known.timeUnixNano !== "string") throw new DiagnosticError("timeUnixNano must be a string")
    if (known.attributes === null || typeof known.attributes !== "object" || Array.isArray(known.attributes)) {
      throw new DiagnosticError("attributes must be an object")
    }
    const name = known.name as DiagnosticName
    const result: Record<string, string | number | boolean | ReadonlyArray<string>> = {}
    for (const [key, item] of Object.entries(known.attributes)) {
      if (!attributeAllowlist.has(key) || !diagnosticAttributes[name].includes(key)) throw new DiagnosticError("an attribute is not allowed")
      if (!value(item)) throw new DiagnosticError("an attribute has an unsupported shape")
      result[key] = item
    }
    return { name, attributes: result, ...(known.timeUnixNano === undefined ? {} : { timeUnixNano: known.timeUnixNano }) }
  })
}

/** Emits only records that passed the catalog allowlist through the backend's OTel logger. */
export const exportDiagnostics = (records: ReadonlyArray<DiagnosticRecord>) => {
  const logger = logs.getLogger("ashe-agent-web")
  for (const record of records) {
    const severity = LOGS[record.name as DiagnosticName].severity
    const attributes: Record<string, string | number | boolean | string[]> = {}
    for (const [key, value] of Object.entries(record.attributes)) attributes[key] = typeof value === "object" ? [...value] : value
    logger.emit({
      eventName: record.name,
      body: record.name,
      severityText: severity,
      severityNumber: SeverityNumber[severity],
      attributes,
      ...(record.timeUnixNano === undefined ? {} : { timestamp: Number(record.timeUnixNano) / 1_000_000 }),
    })
  }
}

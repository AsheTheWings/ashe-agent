import { context, metrics, propagation, trace } from "@opentelemetry/api"
import { logs } from "@opentelemetry/api-logs"
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { MeterProvider, MetricReader, type ResourceMetrics } from "@opentelemetry/sdk-metrics"
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { ATTRIBUTES, LOGS, METRICS, SPANS } from "../../src/telemetry/signals.ts"
import { resetInstruments } from "../../src/telemetry/signals.ts"

/** A metric reader that collects only when asked. */
class ManualReader extends MetricReader {
  protected async onForceFlush() {}
  protected async onShutdown() {}
}

/**
 * Global tracer, meter, and logger providers over in-memory exporters, for
 * one test file. `stop` restores the API's empty globals.
 */
export const memoryTelemetry = () => {
  const spans = new InMemorySpanExporter()
  const tracerProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] })
  tracerProvider.register()
  const reader = new ManualReader()
  const meterProvider = new MeterProvider({ readers: [reader] })
  metrics.setGlobalMeterProvider(meterProvider)
  resetInstruments()
  const records = new InMemoryLogRecordExporter()
  const loggerProvider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: records })] })
  logs.setGlobalLoggerProvider(loggerProvider)
  return {
    spans: () => spans.getFinishedSpans(),
    logs: () => records.getFinishedLogRecords(),
    metrics: async (): Promise<ResourceMetrics> => {
      const { resourceMetrics, errors } = await reader.collect()
      if (errors.length > 0) throw errors[0]
      return resourceMetrics
    },
    stop: async () => {
      await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown(), loggerProvider.shutdown()])
      trace.disable()
      context.disable()
      propagation.disable()
      metrics.disable()
      logs.disable()
      resetInstruments()
    },
  }
}

export type MemoryTelemetry = ReturnType<typeof memoryTelemetry>

/**
 * The signals the catalog does not declare: span, metric, and log names
 * outside it, attributes a signal may not carry, metric units that differ,
 * and `error.type` values outside its classes. Empty when every emitted
 * signal matches the catalog.
 */
export const offCatalog = async (telemetry: MemoryTelemetry): Promise<ReadonlyArray<string>> => {
  const problems: Array<string> = []
  const checkAttributes = (signal: string, allowed: ReadonlyArray<string>, attributes: Record<string, unknown>) => {
    for (const [name, value] of Object.entries(attributes)) {
      if (!allowed.includes(name)) problems.push(`${signal} carries ${name}`)
      const declared = (ATTRIBUTES as Record<string, { values?: ReadonlyArray<string> }>)[name]
      if (declared?.values !== undefined && !declared.values.includes(String(value))) problems.push(`${signal} ${name}=${String(value)}`)
    }
  }
  for (const span of telemetry.spans()) {
    const declared = (SPANS as Record<string, { attributes: ReadonlyArray<string> }>)[span.name]
    if (declared === undefined) problems.push(`span ${span.name}`)
    else checkAttributes(`span ${span.name}`, declared.attributes, span.attributes)
  }
  for (const scope of (await telemetry.metrics()).scopeMetrics) {
    for (const metric of scope.metrics) {
      const declared = (METRICS as Record<string, { unit: string; attributes: ReadonlyArray<string> }>)[metric.descriptor.name]
      if (declared === undefined) {
        problems.push(`metric ${metric.descriptor.name}`)
        continue
      }
      if (metric.descriptor.unit !== declared.unit) problems.push(`metric ${metric.descriptor.name} unit ${metric.descriptor.unit}`)
      for (const point of metric.dataPoints) checkAttributes(`metric ${metric.descriptor.name}`, declared.attributes, point.attributes)
    }
  }
  for (const record of telemetry.logs()) {
    const name = record.eventName ?? ""
    const declared = (LOGS as Record<string, { attributes: ReadonlyArray<string> }>)[name]
    if (declared === undefined) problems.push(`log ${name}`)
    else checkAttributes(`log ${name}`, declared.attributes, record.attributes)
  }
  return problems
}

/** Everything the exporters received, as one string, to search for content that must not appear. */
export const exportedText = async (telemetry: MemoryTelemetry) =>
  JSON.stringify({
    spans: telemetry.spans().map((span) => ({
      name: span.name,
      attributes: span.attributes,
      status: span.status,
      events: span.events,
      links: span.links,
      resource: span.resource.attributes,
    })),
    metrics: await telemetry.metrics(),
    logs: telemetry.logs().map((record) => ({ name: record.eventName, body: record.body, attributes: record.attributes, severity: record.severityText })),
  })

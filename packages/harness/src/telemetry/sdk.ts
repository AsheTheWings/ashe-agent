import { randomUUID } from "node:crypto"
import { OtelMetrics, OtelTracer, Resource } from "@effect/opentelemetry"
import { logs } from "@opentelemetry/api-logs"
import { metrics } from "@opentelemetry/api"
import { OTLPLogExporter as HttpLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { OTLPLogExporter as ProtoLogExporter } from "@opentelemetry/exporter-logs-otlp-proto"
import { OTLPMetricExporter as HttpMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPMetricExporter as ProtoMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto"
import { OTLPTraceExporter as HttpTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { OTLPTraceExporter as ProtoTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BatchLogRecordProcessor, ConsoleLogRecordExporter, LoggerProvider, type LogRecordExporter } from "@opentelemetry/sdk-logs"
import { ConsoleMetricExporter, MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics"
import { BatchSpanProcessor, ConsoleSpanExporter, type SpanExporter } from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { Layer, Redacted } from "effect"
import type { ExporterSelection, OtlpProtocol } from "../inputs/shapes.ts"

type Selection = typeof ExporterSelection.Type
import { resetInstruments } from "./signals.ts"

export interface TelemetryOptions {
  readonly traces: Selection
  readonly metrics: Selection
  readonly logs: Selection
  /** The OTLP endpoint, without the `/v1/<signal>` path. */
  readonly endpoint: string
  readonly protocol: typeof OtlpProtocol.Type
  /** The export headers from the protected headers file, parsed by `parseOtlpHeaders`; empty without one. */
  readonly headers: Redacted.Redacted<Record<string, string>>
  readonly serviceVersion: string
  readonly deploymentEnvironment: string
}

/** How long one export, and the final flush at shutdown, may take. */
const EXPORT_TIMEOUT_MS = 10_000
const METRIC_INTERVAL_MS = 60_000

/** The resource attributes every signal carries. */
export const resourceAttributes = (options: Pick<TelemetryOptions, "serviceVersion" | "deploymentEnvironment">) => ({
  "service.namespace": "ashe-agent",
  "service.name": "ashe-agent-server",
  "service.version": options.serviceVersion,
  "service.instance.id": randomUUID(),
  "deployment.environment.name": options.deploymentEnvironment,
})

/**
 * Starts the OpenTelemetry SDK: registers the global tracer, meter, and
 * logger providers with the selected exporters, and returns the layer that
 * routes Effect spans and metrics to them, and the shutdown that flushes
 * them.
 */
export const startTelemetry = (options: TelemetryOptions) => {
  const headers = Redacted.value(options.headers)
  const attributes = resourceAttributes(options)
  const resource = resourceFromAttributes(attributes)
  const json = options.protocol === "http/json"
  const otlp = (signal: string) => ({ url: `${options.endpoint.replace(/\/+$/, "")}/v1/${signal}`, headers, timeoutMillis: EXPORT_TIMEOUT_MS })

  const spanExporter = (): SpanExporter | null =>
    options.traces === "none" ? null : options.traces === "console" ? new ConsoleSpanExporter() : json ? new HttpTraceExporter(otlp("traces")) : new ProtoTraceExporter(otlp("traces"))
  const metricExporter = (): PushMetricExporter | null =>
    options.metrics === "none" ? null : options.metrics === "console" ? new ConsoleMetricExporter() : json ? new HttpMetricExporter(otlp("metrics")) : new ProtoMetricExporter(otlp("metrics"))
  const logExporter = (): LogRecordExporter | null =>
    options.logs === "none" ? null : options.logs === "console" ? new ConsoleLogRecordExporter() : json ? new HttpLogExporter(otlp("logs")) : new ProtoLogExporter(otlp("logs"))
  const reader = () => {
    const exporter = metricExporter()
    return exporter === null ? null : new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: METRIC_INTERVAL_MS, exportTimeoutMillis: EXPORT_TIMEOUT_MS })
  }

  const spans = spanExporter()
  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: spans === null ? [] : [new BatchSpanProcessor(spans, { exportTimeoutMillis: EXPORT_TIMEOUT_MS })],
  })
  tracerProvider.register()
  const apiReader = reader()
  const meterProvider = new MeterProvider({ resource, readers: apiReader === null ? [] : [apiReader] })
  metrics.setGlobalMeterProvider(meterProvider)
  resetInstruments()
  const records = logExporter()
  const loggerProvider = new LoggerProvider({
    resource,
    processors: records === null ? [] : [new BatchLogRecordProcessor({ exporter: records, exportTimeoutMillis: EXPORT_TIMEOUT_MS })],
  })
  logs.setGlobalLoggerProvider(loggerProvider)

  // Effect's metrics need a reader of their own, since a reader binds to one producer.
  const effectReader = reader()
  const effectLayer = Layer.mergeAll(
    OtelTracer.layerGlobal,
    effectReader === null ? Layer.empty : OtelMetrics.layer(() => effectReader),
  ).pipe(Layer.provide(Resource.layer({ serviceName: attributes["service.name"], serviceVersion: attributes["service.version"], attributes })))

  const shutdown = async () => {
    const flushed = Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown(), loggerProvider.shutdown()])
    await Promise.race([flushed, new Promise((resolve) => setTimeout(resolve, EXPORT_TIMEOUT_MS).unref())])
  }
  return { effectLayer, shutdown }
}

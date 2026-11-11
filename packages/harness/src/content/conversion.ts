import { readFile } from "node:fs/promises"
import { inspect } from "node:util"
import { endSpan, recordDuration, startSpan, type ErrorClass } from "../telemetry/signals.ts"

export interface PdfGeometry {
  readonly dpi: number
  readonly maxLongEdge: number
  readonly maxPixelsPerPage: number
}

export interface PdfPageWindow {
  readonly offset: number
  readonly limit: number
}

export interface ConvertedPdfPage {
  readonly page: number
  readonly total: number
  readonly png: Uint8Array
  readonly width: number
  readonly height: number
}

export interface ConvertedPdf {
  readonly total: number
  readonly text: string
  readonly pages: ReadonlyArray<ConvertedPdfPage>
}

export interface PdfConversionJob {
  /** Loads retained original bytes only when the job reaches an active slot. */
  readonly load: () => Promise<Uint8Array>
  readonly window: PdfPageWindow
  readonly geometry: PdfGeometry
  readonly signal: AbortSignal
}

export interface ConversionPort {
  convert(job: PdfConversionJob): Promise<ConvertedPdf>
}

export type ConversionFailureKind = "invalid" | "queue" | "timeout" | "output" | "unsupported" | "failed" | "canceled"

export class ConversionError extends Error {
  constructor(readonly kind: ConversionFailureKind, message: string) {
    super(message)
  }
}

export interface WorkerLimits {
  readonly prlimitPath: string
  readonly dataBytes: number
  readonly stackBytes: number
  readonly cpuSeconds: number
  readonly wallMs: number
  readonly outputBytes: number
  readonly activeWorkers: number
  readonly queuedJobs: number
  readonly inputBytes: number
}

export interface WorkerCommand {
  readonly executable: string
  readonly args: ReadonlyArray<string>
}

interface WorkerPage {
  readonly page: number
  readonly total: number
  readonly png: string
  readonly width: number
  readonly height: number
}

interface WorkerResult {
  readonly total: number
  readonly text: string
  readonly pages: ReadonlyArray<WorkerPage>
}

interface WorkerChild {
  readonly stdin: { write: (text: string) => void; end: () => void }
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  readonly kill: (signal?: string) => void
}

const defaultGeometry = (): PdfGeometry => ({ dpi: 144, maxLongEdge: 2_048, maxPixelsPerPage: 4_194_304 })

const positive = (value: number, what: string) => {
  if (!Number.isFinite(value) || value <= 0) throw new ConversionError("invalid", `${what} must be finite and positive`)
}

const validateWindow = (window: PdfPageWindow) => {
  if (!Number.isInteger(window.offset) || window.offset < 1) throw new ConversionError("invalid", "pageOffset must be an integer of at least 1")
  if (!Number.isInteger(window.limit) || window.limit < 1) throw new ConversionError("invalid", "pageLimit must be an integer of at least 1")
  positive(window.limit, "pageLimit")
}

const validateGeometry = (geometry: PdfGeometry) => {
  if (!Number.isInteger(geometry.dpi) || geometry.dpi < 1) throw new ConversionError("invalid", "PDF dpi must be an integer of at least 1")
  positive(geometry.maxLongEdge, "PDF maximum long edge")
  positive(geometry.maxPixelsPerPage, "PDF maximum pixels per page")
}

const withDeadline = async <A>(promise: Promise<A>, wallMs: number, kill: () => void): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      kill()
      reject(new ConversionError("timeout", `PDF conversion exceeded its ${wallMs} ms wall deadline`))
    }, wallMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Runs PDF conversion workers through util-linux prlimit. The queue keeps
 * only loaders and request facts; original bytes are read after a worker
 * slot is acquired. Cancellation removes queued work or terminates and
 * reaps an active child.
 */
export class BoundedPdfConverter implements ConversionPort {
  private active = 0
  private readonly queued: Array<{
    readonly job: PdfConversionJob
    readonly resolve: (value: ConvertedPdf) => void
    readonly reject: (reason: unknown) => void
    readonly onAbort: () => void
  }> = []

  constructor(
    private readonly limits: WorkerLimits,
    private readonly command: WorkerCommand,
  ) {}

  convert(job: PdfConversionJob): Promise<ConvertedPdf> {
    try {
      validateWindow(job.window)
      validateGeometry(job.geometry)
      if (this.limits.activeWorkers < 1 || this.limits.queuedJobs < 0) throw new ConversionError("invalid", "conversion worker limits are invalid")
    } catch (error) {
      return Promise.reject(error)
    }
    job.signal.throwIfAborted()
    const span = startSpan("ashe_agent.conversion", {})
    const started = performance.now()
    const pending = new Promise<ConvertedPdf>((resolve, reject) => {
      const onAbort = () => {
        const index = this.queued.findIndex((entry) => entry.job === job)
        if (index >= 0) {
          this.queued.splice(index, 1)
          reject(job.signal.reason instanceof Error ? job.signal.reason : new ConversionError("canceled", "PDF conversion was canceled"))
        }
      }
      const entry = { job, resolve, reject, onAbort }
      if (this.active < this.limits.activeWorkers) {
        void this.start(entry)
        return
      }
      if (this.queued.length >= this.limits.queuedJobs) {
        reject(new ConversionError("queue", `PDF conversion queue is full at ${this.limits.queuedJobs} jobs`))
        return
      }
      job.signal.addEventListener("abort", onAbort, { once: true })
      this.queued.push(entry)
    })
    return pending.then(
      (result) => {
        endSpan(span, { "ashe_agent.conversion.outcome": "success" })
        recordDuration("ashe_agent.conversion.duration", (performance.now() - started) / 1000, {
          "ashe_agent.conversion.outcome": "success",
        })
        return result
      },
      (error: unknown) => {
        const outcome = error instanceof ConversionError ? error.kind : "failed"
        const failure: ErrorClass = error instanceof ConversionError
          ? error.kind === "timeout"
            ? "conversion_timeout"
            : error.kind === "output"
              ? "conversion_output"
              : error.kind === "canceled"
                ? "canceled"
                : "conversion_failed"
          : "internal"
        endSpan(span, { "ashe_agent.conversion.outcome": outcome }, failure)
        recordDuration("ashe_agent.conversion.duration", (performance.now() - started) / 1000, {
          "ashe_agent.conversion.outcome": outcome,
        })
        throw error
      },
    )
  }

  private async start(entry: (typeof this.queued)[number]) {
    this.active += 1
    entry.job.signal.removeEventListener("abort", entry.onAbort)
    let activeAbort: (() => void) | undefined
    const canceled = () => entry.job.signal.reason instanceof Error
      ? entry.job.signal.reason
      : new ConversionError("canceled", "PDF conversion was canceled")
    const cancellation = new Promise<never>((_, reject) => {
      activeAbort = () => reject(canceled())
      entry.job.signal.addEventListener("abort", activeAbort, { once: true })
    })
    try {
      entry.job.signal.throwIfAborted()
      const loading = Promise.resolve().then(() => entry.job.load())
      loading.catch(() => undefined)
      const bytes = await Promise.race([loading, cancellation])
      entry.job.signal.throwIfAborted()
      if (bytes.byteLength > this.limits.inputBytes) {
        throw new ConversionError("invalid", `PDF original is ${bytes.byteLength} bytes, over the worker input limit of ${this.limits.inputBytes}`)
      }
      entry.resolve(await this.run(entry.job, bytes))
    } catch (error) {
      entry.reject(entry.job.signal.aborted ? canceled() : error)
    } finally {
      if (activeAbort !== undefined) entry.job.signal.removeEventListener("abort", activeAbort)
      entry.job.signal.removeEventListener("abort", entry.onAbort)
      this.active -= 1
      const next = this.queued.shift()
      if (next !== undefined) void this.start(next)
    }
  }

  private async run(job: PdfConversionJob, bytes: Uint8Array): Promise<ConvertedPdf> {
    const request = JSON.stringify({
      pdf: Buffer.from(bytes).toString("base64"),
      window: job.window,
      geometry: job.geometry,
      limits: {
        dataBytes: this.limits.dataBytes,
        stackBytes: this.limits.stackBytes,
        cpuSeconds: this.limits.cpuSeconds,
      },
    })
    if (Buffer.byteLength(request) > this.limits.inputBytes + 16 * 1024 * 1024) {
      throw new ConversionError("invalid", "PDF conversion request is over the bounded input allowance")
    }
    const command = [
      this.limits.prlimitPath,
      `--data=${this.limits.dataBytes}`,
      `--stack=${this.limits.stackBytes}`,
      `--cpu=${this.limits.cpuSeconds}`,
      "--core=0",
      "--",
      this.command.executable,
      ...this.command.args,
      JSON.stringify({
        dataBytes: this.limits.dataBytes,
        stackBytes: this.limits.stackBytes,
        cpuSeconds: this.limits.cpuSeconds,
      }),
    ]
    let child: WorkerChild
    try {
      child = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {} }) as unknown as WorkerChild
    } catch (error) {
      throw new ConversionError("unsupported", `the conversion worker could not start: ${inspect(error)}`)
    }
    const kill = () => { try { child.kill("SIGKILL") } catch {} }
    const aborted = () => kill()
    job.signal.addEventListener("abort", aborted, { once: true })
    try {
      child.stdin.write(request)
      child.stdin.end()
      const output = await withDeadline(this.collect(child, this.limits.outputBytes), this.limits.wallMs, kill)
      const code = await child.exited
      const stderr = await this.readAtMost(child.stderr, 4_096)
      if (job.signal.aborted) throw new ConversionError("canceled", "PDF conversion was canceled")
      if (code !== 0) {
        throw new ConversionError("failed", `PDF conversion worker exited ${code}${stderr === "" ? "" : `: ${stderr}`}`)
      }
      let result: WorkerResult
      try {
        result = JSON.parse(output) as WorkerResult
      } catch {
        throw new ConversionError("failed", "PDF conversion worker returned malformed output")
      }
      return {
        total: result.total,
        text: result.text,
        pages: result.pages.map((page) => ({
          page: page.page,
          total: page.total,
          png: Buffer.from(page.png, "base64"),
          width: page.width,
          height: page.height,
        })),
      }
    } finally {
      job.signal.removeEventListener("abort", aborted)
      kill()
      await child.exited.catch(() => undefined)
    }
  }

  private async readAtMost(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
    const reader = stream.getReader()
    const chunks: Array<Uint8Array> = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const take = value.subarray(0, limit - size)
      chunks.push(take)
      size += take.byteLength
      if (size >= limit) {
        await reader.cancel().catch(() => undefined)
        break
      }
    }
    return Buffer.concat(chunks).toString("utf8")
  }

  private async collect(child: WorkerChild, limit: number): Promise<string> {
    const reader = child.stdout.getReader()
    const chunks: Array<Uint8Array> = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        try { child.kill("SIGKILL") } catch {}
        throw new ConversionError("output", `PDF conversion output exceeded ${limit} bytes`)
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString("utf8")
  }
}

/** Runs outside the harness's input and store bootstrap as a bounded child process. */
export const readWorkerRequest = async () => {
  const chunks: Array<Uint8Array> = []
  let size = 0
  for await (const chunk of Bun.stdin.stream()) {
    size += chunk.byteLength
    if (size > 64 * 1024 * 1024) throw new ConversionError("invalid", "conversion worker request exceeded 64 MiB")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

/** Reads one soft limit from /proc/self/limits. */
export const softLimit = async (label: string): Promise<number | null> => {
  const text = await readFile("/proc/self/limits", "utf8")
  const line = text.split("\n").find((candidate) => candidate.startsWith(label))
  if (line === undefined) return null
  const fields = line.slice(label.length).trim().split(/\s+/)
  const value = fields[0]
  if (value === "unlimited") return null
  return Number(value)
}

/** Fails closed unless the process runs under limits no weaker than requested. */
export const verifyWorkerLimits = async (limits: { readonly dataBytes: number; readonly stackBytes: number; readonly cpuSeconds: number }) => {
  const data = await softLimit("Max data size")
  const stack = await softLimit("Max stack size")
  const cpu = await softLimit("Max cpu time")
  if (data === null || data > limits.dataBytes) throw new ConversionError("unsupported", "conversion worker has no valid RLIMIT_DATA ceiling")
  if (stack === null || stack > limits.stackBytes) throw new ConversionError("unsupported", "conversion worker has no valid RLIMIT_STACK ceiling")
  if (cpu === null || cpu > limits.cpuSeconds) throw new ConversionError("unsupported", "conversion worker has no valid RLIMIT_CPU ceiling")
}

export const defaultPdfGeometry = defaultGeometry

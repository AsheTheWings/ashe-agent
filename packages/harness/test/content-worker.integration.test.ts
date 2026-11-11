import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BoundedPdfConverter, ConversionError, type PdfConversionJob, type WorkerLimits } from "../src/content/conversion.ts"

const directories: Array<string> = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const script = (body: string) => {
  const directory = mkdtempSync(join(tmpdir(), "ashe-agent-worker-"))
  directories.push(directory)
  const path = join(directory, "worker.sh")
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o700)
  return path
}

const limits = (overrides: Partial<WorkerLimits> = {}): WorkerLimits => ({
  prlimitPath: "/usr/bin/prlimit",
  dataBytes: 512 * 1024 ** 2,
  stackBytes: 8 * 1024 ** 2,
  cpuSeconds: 20,
  wallMs: 5_000,
  outputBytes: 4096,
  activeWorkers: 1,
  queuedJobs: 1,
  inputBytes: 1024,
  ...overrides,
})

const job = (executable: string): PdfConversionJob => ({
  load: async () => new Uint8Array([1]),
  window: { offset: 1, limit: 1 },
  geometry: { dpi: 72, maxLongEdge: 64, maxPixelsPerPage: 4096 },
  signal: new AbortController().signal,
})

const until = async (condition: () => boolean, deadline = Date.now() + 5_000) => {
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("bounded worker condition did not settle")
    await Bun.sleep(10)
  }
}

describe("bounded conversion worker parent", () => {
  test("an unbounded invocation rejects before it reads its stdin request", async () => {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../src/main.ts"), "conversion-worker", '{"dataBytes":1}'],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    )
    const code = await Promise.race([child.exited, Bun.sleep(2_000).then(() => null)])
    if (code === null) {
      child.kill()
      throw new Error("worker waited for stdin before rejecting unbounded limits")
    }
    expect(code).not.toBe(0)
    expect(await new Response(child.stderr).text()).toContain("expected limits")
  }, 10_000)

  test("queued jobs load their originals only after an active slot is available", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ashe-agent-worker-"))
    directories.push(directory)
    const pidFile = join(directory, "pid")
    const holding = script(`echo $$ > ${JSON.stringify(pidFile)}
cat >/dev/null
exec sleep 30`)
    const loads: Array<string> = []
    const converter = new BoundedPdfConverter(limits({ activeWorkers: 1, queuedJobs: 1 }), {
      executable: holding,
      args: [],
    })
    const activeController = new AbortController()
    const active = converter.convert({
      ...job(holding),
      load: async () => {
        loads.push("active")
        return new Uint8Array([1])
      },
      signal: activeController.signal,
    }).catch((error: unknown) => error)
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "")
    const queuedController = new AbortController()
    const queued = converter.convert({
      ...job(holding),
      load: async () => {
        loads.push("queued")
        return new Uint8Array([2])
      },
      signal: queuedController.signal,
    }).catch((error: unknown) => error)
    expect(loads).toEqual(["active"])
    activeController.abort()
    await active
    await until(() => loads.includes("queued"))
    queuedController.abort()
    await queued
  }, 20_000)

  test("canceling a deferred load releases the slot without starting its worker", async () => {
    let loaded = false
    let runs = 0
    const converter = new BoundedPdfConverter(limits({ activeWorkers: 1, queuedJobs: 1 }), {
      executable: "/bin/false",
      args: [],
    })
    ;(converter as unknown as { run: () => Promise<unknown> }).run = async () => {
      runs += 1
      return { total: 1, text: "", pages: [] }
    }
    const firstController = new AbortController()
    const first = converter.convert({
      ...job("/bin/false"),
      load: () => {
        loaded = true
        return new Promise<Uint8Array>(() => undefined)
      },
      signal: firstController.signal,
    }).catch((error: unknown) => error)
    await until(() => loaded)
    const secondController = new AbortController()
    const second = converter.convert({
      ...job("/bin/false"),
      load: async () => new Uint8Array([2]),
      signal: secondController.signal,
    }).catch((error: unknown) => error)
    firstController.abort()
    const failure = await first
    expect(failure).toBeInstanceOf(DOMException)
    expect((failure as DOMException).name).toBe("AbortError")
    await until(() => runs === 1)
    secondController.abort()
    await second
  }, 10_000)

  test("bounds output, rejects an overfull queue, and reaps a canceled worker", async () => {
    const noisy = script("cat >/dev/null\nhead -c 4096 /dev/zero | tr '\\0' x")
    const converter = new BoundedPdfConverter(limits({ outputBytes: 128 }), { executable: noisy, args: [] })
    const failure = await converter.convert(job(noisy)).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ConversionError)
    expect((failure as ConversionError).kind).toBe("output")

    const pidFile = join(directories.at(-1)!, "pid")
    const holding = script(`echo $$ > ${JSON.stringify(pidFile)}\ncat >/dev/null\nexec sleep 30`)
    const bounded = new BoundedPdfConverter(limits({ activeWorkers: 1, queuedJobs: 1 }), { executable: holding, args: [] })
    const controller = new AbortController()
    const active = bounded.convert({ ...job(holding), signal: controller.signal }).catch((error: unknown) => error)
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "")
    const queuedController = new AbortController()
    const queued = bounded.convert({ ...job(holding), signal: queuedController.signal }).catch((error: unknown) => error)
    const overflow = await bounded.convert(job(holding)).catch((error: unknown) => error)
    expect(overflow).toBeInstanceOf(ConversionError)
    expect((overflow as ConversionError).kind).toBe("queue")
    const workerPid = Number(readFileSync(pidFile, "utf8"))
    controller.abort()
    queuedController.abort()
    expect(await active).toBeInstanceOf(DOMException)
    await queued
    await until(() => {
      try {
        process.kill(workerPid, 0)
        return false
      } catch {
        return true
      }
    })
  }, 20_000)

  test("enforces the wall deadline and reaps the process group", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ashe-agent-worker-"))
    directories.push(directory)
    const pidFile = join(directory, "pid")
    const holding = script(`echo $$ > ${JSON.stringify(pidFile)}
cat >/dev/null
exec sleep 30`)
    const converter = new BoundedPdfConverter(limits({ wallMs: 100 }), { executable: holding, args: [] })
    const failure = await converter.convert(job(holding)).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ConversionError)
    expect((failure as ConversionError).kind).toBe("timeout")
    const workerPid = Number(readFileSync(pidFile, "utf8"))
    await until(() => {
      try {
        process.kill(workerPid, 0)
        return false
      } catch {
        return true
      }
    })
  }, 10_000)
})

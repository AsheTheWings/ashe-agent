import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Subprocess } from "bun"

const main = join(import.meta.dir, "../../src/main.ts")

/** Bounded wait for a condition, polling every 10 ms. */
export const waitFor = async <A>(what: string, check: () => A | undefined | Promise<A | undefined>, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(10)
  }
}

/** A run-owned state directory, inputs, and the `ashe-agent` CLI run against them. */
export class CliRun {
  readonly dir = mkdtempSync(join(tmpdir(), "ashe-agent-cli-"))
  readonly stateDir = join(this.dir, "state")
  readonly env: Record<string, string>
  private readonly servers: Array<Subprocess> = []

  constructor(extraEnv: Record<string, string> = {}) {
    mkdirSync(this.stateDir)
    const keyFile = join(this.dir, "model-api-key")
    writeFileSync(keyFile, "sk-synthetic-test-key")
    chmodSync(keyFile, 0o600)
    this.env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: this.dir,
      ASHE_AGENT_PROFILE: "development",
      ASHE_AGENT_STATE_DIR: this.stateDir,
      ASHE_AGENT_CONFIG_FILE: join(this.dir, "config.json"),
      ASHE_AGENT_MODEL_API_KEY_FILE: keyFile,
      ASHE_AGENT_MODELS: JSON.stringify([{ id: "test/model", contextWindow: 400_000, imageInput: false }]),
      ASHE_AGENT_LISTEN_PORT: "0",
      ASHE_AGENT_ORIGINS: JSON.stringify(["http://127.0.0.1:5173"]),
      OTEL_TRACES_EXPORTER: "none",
      OTEL_METRICS_EXPORTER: "none",
      OTEL_LOGS_EXPORTER: "none",
      ...extraEnv,
    }
  }

  get databasePath() {
    return join(this.stateDir, "database", "ashe-agent.db")
  }

  async run(args: ReadonlyArray<string>, options: { stdin?: string; env?: Record<string, string> } = {}) {
    const child = Bun.spawn([process.execPath, main, ...args], {
      env: { ...this.env, ...options.env },
      stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { code, stdout, stderr }
  }

  /** Migrates, sets the owner password, and returns this run. */
  async prepare(password = "owner-password") {
    const migrated = await this.run(["migrate"])
    if (migrated.code !== 0) throw new Error(`migrate failed: ${migrated.stderr}`)
    const owner = await this.run(["owner", "set-password"], { stdin: `${password}\n` })
    if (owner.code !== 0) throw new Error(`owner set-password failed: ${owner.stderr}`)
    return this
  }

  /** Starts `serve` and returns the WebSocket URL it prints. */
  async serve(): Promise<string> {
    const child = Bun.spawn([process.execPath, main, "serve"], { env: this.env, stdout: "pipe", stderr: "inherit" })
    this.servers.push(child)
    const reader = child.stdout.getReader()
    let output = ""
    return await waitFor("serve to print its URL", async () => {
      const { value, done } = await reader.read()
      if (done) throw new Error(`serve exited with ${await child.exited}`)
      output += new TextDecoder().decode(value)
      const line = output.split("\n")[0]
      return output.includes("\n") ? line : undefined
    })
  }

  /** Stops every `serve` this run started, as SIGTERM does, and waits for each to exit. */
  async stopServers() {
    for (const server of this.servers) {
      server.kill()
      await server.exited
    }
  }

  async cleanup() {
    await this.stopServers()
    rmSync(this.dir, { recursive: true, force: true })
  }
}

/** A protocol client over a real WebSocket that queues every message and records the close. */
export class Client {
  private readonly messages: Array<any> = []
  closed: { code: number } | null = null
  /** Receives every notification; a client without it queues them with responses. */
  onNotification: ((message: any) => void) | null = null
  private nextId = 1

  private constructor(private readonly socket: WebSocket) {
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id === undefined && this.onNotification !== null) this.onNotification(message)
      else this.messages.push(message)
    }
    socket.onclose = (event) => {
      this.closed = { code: event.code }
    }
  }

  /** Connects, or rejects when the upgrade is refused. */
  static async connect(url: string, origin?: string): Promise<Client> {
    const socket = new WebSocket(url, origin === undefined ? undefined : { headers: { Origin: origin } } as any)
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error("the WebSocket connection was refused"))
    })
    return new Client(socket)
  }

  send(message: unknown) {
    this.socket.send(typeof message === "string" ? message : JSON.stringify(message))
  }

  /** Sends a request and waits for its response. */
  async request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++
    this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })
    return await waitFor(`the response to ${method}`, () => {
      const index = this.messages.findIndex((message) => message.id === id)
      if (index === -1) return undefined
      return this.messages.splice(index, 1)[0]
    })
  }

  async waitClosed(timeoutMs = 10_000) {
    return await waitFor("the connection to close", () => this.closed ?? undefined, timeoutMs)
  }

  close() {
    this.socket.close()
  }
}

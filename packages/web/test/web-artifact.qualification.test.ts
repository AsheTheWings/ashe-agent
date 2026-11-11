import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

/*
 * Qualifies the exact bundle `bun run test:qualification` names: its web
 * backend serves the browser built from the same revision, observes a
 * harness session without a browser, commits shared organization, survives
 * replacement, and publishes a consistent dump.
 */

const bundle = process.env.ASHE_AGENT_QUALIFICATION_BUNDLE
if (bundle === undefined) throw new Error("ASHE_AGENT_QUALIFICATION_BUNDLE names no bundle; run bun run test:qualification")

const dir = mkdtempSync(join(tmpdir(), "ashe-agent-web-artifact-"))
const extracted = join(dir, "bundle")
const binary = join(extracted, "web/bin/ashe-agent-web")
const assets = join(extracted, "web")
const migrations = join(extracted, "web/migrations")
const state = join(dir, "state")
const credential = join(dir, "observer.token")
writeFileSync(credential, "observer-token\n", { mode: 0o600 })
chmodSync(credential, 0o600)
mkdirSync(state, { recursive: true, mode: 0o700 })

const summary = {
  id: "session-artifact",
  sessionDir: "/tmp/session-artifact",
  identity: { sessionId: "session-artifact", agentTitle: "untitled", modelId: null },
  selection: { agentTitle: "untitled", modelSettings: { modelId: null, reasoningEffort: null } },
  activeSelection: null,
  activity: "idle",
  createdAt: 1,
  lastSeq: 0,
}

let harness: ReturnType<typeof Bun.serve> | null = null
let server: ReturnType<typeof Bun.spawn> | null = null
let edge: ReturnType<typeof Bun.spawn> | null = null
let webPort = 0
let publicPort = 0
const observerMethods: Array<string> = []
const sockets = new Set<import("bun").ServerWebSocket<unknown>>()
const socketRoles = new Map<import("bun").ServerWebSocket<unknown>, "browser" | "observer">()
const completedActions: Array<string> = []
const submittedTexts: Array<string> = []

const freePort = () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
  const port = probe.port!
  probe.stop(true)
  return port
}

const waitFor = async <A>(what: string, operation: () => Promise<A | undefined>, timeout = 15_000): Promise<A> => {
  const started = Date.now()
  for (;;) {
    const value = await operation()
    if (value !== undefined) return value
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(20)
  }
}

const environment = () => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: dir,
  TMPDIR: dir,
  LANG: "C.UTF-8",
  TZ: "UTC",
  ASHE_AGENT_PROFILE: "production",
  ASHE_AGENT_WEB_STATE_DIR: state,
  ASHE_AGENT_WEB_LISTEN_HOST: "127.0.0.1",
  ASHE_AGENT_WEB_LISTEN_PORT: String(webPort),
  ASHE_AGENT_WEB_HARNESS_URL: `ws://127.0.0.1:${harness!.port}/v1/ws`,
  ASHE_AGENT_WEB_ORIGINS: JSON.stringify([`http://127.0.0.1:${publicPort}`]),
  ASHE_AGENT_WEB_OBSERVER_CREDENTIAL_FILE: credential,
  ASHE_AGENT_WEB_ASSETS_DIR: assets,
  ASHE_AGENT_WEB_MIGRATIONS_DIR: migrations,
  ASHE_AGENT_WEB_INACTIVITY_DAYS: "3",
  ASHE_AGENT_DEPLOYMENT_ENVIRONMENT: "qualification",
  OTEL_TRACES_EXPORTER: "none",
  OTEL_METRICS_EXPORTER: "none",
  OTEL_LOGS_EXPORTER: "none",
})

const start = async () => {
  server = Bun.spawn([binary, "serve"], { env: environment(), stdout: "ignore", stderr: "pipe" })
  await waitFor("the artifact's readiness", async () => {
    const response = await fetch(`http://127.0.0.1:${webPort}/v1/web/health`).catch(() => null)
    return response?.status === 200 ? response : undefined
  })
}

const stop = async () => {
  if (server === null) return
  server.kill()
  await server.exited
  server = null
}

beforeAll(async () => {
  mkdirSync(extracted)
  const tar = Bun.spawnSync(["tar", "-xf", bundle, "-C", extracted])
  if (tar.exitCode !== 0) throw new Error(`tar could not extract ${bundle}: ${tar.stderr.toString()}`)
  harness = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname !== "/v1/auth/identity") {
        return server.upgrade(request, { data: {} }) ? undefined : new Response("not found", { status: 404 })
      }
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "")
      if (token !== "user-token" && token !== "observer-token" && token !== "browser-access") return new Response("no", { status: 401 })
      return Response.json({ principal: { kind: "login", loginId: "artifact" }, harnessId: "harness-artifact", credentialExpiresAt: null })
    },
    websocket: {
      open(socket) { sockets.add(socket) },
      close(socket) { sockets.delete(socket); socketRoles.delete(socket) },
      message(socket, raw) {
        const request = JSON.parse(String(raw)) as { id: number; method: string; params: Record<string, unknown> }
        observerMethods.push(request.method)
        const respond = (result: unknown) => socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }))
        if (request.method === "auth.authenticate") { socketRoles.set(socket, "observer"); respond({ principal: { kind: "token", tokenId: "observer", name: "observer" } }) }
        else if (request.method === "auth.exchange") {
          socketRoles.set(socket, "browser")
          respond({
            principal: { kind: "login", loginId: "artifact" },
            accessToken: "browser-access",
            accessTokenExpiresAt: Date.now() + 900_000,
            refreshToken: "browser-refresh",
            refreshTokenExpiresAt: Date.now() + 2_592_000_000,
          })
        }
        else if (request.method === "auth.refresh") respond({
          principal: { kind: "login", loginId: "artifact" },
          accessToken: "browser-access",
          accessTokenExpiresAt: Date.now() + 900_000,
          refreshToken: "browser-refresh",
          refreshTokenExpiresAt: Date.now() + 2_592_000_000,
        })
        else if (request.method === "models.list") respond({ models: [], defaultModel: "model-artifact" })
        else if (request.method === "agents.list") respond({ agents: [], defaultAgent: null })
        else if (request.method === "actions.list") respond({ actions: [] })
        else if (request.method === "client.setActions") respond({})
        else if (request.method === "session.list") respond({ sessions: [summary] })
        else if (request.method === "session.subscribe") {
          respond({ session: summary })
          if (socketRoles.get(socket) === "browser") {
            socket.send(JSON.stringify({ jsonrpc: "2.0", method: "session.event", params: { sessionId: summary.id, seq: 1, timestamp: Date.now(), event: { type: "QUESTIONS_ASKED", runId: "artifact-run", toolCallId: "artifact-tool", questionSetId: "artifact-q", questions: [{ id: "one", header: "Artifact", question: "Pick?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] } } }))
            socket.send(JSON.stringify({ jsonrpc: "2.0", method: "action.execute", params: { actionId: "artifact-question", sessionId: summary.id, name: "questions.answer", arguments: { questionSetId: "artifact-q", questions: [{ id: "one", header: "Artifact", question: "Pick?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] } } }))
          }
        }
        else if (request.method === "action.complete") { completedActions.push(request.params.actionId as string); respond({}) }
        else if (request.method === "session.input") {
          submittedTexts.push(String(request.params.text ?? ""))
          respond({ inputId: "artifact-input", submissionId: request.params.submissionId ?? "artifact-input", receipt: { submissionId: request.params.submissionId ?? "artifact-input", inputId: "artifact-input", disposition: "pending", acceptedAt: Date.now() } })
        }
        else if (request.method === "session.observe") respond({
          sessionId: summary.id,
          revision: "rev-artifact",
          cursor: 1,
          selection: summary.selection,
          activeSelection: null,
          pending: [],
          execution: { activeTurnId: null, activity: "idle", canResume: false, canRewind: false, canFork: false, contextWorkflowActive: false, restorePending: false },
          userTurnIds: [],
          latestSuccessfulBoundaryId: null,
          attention: [],
        })
        else if (request.method === "session.semantics.page") {
          const object = (request.params as { object?: string }).object ?? "entries"
          respond({ object, revision: "rev-artifact", items: [], nextCursor: null, latestSuccessfulBoundaryId: null })
        }
        else respond({})
      },
    },
  })
  webPort = freePort()
  publicPort = freePort()
  const caddyfile = join(dir, "Caddyfile")
  writeFileSync(caddyfile, `{
  admin off
  auto_https off
}
http://127.0.0.1:${publicPort} {
  handle /v1/web/* {
    reverse_proxy 127.0.0.1:${webPort}
  }
  handle /v1/web-state* {
    reverse_proxy 127.0.0.1:${webPort}
  }
  handle /v1/* {
    reverse_proxy 127.0.0.1:${harness.port}
  }
  handle {
    reverse_proxy 127.0.0.1:${webPort}
  }
}
`)
  edge = Bun.spawn(["caddy", "run", "--config", caddyfile, "--adapter", "caddyfile"], { stdout: "ignore", stderr: "pipe" })
  expect(existsSync(binary)).toBe(true)
  expect(existsSync(migrations)).toBe(true)
  const migrated = Bun.spawnSync([binary, "migrate"], { env: environment() })
  expect(migrated.exitCode).toBe(0)
  await start()
  await waitFor("the edge", async () => (await fetch(`http://127.0.0.1:${publicPort}/v1/web/health`).catch(() => null))?.status === 200 ? true : undefined)
}, 120_000)

afterAll(async () => {
  await stop()
  if (edge !== null) {
    edge.kill()
    await edge.exited
    edge = null
  }
  harness?.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

class WebSocketClient {
  readonly messages: Array<any> = []
  private constructor(readonly socket: WebSocket) {}
  static async open() {
    const socket = new WebSocket(`ws://127.0.0.1:${webPort}/v1/web-state`, { headers: { origin: `http://127.0.0.1:${publicPort}` } } as never)
    const client = new WebSocketClient(socket)
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("web state did not open")) })
    socket.onmessage = (event) => { if (typeof event.data === "string") client.messages.push(JSON.parse(event.data)) }
    client.socket.send(JSON.stringify({ type: "web.authenticate", token: "user-token", protocolVersion: 1 }))
    return client
  }
  async snapshot() { return waitFor("a web snapshot", async () => this.messages.find((message) => message.type === "web.snapshot")) }
  send(message: unknown) { this.socket.send(JSON.stringify(message)) }
  close() { this.socket.close(1000, "done") }
}

type CdpMessage = { readonly id?: number; readonly result?: Record<string, unknown>; readonly error?: { readonly message: string } }

class BrowserPage {
  private nextId = 1
  private readonly pending = new Map<number, { readonly resolve: (value: CdpMessage) => void; readonly reject: (error: Error) => void }>()
  private constructor(readonly socket: WebSocket) {
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return
      const message = JSON.parse(event.data) as CdpMessage
      if (message.id === undefined) return
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) pending.reject(new Error(message.error.message))
      else pending.resolve(message)
    }
  }
  static async open(url: string) {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("CDP did not open")) })
    return new BrowserPage(socket)
  }
  request(method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate<T>(expression: string): Promise<T> {
    const message = await this.request("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
    return (message.result?.result as { value?: T } | undefined)?.value as T
  }
  close() { this.socket.close() }
}

const startBrowser = async () => {
  const port = freePort()
  const profile = join(dir, "chrome")
  mkdirSync(profile)
  const process = Bun.spawn(["google-chrome", "--headless=new", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" })
  const target = await waitFor("a browser target", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null)
    if (response?.status !== 200) return undefined
    const targets = (await response.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>
    return targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl !== undefined)
  }).catch(async (error: unknown) => {
    process.kill()
    await process.exited
    throw error
  })
  const page = await BrowserPage.open(target.webSocketDebuggerUrl!)
  await page.request("Page.enable")
  await page.request("Runtime.enable")
  return { process, page }
}

describe("the exact web artifact", () => {
  test("contains one revision's browser and backend, serves the shell, and never exposes SQLite", async () => {
    const revision = readFileSync(join(assets, "revision.txt"), "utf8").trim()
    expect(revision).toMatch(/^[0-9a-f]{40}$/)
    expect(Bun.spawnSync([binary, "--version"]).stdout.toString().trim()).toBe(revision)
    const page = await fetch(`http://127.0.0.1:${webPort}/`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain("<title>AsheAgent</title>")
    const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1]
    expect(asset).toBeDefined()
    const js = await (await fetch(`http://127.0.0.1:${webPort}${asset}`)).text()
    expect(js).toContain("Checkpoint window")
    expect(js).toContain("Send")
    expect(js).not.toContain("assistant-ui")
    expect((await fetch(`http://127.0.0.1:${webPort}/web.sqlite`)).status).toBe(404)
  })

  test("observes without a browser, commits shared organization, and survives backend replacement", async () => {
    const socket = await WebSocketClient.open()
    try {
      await socket.snapshot()
      await waitFor("observer discovery", async () => observerMethods.includes("session.subscribe") && observerMethods.includes("session.observe") ? true : undefined)
      expect(observerMethods).not.toContain("session.input")
      expect(observerMethods).not.toContain("session.resume")
      socket.send({ type: "web.command", command: { kind: "organization.set", operationId: "artifact-pin", sessionId: summary.id, patch: { pinned: true } } })
      const receipt = await waitFor("the web receipt", async () => socket.messages.find((message) => message.type === "web.receipt" && message.operationId === "artifact-pin"))
      expect(receipt.outcome).toBe("confirmed")
    } finally {
      socket.close()
    }
    await stop()
    await start()
    const reopened = await WebSocketClient.open()
    try {
      const snapshot = await reopened.snapshot()
      expect(snapshot.sessions.find((row: { sessionId: string }) => row.sessionId === summary.id)?.pinned).toBe(true)
    } finally {
      reopened.close()
    }
  }, 30_000)

  test("publishes a consistent copy under a temporary name and renames it into place", async () => {
    const destination = join(dir, "dumps", "web.sqlite")
    const dump = Bun.spawnSync([binary, "db", "dump", destination], { env: environment() })
    expect(dump.exitCode).toBe(0)
    expect(dump.stderr.toString()).toBe("")
    const db = new Database(destination, { readonly: true })
    try {
      expect(db.query("SELECT pinned FROM web_sessions WHERE session_id = ?").get(summary.id)).toEqual({ pinned: 1 })
      expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
    } finally {
      db.close()
    }
  })

  test("the served browser navigates views and keeps the composer's local intent", async () => {
    const { process, page } = await startBrowser()
    try {
      await page.request("Page.navigate", { url: `http://127.0.0.1:${publicPort}/` })
      await waitFor("the sign-in page", async () => await page.evaluate<boolean>("document.readyState === 'complete'") ? true : undefined)
      await page.evaluate(`sessionStorage.setItem("ashe-agent.signInVerifier", "verifier"); sessionStorage.setItem("ashe-agent.signInServer", ${JSON.stringify(`ws://127.0.0.1:${publicPort}/v1/ws`)});`)
      await page.request("Page.navigate", { url: `http://127.0.0.1:${publicPort}/?signin=1#signIn=browser-code` })
      await waitFor("the signed-in browser", async () => {
        const ready = await page.evaluate<boolean>("Boolean([...document.querySelectorAll('button')].find((button) => button.textContent?.includes('session-artifact')))")
        return ready ? true : undefined
      }, 20_000)
      await page.evaluate("[...document.querySelectorAll('button')].find((button) => button.textContent?.includes('session-artifact'))?.click()")
      await waitFor("the composer", async () => await page.evaluate<boolean>("Boolean(document.querySelector('[aria-label=Message]'))") ? true : undefined)
      await waitFor("the assigned question", async () => await page.evaluate<boolean>("document.body.innerText.includes('Pick?')") ? true : undefined)
      await page.evaluate("[...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Send answers'))?.click()")
      await waitFor("the assigned answer", async () => completedActions.includes("artifact-question") ? true : undefined)
      await page.evaluate("const composer = document.querySelector('[aria-label=Message]'); composer.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(composer, 'kept draft'); composer.dispatchEvent(new Event('input', { bubbles: true }))")
      await waitFor("the draft", async () => await page.evaluate<boolean>(`document.querySelector('[aria-label=Message]')?.value === 'kept draft'`) ? true : undefined)
      const key = async (key: string, code: string, modifiers = 0, text?: string) => {
        await page.request("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers, ...(text === undefined ? {} : { text }) })
        await page.request("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers })
      }
      await key("Control", "ControlLeft", 2)
      await key("i", "KeyI", 2)
      await waitFor("Session view", async () => await page.evaluate<string | null>(`document.querySelector('[data-view]')?.getAttribute('data-view')`) === "session" ? true : undefined)
      expect(await page.evaluate<boolean>(`document.activeElement?.getAttribute('aria-label') === 'Message' && document.querySelector('[aria-label=Message]')?.value === 'kept draft'`)).toBe(true)
      await key("Escape", "Escape")
      await waitFor("Chat view", async () => await page.evaluate<string | null>(`document.querySelector('[data-view]')?.getAttribute('data-view')`) === "chat" ? true : undefined)
      await page.evaluate("document.querySelector('[aria-label=Message]')?.blur(); document.body.focus()")
      await key("z", "KeyZ", 0, "z")
      await waitFor("type-to-focus", async () => await page.evaluate<boolean>(`document.activeElement?.getAttribute('aria-label') === 'Message' && document.querySelector('[aria-label=Message]')?.value === 'kept draftz'`) ? true : undefined)
      await page.evaluate("document.querySelector('[aria-label=Message]').focus(); document.querySelector('[aria-label=Message]').select()")
      await page.request("Input.insertText", { text: "hello harness" })
      await waitFor("the draft body", async () => await page.evaluate<boolean>(`document.querySelector('[aria-label=Message]')?.value === 'hello harness'`) ? true : undefined)
      await page.evaluate("[...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Send')?.click()")
      await waitFor("the harness submission", async () => submittedTexts.includes("hello harness") ? true : undefined)
    } finally {
      page.close()
      process.kill()
      await process.exited
    }
  }, 40_000)
})

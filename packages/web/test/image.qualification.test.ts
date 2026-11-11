import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

/*
 * Qualifies the web image `bun run test:web-image` names: its annotations
 * carry the revision, and the exact container serves the browser shell
 * while accepting an online-validated web-state operation.
 */

const layout = process.env.ASHE_AGENT_QUALIFICATION_IMAGE
const revision = process.env.ASHE_AGENT_QUALIFICATION_REVISION
if (layout === undefined || revision === undefined) {
  throw new Error("ASHE_AGENT_QUALIFICATION_IMAGE and _REVISION name no image; run bun run test:web-image")
}

const layoutTag = "qualified"
const dir = mkdtempSync(join(tmpdir(), "aa-web-"))
const name = `ashe-agent-web-qualification-${process.pid}`
const credentials = join(dir, "credentials")
mkdirSync(credentials, { recursive: true, mode: 0o700 })
writeFileSync(join(credentials, "observer"), "observer-token\n", { mode: 0o600 })
chmodSync(credentials, 0o700)
chmodSync(join(credentials, "observer"), 0o600)
const data = join(dir, "data")
mkdirSync(data, { recursive: true, mode: 0o777 })
chmodSync(data, 0o777)
let harness: ReturnType<typeof Bun.serve> | null = null
let webPort = 0

const podman = (...args: Array<string>) => {
  const base = [
    "--root", join(dir, "storage"), "--runroot", join(dir, "run"), "--tmpdir", join(dir, "tmp"),
    "--storage-driver", "vfs", "--cgroup-manager", "cgroupfs", "--events-backend", "file",
  ]
  return Bun.spawnSync(["podman", ...base, ...args], { timeout: 120_000 })
}

const podmanOk = (...args: Array<string>) => {
  const result = podman(...args)
  if (result.exitCode !== 0) throw new Error(`podman ${args[0]}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

const freePort = () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
  const port = server.port!
  server.stop(true)
  return port
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>

const summary = {
  id: "session-image",
  sessionDir: "/tmp/session-image",
  identity: { sessionId: "session-image", agentTitle: "untitled", modelId: null },
  selection: { agentTitle: "untitled", modelSettings: { modelId: null, reasoningEffort: null } },
  activeSelection: null,
  activity: "idle",
  createdAt: 1,
  lastSeq: 0,
}

beforeAll(async () => {
  mkdirSync(join(dir, "tmp"))
  const owned = Bun.spawnSync(["podman", "unshare", "chown", "-R", "65532:65532", credentials])
  if (owned.exitCode !== 0) throw new Error(`podman unshare chown: ${owned.stderr.toString()}`)
  harness = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === "/v1/auth/identity") {
        const token = request.headers.get("authorization")?.replace(/^Bearer /, "")
        if (token !== "user-token" && token !== "observer-token") return new Response("no", { status: 401 })
        return Response.json({ principal: { kind: "login", loginId: "image" }, harnessId: "harness-image", credentialExpiresAt: null })
      }
      if (server.upgrade(request, { data: {} })) return undefined
      return new Response("not found", { status: 404 })
    },
    websocket: {
      message(socket, raw) {
        const request = JSON.parse(String(raw)) as { id: number; method: string; params: Record<string, unknown> }
        const respond = (result: unknown) => socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }))
        if (request.method === "auth.authenticate") respond({ principal: { kind: "token", tokenId: "observer", name: "observer" } })
        else if (request.method === "client.setActions") respond({})
        else if (request.method === "session.list") respond({ sessions: [summary] })
        else if (request.method === "session.subscribe") respond({ session: summary })
        else if (request.method === "session.observe") respond({
          sessionId: summary.id,
          revision: "rev-1",
          cursor: 0,
          selection: summary.selection,
          activeSelection: null,
          pending: [],
          execution: { activeTurnId: null, activity: "idle", canResume: false, canRewind: false, canFork: false, contextWorkflowActive: false, restorePending: false },
          userTurnIds: [],
          latestSuccessfulBoundaryId: null,
          attention: [],
        })
        else respond({})
      },
    },
  })
  webPort = freePort()
  const image = podmanOk("pull", "--quiet", `oci:${layout}:${layoutTag}`)
  const environment = [
    "--env", "ASHE_AGENT_PROFILE=production",
    "--env", "ASHE_AGENT_WEB_STATE_DIR=/data",
    "--env", "ASHE_AGENT_WEB_LISTEN_HOST=127.0.0.1",
    "--env", `ASHE_AGENT_WEB_LISTEN_PORT=${webPort}`,
    "--env", `ASHE_AGENT_WEB_HARNESS_URL=ws://127.0.0.1:${harness.port}/v1/ws`,
    "--env", `ASHE_AGENT_WEB_ORIGINS=["http://127.0.0.1:${webPort}"]`,
    "--env", "ASHE_AGENT_WEB_OBSERVER_CREDENTIAL_FILE=/run/credentials/observer",
    "--env", "ASHE_AGENT_WEB_ASSETS_DIR=/app",
    "--env", "ASHE_AGENT_WEB_MIGRATIONS_DIR=/app/migrations",
    "--env", "ASHE_AGENT_WEB_INACTIVITY_DAYS=3",
    "--env", "ASHE_AGENT_DEPLOYMENT_ENVIRONMENT=qualification",
    "--env", "OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:1",
    "--env", "OTEL_TRACES_EXPORTER=none",
    "--env", "OTEL_METRICS_EXPORTER=none",
    "--env", "OTEL_LOGS_EXPORTER=none",
  ]
  podmanOk(
    "run", "--rm", "--network", "host",
    "--volume", `${data}:/data:rw,z`, "--volume", `${credentials}:/run/credentials:ro,z`,
    ...environment, image, "migrate",
  )
  podmanOk(
    "run", "--detach", "--name", name, "--read-only", "--network", "host",
    "--volume", `${data}:/data:rw,z`, "--volume", `${credentials}:/run/credentials:ro,z`,
    "--cap-drop", "all", "--security-opt", "no-new-privileges",
    ...environment, image,
  )
  const deadline = Date.now() + 60_000
  for (;;) {
    const status = await fetch(`http://127.0.0.1:${webPort}/v1/web/health`).then((response) => response.status, () => 0)
    if (status === 200) break
    if (podmanOk("inspect", "--format", "{{.State.Running}}", name) !== "true") {
      const logs = podman("logs", name)
      throw new Error(`the image's container stopped: ${logs.stdout.toString()}${logs.stderr.toString()}`)
    }
    if (Date.now() > deadline) throw new Error(`the image never became ready on ${webPort}`)
    await Bun.sleep(200)
  }
}, 180_000)

afterAll(() => {
  podman("rm", "--force", "--time", "0", name)
  podman("unshare", "rm", "-rf", dir)
  harness?.stop(true)
}, 60_000)

const base = () => `http://127.0.0.1:${webPort}`

describe("the web image", () => {
  test("its manifest is annotated with the revision, source, and version", () => {
    const index = readJson(join(layout, "index.json")) as { manifests: Array<{ digest: string }> }
    expect(index.manifests).toHaveLength(1)
    const digest = (index.manifests[0]?.digest ?? "").replace("sha256:", "")
    const manifest = readJson(join(layout, "blobs/sha256", digest)) as { annotations: Record<string, string> }
    expect(manifest.annotations["org.opencontainers.image.revision"]).toBe(revision)
    expect(manifest.annotations["org.opencontainers.image.source"]).toMatch(/^https:\/\//)
    expect(manifest.annotations["org.opencontainers.image.version"]).toBe("0.0.0")
  })

  test("serves the built shell from the backend with no static state fallthrough", async () => {
    const page = await fetch(`${base()}/`)
    expect(page.status).toBe(200)
    expect(page.headers.get("cache-control")).toBe("no-cache")
    expect(page.headers.get("x-content-type-options")).toBe("nosniff")
    const html = await page.text()
    expect(html).toContain("<title>AsheAgent</title>")
    const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1]
    expect(asset).toBeDefined()
    const script = await fetch(`${base()}${asset}`)
    expect(script.status).toBe(200)
    expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect((await fetch(`${base()}/missing`)).status).toBe(404)
    expect((await fetch(`${base()}/assets/missing.js`)).status).toBe(404)
    expect((await fetch(`${base()}/web.sqlite`)).status).toBe(404)
  })

  test("accepts an online-validated web-state operation from the exact image", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${webPort}/v1/web-state`, { headers: { origin: `http://127.0.0.1:${webPort}` } } as never)
    const messages: Array<any> = []
    socket.onmessage = (event) => { if (typeof event.data === "string") messages.push(JSON.parse(event.data)) }
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("web state did not open")) })
    socket.send(JSON.stringify({ type: "web.authenticate", token: "user-token", protocolVersion: 1 }))
    const deadline = Date.now() + 5_000
    while (!messages.some((message) => message.type === "web.snapshot")) {
      if (Date.now() > deadline) throw new Error("no web snapshot")
      await Bun.sleep(20)
    }
    socket.send(JSON.stringify({ type: "web.command", command: { kind: "organization.set", operationId: "image-op", sessionId: "session-image", patch: { pinned: true } } }))
    while (!messages.some((message) => message.type === "web.receipt" && message.operationId === "image-op")) {
      if (Date.now() > deadline) throw new Error("no web receipt")
      await Bun.sleep(20)
    }
    expect(messages.find((message) => message.type === "web.receipt" && message.operationId === "image-op")).toMatchObject({ outcome: "confirmed" })
    socket.close()
  })
})

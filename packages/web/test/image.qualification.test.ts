import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

/*
 * Qualifies the web image `bun run test:web-image` names: the OCI layout's
 * annotated manifest carries the revision, and the image, run read-only in
 * a Podman store of this run, serves that revision's client and writes no
 * console output.
 */

const layout = process.env.ASHE_AGENT_QUALIFICATION_IMAGE
const revision = process.env.ASHE_AGENT_QUALIFICATION_REVISION
if (layout === undefined || revision === undefined) {
  throw new Error("ASHE_AGENT_QUALIFICATION_IMAGE and _REVISION name no image; run bun run test:web-image")
}

const layoutTag = "qualified"
const containerPort = 8080
const dir = mkdtempSync(join(tmpdir(), "aa-web-"))
const name = `ashe-agent-web-qualification-${process.pid}`

/** Podman against a store and runtime directory this run owns. */
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

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))))
    })
  })

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>

let base = ""

beforeAll(async () => {
  mkdirSync(join(dir, "tmp"))
  const image = podmanOk("pull", "--quiet", `oci:${layout}:${layoutTag}`)
  const port = await freePort()
  podmanOk(
    "run", "--detach", "--name", name, "--read-only", "--tmpfs", "/data", "--tmpfs", "/config",
    "--cap-drop", "all", "--security-opt", "no-new-privileges",
    "--publish", `127.0.0.1:${port}:${containerPort}`, image,
  )
  base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 60_000
  for (;;) {
    const status = await fetch(`${base}/revision.txt`).then((response) => response.status, () => 0)
    if (status === 200) break
    if (podmanOk("inspect", "--format", "{{.State.Running}}", name) !== "true") {
      const logs = podman("logs", name)
      throw new Error(`the image's container stopped: ${logs.stdout.toString()}${logs.stderr.toString()}`)
    }
    if (Date.now() > deadline) throw new Error(`the image never served ${base}/revision.txt`)
    await Bun.sleep(200)
  }
}, 180_000)

afterAll(() => {
  podman("rm", "--force", "--time", "0", name)
  // The store holds files of mapped IDs, so they are removed in Podman's user namespace; only this run's
  // directories are touched.
  podman("unshare", "rm", "-rf", join(dir, "storage"), join(dir, "run"))
  rmSync(dir, { recursive: true, force: true })
})

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

  test("serves the client built from the revision", async () => {
    expect((await (await fetch(`${base}/revision.txt`)).text()).trim()).toBe(revision)
    const page = await fetch(`${base}/`)
    expect(page.status).toBe(200)
    expect(page.headers.get("cache-control")).toBe("no-cache")
    expect(page.headers.get("x-content-type-options")).toBe("nosniff")
    const html = await page.text()
    expect(html).toContain("<title>AsheAgent</title>")
    const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1]
    expect(asset).toBeDefined()
    const script = await fetch(`${base}${asset}`)
    expect(script.status).toBe(200)
    expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect((await fetch(`${base}/missing`)).status).toBe(404)
    const missingAsset = await fetch(`${base}/assets/missing.js`)
    expect(missingAsset.status).toBe(404)
    expect(missingAsset.headers.get("cache-control")).toBeNull()
  })

  test("writes no console output", () => {
    const logs = podman("logs", name)
    expect(logs.exitCode).toBe(0)
    expect(logs.stdout.toString() + logs.stderr.toString()).toBe("")
  })
})

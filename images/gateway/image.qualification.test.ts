import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

/*
 * Qualifies the gateway image `bun run test:gateway-image` names: the OCI
 * layout's annotated manifest carries the revision, and the image, run
 * read-only in a Podman store of this run with the arguments
 * docs/gateway.md gives, on a loopback port of this run, and synthetic
 * credentials, answers its health
 * check, refuses requests without a session, signs in the allowed GitHub
 * login and refuses another, and writes nothing to the console after
 * startup. GitHub is a fake of this run on loopback that grants only the
 * scopes the sign-in asked for, as GitHub does; three URL arguments point
 * the image at it.
 */

const layout = process.env.ASHE_AGENT_QUALIFICATION_IMAGE
const revision = process.env.ASHE_AGENT_QUALIFICATION_REVISION
if (layout === undefined || revision === undefined) {
  throw new Error("ASHE_AGENT_QUALIFICATION_IMAGE and _REVISION name no image; run bun run test:gateway-image")
}

const layoutTag = "qualified"
const origin = "https://gateway.example"
const allowed = "allowed-user"
const clientId = "synthetic-client-id"
const clientSecret = "synthetic-client-secret"
const dir = mkdtempSync(join(tmpdir(), "aa-gw-"))
const name = `ashe-agent-gateway-qualification-${process.pid}`
/** The one line oauth2-proxy prints before --standard-logging=false takes effect. */
const startupLine = /^\[[^\]]+\] \[logging\.go:\d+\] Warning: Logging disabled\. No further logs will be shown\.$/

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

/** A fake GitHub: an issued code names a login and the scopes the authorize request asked for. */
const grants = new Map<string, { login: string; scopes: Array<string> }>()
const redeemedSecrets: Array<string> = []
const fakeGitHub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/login/oauth/access_token" && request.method === "POST") {
      const form = new URLSearchParams(await request.text())
      redeemedSecrets.push(form.get("client_secret") ?? "")
      const code = form.get("code") ?? ""
      if (form.get("client_id") !== clientId || form.get("client_secret") !== clientSecret || !grants.has(code)) {
        return Response.json({ error: "bad_verification_code" })
      }
      return Response.json({ access_token: code, token_type: "bearer", scope: grants.get(code)?.scopes.join(",") })
    }
    const grant = grants.get((request.headers.get("authorization") ?? "").replace(/^token /, ""))
    if (grant === undefined) return Response.json({ message: "Bad credentials" }, { status: 401 })
    const has = (...scopes: Array<string>) => scopes.some((scope) => grant.scopes.includes(scope))
    switch (url.pathname) {
      case "/":
        return Response.json({})
      case "/user":
        return Response.json({ login: grant.login, email: null })
      case "/user/emails":
        return has("user", "user:email")
          ? Response.json([{ email: `${grant.login}@example.com`, primary: true, verified: true }])
          : Response.json({ message: "Not Found" }, { status: 404 })
      case "/user/orgs":
      case "/user/teams":
        return has("user", "read:org")
          ? Response.json([])
          : Response.json({ message: "You need at least read:org scope or user scope" }, { status: 403 })
      default:
        return Response.json({ message: "Not Found" }, { status: 404 })
    }
  },
})
const github = `http://127.0.0.1:${fakeGitHub.port}`

/**
 * The arguments docs/gateway.md gives, except that under host networking the gateway listens on a loopback
 * port of this run, then the three that point the image at the fake GitHub.
 */
const gatewayArguments = (port: number) => [
  `--http-address=127.0.0.1:${port}`, "--provider=github", `--client-id=${clientId}`,
  "--client-secret-file=/run/secrets/client-secret", "--cookie-secret-file=/run/secrets/cookie-secret",
  `--github-user=${allowed}`, "--email-domain=*", "--scope=user:email read:org", "--upstream=static://200",
  `--redirect-url=${origin}/oauth2/callback`, "--reverse-proxy=true", "--cookie-expire=720h",
  "--skip-provider-button=true", "--request-logging=false", "--auth-logging=false", "--standard-logging=false",
  `--login-url=${github}/login/oauth/authorize`, `--redeem-url=${github}/login/oauth/access_token`,
  `--validate-url=${github}/`,
]

/** The headers Caddy sends the gateway for a request to the origin. */
const proxied = { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "gateway.example" }

const cookiesOf = (response: Response) =>
  new Map(response.headers.getSetCookie().map((cookie) => {
    const pair = cookie.split(";")[0] ?? ""
    const at = pair.indexOf("=")
    return [pair.slice(0, at), pair.slice(at + 1)] as const
  }))

const cookieHeader = (cookies: Map<string, string>) => [...cookies].map(([key, value]) => `${key}=${value}`).join("; ")

let base = ""
let image = ""

/** Starts a sign-in, has the fake GitHub authorize it as the login, and returns the callback's response. */
const signIn = async (login: string) => {
  const start = await fetch(`${base}/oauth2/start?rd=%2F`, { redirect: "manual", headers: proxied })
  expect(start.status).toBe(302)
  const authorize = new URL(start.headers.get("location") ?? "")
  const code = `code-${login}-${grants.size}`
  grants.set(code, { login, scopes: (authorize.searchParams.get("scope") ?? "").split(" ") })
  const callback = new URL(`${base}/oauth2/callback`)
  callback.searchParams.set("code", code)
  callback.searchParams.set("state", authorize.searchParams.get("state") ?? "")
  const csrf = cookiesOf(start)
  return await fetch(callback, { redirect: "manual", headers: { ...proxied, Cookie: cookieHeader(csrf) } })
}

const authStatus = async (cookies: Map<string, string>) =>
  (await fetch(`${base}/oauth2/auth`, { headers: { ...proxied, Cookie: cookieHeader(cookies) } })).status

beforeAll(async () => {
  mkdirSync(join(dir, "tmp"))
  const secrets = join(dir, "secrets")
  mkdirSync(secrets)
  writeFileSync(join(secrets, "client-secret"), clientSecret)
  // A synthetic 32-byte key in base64url, the documented format.
  writeFileSync(join(secrets, "cookie-secret"), Buffer.alloc(32, 7).toString("base64url"))
  // The container's user reads them through Podman's user namespace.
  chmodSync(join(secrets, "client-secret"), 0o644)
  chmodSync(join(secrets, "cookie-secret"), 0o644)
  image = podmanOk("pull", "--quiet", `oci:${layout}:${layoutTag}`)
  const port = await freePort()
  // Host networking lets the gateway reach the fake GitHub on loopback.
  podmanOk(
    "run", "--detach", "--name", name, "--read-only", "--cap-drop", "all", "--security-opt", "no-new-privileges",
    "--network", "host", "--volume", `${secrets}:/run/secrets:ro`, image, ...gatewayArguments(port),
  )
  base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 60_000
  for (;;) {
    const status = await fetch(`${base}/ping`).then((response) => response.status, () => 0)
    if (status === 200) break
    if (podmanOk("inspect", "--format", "{{.State.Running}}", name) !== "true") {
      const logs = podman("logs", name)
      throw new Error(`the image's container stopped: ${logs.stdout.toString()}${logs.stderr.toString()}`)
    }
    if (Date.now() > deadline) throw new Error(`the image never answered ${base}/ping`)
    await Bun.sleep(200)
  }
}, 180_000)

afterAll(() => {
  podman("rm", "--force", "--time", "0", name)
  void fakeGitHub.stop(true)
  // The store holds files of mapped IDs, so they are removed in Podman's user namespace; only this run's
  // directories are touched.
  podman("unshare", "rm", "-rf", join(dir, "storage"), join(dir, "run"))
  rmSync(dir, { recursive: true, force: true })
})

describe("the gateway image", () => {
  test("its manifest is annotated with the revision, source, and version", () => {
    const index = readJson(join(layout, "index.json")) as { manifests: Array<{ digest: string }> }
    expect(index.manifests).toHaveLength(1)
    const digest = (index.manifests[0]?.digest ?? "").replace("sha256:", "")
    const manifest = readJson(join(layout, "blobs/sha256", digest)) as { annotations: Record<string, string> }
    expect(manifest.annotations["org.opencontainers.image.revision"]).toBe(revision)
    expect(manifest.annotations["org.opencontainers.image.source"]).toMatch(/^https:\/\//)
    expect(manifest.annotations["org.opencontainers.image.version"]).toBe("0.0.0")
  })

  test("runs oauth2-proxy v7.15.5 as a non-root user", () => {
    expect(podmanOk("image", "inspect", "--format", "{{.Config.User}}", image)).toBe("65532:65532")
    const version = podmanOk("run", "--rm", "--read-only", "--cap-drop", "all", image, "--version")
    expect(version).toStartWith("oauth2-proxy v7.15.5 ")
  })

  test("refuses a request without a session", async () => {
    expect(await authStatus(new Map())).toBe(401)
  })

  test("asks GitHub for the documented scope and callback", async () => {
    const start = await fetch(`${base}/oauth2/start?rd=%2F`, { redirect: "manual", headers: proxied })
    const authorize = new URL(start.headers.get("location") ?? "")
    expect(authorize.searchParams.get("client_id")).toBe(clientId)
    expect(authorize.searchParams.get("scope")).toBe("user:email read:org")
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${origin}/oauth2/callback`)
  })

  test("signs in the allowed login with a session the auth check accepts", async () => {
    const callback = await signIn(allowed)
    expect(callback.status).toBe(302)
    expect(callback.headers.get("location")).toBe("/")
    const session = cookiesOf(callback)
    expect(session.get("_oauth2_proxy")).toBeTruthy()
    expect(callback.headers.getSetCookie().find((cookie) => cookie.startsWith("_oauth2_proxy="))).toContain("Secure")
    expect(await authStatus(session)).toBe(202)
    expect(redeemedSecrets.at(-1)).toBe(clientSecret)
  })

  test("refuses another login a session", async () => {
    const callback = await signIn("another-user")
    expect(callback.status).not.toBe(302)
    const cookies = cookiesOf(callback)
    expect(cookies.get("_oauth2_proxy") ?? "").toBe("")
    expect(await authStatus(cookies)).toBe(401)
  })

  test("writes nothing to the console after its startup line", () => {
    const logs = podman("logs", name)
    expect(logs.exitCode).toBe(0)
    const lines = (logs.stdout.toString() + logs.stderr.toString()).split("\n").filter((line) => line !== "")
    expect(lines.length).toBeLessThanOrEqual(1)
    for (const line of lines) expect(line).toMatch(startupLine)
  })
})

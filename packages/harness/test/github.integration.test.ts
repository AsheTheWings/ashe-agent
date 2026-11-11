import { afterAll, describe, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { authenticate, principalActive } from "../src/auth/credentials.ts"
import { challengeOf, PENDING_SIGN_IN_TTL_MS, SIGN_IN_CODE_TTL_MS } from "../src/auth/github.ts"
import { startWebSocketServer } from "../src/server/websocket.ts"
import { openDatabase } from "../src/store/database.ts"
import { CliRun, Client } from "./support/cli.ts"
import { callback, httpUrl, signInCode, startSignIn } from "./support/github.ts"
import { exportedText, memoryTelemetry, offCatalog } from "./support/telemetry.ts"

const telemetry = memoryTelemetry()
afterAll(() => telemetry.stop())

const withServer = async (body: (h: { run: CliRun; db: Database; url: string; advance: (ms: number) => void }) => Promise<void>) => {
  const run = new CliRun()
  let server: ReturnType<typeof startWebSocketServer> | undefined
  let db: Database | undefined
  let now = Date.now()
  try {
    await run.prepare()
    db = openDatabase(run.databasePath)
    server = startWebSocketServer({ db, hostname: "127.0.0.1", port: 0, origins: ["http://127.0.0.1:5173"], github: run.github.config, handlers: {}, now: () => now })
    await body({ run, db, url: server.url, advance: (ms) => { now += ms } })
  } finally {
    await server?.stop()
    db?.close()
    await run.cleanup()
  }
}

const exchange = async (url: string, params: { code: string; verifier: string }, protocolVersion = 1) => {
  const client = await Client.connect(url)
  const response = await client.request("auth.exchange", { ...params, protocolVersion })
  if (response.error) expect((await client.waitClosed()).code).toBe(1008)
  else client.close()
  return response
}
const fragment = (response: Response) => new URL(response.headers.get("location")!).hash
const headers = (response: Response) => {
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(response.headers.get("referrer-policy")).toBe("no-referrer")
}

describe("GitHub sign-in over HTTP and WebSocket", () => {
  test("owner sign-in uses independent PKCE, revokes the GitHub token, and creates an owner login", async () => {
    await withServer(async ({ run, db, url }) => {
      const { response, authorize, verifier } = await startSignIn(url)
      headers(response)
      expect(response.status).toBe(302)
      expect(authorize.origin).toBe(run.github.base)
      expect(authorize.pathname).toBe("/login/oauth/authorize")
      expect(authorize.searchParams.get("client_id")).toBe("test-client")
      expect(authorize.searchParams.get("redirect_uri")).toBe(run.github.config.callbackUrl)
      expect(authorize.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256")
      expect(authorize.searchParams.get("allow_signup")).toBe("false")
      expect(authorize.searchParams.has("scope")).toBe(false)
      const back = await callback(url, authorize.searchParams.get("state")!)
      headers(back)
      const code = fragment(back).slice("#signIn=".length)
      expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)
      const result = await exchange(url, { code, verifier })
      expect(result.error).toBeUndefined()
      expect(result.result.principal.kind).toBe("login")
      expect(db.query("SELECT github_user_id FROM logins").get()).toEqual({ github_user_id: 42 })
      const posted = new URLSearchParams(run.github.requests[0]!.body)
      expect(posted.get("client_secret")).toBe("synthetic-github-secret")
      expect(posted.get("redirect_uri")).toBe(run.github.config.callbackUrl)
      expect(challengeOf(posted.get("code_verifier")!)).toBe(authorize.searchParams.get("code_challenge")!)
      expect(posted.get("code_verifier")).not.toBe(verifier)
      const revoked = run.github.requests.at(-1)!
      expect(revoked).toMatchObject({ method: "DELETE", path: "/applications/test-client/token" })
      expect(JSON.parse(revoked.body)).toEqual({ access_token: "synthetic-github-token" })
      expect(revoked.authorization).toBe(`Basic ${Buffer.from("test-client:synthetic-github-secret").toString("base64")}`)
      const dump = JSON.stringify(db.query("SELECT * FROM logins").all())
      for (const secret of [code!, verifier, "synthetic-github-token", "synthetic-github-secret"]) expect(dump).not.toContain(secret)
    })
  })

  test("another account is refused by numeric ID and creates no login or sign-in code", async () => {
    await withServer(async ({ run, db, url }) => {
      run.github.user = { id: 43, login: "owner" }
      const { authorize } = await startSignIn(url)
      expect(fragment(await callback(url, authorize.searchParams.get("state")!))).toBe("#signInError=not_owner")
      expect((await exchange(url, { code: "absent", verifier: "wrong" })).error.code).toBe(-32002)
      expect(db.query("SELECT count(*) AS n FROM logins").get()).toEqual({ n: 0 })
      expect(run.github.requests.at(-1)!.method).toBe("DELETE")
    })
  })

  test("denial and a missing code return to the client without exchanging", async () => {
    await withServer(async ({ run, url }) => {
      for (const [params, expected] of [[{ error: "access_denied" }, "denied"], [{}, "github_failed"]] as const) {
        const { authorize } = await startSignIn(url)
        const back = await callback(url, authorize.searchParams.get("state")!, params)
        headers(back)
        expect(fragment(back)).toBe(`#signInError=${expected}`)
      }
      expect(run.github.requests).toHaveLength(0)
    })
  })

  test("GitHub errors and malformed answers fail closed, and lookup failures still revoke", async () => {
    for (const mode of ["token_error", "user_error", "missing_token", "missing_id", "string_id"] as const) {
      await withServer(async ({ run, db, url }) => {
        if (mode === "token_error") run.github.tokenStatus = 500
        if (mode === "user_error") run.github.userStatus = 500
        if (mode === "missing_token") run.github.token = {}
        if (mode === "missing_id") run.github.user = {}
        if (mode === "string_id") run.github.user = { id: "42" }
        const { authorize } = await startSignIn(url)
        const back = await callback(url, authorize.searchParams.get("state")!)
        expect(fragment(back)).toBe("#signInError=github_failed")
        expect(db.query("SELECT count(*) AS n FROM logins").get()).toEqual({ n: 0 })
        if (mode.includes("id") || mode === "user_error") expect(run.github.requests.at(-1)!.method).toBe("DELETE")
      })
    }
  }, 20_000)

  for (const endpoint of ["token", "user"] as const) test(`${endpoint} requests time out after ten seconds`, async () => {
    await withServer(async ({ run, url }) => {
      run.github.hang = endpoint
      const { authorize } = await startSignIn(url)
      const started = Date.now()
      expect(fragment(await callback(url, authorize.searchParams.get("state")!))).toBe("#signInError=github_failed")
      expect(Date.now() - started).toBeGreaterThanOrEqual(9_500)
      expect(Date.now() - started).toBeLessThan(15_000)
      if (endpoint === "user") expect(run.github.requests.at(-1)!.method).toBe("DELETE")
    })
  }, 25_000)

  test("revocation failure preserves sign-in and emits a bounded log record", async () => {
    await withServer(async ({ run, url }) => {
      run.github.revokeStatus = 500
      const params = await signInCode(url)
      expect((await exchange(url, params)).error).toBeUndefined()
      expect(telemetry.logs().some((log) => log.eventName === "ashe_agent.github_token_revoke_failed" && log.attributes?.["error.type"] === "github_failed")).toBe(true)
    })
  })

  test("bad starts, unknown, reused, and expired states refuse without redirects", async () => {
    await withServer(async ({ url, advance }) => {
      for (const params of [{ origin: "https://unlisted.example", challenge: "x".repeat(43) }, { origin: "http://127.0.0.1:5173", challenge: "bad" }]) {
        const address = httpUrl(url, "/v1/auth/github/start")
        address.search = new URLSearchParams(params).toString()
        const response = await fetch(address, { redirect: "manual" })
        headers(response)
        expect(response.status).toBe(400)
        expect(response.headers.has("location")).toBe(false)
      }
      const { authorize } = await startSignIn(url)
      const state = authorize.searchParams.get("state")!
      await callback(url, state, { error: "access_denied" })
      expect((await callback(url, state)).status).toBe(400)
      const expired = (await startSignIn(url)).authorize.searchParams.get("state")!
      advance(PENDING_SIGN_IN_TTL_MS)
      for (const state of [expired, "unknown"]) {
        const response = await callback(url, state)
        headers(response)
        expect(response.status).toBe(400)
        expect(response.headers.has("location")).toBe(false)
      }
      expect((await fetch(httpUrl(url, "/other"))).status).toBe(404)
      expect((await fetch(httpUrl(url, "/v1/ws"))).status).toBe(426)
    })
  })

  test("the 65th pending sign-in evicts the oldest", async () => {
    await withServer(async ({ url }) => {
      const oldest = (await startSignIn(url)).authorize.searchParams.get("state")!
      let newest = ""
      for (let i = 0; i < 64; i++) newest = (await startSignIn(url)).authorize.searchParams.get("state")!
      expect((await callback(url, oldest)).status).toBe(400)
      expect((await callback(url, newest, { error: "access_denied" })).status).toBe(302)
    })
  })

  test("codes expire and are consumed by success, wrong verifiers, and unsupported versions", async () => {
    await withServer(async ({ url, advance }) => {
      const spent = await signInCode(url)
      expect((await exchange(url, spent)).error).toBeUndefined()
      expect((await exchange(url, spent)).error.code).toBe(-32002)
      const wrong = await signInCode(url)
      expect((await exchange(url, { ...wrong, verifier: "wrong" })).error.code).toBe(-32002)
      expect((await exchange(url, wrong)).error.code).toBe(-32002)
      const version = await signInCode(url)
      expect((await exchange(url, version, 999)).error.code).toBe(-32000)
      expect((await exchange(url, version)).error.code).toBe(-32002)
      const expired = await signInCode(url)
      advance(SIGN_IN_CODE_TTL_MS)
      expect((await exchange(url, expired)).error.code).toBe(-32002)
    })
  })

  test("an owner change refuses prior access, refresh, and new connections", async () => {
    const run = new CliRun()
    try {
      await run.prepare()
      const url = await run.serve()
      const tokens = (await exchange(url, await signInCode(url))).result
      const db = openDatabase(run.databasePath)
      try {
        expect(authenticate(db, tokens.accessToken, 42, Date.now()).ok).toBe(true)
        expect(principalActive(db, tokens.principal, 43)).toBe(false)
      } finally { db.close() }
      await run.stopServers()
      run.env.ASHE_AGENT_GITHUB_OWNER_ID = "43"
      const next = await run.serve()
      for (const [method, params] of [["auth.authenticate", { token: tokens.accessToken }], ["auth.refresh", { refreshToken: tokens.refreshToken }]] as const) {
        const client = await Client.connect(next)
        expect((await client.request(method, { ...params, protocolVersion: 1 })).error.code).toBe(-32002)
        expect((await client.waitClosed()).code).toBe(1008)
      }
    } finally { await run.cleanup() }
  }, 20_000)

  test("callback spans record accepted and refused outcomes without sign-in secrets", async () => {
    const before = telemetry.spans().length
    await withServer(async ({ run, url }) => {
      await signInCode(url)
      const denied = (await startSignIn(url)).authorize.searchParams.get("state")!
      await callback(url, denied, { error: "access_denied" })
      run.github.user = { id: 43 }
      await callback(url, (await startSignIn(url)).authorize.searchParams.get("state")!)
      await callback(url, "unknown")
      run.github.tokenStatus = 500
      await callback(url, (await startSignIn(url)).authorize.searchParams.get("state")!)
    })
    const spans = telemetry.spans().slice(before).filter((span) => span.name === "ashe_agent.github_sign_in")
    for (const outcome of ["signed_in", "not_owner", "denied", "unknown_state", "github_failed"]) {
      expect(spans.some((span) => span.attributes["ashe_agent.sign_in.outcome"] === outcome)).toBe(true)
    }
    expect(await offCatalog(telemetry)).toEqual([])
    const exported = await exportedText(telemetry)
    for (const value of ["synthetic-code", "synthetic-github-token", "synthetic-github-secret"]) expect(exported).not.toContain(value)
  })
})

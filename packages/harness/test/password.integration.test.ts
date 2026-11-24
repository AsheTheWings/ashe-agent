import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Redacted } from "effect"
import { challengeOf, randomToken } from "../src/auth/github.ts"
import { PasswordSignIn } from "../src/auth/password.ts"
import { CliRun, Client } from "./support/cli.ts"
import { httpUrl } from "./support/github.ts"
import { exportedText, memoryTelemetry, offCatalog } from "./support/telemetry.ts"

const telemetry = memoryTelemetry()
afterAll(() => telemetry.stop())

const startPassword = async (url: string, body: unknown, origin = "http://127.0.0.1:5173") => {
  const endpoint = httpUrl(url, "/v1/auth/password/exchange")
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

const passwordBody = (password: unknown, verifier = randomToken()) => ({
  verifier,
  body: { origin: "http://127.0.0.1:5173", challenge: challengeOf(verifier), password },
})

const authenticateWithPassword = async (url: string, password: string) => {
  const { verifier, body } = passwordBody(password)
  const response = await startPassword(url, body)
  expect(response.status).toBe(200)
  const { signIn } = (await response.json()) as { signIn: string }
  const client = await Client.connect(url)
  const exchanged = await client.request("auth.exchange", { code: signIn, verifier, protocolVersion: 1 })
  return { client, exchanged }
}

const runs: Array<CliRun> = []
afterEach(async () => {
  for (const run of runs.splice(0)) await run.cleanup()
})

const passwordRun = async (options: { github?: boolean } = {}) => {
  const run = new CliRun()
  runs.push(run)
  const passwordFile = join(run.dir, "dev-password")
  writeFileSync(passwordFile, "correct horse battery staple")
  chmodSync(passwordFile, 0o600)
  if (!options.github) {
    delete run.env.ASHE_AGENT_GITHUB_CLIENT_ID
    delete run.env.ASHE_AGENT_GITHUB_CLIENT_SECRET_FILE
    delete run.env.ASHE_AGENT_GITHUB_CALLBACK_URL
  }
  run.env.ASHE_AGENT_DEV_PASSWORD_FILE = passwordFile
  await run.prepare()
  const url = await run.serve()
  return { run, url }
}

describe("development password sign-in", () => {
  test("a password signs in without a GitHub app", async () => {
    const { url } = await passwordRun()
    const methods = await fetch(httpUrl(url, "/v1/auth/methods"), { headers: { Origin: "http://127.0.0.1:5173" } })
    expect(methods.status).toBe(200)
    expect(await methods.json()).toEqual({ github: false, password: true })
    expect((await fetch(httpUrl(url, "/v1/auth/methods"), { headers: { Origin: "http://evil.example" } })).status).toBe(403)
    const { client, exchanged } = await authenticateWithPassword(url, "correct horse battery staple")
    expect(exchanged.error).toBeUndefined()
    const models = await client.request("models.list")
    expect(models.error).toBeUndefined()
    client.close()
  })

  test("a password and a GitHub app sign in side by side", async () => {
    const { url } = await passwordRun({ github: true })
    const methods = await fetch(httpUrl(url, "/v1/auth/methods"), { headers: { Origin: "http://127.0.0.1:5173" } })
    expect(methods.status).toBe(200)
    expect(await methods.json()).toEqual({ github: true, password: true })
    const { client, exchanged } = await authenticateWithPassword(url, "correct horse battery staple")
    expect(exchanged.error).toBeUndefined()
    client.close()
  })

  test("a wrong password and an unlisted origin fail closed", async () => {
    const { url } = await passwordRun()
    const { verifier, body } = passwordBody("wrong password")
    const wrong = await startPassword(url, body)
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get("referrer-policy")).toBe("no-referrer")
    expect(wrong.headers.get("cache-control")).toBe("no-store")
    expect(wrong.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173")
    expect((await startPassword(url, { ...body, password: "correct horse battery staple" }, "http://evil.example")).status).toBe(403)
    const malformed = await startPassword(url, { origin: "http://127.0.0.1:5173", challenge: challengeOf(verifier) })
    expect(malformed.status).toBe(400)
    expect(malformed.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173")
    expect(malformed.headers.get("referrer-policy")).toBe("no-referrer")
    const oversized = await startPassword(url, "x".repeat(5_000))
    expect(oversized.status).toBe(413)
    expect(oversized.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173")
    const multibyte = await startPassword(url, JSON.stringify({ ...body, password: "é".repeat(2_200) }))
    expect(multibyte.status).toBe(413)
  })

  test("password sign-in spans record outcomes without leaking the password", async () => {
    const secret = "synthetic-dev-password-secret-value"
    const before = telemetry.spans().length
    const signIn = new PasswordSignIn({ ownerId: 42, secret: Redacted.make(secret) })
    const challenge = challengeOf(randomToken())
    const origins = ["http://127.0.0.1:5173"]
    expect(signIn.start(origins[0]!, origins, challenge, secret).outcome).toBe("signed_in")
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(signIn.start(origins[0]!, origins, challenge, "wrong-candidate-password").outcome).toBe("wrong_password")
    }
    expect(signIn.start(origins[0]!, origins, challenge, secret).outcome).toBe("sign_in_throttled")
    const spans = telemetry.spans().slice(before).filter((span) => span.name === "ashe_agent.password_sign_in")
    for (const outcome of ["signed_in", "wrong_password", "sign_in_throttled"]) {
      expect(spans.some((span) => span.attributes["ashe_agent.sign_in.outcome"] === outcome)).toBe(true)
    }
    expect(await offCatalog(telemetry)).toEqual([])
    const exported = await exportedText(telemetry)
    expect(exported).not.toContain(secret)
    expect(exported).not.toContain("wrong-candidate-password")
  })

  test("a production password file refuses serve", async () => {
    const run = new CliRun()
    runs.push(run)
    const passwordFile = join(run.dir, "dev-password")
    writeFileSync(passwordFile, "correct horse battery staple")
    chmodSync(passwordFile, 0o600)
    const refused = await run.run(["serve"], {
      env: {
        ASHE_AGENT_PROFILE: "production",
        ASHE_AGENT_LISTEN_PORT: "7499",
        ASHE_AGENT_USER_TIME_ZONE: "UTC",
        ASHE_AGENT_DEPLOYMENT_ENVIRONMENT: "test",
        ASHE_AGENT_DEV_PASSWORD_FILE: passwordFile,
      },
    })
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain("ASHE_AGENT_DEV_PASSWORD_FILE")
  })
})

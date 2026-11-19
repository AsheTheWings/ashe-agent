import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { challengeOf, randomToken } from "../src/auth/github.ts"
import { CliRun, Client } from "./support/cli.ts"
import { httpUrl } from "./support/github.ts"

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
    const { client, exchanged } = await authenticateWithPassword(url, "correct horse battery staple")
    expect(exchanged.error).toBeUndefined()
    const models = await client.request("models.list")
    expect(models.error).toBeUndefined()
    client.close()
  })

  test("a password and a GitHub app sign in side by side", async () => {
    const { url } = await passwordRun({ github: true })
    const { client, exchanged } = await authenticateWithPassword(url, "correct horse battery staple")
    expect(exchanged.error).toBeUndefined()
    client.close()
  })

  test("a wrong password and an unlisted origin fail closed", async () => {
    const { url } = await passwordRun()
    const { verifier, body } = passwordBody("wrong password")
    expect((await startPassword(url, body)).status).toBe(401)
    expect((await startPassword(url, { ...body, password: "correct horse battery staple" }, "http://evil.example")).status).toBe(403)
    const malformed = await startPassword(url, { origin: "http://127.0.0.1:5173", challenge: challengeOf(verifier) })
    expect(malformed.status).toBe(400)
    const oversized = await startPassword(url, "x".repeat(5_000))
    expect(oversized.status).toBe(413)
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

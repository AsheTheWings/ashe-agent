import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tokenHash } from "../src/auth/tokens.ts"
import { CliRun, Client } from "./support/cli.ts"

import { signInCode } from "./support/github.ts"

/** Runs `body` against a run-owned state directory, migrated unless `fresh`, and cleans up. */
const withRun = async (
  body: (run: CliRun, url: string) => Promise<void>,
  options: { fresh?: boolean; serve?: boolean; env?: Record<string, string> } = {},
) => {
  const run = new CliRun(options.env)
  try {
    if (!options.fresh) await run.prepare()
    const url = options.serve === false ? "" : await run.serve()
    await body(run, url)
  } finally {
    await run.cleanup()
  }
}

const login = async (url: string) => {
  const exchange = await signInCode(url)
  const client = await Client.connect(url)
  return { client, response: await client.request("auth.exchange", { ...exchange, protocolVersion: 1 }) }
}

const authenticateWith = async (url: string, token: string, protocolVersion = 1) => {
  const client = await Client.connect(url)
  return { client, response: await client.request("auth.authenticate", { token, protocolVersion }) }
}

const refreshWith = async (url: string, refreshToken: string) => {
  const client = await Client.connect(url)
  return { client, response: await client.request("auth.refresh", { refreshToken, protocolVersion: 1 }) }
}

/** An authenticated connection answers a later request instead of closing as unauthenticated. */
const expectAuthenticated = async (client: Client) => {
  const response = await client.request("models.list")
  expect(response.error?.code).not.toBe(-32001)
  expect(client.closed).toBeNull()
}

describe("entry point and database", () => {
  test("a command exits naming each invalid or missing input before any work", async () => {
    await withRun(
      async (run) => {
        const result = await run.run(["serve"], { env: { ASHE_AGENT_LISTEN_PORT: "http", ASHE_AGENT_DEFAULT_MODEL: "test/other" } })
        expect(result.code).toBe(2)
        expect(result.stderr).toContain("ASHE_AGENT_LISTEN_PORT")
        expect(result.stderr).toContain("ASHE_AGENT_DEFAULT_MODEL")
        expect(result.stdout).toBe("")
      },
      { fresh: true, serve: false },
    )
  })

  test("check validates serve's inputs without a database and prints the URL serve would listen on", async () => {
    await withRun(
      async (run) => {
        const checked = await run.run(["check"], { env: { ASHE_AGENT_LISTEN_PORT: "7999" } })
        expect(checked).toEqual({ code: 0, stdout: "ws://127.0.0.1:7999/v1/ws\n", stderr: "" })
        expect(readdirSync(run.stateDir)).toEqual([])
        const invalid = await run.run(["check"], { env: { ASHE_AGENT_DEFAULT_MODEL: "test/other" } })
        expect(invalid.code).toBe(2)
        expect(invalid.stderr).toContain("ASHE_AGENT_DEFAULT_MODEL")
        const providers = JSON.parse(run.env.ASHE_AGENT_PROVIDERS!)
        providers.test.apiKeyFile = join(run.dir, "absent-key")
        const keyless = await run.run(["check"], { env: { ASHE_AGENT_PROVIDERS: JSON.stringify(providers) } })
        expect(keyless.code).toBe(2)
        expect(keyless.stdout).toBe("")
        const headersFile = join(run.dir, "otlp-headers")
        writeFileSync(headersFile, "api-key=secret-value\nnot a header line\n", { mode: 0o600 })
        for (const command of ["check", "serve"]) {
          const malformed = await run.run([command], { env: { ASHE_AGENT_OTLP_HEADERS_FILE: headersFile } })
          expect(malformed.code).toBe(2)
          expect(malformed.stderr).toContain("ASHE_AGENT_OTLP_HEADERS_FILE: line 2 is not name=value")
          expect(malformed.stderr).not.toContain("secret-value")
        }
      },
      { fresh: true, serve: false },
    )
  })

  test("migrate creates an absent state directory", async () => {
    await withRun(
      async (run) => {
        const stateDir = join(run.dir, "absent", "ashe-agent")
        const result = await run.run(["migrate"], { env: { ASHE_AGENT_STATE_DIR: stateDir } })
        expect(result.code).toBe(0)
        expect(existsSync(join(stateDir, "database", "ashe-agent.db"))).toBe(true)
        const beside = readdirSync(join(stateDir, "database")).filter((name) => name !== "ashe-agent.db")
        expect(beside.every((name) => name === "ashe-agent.db-wal" || name === "ashe-agent.db-shm")).toBe(true)
        expect(readdirSync(stateDir)).toEqual(["database"])
      },
      { fresh: true, serve: false },
    )
  })

  test("serve exits nonzero when it cannot listen", async () => {
    const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
    try {
      await withRun(
        async (run) => {
          const result = await run.run(["serve"], { env: { ASHE_AGENT_LISTEN_PORT: String(occupied.port) } })
          expect(result.code).toBe(1)
          expect(result.stderr).toContain("serve stopped")
        },
        { serve: false },
      )
    } finally {
      occupied.stop(true)
    }
  })

  test("db dump writes a copy that opens, and migrate status lists applied migrations", async () => {
    await withRun(
      async (run) => {
        const status = await run.run(["migrate", "status"])
        expect(status.stdout).toContain("applied  0002_credentials.sql")
        const destination = join(run.dir, "dump.db")
        expect((await run.run(["db", "dump", destination])).code).toBe(0)
        const copy = new Database(destination, { readonly: true })
        expect(copy.query("SELECT count(*) AS n FROM api_tokens").get()).toEqual({ n: 0 })
        copy.close()
      },
      { serve: false },
    )
  })
})

describe("migration gate", () => {
  test("serve refuses a pending migration, and status reports it without writing", async () => {
    await withRun(
      async (run) => {
        mkdirSync(dirname(run.databasePath), { recursive: true })
        const db = new Database(run.databasePath, { create: true })
        db.run("PRAGMA journal_mode = WAL")
        db.close()
        const before = readFileSync(run.databasePath)
        const status = await run.run(["migrate", "status"])
        expect(status.code).toBe(0)
        expect(status.stdout).toContain("pending  0001_checkpoints.sql")
        expect(readFileSync(run.databasePath).equals(before)).toBe(true)
        const serve = await run.run(["serve"])
        expect(serve.code).toBe(1)
        expect(serve.stderr).toContain("pending")
      },
      { fresh: true, serve: false },
    )
  })

  test("serve refuses a drifted ledger, and status reports it without writing", async () => {
    await withRun(
      async (run) => {
        const db = new Database(run.databasePath)
        db.run("UPDATE schema_migrations SET sha256 = ? WHERE position = 1", ["0".repeat(64)])
        db.run("PRAGMA wal_checkpoint(TRUNCATE)")
        db.close()
        const before = readFileSync(run.databasePath)
        const status = await run.run(["migrate", "status"])
        expect(status.code).toBe(1)
        expect(status.stderr).toContain("checksum")
        expect(readFileSync(run.databasePath).equals(before)).toBe(true)
        const serve = await run.run(["serve"])
        expect(serve.code).toBe(1)
        expect(serve.stderr).toContain("checksum")
      },
      { serve: false },
    )
  })
})

describe("authentication over a real WebSocket", () => {
  test("serve prints its WebSocket URL", async () => {
    await withRun(async (_run, url) => expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/v1\/ws$/))
  })

  test("login and refresh authenticate their own connections", async () => {
    await withRun(async (_run, url) => {
      const first = await login(url)
      await expectAuthenticated(first.client)
      const refreshed = await refreshWith(url, first.response.result.refreshToken)
      expect(refreshed.response.result.principal).toEqual(first.response.result.principal)
      await expectAuthenticated(refreshed.client)
    })
  })

  test("an access token from login and an API token authenticate a new connection", async () => {
    await withRun(async (run, url) => {
      const first = await login(url)
      const access = await authenticateWith(url, first.response.result.accessToken)
      expect(access.response.result.principal).toEqual(first.response.result.principal)
      await expectAuthenticated(access.client)
      const token = (await run.run(["token", "create", "auth-test"])).stdout.trim()
      const api = await authenticateWith(url, token)
      expect(api.response.result.principal).toMatchObject({ kind: "token", name: "auth-test" })
      await expectAuthenticated(api.client)
    })
  })

  test("tokens are valid for 15 minutes and 30 days, and every credential is stored hashed", async () => {
    await withRun(async (_run, url) => {
      const before = Date.now()
      const { response } = await login(url)
      const tokens = response.result
      expect(tokens.accessTokenExpiresAt - before).toBeGreaterThanOrEqual(15 * 60_000 - 5_000)
      expect(tokens.accessTokenExpiresAt - before).toBeLessThanOrEqual(15 * 60_000 + 5_000)
      expect(tokens.refreshTokenExpiresAt - before).toBeGreaterThanOrEqual(30 * 86_400_000 - 5_000)
      expect(tokens.refreshTokenExpiresAt - before).toBeLessThanOrEqual(30 * 86_400_000 + 5_000)
    }, {})
    await withRun(async (run, url) => {
      const { response } = await login(url)
      const db = new Database(run.databasePath, { readonly: true })
      const dump = JSON.stringify([
        db.query("SELECT * FROM access_tokens").all(),
        db.query("SELECT * FROM refresh_tokens").all(),
      ])
      const access = db.query<{ token_hash: string }, []>("SELECT token_hash FROM access_tokens").all()
      const refresh = db.query<{ token_hash: string }, []>("SELECT token_hash FROM refresh_tokens").all()
      db.close()
      expect(access.map((row) => row.token_hash)).toEqual([tokenHash(response.result.accessToken)])
      expect(refresh.map((row) => row.token_hash)).toEqual([tokenHash(response.result.refreshToken)])
      for (const secret of [response.result.accessToken, response.result.refreshToken]) {
        expect(dump).not.toContain(secret)
      }
    })
  })

  test("missing, malformed, expired, and revoked tokens are refused and close the connection", async () => {
    await withRun(async (run, url) => {
      const missing = await Client.connect(url)
      expect((await missing.request("auth.authenticate", { protocolVersion: 1 })).error.code).toBe(-32602)
      await missing.waitClosed()

      const malformed = await authenticateWith(url, "not-a-token")
      expect(malformed.response.error.code).toBe(-32002)
      expect((await malformed.client.waitClosed()).code).toBe(1008)

      const fresh = await login(url)
      const db = new Database(run.databasePath)
      db.run("UPDATE access_tokens SET expires_at = 0 WHERE token_hash = ?", [tokenHash(fresh.response.result.accessToken)])
      db.close()
      const expired = await authenticateWith(url, fresh.response.result.accessToken)
      expect(expired.response.error.code).toBe(-32002)
      await expired.client.waitClosed()

      const token = (await run.run(["token", "create", "to-revoke"])).stdout.trim()
      expect((await run.run(["token", "revoke", "to-revoke"])).code).toBe(0)
      const revoked = await authenticateWith(url, token)
      expect(revoked.response.error.code).toBe(-32002)
      await revoked.client.waitClosed()
    })
  })

  test("a first message that does not authenticate closes the connection", async () => {
    await withRun(async (_run, url) => {
      const client = await Client.connect(url)
      expect((await client.request("models.list")).error.code).toBe(-32001)
      expect((await client.waitClosed()).code).toBe(1008)
    })
  })

  test("a connection silent for 10 seconds is closed", async () => {
    await withRun(async (_run, url) => {
      const client = await Client.connect(url)
      const started = Date.now()
      expect((await client.waitClosed(15_000)).code).toBe(1008)
      expect(Date.now() - started).toBeGreaterThanOrEqual(9_000)
    })
  }, 25_000)

  test("a disallowed origin is refused at the upgrade, and an allowed one connects", async () => {
    await withRun(async (_run, url) => {
      await expect(Client.connect(url, "https://elsewhere.example")).rejects.toThrow()
      ;(await Client.connect(url, "http://127.0.0.1:5173")).close()
    })
  })

  test("a supported version authenticates and an unsupported one is refused naming the supported", async () => {
    await withRun(async (run, url) => {
      const token = (await run.run(["token", "create", "versions"])).stdout.trim()
      expect((await authenticateWith(url, token, 1)).response.result.principal.kind).toBe("token")
      const unsupported = await authenticateWith(url, token, 99)
      expect(unsupported.response.error.code).toBe(-32000)
      expect(unsupported.response.error.data.supportedVersions).toEqual([1])
      expect(unsupported.response.result).toBeUndefined()
      expect((await unsupported.client.waitClosed()).code).toBe(1008)
    })
  })
})

describe("refresh token rotation", () => {
  test("refresh rotates, and reusing a rotated token revokes its family", async () => {
    await withRun(async (_run, url) => {
      const { response } = await login(url)
      const first = response.result.refreshToken
      const rotated = (await refreshWith(url, first)).response
      expect(rotated.result.refreshToken).not.toBe(first)
      expect((await refreshWith(url, first)).response.error.code).toBe(-32002)
      expect((await refreshWith(url, rotated.result.refreshToken)).response.error.code).toBe(-32002)
      expect((await authenticateWith(url, rotated.result.accessToken)).response.error.code).toBe(-32002)
    })
  })

  test("reusing a rotated token that has expired still revokes its family", async () => {
    await withRun(async (run, url) => {
      const first = (await login(url)).response.result.refreshToken
      const rotated = (await refreshWith(url, first)).response.result
      const db = new Database(run.databasePath)
      db.run("UPDATE refresh_tokens SET expires_at = 0 WHERE token_hash = ?", [tokenHash(first)])
      db.close()
      expect((await refreshWith(url, first)).response.error.code).toBe(-32002)
      expect((await refreshWith(url, rotated.refreshToken)).response.error.code).toBe(-32002)
      expect((await authenticateWith(url, rotated.accessToken)).response.error.code).toBe(-32002)
    })
  })
})

describe("API token lifecycle", () => {
  test("a token is printed once, stored as its hash, listed, revoked, and its name reused", async () => {
    await withRun(async (run, url) => {
      const created = await run.run(["token", "create", "laptop"])
      expect(created.code).toBe(0)
      const token = created.stdout.trim()
      expect(created.stdout).toBe(`${token}\n`)

      const db = new Database(run.databasePath, { readonly: true })
      const stored = db.query<Record<string, unknown>, []>("SELECT * FROM api_tokens").all()
      db.close()
      expect(stored).toHaveLength(1)
      expect(stored[0]!.token_hash).toBe(tokenHash(token))
      expect(JSON.stringify(stored)).not.toContain(token)

      expect((await run.run(["token", "list"])).stdout).toMatch(/^laptop\tcreated \S+\tlast used never\n$/)
      expect((await run.run(["token", "create", ""])).code).toBe(1)
      expect((await run.run(["token", "create", "laptop"])).code).toBe(1)

      const connection = await authenticateWith(url, token)
      const firstId = connection.response.result.principal.tokenId
      expect((await run.run(["token", "list"])).stdout).not.toContain("last used never")
      expect((await run.run(["token", "revoke", "laptop"])).code).toBe(0)
      expect((await connection.client.waitClosed()).code).toBe(1008)
      expect((await authenticateWith(url, token)).response.error.code).toBe(-32002)
      expect((await run.run(["token", "list"])).stdout).not.toContain("laptop")

      const again = (await run.run(["token", "create", "laptop"])).stdout.trim()
      const second = await authenticateWith(url, again)
      expect(second.response.result.principal.tokenId).not.toBe(firstId)
      expect((await authenticateWith(url, token)).response.error.code).toBe(-32002)
      expect((await run.run(["token", "list"])).stdout).toContain("laptop")
    })
  }, 20_000)
})

describe("agents over a real WebSocket", () => {
  test("an authenticated client lists the configured agents with their title file states and the default agent", async () => {
    await withRun(
      async (run, url) => {
        const dir = join(run.dir, ".config", "ashe-agent", "titles")
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "helper.md"), "---\ndescription: Helps\n---\nBody")
        writeFileSync(join(dir, "broken.md"), "---\nmode: sometimes\n---\n")
        const { client } = await login(url)
        expect((await client.request("agents.list")).result).toEqual({
          agents: [
            { key: "helper", title: "Helper", description: "Helps", model: "test/model", reasoningEfforts: {}, titleFile: { state: "present" } },
            {
              key: "broken",
              title: "Broken",
              description: null,
              model: null,
              reasoningEfforts: {},
              titleFile: { state: "refused", reason: 'its frontmatter holds "mode", not only description' },
            },
          ],
          defaultAgent: "helper",
        })
        const created = await client.request("session.create", {})
        expect(created.result.session).toMatchObject({ agent: "helper", model: "test/model" })
        client.close()
      },
      { env: { ASHE_AGENT_AGENTS: JSON.stringify({ helper: { model: "test/model" }, broken: {} }), ASHE_AGENT_DEFAULT_AGENT: "helper" } },
    )
  })
})

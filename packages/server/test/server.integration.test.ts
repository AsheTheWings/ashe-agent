import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { login as loginDirect, setOwnerPassword } from "../src/auth/credentials.ts"
import { tokenHash } from "../src/auth/tokens.ts"
import { openDatabase } from "../src/store/database.ts"
import { CliRun, Client, waitFor } from "./support/cli.ts"

const PASSWORD = "owner-password"

/** Runs `body` against a run-owned state directory, migrated with a password unless `fresh`, and cleans up. */
const withRun = async (
  body: (run: CliRun, url: string) => Promise<void>,
  options: { fresh?: boolean; serve?: boolean; env?: Record<string, string> } = {},
) => {
  const run = new CliRun(options.env)
  try {
    if (!options.fresh) await run.prepare(PASSWORD)
    const url = options.serve === false ? "" : await run.serve()
    await body(run, url)
  } finally {
    await run.cleanup()
  }
}

const login = async (url: string, password = PASSWORD) => {
  const client = await Client.connect(url)
  return { client, response: await client.request("auth.login", { password, protocolVersion: 1 }) }
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
        const result = await run.run(["serve"], { env: { ASHE_AGENT_LISTEN_PORT: "http", ASHE_AGENT_MODELS: "[]" } })
        expect(result.code).toBe(2)
        expect(result.stderr).toContain("ASHE_AGENT_LISTEN_PORT")
        expect(result.stderr).toContain("ASHE_AGENT_MODELS")
        expect(result.stdout).toBe("")
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
        expect(existsSync(join(stateDir, "ashe-agent.db"))).toBe(true)
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
        expect(copy.query("SELECT 1 FROM owner WHERE id = 1").get()).not.toBeNull()
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

  test("login is refused while no owner password is set", async () => {
    await withRun(
      async (run) => {
        expect((await run.run(["migrate"])).code).toBe(0)
        const url = await run.serve()
        const { client, response } = await login(url, "anything")
        expect(response.error.code).toBe(-32002)
        expect(response.error.message).toContain("no owner password")
        expect((await client.waitClosed()).code).toBe(1008)
      },
      { fresh: true, serve: false },
    )
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
        db.query("SELECT * FROM owner").all(),
      ])
      const access = db.query<{ token_hash: string }, []>("SELECT token_hash FROM access_tokens").all()
      const refresh = db.query<{ token_hash: string }, []>("SELECT token_hash FROM refresh_tokens").all()
      const owner = db.query<{ password_hash: string }, []>("SELECT password_hash FROM owner").get()!
      db.close()
      expect(access.map((row) => row.token_hash)).toEqual([tokenHash(response.result.accessToken)])
      expect(refresh.map((row) => row.token_hash)).toEqual([tokenHash(response.result.refreshToken)])
      expect(owner.password_hash.startsWith("$argon2id$")).toBe(true)
      for (const secret of [response.result.accessToken, response.result.refreshToken, PASSWORD]) {
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

describe("refresh, sign-out, and rate limiting", () => {
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

  test("a password change revokes refresh tokens and closes login connections", async () => {
    await withRun(async (run, url) => {
      const { client, response } = await login(url)
      expect((await run.run(["owner", "set-password"], { stdin: "another-password\n" })).code).toBe(0)
      expect((await client.waitClosed(5_000)).code).toBe(1008)
      expect((await refreshWith(url, response.result.refreshToken)).response.error.code).toBe(-32002)
      expect((await authenticateWith(url, response.result.accessToken)).response.error.code).toBe(-32002)
    })
  })

  test("five failed logins lock login, even with the right password", async () => {
    await withRun(async (_run, url) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        expect((await login(url, "wrong")).response.error.code).toBe(-32002)
      }
      const locked = (await login(url)).response
      expect(locked.error.code).toBe(-32003)
      expect(locked.error.data.retryAt).toBeGreaterThan(Date.now())
    })
  })

  test("concurrent failed logins cannot pass the limit together", async () => {
    await withRun(async (_run, url) => {
      const responses = await Promise.all(Array.from({ length: 12 }, () => login(url, "wrong")))
      const codes = responses.map(({ response }) => response.error.code)
      expect(codes.filter((code) => code === -32002)).toHaveLength(5)
      expect(codes.filter((code) => code === -32003)).toHaveLength(7)
    })
  })
})

describe("password change during a login", () => {
  test("a login whose verification overlaps a password change fails", async () => {
    await withRun(
      async (run) => {
        const db = openDatabase(run.databasePath)
        try {
          let release = () => {}
          const verifying = new Promise<void>((resolve) => (release = resolve))
          let verifyStarted = false
          const pending = loginDirect(db, PASSWORD, Date.now(), async (password, hash) => {
            verifyStarted = true
            const ok = await Bun.password.verify(password, hash)
            await verifying
            return ok
          })
          await waitFor("verification to start", () => (verifyStarted ? true : undefined))
          await setOwnerPassword(db, "changed-password", Date.now())
          release()
          expect((await pending).ok).toBe(false)
          expect(db.query("SELECT count(*) AS n FROM logins WHERE revoked_at IS NULL").get()).toEqual({ n: 0 })
        } finally {
          db.close()
        }
      },
      { serve: false },
    )
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
  })
})

describe("agents over a real WebSocket", () => {
  test("an authenticated client lists the valid agents and the refused agent files", async () => {
    await withRun(async (run, url) => {
      const dir = join(run.dir, ".config", "ashe-agent", "agents")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "helper.md"), "---\ndescription: Helps\nmode: primary\nmodel: test/model\n---\nBody")
      writeFileSync(join(dir, "broken.md"), "---\nmode: sometimes\n---\n")
      const { client } = await login(url)
      expect((await client.request("agents.list")).result).toEqual({
        agents: [{ name: "helper", description: "Helps", mode: "primary", model: "test/model" }],
        refused: [{ path: join(dir, "broken.md"), reason: "mode is not primary, subagent, or all" }],
      })
      client.close()
    })
  })
})

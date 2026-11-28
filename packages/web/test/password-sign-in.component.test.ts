import { afterEach, describe, expect, test } from "bun:test"
import { ErrorCode } from "@ashe-agent/protocol"
import { sha256 } from "@noble/hashes/sha2.js"
import { SessionClient, storageKeys } from "../src/session/client.ts"
import type { KeyValueStorage, SessionClientPorts, SocketHandlers } from "../src/session/ports.ts"

const SERVER_URL = "ws://server.test/v1/ws"

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

const memoryStorage = (): KeyValueStorage => {
  const entries = new Map<string, string>()
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  }
}

type SentRequest = { readonly id: number; readonly method: string; readonly params: Record<string, unknown> }

class FakeSocket {
  readonly requests: Array<SentRequest> = []
  constructor(
    readonly url: string,
    private readonly handlers: SocketHandlers,
    private readonly answer: (request: SentRequest) => unknown,
  ) {}
  send(text: string) {
    const request = JSON.parse(text) as SentRequest
    this.requests.push(request)
    const result = this.answer(request)
    queueMicrotask(() => this.handlers.onMessage(JSON.stringify({ jsonrpc: "2.0", id: request.id, result })))
  }
  close() {}
}

const fakePorts = (answer: (request: SentRequest) => unknown) => {
  const sockets: Array<FakeSocket> = []
  const ports: SessionClientPorts = {
    serverUrl: SERVER_URL,
    openSocket: (url, handlers) => {
      const socket = new FakeSocket(url, handlers, answer)
      sockets.push(socket)
      queueMicrotask(() => handlers.onOpen())
      return socket
    },
    storage: memoryStorage(),
    signIn: {
      storage: memoryStorage(), origin: "http://client.test", fragment: () => "",
      clearFragment: () => {}, navigate: () => {},
      randomBytes: () => new Uint8Array(32).fill(7),
    },
    withLock: (_name, task) => task(),
    now: () => Date.now(),
    setTimer: () => 0,
    clearTimer: () => {},
  }
  return { ports, sockets }
}

const until = async (what: string, condition: () => boolean) => {
  for (let turn = 0; turn < 1_000; turn++) {
    if (condition()) return
    await null
  }
  throw new Error(`timed out waiting for ${what}`)
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const stubFetch = (response: () => Promise<Response>) => {
  const seen: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url, init: init ?? {} })
    return response()
  }) as unknown as typeof fetch
  return seen
}

const answerExchange = () => ({
  accessToken: "access-1",
  accessTokenExpiresAt: Date.now() + 15 * 60_000,
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: Date.now() + 30 * 86_400_000,
  principal: { kind: "login", loginId: "l1" },
})

describe("development password sign-in", () => {
  test("a correct password posts to the password endpoint and exchanges its code", async () => {
    const seen = stubFetch(async () => Response.json({ signIn: "code-1" }))
    const { ports, sockets } = fakePorts(() => answerExchange())
    const client = new SessionClient(ports)
    await client.signInWithPassword("correct horse battery staple")
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe("http://server.test/v1/auth/password/exchange")
    const body = JSON.parse(seen[0]!.init.body as string) as Record<string, unknown>
    const verifier = base64url(new Uint8Array(32).fill(7))
    expect(body).toEqual({
      origin: "http://client.test",
      challenge: base64url(sha256(new TextEncoder().encode(verifier))),
      password: "correct horse battery staple",
    })
    await until("exchange", () => sockets.length > 0 && sockets[0]!.requests.length > 0)
    expect(sockets[0]!.requests[0]).toMatchObject({ method: "auth.exchange", params: { code: "code-1", verifier } })
    expect(client.store.getState().error).toBeNull()
  })

  test("a wrong password, throttling, and an unavailable endpoint stay signed out with a reason", async () => {
    for (const [status, message] of [[401, "Incorrect password. Try again."], [429, "Too many attempts. Try again in a minute."], [404, "Password sign-in is unavailable on this server."]] as const) {
      const seen = stubFetch(async () => new Response("no", { status }))
      const { ports, sockets } = fakePorts(() => answerExchange())
      const client = new SessionClient(ports)
      await client.signInWithPassword("wrong")
      expect(seen).toHaveLength(1)
      expect(sockets).toHaveLength(0)
      expect(client.store.getState().error).toBe(message)
    }
  })

  test("an unreachable endpoint and malformed 200 JSON report safe errors without touching sessionStorage", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch
    const { ports, sockets } = fakePorts(() => answerExchange())
    const client = new SessionClient(ports)
    await client.signInWithPassword("correct horse battery staple")
    expect(sockets).toHaveLength(0)
    expect(client.store.getState().status).toBe("signedOut")
    expect(client.store.getState().error).toBe("down")
    expect(ports.signIn.storage.getItem("ashe-agent.sign-in-verifier")).toBeNull()

    stubFetch(async () => new Response("not-json", { status: 200 }))
    await client.signInWithPassword("correct horse battery staple")
    expect(client.store.getState().status).toBe("signedOut")
    expect(client.store.getState().error).toBe("Password sign-in failed. Try again.")
  })

  test("in-flight password sign-in marks connecting and ignores stale responses", async () => {
    let resolveFirst!: (response: Response) => void
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve
    })
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return calls === 1 ? firstResponse : Response.json({ signIn: "code-2" })
    }) as unknown as typeof fetch
    const { ports, sockets } = fakePorts(() => answerExchange())
    const client = new SessionClient(ports)
    const first = client.signInWithPassword("first-attempt")
    expect(client.store.getState().status).toBe("connecting")
    const second = client.signInWithPassword("second-attempt")
    await second
    resolveFirst(new Response("no", { status: 401 }))
    await first
    await until("second exchange", () => sockets.length > 0 && sockets[0]!.requests.length > 0)
    expect(sockets[0]!.requests[0]).toMatchObject({ method: "auth.exchange", params: { code: "code-2" } })
    expect(client.store.getState().error).toBeNull()
  })

  test("authMethods reads the server's enabled sign-in methods and defaults safely when unreachable", async () => {
    const seen = stubFetch(async () => Response.json({ github: false, password: true }))
    const { ports } = fakePorts(() => answerExchange())
    const client = new SessionClient(ports)
    expect(await client.authMethods()).toEqual({ github: false, password: true })
    expect(seen[0]!.url).toBe("http://server.test/v1/auth/methods")
    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch
    expect(await client.authMethods()).toEqual({ github: true, password: false })
  })

  test("resume sets restoring synchronously until refresh settles, while password sign-in keeps restoring false", async () => {
    const { ports } = fakePorts((request) => {
      if (request.method === "auth.refresh") return answerExchange()
      if (request.method === "models.list") return { models: [] }
      if (request.method === "agents.list") return { agents: [] }
      if (request.method === "session.list") return { sessions: [] }
      if (request.method === "actions.list") return { actions: [] }
      return {}
    })
    ports.storage.setItem(storageKeys.refreshToken(SERVER_URL), "stored-refresh")
    const client = new SessionClient(ports)
    expect(client.store.getState().restoring).toBe(false)
    client.resume()
    expect(client.store.getState().restoring).toBe(true)
    expect(client.store.getState().status).toBe("connecting")
    await until("connected", () => client.store.getState().status === "connected")
    expect(client.store.getState().restoring).toBe(false)

    // Interactive password sign-in stays on the sign-in screen (restoring remains false).
    stubFetch(async () => Response.json({ signIn: "code-3" }))
    const interactive = new SessionClient(fakePorts(() => answerExchange()).ports)
    const pending = interactive.signInWithPassword("secret")
    expect(interactive.store.getState().restoring).toBe(false)
    await pending
    expect(interactive.store.getState().restoring).toBe(false)

    // Revoked/expired stored refresh token clears restoring and returns to signedOut.
    const failingStorage = memoryStorage()
    failingStorage.setItem(storageKeys.refreshToken(SERVER_URL), "expired-refresh")
    const failingPorts: SessionClientPorts = {
      serverUrl: SERVER_URL,
      openSocket: (_url, handlers) => {
        const socket = {
          send: (text: string) => {
            const req = JSON.parse(text) as SentRequest
            queueMicrotask(() =>
              handlers.onMessage(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: req.id,
                  error: { code: ErrorCode.authenticationFailed, message: "refresh token expired" },
                }),
              ),
            )
          },
          close: () => {},
        }
        queueMicrotask(() => handlers.onOpen())
        return socket
      },
      storage: failingStorage,
      signIn: ports.signIn,
      withLock: (_name, task) => task(),
      now: () => Date.now(),
      setTimer: () => 0,
      clearTimer: () => {},
    }
    const failingClient = new SessionClient(failingPorts)
    failingClient.resume()
    expect(failingClient.store.getState().restoring).toBe(true)
    await until("signedOut", () => failingClient.store.getState().status === "signedOut")
    expect(failingClient.store.getState().restoring).toBe(false)
    expect(failingClient.store.getState().error).toBe("refresh token expired")
  })
})

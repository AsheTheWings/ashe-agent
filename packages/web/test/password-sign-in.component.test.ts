import { afterEach, describe, expect, test } from "bun:test"
import { sha256 } from "@noble/hashes/sha2.js"
import { SessionClient } from "../src/session/client.ts"
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

  test("an unreachable endpoint reports its failure", async () => {
  globalThis.fetch = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch
    const { ports, sockets } = fakePorts(() => answerExchange())
    const client = new SessionClient(ports)
    await client.signInWithPassword("correct horse battery staple")
    expect(sockets).toHaveLength(0)
    expect(client.store.getState().error).toBe("down")
  })
})

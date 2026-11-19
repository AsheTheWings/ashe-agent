import { describe, expect, test } from "bun:test"
import { Redacted } from "effect"
import { challengeOf, randomToken } from "../src/auth/github.ts"
import { PasswordSignIn } from "../src/auth/password.ts"

const origins = ["http://127.0.0.1:5173"]
const config = { ownerId: 42, secret: Redacted.make("correct horse battery staple") }

const signIn = (now = () => Date.now()) => new PasswordSignIn(config, now)
const verifier = randomToken()
const challenge = challengeOf(verifier)

describe("development password sign-in", () => {
  test("a correct password mints an exchangeable code", () => {
    const password = signIn()
    const started = password.start(origins[0]!, origins, challenge, "correct horse battery staple")
    expect(started.outcome).toBe("signed_in")
    expect(typeof started.code).toBe("string")
    expect(password.exchange(started.code!, verifier)).toBe(42)
  })

  test("an unlisted origin and a malformed challenge never reach the password", () => {
    const password = signIn()
    expect(password.start("http://evil.example", origins, challenge, "correct horse battery staple").outcome).toBe("origin_not_allowed")
    expect(password.start(null, origins, challenge, "correct horse battery staple").outcome).toBe("origin_not_allowed")
    expect(password.start(origins[0]!, origins, "short", "correct horse battery staple").outcome).toBe("bad_request")
    expect(password.start(origins[0]!, origins, challenge, null).outcome).toBe("bad_request")
  })

  test("a wrong password fails closed without minting a code", () => {
    const password = signIn()
    expect(password.start(origins[0]!, origins, challenge, "wrong").outcome).toBe("wrong_password")
    expect(password.start(origins[0]!, origins, challenge, "").outcome).toBe("wrong_password")
  })

  test("ten wrong passwords throttle the window, and a correct one resets it", () => {
    let now = 1_000
    const password = signIn(() => now)
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(password.start(origins[0]!, origins, challenge, "wrong").outcome).toBe("wrong_password")
    }
    expect(password.start(origins[0]!, origins, challenge, "wrong").outcome).toBe("sign_in_throttled")
    expect(password.start(origins[0]!, origins, challenge, "correct horse battery staple").outcome).toBe("sign_in_throttled")
    now += 60_001
    const started = password.start(origins[0]!, origins, challenge, "correct horse battery staple")
    expect(started.outcome).toBe("signed_in")
    expect(password.exchange(started.code!, verifier)).toBe(42)
  })

  test("a code is spent by its first exchange and expires", () => {
    let now = 1_000
    const password = signIn(() => now)
    const first = password.start(origins[0]!, origins, challenge, "correct horse battery staple")
    expect(password.exchange(first.code!, "another-verifier-that-is-long-enough-123456789")).toBeNull()
    expect(password.exchange(first.code!, verifier)).toBeNull()
    const second = password.start(origins[0]!, origins, challenge, "correct horse battery staple")
    now += 61_000
    expect(password.exchange(second.code!, verifier)).toBeNull()
  })
})

import { timingSafeEqual } from "node:crypto"
import { Redacted } from "effect"
import { endSpan, startSpan, type ErrorClass } from "../telemetry/signals.ts"
import { CHALLENGE, challengeOf, randomToken, SIGN_IN_CODE_TTL_MS } from "./github.ts"

/** How many wrong passwords a window tolerates before it throttles. */
export const PASSWORD_ATTEMPT_LIMIT = 10

/** How long a window of wrong passwords lasts. */
export const PASSWORD_ATTEMPT_WINDOW_MS = 60_000

/** The longest password the exchange reads; longer bodies are refused before parsing. */
export const PASSWORD_REQUEST_LIMIT_BYTES = 4_096

/** The development password the owner signs in with, and the owner's user ID its logins carry. */
export interface PasswordSignInConfig {
  readonly ownerId: number
  readonly secret: Redacted.Redacted<string>
}

/** How a password exchange ended, as its span records it. */
export type PasswordSignInOutcome = "signed_in" | "wrong_password" | "sign_in_throttled"

const errorClassOf: Record<Exclude<PasswordSignInOutcome, "signed_in">, ErrorClass> = {
  wrong_password: "wrong_password",
  sign_in_throttled: "sign_in_throttled",
}

interface PasswordSignInCode {
  readonly challenge: string
  readonly expiresAt: number
}

const digest = (password: string): Buffer => Buffer.from(new Bun.CryptoHasher("sha256").update(password).digest())

/**
 * Development password sign-in. `start` checks the origin, the challenge,
 * and the password, and mints a one-time code bound to the challenge;
 * `exchange` spends the code when its verifier matches. Throttling counts
 * wrong passwords in a window; a correct password resets the count.
 */
export class PasswordSignIn {
  readonly #codes = new Map<string, PasswordSignInCode>()
  #failures = 0
  #windowEndsAt = 0

  constructor(
    private readonly config: PasswordSignInConfig,
    private readonly now: () => number = Date.now,
  ) {}

  start(
    origin: string | null,
    origins: ReadonlyArray<string>,
    challenge: unknown,
    password: unknown,
  ): { outcome: PasswordSignInOutcome | "origin_not_allowed" | "bad_request"; code?: string } {
    if (origin === null || !origins.includes(origin)) return { outcome: "origin_not_allowed" }
    if (typeof challenge !== "string" || !CHALLENGE.test(challenge) || typeof password !== "string") {
      return { outcome: "bad_request" }
    }
    const span = startSpan("ashe_agent.password_sign_in", {})
    const now = this.now()
    if (this.#windowEndsAt > 0 && now >= this.#windowEndsAt) {
      this.#windowEndsAt = 0
      this.#failures = 0
    }
    if (this.#failures >= PASSWORD_ATTEMPT_LIMIT) {
      endSpan(span, { "ashe_agent.sign_in.outcome": "sign_in_throttled" }, errorClassOf.sign_in_throttled)
      return { outcome: "sign_in_throttled" }
    }
    const expected = digest(Redacted.value(this.config.secret))
    const presented = digest(password)
    if (!timingSafeEqual(presented, expected)) {
      if (this.#failures === 0) this.#windowEndsAt = now + PASSWORD_ATTEMPT_WINDOW_MS
      this.#failures += 1
      endSpan(span, { "ashe_agent.sign_in.outcome": "wrong_password" }, errorClassOf.wrong_password)
      return { outcome: "wrong_password" }
    }
    this.#failures = 0
    this.#windowEndsAt = 0
    this.dropExpiredCodes(now)
    while (this.#codes.size >= 64) this.#codes.delete(this.#codes.keys().next().value!)
    const code = randomToken()
    this.#codes.set(code, { challenge, expiresAt: now + SIGN_IN_CODE_TTL_MS })
    endSpan(span, { "ashe_agent.sign_in.outcome": "signed_in" })
    return { outcome: "signed_in", code }
  }

  /**
   * Spends a sign-in code: the owner's ID when it is unexpired and
   * `verifier`'s challenge is the one it is bound to, else null. A code is
   * spent by its first exchange, whatever the outcome.
   */
  exchange(code: string, verifier: string): number | null {
    const now = this.now()
    this.dropExpiredCodes(now)
    const entry = this.#codes.get(code)
    if (entry === undefined) return null
    this.#codes.delete(code)
    const expected = Buffer.from(entry.challenge)
    const actual = Buffer.from(challengeOf(verifier))
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? this.config.ownerId : null
  }

  private dropExpiredCodes(now: number): void {
    for (const [code, entry] of this.#codes) if (entry.expiresAt <= now) this.#codes.delete(code)
  }
}

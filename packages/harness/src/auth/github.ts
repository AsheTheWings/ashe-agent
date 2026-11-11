import { timingSafeEqual } from "node:crypto"
import { Redacted } from "effect"
import { emitLog, endSpan, startSpan, type ErrorClass } from "../telemetry/signals.ts"

/** How long a pending sign-in waits for GitHub's callback. */
export const PENDING_SIGN_IN_TTL_MS = 10 * 60 * 1000

/** How many pending sign-ins the server holds; a new one drops the oldest. */
export const PENDING_SIGN_IN_LIMIT = 64

/** How long a sign-in code waits for its exchange. */
export const SIGN_IN_CODE_TTL_MS = 60 * 1000

/** How long each request to GitHub may take, its body included. */
export const GITHUB_REQUEST_TIMEOUT_MS = 10_000

/** The GitHub OAuth app the owner signs in through, and the one GitHub user who may. */
export interface GithubSignInConfig {
  readonly clientId: string
  readonly clientSecret: Redacted.Redacted<string>
  readonly callbackUrl: string
  readonly ownerId: number
  /** Base of the authorize and token endpoints. */
  readonly githubUrl: string
  /** Base of the REST API. */
  readonly githubApiUrl: string
}

/** How a callback ended, as its span records it. */
export type SignInOutcome = "signed_in" | "denied" | "not_owner" | "github_failed" | "unknown_state"

/** The reason a client is sent back without a sign-in code, as the `signInError` fragment names it. */
type SignInError = "denied" | "not_owner" | "github_failed"

const errorClassOf: Record<Exclude<SignInOutcome, "signed_in">, ErrorClass> = {
  denied: "sign_in_denied",
  not_owner: "not_owner",
  github_failed: "github_failed",
  unknown_state: "sign_in_unknown_state",
}

interface PendingSignIn {
  readonly origin: string
  readonly challenge: string
  readonly verifier: string
  readonly expiresAt: number
}

interface SignInCode {
  readonly challenge: string
  readonly githubUserId: number
  readonly expiresAt: number
}

/** 32 random bytes in base64url: 43 characters, 256 bits. */
export const randomToken = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")

/** The S256 challenge of a PKCE verifier: the base64url SHA-256 of its text. */
export const challengeOf = (verifier: string): string =>
  Buffer.from(new Bun.CryptoHasher("sha256").update(verifier).digest()).toString("base64url")

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/

const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, "")

/** A response no cache keeps and no navigation refers to. */
const respond = (status: number, body: string | null, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...headers } })

const redirect = (location: string) => respond(302, null, { Location: location })

/** Thrown when a GitHub request fails, times out, or answers without what it should. */
class GithubFailure extends Error {}

const githubJson = async (url: string, init: RequestInit): Promise<Record<string, unknown>> => {
  let body: unknown
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS) })
    if (!response.ok) throw new GithubFailure()
    body = await response.json()
  } catch {
    throw new GithubFailure()
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new GithubFailure()
  return body as Record<string, unknown>
}

/**
 * GitHub sign-in for the owner. `start` records a pending sign-in and sends
 * the browser to GitHub; `callback` exchanges GitHub's code, accepts only
 * the configured owner, and sends the browser back to its origin with a
 * one-time sign-in code bound to the client's challenge; `exchange` spends
 * that code. Pending sign-ins and sign-in codes live only in this object.
 */
export class GithubSignIn {
  private readonly pending = new Map<string, PendingSignIn>()
  private readonly codes = new Map<string, SignInCode>()
  private readonly githubUrl: string
  private readonly githubApiUrl: string

  constructor(
    private readonly config: GithubSignInConfig,
    private readonly origins: ReadonlyArray<string>,
    private readonly now: () => number = Date.now,
  ) {
    this.githubUrl = withoutTrailingSlash(config.githubUrl)
    this.githubApiUrl = withoutTrailingSlash(config.githubApiUrl)
  }

  /** Answers the start path: a redirect to GitHub's authorize page, or 400 for an unlisted origin or a malformed challenge. */
  start(url: URL): Response {
    const origin = url.searchParams.get("origin")
    const challenge = url.searchParams.get("challenge")
    if (origin === null || !this.origins.includes(origin)) return respond(400, "origin not allowed")
    if (challenge === null || !CHALLENGE.test(challenge)) return respond(400, "challenge must be 43 base64url characters")
    const now = this.now()
    for (const [state, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(state)
    while (this.pending.size >= PENDING_SIGN_IN_LIMIT) this.pending.delete(this.pending.keys().next().value!)
    const state = randomToken()
    const verifier = randomToken()
    this.pending.set(state, { origin, challenge, verifier, expiresAt: now + PENDING_SIGN_IN_TTL_MS })
    const authorize = new URL(`${this.githubUrl}/login/oauth/authorize`)
    authorize.searchParams.set("client_id", this.config.clientId)
    authorize.searchParams.set("redirect_uri", this.config.callbackUrl)
    authorize.searchParams.set("state", state)
    authorize.searchParams.set("code_challenge", challengeOf(verifier))
    authorize.searchParams.set("code_challenge_method", "S256")
    authorize.searchParams.set("allow_signup", "false")
    return redirect(authorize.href)
  }

  /** Answers the callback path, traced as one `ashe_agent.github_sign_in` span. */
  async callback(url: URL): Promise<Response> {
    const span = startSpan("ashe_agent.github_sign_in", {})
    let outcome: SignInOutcome = "github_failed"
    try {
      const result = await this.complete(url)
      outcome = result.outcome
      return result.response
    } finally {
      endSpan(span, { "ashe_agent.sign_in.outcome": outcome }, outcome === "signed_in" ? undefined : errorClassOf[outcome])
    }
  }

  /**
   * Spends a sign-in code: the GitHub user it was created for, when it is
   * unexpired and `verifier`'s challenge is the one it is bound to, else
   * null. A code is spent by its first exchange, whatever the outcome.
   */
  exchange(code: string, verifier: string): number | null {
    const now = this.now()
    this.dropExpiredCodes(now)
    const entry = this.codes.get(code)
    if (entry === undefined) return null
    this.codes.delete(code)
    const expected = Buffer.from(entry.challenge)
    const actual = Buffer.from(challengeOf(verifier))
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? entry.githubUserId : null
  }

  private dropExpiredCodes(now: number) {
    for (const [code, entry] of this.codes) if (entry.expiresAt <= now) this.codes.delete(code)
  }

  private async complete(url: URL): Promise<{ outcome: SignInOutcome; response: Response }> {
    const state = url.searchParams.get("state")
    const pending = state === null ? undefined : this.pending.get(state)
    if (state !== null) this.pending.delete(state)
    if (pending === undefined || pending.expiresAt <= this.now()) {
      return { outcome: "unknown_state", response: respond(400, "unknown sign-in state") }
    }
    const back = (error: SignInError) => ({
      outcome: error,
      response: redirect(`${pending.origin}/#signInError=${error}`),
    })
    if (url.searchParams.has("error")) return back("denied")
    const code = url.searchParams.get("code")
    if (code === null || code.length === 0) return back("github_failed")
    let token: string
    try {
      token = await this.exchangeCode(code, pending.verifier)
    } catch {
      return back("github_failed")
    }
    let userId: number | null = null
    try {
      userId = await this.lookUpUser(token)
    } catch {
      userId = null
    } finally {
      await this.revoke(token)
    }
    if (userId === null) return back("github_failed")
    if (userId !== this.config.ownerId) return back("not_owner")
    const now = this.now()
    this.dropExpiredCodes(now)
    const signInCode = randomToken()
    this.codes.set(signInCode, { challenge: pending.challenge, githubUserId: userId, expiresAt: now + SIGN_IN_CODE_TTL_MS })
    return { outcome: "signed_in", response: redirect(`${pending.origin}/#signIn=${signInCode}`) }
  }

  private async exchangeCode(code: string, verifier: string): Promise<string> {
    const body = await githubJson(`${this.githubUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: Redacted.value(this.config.clientSecret),
        code,
        redirect_uri: this.config.callbackUrl,
        code_verifier: verifier,
      }),
    })
    const token = body.access_token
    if (typeof token !== "string" || token.length === 0) throw new GithubFailure()
    return token
  }

  private async lookUpUser(token: string): Promise<number> {
    const body = await githubJson(`${this.githubApiUrl}/user`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "ashe-agent" },
    })
    const id = body.id
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw new GithubFailure()
    return id
  }

  /** Revokes a GitHub token; a failure is logged and changes nothing else. */
  private async revoke(token: string): Promise<void> {
    const credentials = Buffer.from(`${this.config.clientId}:${Redacted.value(this.config.clientSecret)}`).toString("base64")
    let revoked = false
    try {
      const response = await fetch(`${this.githubApiUrl}/applications/${encodeURIComponent(this.config.clientId)}/token`, {
        method: "DELETE",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/json",
          "User-Agent": "ashe-agent",
        },
        body: JSON.stringify({ access_token: token }),
        signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
      })
      await response.body?.cancel()
      revoked = response.ok
    } catch {
      revoked = false
    }
    if (!revoked) emitLog("ashe_agent.github_token_revoke_failed", { "error.type": "github_failed" })
  }
}

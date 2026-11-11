import { OWNER_IDENTITY_PATH, OwnerIdentity, type Sender } from "@ashe-agent/protocol"
import { Schema } from "effect"
import type { WebIdentity } from "../shared/web-state.ts"

export class AuthenticationError extends Error {
  constructor(
    readonly code: "unauthenticated" | "expired" | "binding",
    message: string,
  ) {
    super(message)
    this.name = "AuthenticationError"
  }
}

export const principalLabel = (principal: Sender): string =>
  principal.kind === "login" ? `login:${principal.loginId}` : `token:${principal.tokenId}`

export const httpOrigin = (websocketUrl: string): string => {
  const url = new URL(websocketUrl)
  url.protocol = url.protocol === "wss:" ? "https:" : "http:"
  return url.origin
}

/** Validates one current credential through the configured harness and returns its durable binding. */
export const validateCredential = async (
  harnessUrl: string,
  token: string,
  now: () => number = Date.now,
): Promise<WebIdentity> => {
  let response: Response
  try {
    response = await fetch(new URL(OWNER_IDENTITY_PATH, httpOrigin(harnessUrl)), {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new AuthenticationError("unauthenticated", "the harness could not be reached")
  }
  if (response.status === 401 || response.status === 403) throw new AuthenticationError("unauthenticated", "the credential is not authorized")
  if (!response.ok) throw new AuthenticationError("unauthenticated", `the harness answered ${response.status}`)
  const decoded = Schema.decodeUnknownResult(OwnerIdentity)(await response.json())
  if (decoded._tag === "Failure") throw new AuthenticationError("unauthenticated", "the harness identity response is malformed")
  const identity = decoded.success
  if (identity.credentialExpiresAt !== null && identity.credentialExpiresAt <= now()) {
    throw new AuthenticationError("expired", "the credential expired")
  }
  return {
    principal: principalLabel(identity.principal),
    harnessId: identity.harnessId,
    credentialExpiresAt: identity.credentialExpiresAt,
  }
}

/** The origin a browser WebSocket upgrade presented is one this backend serves. */
export const originAllowed = (origin: string | null, allowed: ReadonlyArray<string>): boolean =>
  origin !== null && allowed.includes(origin)

/** A bounded request body; callers reject one larger than this before parsing it. */
export const MAX_MESSAGE_BYTES = 64 * 1024

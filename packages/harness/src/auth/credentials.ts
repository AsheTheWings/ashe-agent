import type { Database } from "bun:sqlite"
import type { Sender } from "@ashe-agent/protocol"
import { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS, newToken, tokenHash, tokenKind } from "./tokens.ts"

export interface Tokens {
  readonly accessToken: string
  readonly accessTokenExpiresAt: number
  readonly refreshToken: string
  readonly refreshTokenExpiresAt: number
  readonly principal: Sender
}

export type RefreshResult = { readonly ok: true; readonly tokens: Tokens } | { readonly ok: false }

export type AuthenticateResult = { readonly ok: true; readonly principal: Sender } | { readonly ok: false }

export interface ApiTokenInfo {
  readonly id: string
  readonly name: string
  readonly createdAt: number
  readonly lastUsedAt: number | null
}

export type CreateTokenResult =
  | { readonly ok: true; readonly token: string; readonly info: ApiTokenInfo }
  | { readonly ok: false; readonly reason: "empty-name" | "name-taken" }

const issueTokens = (db: Database, loginId: string, now: number): Tokens => {
  const accessToken = newToken("access")
  const refreshToken = newToken("refresh")
  const accessTokenExpiresAt = now + ACCESS_TOKEN_TTL_MS
  const refreshTokenExpiresAt = now + REFRESH_TOKEN_TTL_MS
  db.query("INSERT INTO access_tokens (token_hash, login_id, expires_at) VALUES (?, ?, ?)").run(
    tokenHash(accessToken),
    loginId,
    accessTokenExpiresAt,
  )
  db.query("INSERT INTO refresh_tokens (token_hash, login_id, issued_at, expires_at) VALUES (?, ?, ?, ?)").run(
    tokenHash(refreshToken),
    loginId,
    now,
    refreshTokenExpiresAt,
  )
  return {
    accessToken,
    accessTokenExpiresAt,
    refreshToken,
    refreshTokenExpiresAt,
    principal: { kind: "login", loginId },
  }
}

/** Creates a login for the owner's GitHub user with its first access and refresh tokens. */
export const createLogin = (db: Database, githubUserId: number, now: number): Tokens => {
  const loginId = crypto.randomUUID()
  return db.transaction((): Tokens => {
    db.query("INSERT INTO logins (id, github_user_id, created_at) VALUES (?, ?, ?)").run(loginId, githubUserId, now)
    return issueTokens(db, loginId, now)
  }).immediate()
}

/**
 * Exchanges a refresh token for new tokens and retires it. Presenting a
 * retired refresh token, even an expired one, revokes its whole login. A
 * login issued for a GitHub user other than `ownerId` refreshes nothing.
 */
export const refresh = (db: Database, refreshToken: string, ownerId: number, now: number): RefreshResult => {
  if (tokenKind(refreshToken) !== "refresh") return { ok: false }
  return db.transaction((): RefreshResult => {
    const row = db
      .query<
        { login_id: string; github_user_id: number; expires_at: number; rotated_at: number | null; revoked_at: number | null },
        [string]
      >(
        `SELECT r.login_id, l.github_user_id, r.expires_at, r.rotated_at, l.revoked_at
          FROM refresh_tokens AS r JOIN logins AS l ON l.id = r.login_id WHERE r.token_hash = ?`,
      )
      .get(tokenHash(refreshToken))
    if (row === null || row.revoked_at !== null || row.github_user_id !== ownerId) return { ok: false }
    if (row.rotated_at !== null) {
      db.query("UPDATE logins SET revoked_at = ? WHERE id = ?").run(now, row.login_id)
      return { ok: false }
    }
    if (row.expires_at <= now) return { ok: false }
    db.query("UPDATE refresh_tokens SET rotated_at = ? WHERE token_hash = ?").run(now, tokenHash(refreshToken))
    return { ok: true, tokens: issueTokens(db, row.login_id, now) }
  }).immediate()
}

/**
 * Checks an access token or an API token, recording an API token's use. An
 * access token of a login issued for a GitHub user other than `ownerId`
 * authenticates nothing.
 */
export const authenticate = (db: Database, token: string, ownerId: number, now: number): AuthenticateResult => {
  const kind = tokenKind(token)
  if (kind === "access") {
    const row = db
      .query<{ login_id: string }, [string, number, number]>(
        `SELECT a.login_id FROM access_tokens AS a JOIN logins AS l ON l.id = a.login_id
          WHERE a.token_hash = ? AND a.expires_at > ? AND l.revoked_at IS NULL AND l.github_user_id = ?`,
      )
      .get(tokenHash(token), now, ownerId)
    return row === null ? { ok: false } : { ok: true, principal: { kind: "login", loginId: row.login_id } }
  }
  if (kind === "api") {
    const row = db
      .query<{ id: string; name: string }, [string]>(
        "SELECT id, name FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL",
      )
      .get(tokenHash(token))
    if (row === null) return { ok: false }
    db.query("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now, row.id)
    return { ok: true, principal: { kind: "token", tokenId: row.id, name: row.name } }
  }
  return { ok: false }
}

export const createApiToken = (db: Database, name: string, now: number): CreateTokenResult => {
  if (name.trim().length === 0) return { ok: false, reason: "empty-name" }
  const token = newToken("api")
  const info: ApiTokenInfo = { id: crypto.randomUUID(), name, createdAt: now, lastUsedAt: null }
  try {
    db.query("INSERT INTO api_tokens (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)").run(
      info.id,
      name,
      tokenHash(token),
      now,
    )
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed: api_tokens.name")) {
      return { ok: false, reason: "name-taken" }
    }
    throw error
  }
  return { ok: true, token, info }
}

/** Active API tokens, oldest first. */
export const listApiTokens = (db: Database): ReadonlyArray<ApiTokenInfo> =>
  db
    .query<{ id: string; name: string; created_at: number; last_used_at: number | null }, []>(
      "SELECT id, name, created_at, last_used_at FROM api_tokens WHERE revoked_at IS NULL ORDER BY created_at, name",
    )
    .all()
    .map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at }))

/** Revokes the active API token with this name; false when there is none. */
export const revokeApiToken = (db: Database, name: string, now: number): boolean =>
  db.query("UPDATE api_tokens SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL").run(now, name).changes > 0

/**
 * Whether a connection's principal still holds: its API token is not
 * revoked, or its login is not revoked and was issued for `ownerId`.
 */
export const principalActive = (db: Database, principal: Sender, ownerId: number): boolean =>
  principal.kind === "login"
    ? db
        .query("SELECT 1 FROM logins WHERE id = ? AND revoked_at IS NULL AND github_user_id = ?")
        .get(principal.loginId, ownerId) !== null
    : db.query("SELECT 1 FROM api_tokens WHERE id = ? AND revoked_at IS NULL").get(principal.tokenId) !== null

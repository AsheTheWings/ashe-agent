/** Token kinds, told apart by their prefixes. */
export const TOKEN_PREFIX = { access: "aaa_", refresh: "aar_", api: "aat_" } as const

export type TokenKind = keyof typeof TOKEN_PREFIX

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** A new token: its prefix and 32 random bytes in base64url. */
export const newToken = (kind: TokenKind): string =>
  `${TOKEN_PREFIX[kind]}${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`

/** The kind a token's prefix names, or null for a token of no known shape. */
export const tokenKind = (token: string): TokenKind | null => {
  for (const [kind, prefix] of Object.entries(TOKEN_PREFIX) as Array<[TokenKind, string]>) {
    if (token.startsWith(prefix) && /^[A-Za-z0-9_-]{43}$/.test(token.slice(prefix.length))) return kind
  }
  return null
}

/** The hex SHA-256 under which a token is stored. */
export const tokenHash = (token: string): string => new Bun.CryptoHasher("sha256").update(token).digest("hex")

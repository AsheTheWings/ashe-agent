import { describe, expect, test } from "bun:test"
import { LOGIN_FAILURE_WINDOW_MS, loginLockedUntil } from "../src/auth/rate-limit.ts"
import { newToken, tokenKind } from "../src/auth/tokens.ts"

const minute = 60_000

describe("login rate limit", () => {
  test("four failures do not lock", () => {
    expect(loginLockedUntil([0, 1, 2, 3], 4)).toBeNull()
  })

  test("five failures within the window lock until the window after the fifth", () => {
    const failures = [0, minute, 2 * minute, 3 * minute, 4 * minute]
    expect(loginLockedUntil(failures, 5 * minute)).toBe(4 * minute + LOGIN_FAILURE_WINDOW_MS)
    expect(loginLockedUntil(failures, 4 * minute + LOGIN_FAILURE_WINDOW_MS - 1)).toBe(4 * minute + LOGIN_FAILURE_WINDOW_MS)
    expect(loginLockedUntil(failures, 4 * minute + LOGIN_FAILURE_WINDOW_MS)).toBeNull()
  })

  test("five failures spread over more than the window do not lock", () => {
    expect(loginLockedUntil([0, minute, 2 * minute, 3 * minute, LOGIN_FAILURE_WINDOW_MS], LOGIN_FAILURE_WINDOW_MS + 1)).toBeNull()
  })

  test("five failures within just under the window lock", () => {
    const last = LOGIN_FAILURE_WINDOW_MS - 1
    expect(loginLockedUntil([0, minute, 2 * minute, 3 * minute, last], last + 1)).toBe(last + LOGIN_FAILURE_WINDOW_MS)
  })
})

describe("tokens", () => {
  test("each kind is told apart by its prefix and shape", () => {
    for (const kind of ["access", "refresh", "api"] as const) expect(tokenKind(newToken(kind))).toBe(kind)
    expect(tokenKind("aat_short")).toBeNull()
    expect(tokenKind("")).toBeNull()
    expect(tokenKind(`xyz_${"a".repeat(43)}`)).toBeNull()
  })

  test("tokens are unique", () => {
    expect(newToken("api")).not.toBe(newToken("api"))
  })
})

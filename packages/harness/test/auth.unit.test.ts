import { describe, expect, test } from "bun:test"
import { newToken, tokenKind } from "../src/auth/tokens.ts"

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

import { describe, expect, test } from "bun:test"
import { isSpaRoute, parseSessionPath, sessionPath } from "../src/shared/routes.ts"

describe("session URL routing", () => {
  test("round-trips valid session ids and accepts an optional trailing slash", () => {
    expect(sessionPath("abc123def456")).toBe("/sessions/abc123def456")
    expect(parseSessionPath("/sessions/abc123def456")).toBe("abc123def456")
    expect(parseSessionPath("/sessions/abc123def456/")).toBe("abc123def456")
    expect(parseSessionPath(sessionPath("session with space"))).toBe("session with space")
    expect(isSpaRoute("/")).toBe(true)
    expect(isSpaRoute("/sessions/abc123def456")).toBe(true)
  })

  test("rejects non-session paths, multi-segment paths, malformed encodings, and traversal", () => {
    for (const invalid of [
      "/",
      "/sessions",
      "/sessions/",
      "/sessions/a/b",
      "/sessions/.",
      "/sessions/..",
      "/sessions/%2e%2e",
      "/sessions/%2f",
      "/sessions/%5c",
      "/sessions/%E0%A4%A",
      "/sessions/%20%20",
      "/state.sqlite",
      "/v1/web/health",
    ]) {
      expect(parseSessionPath(invalid)).toBeNull()
      expect(isSpaRoute(invalid)).toBe(invalid === "/")
    }
  })
})

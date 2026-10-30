import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { parseOtlpHeaders } from "../src/telemetry/sdk.ts"

describe("OTLP headers file", () => {
  test("takes name=value lines exactly after the first =, skipping blanks and comments", () => {
    expect(parseOtlpHeaders("# keys\n\napi-key=a=b\nAuthorization=Bearer x y\n")).toEqual(Result.succeed({ "api-key": "a=b", Authorization: "Bearer x y" }))
  })

  test("a malformed line is named by number, never by content", () => {
    const parsed = parseOtlpHeaders("api-key=ok\nsecret-without-equals\n")
    expect(parsed).toEqual(Result.fail("line 2 is not name=value"))
    expect(JSON.stringify(parsed)).not.toContain("secret-without-equals")
  })
})

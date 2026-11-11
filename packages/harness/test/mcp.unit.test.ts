import { describe, expect, test } from "bun:test"
import { Redacted, Result } from "effect"
import { parseEnvFile, parseHeadersFile, readCredentials } from "../src/tools/mcp/credentials.ts"
import { registeredName } from "../src/tools/mcp/servers.ts"

const file = (text: string, mode = 0o600) => () => ({ kind: "ok" as const, text, mode })

describe("MCP credentials", () => {
  test("env and headers files parse line by line, keeping values exactly", () => {
    expect(parseEnvFile("# comment\n\nA=1\nB==two = \nC=\n")).toEqual(Result.succeed({ A: "1", B: "=two = ", C: "" }))
    expect(parseHeadersFile("Authorization: Bearer a:b\nX-Key:\t  v \n")).toEqual(Result.succeed({ Authorization: "Bearer a:b", "X-Key": "v " }))
  })

  test("problems name the file and line, never a value", () => {
    const env = readCredentials("/run/env", parseEnvFile, file("GOOD=1\nsecret-value-without-name\n"))
    expect(env).toEqual(Result.fail("/run/env: line 2 is not NAME=value"))
    const headers = readCredentials("/run/h", parseHeadersFile, file("Bad Header: hidden-token\n"))
    expect(headers).toEqual(Result.fail("/run/h: line 1 is not Name: value"))
    expect(readCredentials("/run/h", parseHeadersFile, file("A: b\n", 0o644))).toEqual(Result.fail("/run/h names a file that its group or others can access"))
    const read = readCredentials("/run/h", parseHeadersFile, file("A: b\n"))
    expect(Result.isSuccess(read) && Redacted.value(read.success)).toEqual({ A: "b" })
    expect(Result.isSuccess(read) && String(read.success)).not.toContain("b\"")
  })

  test("registered names join server and tool and replace other characters with _", () => {
    expect(registeredName("docs", "search.v2")).toBe("docs_search_v2")
    expect(registeredName("my-server", "a b/c")).toBe("my-server_a_b_c")
  })
})

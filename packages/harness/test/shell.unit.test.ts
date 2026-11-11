import { describe, expect, test } from "bun:test"
import { shellOfPasswdEntry } from "../src/tools/shell/login-shell.ts"
import { HeadTailBuffer, truncateToTokens } from "../src/tools/shell/output.ts"

const bytes = (text: string) => new TextEncoder().encode(text)

describe("shell output", () => {
  test("a head-tail buffer keeps the first and last halves of its budget and counts what fell between", () => {
    const buffer = new HeadTailBuffer(10)
    buffer.push(bytes("abc"))
    expect(buffer.text()).toBe("abc")
    buffer.push(bytes("defghijklmnop"))
    expect(buffer.omitted).toBe(6)
    expect(buffer.text()).toBe("abcde\n... 6 bytes omitted ...\nlmnop")
    const into = new HeadTailBuffer(10)
    into.push(bytes("12"))
    into.take(buffer)
    expect(buffer.empty).toBe(true)
    expect(into.retained).toBe(10)
    expect(into.text()).toMatch(/^12abc\n\.\.\. \d+ bytes omitted \.\.\.\nlmnop$/)
  })

  test("output over its token budget keeps head and tail at character boundaries around a marker", () => {
    expect(truncateToTokens("short", 10)).toEqual({ text: "short", originalTokens: null })
    const long = `${"é".repeat(30)}${"x".repeat(100)}${"ü".repeat(30)}`
    const cut = truncateToTokens(long, 10)
    expect(cut.originalTokens).toBe(Math.ceil(bytes(long).length / 4))
    const body = cut.text.slice(cut.text.indexOf("\n\n") + 2)
    expect(body).toMatch(/^é+…\d+ tokens truncated…ü+$/)
    expect(body.includes("\uFFFD")).toBe(false)
    expect(bytes(body.replace(/…\d+ tokens truncated…/, "")).length).toBeLessThanOrEqual(40)
    expect(cut.text).toStartWith(`Warning: truncated output (original token count: ${cut.originalTokens})\nTotal output lines: 1\n\n`)
  })
})

describe("login shell", () => {
  test("a passwd entry gives its last field when it is an absolute path", () => {
    expect(shellOfPasswdEntry("ashe:x:1000:1000:Ashe,,,:/home/ashe:/usr/bin/zsh\n")).toBe("/usr/bin/zsh")
    expect(shellOfPasswdEntry("svc:x:999:999::/var/lib/svc:")).toBeNull()
    expect(shellOfPasswdEntry("svc:x:999:999::/var/lib/svc:nologin")).toBeNull()
    expect(shellOfPasswdEntry("not an entry")).toBeNull()
  })
})

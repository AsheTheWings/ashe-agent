import { describe, expect, test } from "bun:test"
import {
  decodeText,
  MAX_TOTAL_BYTES,
  readMany,
  readWindow,
  streamRefusal,
  type FileRead,
} from "../src/tools/file/read-window.ts"

const numbered = (from: number, to: number, line = (n: number) => `line ${n}`) =>
  Array.from({ length: to - from + 1 }, (_, index) => `${String(from + index).padStart(6)}\t${line(from + index)}`)
const file = (count: number, line = (n: number) => `line ${n}`) => `${Array.from({ length: count }, (_, i) => line(i + 1)).join("\n")}\n`

describe("file_read windows", () => {
  test("lines are numbered as `cat -n` prints them", () => {
    expect(readWindow("a\nb\n")).toBe("     1\ta\n     2\tb")
    expect(readWindow("no newline")).toBe("     1\tno newline")
  })

  test("the line ceiling names the offset to continue from, without an error prefix", () => {
    const window = readWindow(file(2_500)).split("\n")
    expect(window).toHaveLength(2_001)
    expect(window.slice(0, 2_000)).toEqual(numbered(1, 2_000))
    expect(window.at(-1)).toBe("[Stopped at 2000 lines: lines 1-2000 of 2500; continue from offset 2001.]")
    expect(readWindow(file(2_500), { offset: 2_001 }).split("\n")).toEqual(numbered(2_001, 2_500))
    expect(readWindow(file(10), { offset: 3, limit: 2 }).split("\n")).toEqual([...numbered(3, 4), "[Stopped at 2 lines: lines 3-4 of 10; continue from offset 5.]"])
    expect(readWindow(file(10), { limit: 5_000 }).split("\n")).toEqual(numbered(1, 10))
  })

  test("the byte ceiling stops at a whole line and names the offset to continue from", () => {
    const long = (n: number) => `${n}`.padEnd(1_000, "x")
    const window = readWindow(file(200, long)).split("\n")
    const shown = window.length - 1
    expect(window.slice(0, shown)).toEqual(numbered(1, shown, long))
    expect(window.join("\n").length).toBeLessThanOrEqual(128 * 1024 + 200)
    expect(window.at(-1)).toBe(`[Stopped at 131072 bytes: lines 1-${shown} of 200; continue from offset ${shown + 1}.]`)
    expect(readWindow("abc\n", { maxBytes: 4 })).toBe("[Line 1 does not fit in the remaining 4 bytes; continue from offset 1.]")
  })

  test("an empty file and an offset past the end say so", () => {
    expect(readWindow("")).toBe("[The file is empty; continue from offset 1 once it has lines.]")
    expect(readWindow(file(3), { offset: 4 })).toBe(
      "[Offset 4 is past the end of the file, which has 3 lines; continue from offset 1, or use a negative offset to read its end.]",
    )
  })

  test("a negative offset reads from the end", () => {
    expect(readWindow(file(10), { offset: -3 }).split("\n")).toEqual(numbered(8, 10))
    expect(readWindow(file(10), { offset: -1 })).toBe(numbered(10, 10)[0]!)
    expect(readWindow(file(3), { offset: -50 }).split("\n")).toEqual(numbered(1, 3))
  })

  test("a line over the character ceiling is cut at a character boundary, even inside a multi-byte character", () => {
    const emoji = "😀".repeat(2_001)
    const [line, note] = readWindow(`${emoji}\n`).split("\n")
    expect(line).toBe(`     1\t${"😀".repeat(2_000)}`)
    expect(line!.includes("\uFFFD")).toBe(false)
    expect(note).toBe("[Line 1 was cut at 2000 characters; continue line 1 from offset 1, column 2001.]")
    expect(readWindow(`${"é".repeat(2_000)}\n`)).toBe(`     1\t${"é".repeat(2_000)}`)
  })

  test("a cut line continues from the column its note names", () => {
    const long = `${"a".repeat(2_000)}${"b".repeat(2_000)}c`
    const text = `short\n${long}\n${"d".repeat(2_001)}\nlast\n`
    expect(readWindow(text).split("\n").at(-1)).toBe(
      "[2 lines were cut at 2000 characters; continue line 2 from offset 2, column 2001, and each other cut line from its own offset, column 2001.]",
    )
    const second = readWindow(text, { offset: 2, column: 2_001, limit: 1 }).split("\n")
    expect(second).toEqual([
      `     2\t${"b".repeat(2_000)}`,
      "[Line 2 was cut at 2000 characters; continue line 2 from offset 2, column 4001.]",
      "[Stopped at 1 lines: lines 2-2 of 4; continue from offset 3.]",
    ])
    expect(readWindow(text, { offset: 2, column: 4_001 }).split("\n")).toEqual([
      "     2\tc",
      `     3\t${"d".repeat(2_000)}`,
      "     4\tlast",
      "[Line 3 was cut at 2000 characters; continue line 3 from offset 3, column 2001.]",
    ])
    expect(readWindow(text, { offset: 2, column: 4_002 })).toBe("[Column 4002 is past the end of line 2, which has 4001 characters; continue from offset 3.]")
  })

  test("a leading BOM is stripped and CRLF becomes LF", () => {
    const bytes = new TextEncoder().encode("\uFEFFone\r\ntwo\r\nlone\rcr\n")
    expect(decodeText(bytes)).toBe("one\ntwo\nlone\rcr\n")
    expect(decodeText(new TextEncoder().encode("a\uFEFFb"))).toBe("a\uFEFFb")
  })
})

describe("file_read refusals", () => {
  test("devices, process file descriptors, FIFOs, and sockets are refused before reading", () => {
    for (const path of ["/dev/zero", "/dev", "/dev/stdin", "/proc/self/fd/0", "/proc/123/fd", "/proc/self/fd"]) {
      expect(streamRefusal(path, "file")).toBe(`${path} is a device or stream, which file_read does not read.`)
    }
    for (const kind of ["character", "block", "fifo", "socket"] as const) expect(streamRefusal("/tmp/x", kind)).not.toBeNull()
    expect(streamRefusal("/home/a/dev/x", "file")).toBeNull()
    expect(streamRefusal("/proc/self/status", "file")).toBeNull()
    expect(streamRefusal("/devices", "file")).toBeNull()
  })
})

describe("reading several files", () => {
  const fake = (sizes: Record<string, number>) => async (name: string, maxBytes: number): Promise<FileRead> => ({
    parts: [{ type: "text", text: "x".repeat(Math.min(sizes[name]!, maxBytes)) }],
    failed: false,
  })

  test("each file comes under a header with what is left of the total, and the rest are named as not read", async () => {
    const budgets: Array<number> = []
    const sizes = { a: 40 * 1024, b: 50 * 1024, c: 30 * 1024, d: 10, e: 10 }
    const read = fake(sizes)
    const parts = await readMany(["a", "b", "c", "d", "e"], async (name, maxBytes) => {
      budgets.push(maxBytes)
      return read(name, maxBytes)
    })
    const texts = parts.map((part) => (part.type === "text" ? part.text : ""))
    expect(texts.filter((text) => text.startsWith("==>"))).toEqual(["==> a <==", "==> b <==", "==> c <=="])
    expect(budgets[0]).toBe(MAX_TOTAL_BYTES)
    expect(budgets[2]).toBeLessThan(MAX_TOTAL_BYTES - 90 * 1024)
    expect(texts.at(-1)).toBe(`[Stopped at ${MAX_TOTAL_BYTES} bytes in total; not read: d, e.]`)
  })

  test("a failure is reported inline and the other files are still read", async () => {
    const parts = await readMany(["a", "missing", "b"], async (name) =>
      name === "missing" ? { parts: [{ type: "text", text: "missing does not exist." }], failed: true } : { parts: [{ type: "text", text: name }], failed: false },
    )
    expect(parts.map((part) => (part.type === "text" ? part.text : ""))).toEqual(["==> a <==", "a", "==> missing <==", "missing does not exist.", "==> b <==", "b"])
  })
})

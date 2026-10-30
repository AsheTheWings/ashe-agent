import { describe, expect, test } from "bun:test"
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SessionEvent } from "@ashe-agent/protocol"
import type { Tool, ToolRun } from "../src/agent/tools.ts"
import { fileTools } from "../src/tools/file/index.ts"
import { waitFor } from "./support/cli.ts"
import { AgentHarness, agentModels, callTools, messageText, responsesInput, say } from "./support/agent.ts"

const fixtures = join(import.meta.dir, "fixtures/documents")
const [alpha, beta] = [agentModels[0]!.id, agentModels[1]!.id]
const models = [
  { ...agentModels[0]!, imageInput: false },
  { ...agentModels[1]!, imageInput: true },
]

const withHarness = async (options: ConstructorParameters<typeof AgentHarness>[0], body: (h: AgentHarness) => Promise<void>) => {
  const harness = new AgentHarness({ tools: fileTools(), models, ...options })
  try {
    cpSync(fixtures, harness.dir, { recursive: true })
    await body(harness)
  } finally {
    await harness.cleanup()
  }
}

const ofType = (events: ReadonlyArray<SessionEvent>, type: string) =>
  (events.map((event) => event.event) as Array<any>).filter((event) => event.type === type)

/** Calls a file tool directly, as a turn would, with every call allowed. */
const call = (tool: Tool, cwd: string, args: unknown, imageInput = false, authorize: ToolRun["authorize"] = async () => {}) => {
  const run: ToolRun = {
    sessionId: "s",
    runId: "r",
    toolCallId: crypto.randomUUID(),
    cwd,
    imageInput,
    signal: new AbortController().signal,
    authorize,
    started: () => {},
    onCancel: () => {},
    programCall: () => {},
  }
  return tool.run(args, run)
}

const tool = (name: string) => fileTools().find((candidate) => candidate.spec.name === name)!

describe("file_read documents", () => {
  test("docx, xlsx, csv, and text-layer PDF convert to Markdown and page like text", async () => {
    await withHarness({}, async (h) => {
      const read = tool("file_read")
      const docx = await call(read, h.dir, { path: "report.docx", limit: 3 })
      expect(docx.outcome).toBe("success")
      expect(docx.content).toStartWith("     1\tFixture Title\n     2\t\n     3\tParagraph 1 of the fixture document.\n")
      expect(docx.content).toMatch(/\[Stopped at 3 lines: lines 1-3 of \d+; continue from offset 4\.\]$/)
      expect((await call(read, h.dir, { path: "report.docx", offset: 4, limit: 2 })).content).toStartWith("     4\t\n     5\tParagraph 2 of")
      expect((await call(read, h.dir, { path: "fruit.xlsx" })).content).toContain("\t| apple | 3 |")
      expect((await call(read, h.dir, { path: join(h.dir, "prices.csv") })).content).toBe(
        "     1\t| item | price |\n     2\t| --- | --- |\n     3\t| tea | 4 |\n     4\t| coffee | 5 |",
      )
      const pdf = await call(read, h.dir, { path: "orchard.pdf", limit: 1 })
      expect(pdf.content).toStartWith("     1\t# Orchard report\n[Stopped at 1 lines")
      expect((await call(read, h.dir, { path: "orchard.pdf", offset: -1 })).content).toContain("Paragraph 24.")
    })
  })

  test("an image-only PDF reports needsOcr with its pages, inline in a read of several files", async () => {
    await withHarness({}, async (h) => {
      const read = tool("file_read")
      const scan = await call(read, h.dir, { path: "scan.pdf" })
      expect(scan).toEqual({
        outcome: "failed",
        content: "scan.pdf could not be converted from pdf to Markdown (needsOcr: pages 1 of 1 are scanned or image-only and need OCR, which file_read does not do.)",
      })
      const several = await call(read, h.dir, { path: ["scan.pdf", "*.csv"] })
      expect(several.outcome).toBe("success")
      expect(several.content).toBe(
        [
          "==> scan.pdf <==",
          "scan.pdf could not be converted from pdf to Markdown (needsOcr: pages 1 of 1 are scanned or image-only and need OCR, which file_read does not do.)",
          "==> prices.csv <==",
          "     1\t| item | price |\n     2\t| --- | --- |\n     3\t| tea | 4 |\n     4\t| coffee | 5 |",
        ].join("\n"),
      )
    })
  })

  test("devices and FIFOs are refused before reading, and missing files and directories are named", async () => {
    await withHarness({}, async (h) => {
      const read = tool("file_read")
      expect(await call(read, h.dir, { path: "/dev/zero" })).toEqual({ outcome: "failed", content: "/dev/zero is a device or stream, which file_read does not read." })
      expect(Bun.spawnSync(["mkfifo", join(h.dir, "pipe")]).exitCode).toBe(0)
      expect((await call(read, h.dir, { path: "pipe" })).content).toBe(`${join(h.dir, "pipe")} is a device or stream, which file_read does not read.`)
      expect((await call(read, h.dir, { path: "nope.txt" })).content).toBe("nope.txt does not exist.")
      mkdirSync(join(h.dir, "sub"))
      expect((await call(read, h.dir, { path: "sub" })).content).toBe("sub is a directory.")
    })
  })
})

describe("file_read images", () => {
  test("an image reaches a model that takes images as an input_image part, else a refusal; records carry a placeholder", async () => {
    await withHarness({}, async (h) => {
      const viewer = h.create({ model: beta })
      cpSync(join(fixtures, "red.png"), join(h.sessionDir(viewer), "red.png"))
      h.model.next(callTools([{ name: "file_read", args: { path: "red.png" } }]), say("red"))
      h.input(viewer, "look")
      await h.turnsEnded(viewer, 1)
      const output = responsesInput(h.model.last()).find((item) => item.type === "function_call_output")!
      expect(output.output).toEqual([
        { type: "input_text", text: "red.png is an image (image/png, 73 bytes)." },
        { type: "input_image", image_url: `data:image/png;base64,${readFileSync(join(fixtures, "red.png")).toString("base64")}`, detail: "auto" },
      ])

      h.hub.setModel(viewer, alpha, h.sender)
      h.model.next(say("ok"))
      h.input(viewer, "describe")
      await h.turnsEnded(viewer, 2)
      const record = h.model.last().messages.map(messageText).join("\n")
      expect(record).toContain("red.png is an image (image/png, 73 bytes).\n[image: red.png]")
      expect(JSON.stringify(responsesInput(h.model.last()))).not.toContain("input_image")

      const blind = h.create({ model: alpha })
      cpSync(join(fixtures, "red.png"), join(h.sessionDir(blind), "red.png"))
      h.model.next(callTools([{ name: "file_read", args: { path: "red.png" } }]), say("cannot"))
      h.input(blind, "look")
      await h.turnsEnded(blind, 1)
      expect(ofType(h.events(blind), "TOOL_CALL_RESULT")[0]).toMatchObject({
        outcome: "failed",
        content: "red.png is an image (image/png), and the turn's model cannot view images.",
      })
    })
  })
})

describe("file tools in a turn", () => {
  test("tools are sent with flat namespaced names", async () => {
    expect(fileTools().map((candidate) => [candidate.namespace, candidate.name, candidate.spec.name])).toEqual([
      ["file", "read", "file_read"],
      ["file", "patch", "file_patch"],
    ])
  })

  test("file_patch asks `edit` for every resolved path, a move's destination included, then applies the patch", async () => {
    await withHarness({ permission: { edit: "ask", read: { "*.secret": "deny" } } }, async (h) => {
      const id = h.create()
      const dir = h.sessionDir(id)
      writeFileSync(join(dir, "old.txt"), "one\ntwo\n")
      writeFileSync(join(dir, "key.secret"), "k")
      const patch = [
        "*** Begin Patch",
        "*** Add File: notes/new.txt",
        "+hello",
        "*** Update File: old.txt",
        "*** Move to: moved/renamed.txt",
        "@@",
        " one",
        "-two",
        "+TWO",
        "*** End Patch",
      ].join("\n")
      h.model.next(
        callTools([
          { name: "file_patch", args: { patch } },
          { name: "file_read", args: { path: "key.secret" } },
          { name: "file_patch", args: { patch: "*** Begin Patch\n*** Frobnicate: x\n*** End Patch" } },
        ]),
        say("done"),
      )
      h.input(id, "edit")
      const request = await waitFor("the edit request", () => ofType(h.events(id), "PERMISSION_REQUESTED")[0])
      const root = realpathSync(dir)
      expect(request).toMatchObject({
        permission: "edit",
        subjects: [join(root, "notes/new.txt"), join(root, "old.txt"), join(root, "moved/renamed.txt")],
      })
      expect(existsSync(join(dir, "notes"))).toBe(false)
      h.answer(id, request.requestId, "once")
      await h.turnsEnded(id, 1)
      const results = ofType(h.events(id), "TOOL_CALL_RESULT")
      expect(results[0]).toMatchObject({ outcome: "success", content: "Success. Updated the following files:\nA notes/new.txt\nM moved/renamed.txt" })
      expect(readFileSync(join(dir, "notes/new.txt"), "utf8")).toBe("hello\n")
      expect(readFileSync(join(dir, "moved/renamed.txt"), "utf8")).toBe("one\nTWO\n")
      expect(existsSync(join(dir, "old.txt"))).toBe(false)
      expect(results[1]).toMatchObject({ outcome: "failed", content: expect.stringContaining("denied by configuration") })
      expect(results[2]).toMatchObject({ outcome: "failed", content: expect.stringContaining("The patch is invalid: Invalid hunk at line 2") })
      expect(ofType(h.events(id), "PERMISSION_REQUESTED")).toHaveLength(1)
      expect(ofType(h.events(id), "TOOL_EXECUTION_STARTED")).toHaveLength(1)
    })
  })

  test("both tools authorize and touch the path the operating system resolves, `..` after a symlink included", async () => {
    await withHarness({}, async (h) => {
      // The session works in `work`, where `link` points at `../outside`, so `link/../victim.txt` is `<root>/victim.txt`.
      const root = realpathSync(h.dir)
      mkdirSync(join(h.dir, "work"))
      mkdirSync(join(h.dir, "outside"))
      symlinkSync("../outside", join(h.dir, "work", "link"))
      writeFileSync(join(h.dir, "victim.txt"), "real victim\n")
      writeFileSync(join(h.dir, "work", "victim.txt"), "lexical victim\n")
      writeFileSync(join(h.dir, "outside", "target.txt"), "target\n")
      symlinkSync("target.txt", join(h.dir, "outside", "alias.txt"))
      const cwd = join(h.dir, "work")
      const read = tool("file_read")
      expect((await call(read, cwd, { path: "link/../victim.txt" })).content).toBe("     1\treal victim")
      expect((await call(read, cwd, { path: ["link/../*.txt"] })).content).toContain("real victim")
      expect((await call(read, cwd, { path: [join(h.dir, "outside", "t*.txt")] })).content).toBe(
        `==> ${join(h.dir, "outside", "target.txt")} <==\n     1\ttarget`,
      )

      const checks: Array<unknown> = []
      const patch = tool("file_patch")
      const run: ToolRun = {
        sessionId: "s",
        runId: "r",
        toolCallId: "c",
        cwd,
        imageInput: false,
        signal: new AbortController().signal,
        authorize: async (check) => void checks.push(check),
        started: () => {},
        onCancel: () => {},
        programCall: () => {},
      }
      const update = "*** Begin Patch\n*** Update File: link/../victim.txt\n@@\n-real victim\n+patched\n*** Delete File: link/alias.txt\n*** End Patch"
      expect(await patch.run({ patch: update }, run)).toMatchObject({ outcome: "success" })
      expect(checks).toEqual([
        { permission: "edit", subjects: [join(root, "victim.txt"), join(root, "outside", "alias.txt")], patterns: [join(root, "victim.txt"), join(root, "outside", "alias.txt")] },
      ])
      expect(readFileSync(join(h.dir, "victim.txt"), "utf8")).toBe("patched\n")
      expect(readFileSync(join(h.dir, "work", "victim.txt"), "utf8")).toBe("lexical victim\n")
      expect(() => lstatSync(join(h.dir, "outside", "alias.txt"))).toThrow()
      expect(readFileSync(join(h.dir, "outside", "target.txt"), "utf8")).toBe("target\n")
    })
  })

  test("a deny rule on the resolved path refuses a patch reaching it through `..` after a symlink", async () => {
    await withHarness({ permission: { edit: { "~/victim.txt": "deny" } } }, async (h) => {
      const id = h.create()
      const work = h.sessionDir(id)
      mkdirSync(join(h.dir, "outside"))
      symlinkSync(join(h.dir, "outside"), join(work, "link"))
      writeFileSync(join(h.dir, "victim.txt"), "keep\n")
      h.model.next(callTools([{ name: "file_patch", args: { patch: "*** Begin Patch\n*** Add File: link/../victim.txt\n+overwritten\n*** End Patch" } }]), say("done"))
      h.input(id, "edit")
      await h.turnsEnded(id, 1)
      expect(ofType(h.events(id), "TOOL_CALL_RESULT")[0]).toMatchObject({ outcome: "failed", content: expect.stringContaining("denied by configuration") })
      expect(readFileSync(join(h.dir, "victim.txt"), "utf8")).toBe("keep\n")
      expect(existsSync(join(work, "victim.txt"))).toBe(false)
    })
  })

  test("a patch's later hunks act on the paths resolved before its earlier hunks ran", async () => {
    await withHarness({ permission: { edit: { "~/sessions/*/other": "deny" } } }, async (h) => {
      // The session directory's `link` points at `<root>/a/f`, so `link/../other` resolves to `<root>/a/other` before the link is deleted.
      const id = h.create()
      const work = h.sessionDir(id)
      mkdirSync(join(h.dir, "a", "f"), { recursive: true })
      symlinkSync(join(h.dir, "a", "f"), join(work, "link"))
      const patch = "*** Begin Patch\n*** Delete File: link\n*** Add File: link/../other\n+made\n*** End Patch"
      h.model.next(callTools([{ name: "file_patch", args: { patch } }]), say("done"))
      h.input(id, "edit")
      await h.turnsEnded(id, 1)
      expect(ofType(h.events(id), "TOOL_CALL_RESULT")[0]).toMatchObject({ outcome: "success" })
      expect(existsSync(join(work, "other"))).toBe(false)
      expect(readFileSync(join(h.dir, "a", "other"), "utf8")).toBe("made\n")
    })
  })

  test("a path that resolves differently once authorized is not read or patched", async () => {
    await withHarness({}, async (h) => {
      mkdirSync(join(h.dir, "one"))
      mkdirSync(join(h.dir, "two"))
      writeFileSync(join(h.dir, "one", "f.txt"), "one\n")
      writeFileSync(join(h.dir, "two", "f.txt"), "two\n")
      const relink = async () => {
        rmSync(join(h.dir, "link"))
        symlinkSync("two", join(h.dir, "link"))
      }
      const root = realpathSync(h.dir)
      symlinkSync("one", join(h.dir, "link"))
      expect(await call(tool("file_read"), h.dir, { path: "link/f.txt" }, false, relink)).toEqual({
        outcome: "failed",
        content: `link/f.txt was not read: it resolved to ${join(root, "one/f.txt")} when authorized and resolves to ${join(root, "two/f.txt")} now.`,
      })
      rmSync(join(h.dir, "link"))
      symlinkSync("one", join(h.dir, "link"))
      const patched = await call(tool("file_patch"), h.dir, { patch: "*** Begin Patch\n*** Update File: link/f.txt\n@@\n-one\n+ONE\n*** End Patch" }, false, relink)
      expect(patched).toMatchObject({ outcome: "failed", content: expect.stringContaining("Nothing was changed.") })
      expect(readFileSync(join(h.dir, "one", "f.txt"), "utf8")).toBe("one\n")
      expect(readFileSync(join(h.dir, "two", "f.txt"), "utf8")).toBe("two\n")
    })
  })

  test("deleting a symlink removes the link without reading its target, and a move names its source's target too", async () => {
    await withHarness({}, async (h) => {
      const root = realpathSync(h.dir)
      writeFileSync(join(h.dir, "locked"), "secret\n")
      chmodSync(join(h.dir, "locked"), 0o000)
      symlinkSync("locked", join(h.dir, "to-locked"))
      symlinkSync("missing", join(h.dir, "dangling"))
      mkdirSync(join(h.dir, "dir"))
      symlinkSync("dir", join(h.dir, "to-dir"))
      writeFileSync(join(h.dir, "real.txt"), "content\n")
      symlinkSync("real.txt", join(h.dir, "alias.txt"))
      const checks: Array<any> = []
      const patch = [
        "*** Begin Patch",
        "*** Delete File: to-locked",
        "*** Delete File: dangling",
        "*** Delete File: to-dir",
        "*** Update File: alias.txt",
        "*** Move to: moved.txt",
        "@@",
        "-content",
        "+moved",
        "*** End Patch",
      ].join("\n")
      const result = await call(tool("file_patch"), h.dir, { patch }, false, async (check) => void checks.push(check))
      expect(result).toMatchObject({ outcome: "success" })
      expect(checks[0].subjects).toEqual(
        ["to-locked", "dangling", "to-dir", "alias.txt", "real.txt", "moved.txt"].map((name) => join(root, name)),
      )
      for (const name of ["to-locked", "dangling", "to-dir", "alias.txt"]) expect(() => lstatSync(join(h.dir, name))).toThrow()
      expect(lstatSync(join(h.dir, "locked")).isFile()).toBe(true)
      expect(lstatSync(join(h.dir, "dir")).isDirectory()).toBe(true)
      expect(readFileSync(join(h.dir, "moved.txt"), "utf8")).toBe("moved\n")
      expect(readFileSync(join(h.dir, "real.txt"), "utf8")).toBe("content\n")
      chmodSync(join(h.dir, "locked"), 0o600)
    })
  })

  test("a symlink named `.csv` converts as CSV, though its target has no extension", async () => {
    await withHarness({}, async (h) => {
      writeFileSync(join(h.dir, "data"), "a,b\n1,2\n")
      symlinkSync("data", join(h.dir, "table.csv"))
      expect((await call(tool("file_read"), h.dir, { path: "table.csv" })).content).toBe("     1\t| a | b |\n     2\t| --- | --- |\n     3\t| 1 | 2 |")
    })
  })
})

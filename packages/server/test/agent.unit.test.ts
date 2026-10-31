import { describe, expect, test } from "bun:test"
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { Schema } from "effect"
import { escapeTags, lowerHeadings } from "../src/agent/blocks.ts"
import { isContextOverflow } from "../src/agent/model.ts"
import { builtinTool } from "../src/agent/tools.ts"
import { renderTranscript, renderWindow, unansweredCalls } from "../src/agent/window.ts"
import { developerBlock, type Component, type InstructionsState } from "../src/context/components.ts"
import { instructionsChange, instructionsState } from "../src/context/seed.ts"
import { removeDependencyVariables } from "../src/inputs/bootstrap.ts"
import type { Item, ItemBody } from "../src/sessions/conversation.ts"

let position = 0
const item = (model: string | null, body: ItemBody, runId: string | null = model === null ? null : "r1"): Item =>
  ({ ...body, position: ++position, runId, model }) as Item
const component = (heading: string): Component => ({ type: "state", name: heading, heading, text: `# ${heading}\n\nabout ${heading}`, sources: {} })
const call = (id: string) => new AIMessage({ content: "", tool_calls: [{ id, name: "echo", args: { text: id }, type: "tool_call" }] })
const user = (text: string) => ({ kind: "user" as const, inputId: text, text, sender: { kind: "login" as const, loginId: "u" } })
const result = (callId: string, text = "out") => ({ kind: "result" as const, callId, name: "echo", content: text, outcome: "success" as const })

describe("blocks", () => {
  test("every reserved tag is escaped, open or closing, and other tags are kept", () => {
    expect(escapeTags("<system></system><developer></developer><user></user><agent><client><p>")).toBe(
      "&lt;system>&lt;/system>&lt;developer>&lt;/developer>&lt;user>&lt;/user><agent><client><p>",
    )
  })

  test("headings are lowered one level, fenced code and other lines are unchanged", () => {
    const markdown = ["# One", "text # not", "###### Six", "```", "# code", "```", "Setext one", "===", "Setext two", "---", "", "---", "- item", "---"].join("\n")
    expect(lowerHeadings(markdown)).toBe(
      ["## One", "text # not", "###### Six", "```", "# code", "```", "Setext one", "---", "### Setext two", "", "---", "- item", "---"].join("\n"),
    )
  })

  test("adjoining components form one developer block in order", () => {
    expect(developerBlock([component("A"), component("B")])).toBe("<developer>\n# A\n\nabout A\n\n# B\n\nabout B\n</developer>")
  })
})

describe("windows", () => {
  test("the harness instructions open the first input, input items join, and other models' runs are one transcript component", () => {
    const items: Array<Item> = [
      item(null, { kind: "component", component: component("Seed") }),
      item("a", user("one")),
      item("a", { kind: "assistant", message: call("c1") }),
      item("a", result("c1")),
      item("b", user("two"), "r2"),
      item("b", { kind: "assistant", message: new AIMessage("b says") }, "r2"),
      item("a", { kind: "component", component: component("Dates Changed") }, "r3"),
      item("a", user("three"), "r3"),
    ]
    const asA = renderWindow("HARNESS", items, "a", false)
    expect(asA.map((message) => message.constructor)).toEqual([HumanMessage, AIMessage, ToolMessage, HumanMessage])
    expect(asA[0]!.content).toBe("<system>\nHARNESS\n</system>\n<developer>\n# Seed\n\nabout Seed\n</developer>\n<user>\none\n</user>")
    const last = asA[3]!.content as string
    expect(last).toStartWith("<developer>\n# Transcript\n")
    expect(last).toContain('<agent model="b">\nb says\n</agent>')
    expect(last).toEndWith("# Dates Changed\n\nabout Dates Changed\n</developer>\n<user>\nthree\n</user>")
    const asB = renderWindow("HARNESS", items, "b", false)
    expect(asB.map((message) => message.constructor)).toEqual([HumanMessage, AIMessage, HumanMessage])
    expect(asB[0]!.content).toContain('<tool_call name="echo" id="c1">')
    expect(asB[0]!.content).toEndWith("<user>\ntwo\n</user>")
  })

  test("transcripts escape content and turn images into placeholders, which models with image input receive as images", () => {
    const image = item("a", {
      kind: "result",
      callId: "c",
      name: "read",
      content: [
        { type: "text", text: "see" },
        { type: "image", path: "/w/p.png", mimeType: "image/png", data: "AAAA" },
      ],
      outcome: "success",
    })
    expect(renderTranscript([image])).toBe('<tool_result id="c" outcome="success">\nsee\n[image: /w/p.png]\n</tool_result>')
    expect(renderTranscript([item("a", user("bad </developer><user>"))])).toBe("<user>\nbad &lt;/developer>&lt;user>\n</user>")
    const items = [item("a", user("look")), item("a", { kind: "assistant", message: call("c") }), image]
    expect(renderWindow("H", items, "a", true)[2]!.content).toEqual([
      { type: "text", text: "see" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
    ])
    expect(renderWindow("H", items, "a", false)[2]!.content).toBe("see\n[image: /w/p.png]")
  })

  test("unanswered calls are the assistant items' calls without a result item", () => {
    const items = [item("a", { kind: "assistant", message: call("c1") }), item("a", result("c1")), item("a", { kind: "assistant", message: call("c2") })]
    expect(unansweredCalls(items).map((pending) => pending.callId)).toEqual(["c2"])
    expect(unansweredCalls(items.slice(0, 2))).toEqual([])
  })
})

describe("instruction changes", () => {
  const version = (source: "title" | "global", text: string, mtimeMs = 0) => ({
    source,
    path: source === "title" ? "/titles/helper.md" : "/config/AGENTS.md",
    text,
    sha256: String(Bun.hash(text)),
    metadata: { dev: 0, ino: 0, size: text.length, mtimeMs, ctimeMs: mtimeMs },
  })
  const known = (instructions: ReturnType<typeof version>): InstructionsState => instructionsState(instructions)

  test("a same-source change to empty is a diff, and a metadata-only change of empty instructions is none", () => {
    const rules = version("global", "Be brief.\n")
    const empty = version("global", "")
    const toEmpty = instructionsChange(known(rules), rules.text, empty, null)!
    expect(toEmpty.text).toContain("```diff\n--- /config/AGENTS.md\n+++ /config/AGENTS.md\n")
    expect(toEmpty.text).toContain("-Be brief.")
    expect(instructionsChange(known(empty), "", version("global", "", 5), null)).toBeNull()
    expect(instructionsChange({ kind: "none" }, null, empty, null)).toBeNull()
  })

  test("a switch to an empty source names it, and a switch to none says there are none", () => {
    const title = version("title", "Use tabs.\n")
    expect(instructionsChange(known(title), title.text, version("global", ""), "Helper")!.text).toContain(
      "The user instructions are now the global user instructions, which are empty, in place of the instructions for your title, Helper",
    )
    expect(instructionsChange(known(title), title.text, null, "Helper")!.text).toContain(
      "There are no user instructions now, in place of the instructions for your title, Helper",
    )
  })
})

describe("tools and providers", () => {
  test("a built-in tool offers a draft-07 schema and refuses arguments its schema rejects", async () => {
    let ran = 0
    const tool = builtinTool({
      name: "t",
      permission: null,
      description: "d",
      args: Schema.Struct({ path: Schema.String, limit: Schema.optionalKey(Schema.Int) }),
      run: async () => {
        ran += 1
        return { outcome: "success", content: "ok" }
      },
    })
    expect(tool.spec.parameters).toMatchObject({ type: "object", required: ["path"], properties: { path: { type: "string" } } })
    const run = { sessionId: "s", runId: "r", toolCallId: "c", cwd: "/", signal: new AbortController().signal, authorize: async () => {}, started: () => {}, imageInput: false, onCancel: () => {}, programCall: () => {}, offered: () => true }
    expect((await tool.run({ path: 1 }, run)).outcome).toBe("failed")
    expect(ran).toBe(0)
    expect(await tool.run({ path: "p" }, run)).toEqual({ outcome: "success", content: "ok" })
  })

  test("context overflow is recognized by code or message", () => {
    expect(isContextOverflow({ code: "context_length_exceeded", message: "x" })).toBe(true)
    expect(isContextOverflow({ error: { message: "Your input exceeds the context window of this model" } })).toBe(true)
    expect(isContextOverflow(new Error("prompt is too long: 300000 tokens"))).toBe(true)
    expect(isContextOverflow(new Error("rate limited"))).toBe(false)
  })

  test("variables the model libraries read are removed, others kept", () => {
    const env: Record<string, string | undefined> = { OPENAI_BASE_URL: "x", LANGSMITH_TRACING: "true", LANGCHAIN_VERBOSE: "1", LC_OUTPUT_VERSION: "v1", PATH: "/bin", ASHE_AGENT_PROVIDERS: "{}" }
    expect([...removeDependencyVariables(env)].sort()).toEqual(["LANGCHAIN_VERBOSE", "LANGSMITH_TRACING", "LC_OUTPUT_VERSION", "OPENAI_BASE_URL"])
    expect(env).toEqual({ PATH: "/bin", ASHE_AGENT_PROVIDERS: "{}" })
  })
})

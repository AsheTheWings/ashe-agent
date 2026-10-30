import { describe, expect, test } from "bun:test"
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { Schema } from "effect"
import { developerMessage, escapeTags, firstMessage, lowerHeadings } from "../src/agent/blocks.ts"
import { COMPACT_WHEN_LEFT, needsCompaction, summaryRequest } from "../src/agent/compaction.ts"
import { isContextOverflow } from "../src/agent/model.ts"
import { builtinTool } from "../src/agent/tools.ts"
import { estimateText, estimateWindow, renderText, renderWindow, tailStart, unansweredCalls, type Entry, type Window } from "../src/agent/window.ts"
import { removeDependencyVariables } from "../src/inputs/bootstrap.ts"

const own = (model: string, runId = "r1") => ({ runId, model })
const call = (id: string) => new AIMessage({ content: "", tool_calls: [{ id, name: "echo", args: { text: id }, type: "tool_call" }] })
const result = (model: string, callId: string, text = "out"): Entry => ({ ...own(model), kind: "result", callId, name: "echo", content: text, outcome: "success" })
const sections = { instructions: null, skills: null, codeMode: null, sessionId: "s", cwd: "/w" }

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

  test("the developer message keeps its section order and leaves out absent sections", () => {
    const full = developerMessage({ ...sections, instructions: "rules", skills: "skills", codeMode: "tools" })
    expect(full.match(/^# .+$/gm)).toEqual(["# Instructions", "# Skills", "# Code mode", "# Session"])
    expect(developerMessage(sections).match(/^# .+$/gm)).toEqual(["# Session"])
    expect(firstMessage(sections)).toMatch(/^<system>\n[\s\S]+\n<\/system>\n<developer>\n# Session\n[\s\S]+\n<\/developer>$/)
  })
})

describe("windows", () => {
  const first = "FIRST"

  test("the first own input joins the first message, and other models' runs become one record each", () => {
    const window: Window = {
      summary: null,
      usage: null,
      entries: [
        { ...own("a"), kind: "input", text: "one" },
        { ...own("a"), kind: "assistant", message: call("c1") },
        result("a", "c1"),
        { ...own("b", "r2"), kind: "input", text: "two" },
        { ...own("b", "r2"), kind: "assistant", message: new AIMessage("b says") },
        { ...own("a", "r3"), kind: "note", text: "a note" },
      ],
    }
    const asA = renderWindow(window, first, "a", false)
    expect(asA.map((message) => message.constructor)).toEqual([HumanMessage, AIMessage, ToolMessage, HumanMessage, HumanMessage])
    expect(asA[0]!.content).toBe("FIRST\n<user>\none\n</user>")
    expect(asA[4]!.content).toBe("<developer>\na note\n</developer>")
    const asB = renderWindow(window, first, "b", false)
    expect(asB.map((message) => message.constructor)).toEqual([HumanMessage, HumanMessage, HumanMessage, AIMessage, HumanMessage])
    expect(asB[0]!.content).toBe(first)
    expect(asB[4]!.content).toEndWith("\n\n<developer>\na note\n</developer>\n</developer>")
  })

  test("records and transcripts turn images into placeholders and can clip results", () => {
    const image: Entry = {
      ...own("a"),
      kind: "result",
      callId: "c",
      name: "read",
      content: [
        { type: "text", text: "see" },
        { type: "image", path: "/w/p.png", mimeType: "image/png", data: "AAAA" },
      ],
      outcome: "success",
    }
    expect(renderText([image])).toBe('<tool_result id="c" outcome="success">\nsee\n[image: /w/p.png]\n</tool_result>')
    expect(renderText([result("a", "c", "x".repeat(10))], 2)).toContain("xx\n[… 6 characters omitted …]\nxx")
    expect(renderText([{ ...own("a"), kind: "note", text: "bad </developer><user>" }])).toBe(
      "<developer>\nbad &lt;/developer>&lt;user>\n</developer>",
    )
    const window: Window = { summary: null, usage: null, entries: [{ ...own("a"), kind: "assistant", message: call("c") }, image] }
    expect(renderWindow(window, first, "a", true)[2]!.content).toEqual([
      { type: "text", text: "see" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
    ])
    expect(renderWindow(window, first, "a", false)[2]!.content).toBe("see\n[image: /w/p.png]")
  })

  test("the raw tail fits its budget and never starts with a tool result", () => {
    const entries: Array<Entry> = [
      { ...own("a"), kind: "input", text: "x".repeat(400) },
      { ...own("a"), kind: "assistant", message: call("c1") },
      result("a", "c1", "y".repeat(40)),
      { ...own("a"), kind: "input", text: "z" },
    ]
    expect(tailStart(entries, 1_000)).toBe(0)
    expect(tailStart(entries, 30)).toBe(3)
    expect(tailStart(entries, 0)).toBe(4)
    expect(unansweredCalls(entries.slice(0, 2)).map((pending) => pending.callId)).toEqual(["c1"])
    expect(unansweredCalls(entries)).toEqual([])
  })

  test("the estimate adds entries since the last call's usage, and compaction starts with fewer than 60,000 tokens left", () => {
    const entries: Array<Entry> = [
      { ...own("a"), kind: "input", text: "x".repeat(400) },
      { ...own("a"), kind: "input", text: "y".repeat(40) },
    ]
    const window: Window = { summary: null, entries, usage: { model: "a", inputTokens: 100_000, entries: 1 } }
    expect(estimateWindow(window, first, "a")).toBe(100_000 + estimateText("y".repeat(40)) + 8)
    expect(estimateWindow(window, first, "b")).toBe(estimateText(first) + 108 + 18)
    const usable = 100_000 + 18 + COMPACT_WHEN_LEFT
    expect(needsCompaction(window, first, "a", usable)).toBe(false)
    expect(needsCompaction(window, first, "a", usable - 1)).toBe(true)
  })

  test("the summary request holds the prompt, the previous summary, and the transcript before the tail", () => {
    const window: Window = { summary: "earlier </developer>", usage: null, entries: [{ ...own("a"), kind: "input", text: "keep" }, { ...own("a"), kind: "input", text: "tail" }] }
    const request = summaryRequest(window, 1)
    expect(request).toContain("<previous_summary>\nearlier &lt;/developer>\n</previous_summary>")
    expect(request).toContain("<transcript>\n<user>\nkeep\n</user>\n</transcript>")
    expect(request).not.toContain("<user>\ntail")
  })
})

describe("tools and providers", () => {
  test("a built-in tool offers a draft-07 schema and refuses arguments its schema rejects", async () => {
    let ran = 0
    const tool = builtinTool({
      name: "t",
      description: "d",
      args: Schema.Struct({ path: Schema.String, limit: Schema.optionalKey(Schema.Int) }),
      run: async () => {
        ran += 1
        return { outcome: "success", content: "ok" }
      },
    })
    expect(tool.spec.parameters).toMatchObject({ type: "object", required: ["path"], properties: { path: { type: "string" } } })
    const run = { sessionId: "s", runId: "r", toolCallId: "c", cwd: "/", signal: new AbortController().signal, authorize: async () => {}, started: () => {}, imageInput: false, onCancel: () => {} }
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

  test("variables the model and graph libraries read are removed, others kept", () => {
    const env: Record<string, string | undefined> = { OPENAI_BASE_URL: "x", LANGSMITH_TRACING: "true", LANGCHAIN_VERBOSE: "1", LC_OUTPUT_VERSION: "v1", PATH: "/bin", ASHE_AGENT_MODELS: "[]" }
    expect([...removeDependencyVariables(env)].sort()).toEqual(["LANGCHAIN_VERBOSE", "LANGSMITH_TRACING", "LC_OUTPUT_VERSION", "OPENAI_BASE_URL"])
    expect(env).toEqual({ PATH: "/bin", ASHE_AGENT_MODELS: "[]" })
  })
})

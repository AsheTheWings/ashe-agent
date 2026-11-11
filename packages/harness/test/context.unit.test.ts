import { describe, expect, test } from "bun:test"
import { AIMessage } from "@langchain/core/messages"
import { estimateCall } from "../src/agent/window.ts"
import { handoffTranscript } from "../src/context/auxiliary.ts"
import { checkpointComponent, recentTranscript, timelinesOverhead, trimPlan } from "../src/context/checkpoint.ts"
import { componentIssue } from "../src/context/seed.ts"
import {
  CHECKPOINT_ALLOWANCE,
  estimateTokens,
  IMAGE_TOKENS,
  RECENT_TRANSCRIPT_ALLOWANCE,
  TIMELINES_ALLOWANCE,
  TOOL_DEFINITIONS_ALLOWANCE,
} from "../src/context/constants.ts"
import {
  entryRenderer,
  openItems,
  parseHeader,
  researchSummary,
  validateAppend,
  type AppendInput,
  type Entry,
} from "../src/context/entries.ts"
import { answerEntries, questionProblems } from "../src/context/questions.ts"
import { boundaryCloses, boundarySize, clearingPlan, itemTokens } from "../src/context/sizes.ts"
import { toolDefinitionsIssue } from "../src/context/seed.ts"
import { memoryViolations, researchViolations } from "../src/context/validation.ts"
import type { AskArgs } from "../src/context/tools.ts"
import type { Item, ItemBody } from "../src/sessions/conversation.ts"
import { randomSessionId } from "../src/sessions/hub.ts"

const entry = (number: number, kind: Entry["kind"], fields: Record<string, string>, options: { resolves?: Array<number>; trimmed?: boolean } = {}): Entry => ({
  number,
  kind,
  fields,
  resolves: options.resolves ?? [],
  trimmed: options.trimmed ?? false,
  runId: "r1",
  windowPosition: 1,
})

const nothing = () => undefined
const never = () => false

let position = 0
const item = (body: ItemBody, runId: string | null = "r1"): Item => ({ ...body, position: ++position, runId, model: "test/alpha" }) as Item
const user = (text: string) => item({ kind: "user", inputId: text, text, sender: { kind: "login", loginId: "u" } })
const reply = (text: string, calls: Array<string> = []) =>
  item({ kind: "assistant", message: new AIMessage({ content: text, tool_calls: calls.map((id) => ({ id, name: "echo", args: {}, type: "tool_call" as const })) }) })
const result = (callId: string, content: string, runId = "r1") => item({ kind: "result", callId, name: "echo", content, outcome: "success" }, runId)

describe("entries", () => {
  test("fields hold 1 to 120 code points on one line, a call 1 to 16 entries, and an invalid entry refuses the batch", () => {
    const open = (Text: string): AppendInput => ({ kind: "open", Text })
    expect(validateAppend([open("é".repeat(120))], nothing, never)).toMatchObject({ ok: true })
    expect(validateAppend([open("x".repeat(121))], nothing, never)).toEqual({ ok: false, problems: ["entry 1: Text holds 121 characters, not 1 to 120"] })
    expect(validateAppend([open("")], nothing, never)).toEqual({ ok: false, problems: ["entry 1: Text holds 0 characters, not 1 to 120"] })
    expect(validateAppend([open("a"), open("two\nlines")], nothing, never)).toEqual({ ok: false, problems: ["entry 2: Text holds a line break"] })
    expect(validateAppend([{ kind: "decision", Decision: "d", Rationale: "" }], nothing, never)).toMatchObject({ ok: false })
    expect(validateAppend(Array.from({ length: 16 }, () => open("a")), nothing, never)).toMatchObject({ ok: true })
    expect(validateAppend(Array.from({ length: 17 }, () => open("a")), nothing, never)).toMatchObject({ ok: false, problems: ["a call appends 1 to 16 entries, not 17"] })
    expect(validateAppend([], nothing, never)).toMatchObject({ ok: false, problems: ["a call appends 1 to 16 entries, not 0"] })
  })

  test("each resolves refusal: no entry, a kind other than open or problem, already resolved, named twice, and its count", () => {
    const stored = new Map<number, Pick<Entry, "kind">>([
      [1, { kind: "open" }],
      [2, { kind: "decision" }],
      [3, { kind: "problem" }],
      [4, { kind: "open" }],
    ])
    const lookup = (number: number) => stored.get(number)
    const resolved = (number: number) => number === 4
    const done = (resolves: Array<number>): AppendInput => ({ kind: "done", Text: "finished", resolves })
    expect(validateAppend([done([1, 3])], lookup, resolved)).toEqual({ ok: true, entries: [{ kind: "done", fields: { Text: "finished" }, resolves: [1, 3] }] })
    const refused = (inputs: Array<AppendInput>) => {
      const checked = validateAppend(inputs, lookup, resolved)
      return checked.ok ? [] : checked.problems
    }
    expect(refused([done([9])])).toEqual(["entry 1: resolves #9, which is no entry of this session"])
    expect(refused([done([2])])).toEqual(["entry 1: resolves #2, a decision entry, not an open or problem entry"])
    expect(refused([done([4])])).toEqual(["entry 1: resolves #4, which is already resolved"])
    expect(refused([done([1]), done([1])])).toEqual(["entry 2: resolves #1, which another resolves of this call names"])
    expect(refused([done([])])).toEqual(["entry 1: resolves lists 0 entries, not 1 to 16"])
    expect(refused([done(Array.from({ length: 17 }, () => 1))])[0]).toBe("entry 1: resolves lists 17 entries, not 1 to 16")
  })

  test("entries render a header, fields in order, escaped header-like lines, and a done entry restating what it resolves", () => {
    const all = [
      entry(1, "open", { Text: "Write the parser" }),
      entry(2, "problem", { Text: "The build fails" }),
      entry(3, "done", { Text: "Parser written" }, { resolves: [1, 2] }),
      entry(4, "decision", { Rationale: "simpler", Decision: "Use JSON" }),
      entry(5, "compaction", { Text: "Requests:\n[OPEN #9] looks like a header\n- more" }),
      entry(6, "research", { FileName: "a.md", Change: "created", Summary: "s" }),
      entry(7, "answer", { Question: "Which?", Selection: "A: the first", UserNote: "note" }),
      entry(8, "answer", { Question: "Which?", UserNote: "only a note" }),
    ]
    const render = entryRenderer(all)
    expect(render(all[2]!)).toBe("[DONE #3]\nText: Parser written\nResolves: #1 [OPEN] Write the parser\nResolves: #2 [PROBLEM] The build fails")
    expect(render(all[3]!)).toBe("[DECISION #4]\nDecision: Use JSON\nRationale: simpler")
    expect(render(all[4]!)).toBe("[COMPACTION #5]\nRequests:\n\\[OPEN #9] looks like a header\n- more")
    expect(render(all[5]!)).toBe("[RESEARCH #6]\nFileName: a.md\nChange: created\nSummary: s")
    expect(render(all[6]!)).toBe("[ANSWER #7]\nQuestion: Which?\nSelection: A: the first\nUserNote: note")
    expect(render(all[7]!)).toBe("[ANSWER #8]\nQuestion: Which?\nUserNote: only a note")
    expect(parseHeader("[OPEN #12]")).toEqual({ kind: "open", number: 12 })
    expect(parseHeader("\\[OPEN #12]")).toBeNull()
    expect(parseHeader("[OPEN #0]")).toBeNull()
    expect(openItems(all)).toEqual([])
    expect(openItems(all.slice(0, 2)).map((open) => open.number)).toEqual([1, 2])
  })

  test("a research summary is one line cut at a word boundary to 240 code points with an ellipsis, and none when empty", () => {
    expect(researchSummary("  The file\n gained   a section.  ")).toBe("The file gained a section.")
    expect(researchSummary(" \n ")).toBeNull()
    const exact = "é".repeat(240)
    expect(researchSummary(exact)).toBe(exact)
    const long = `${"word ".repeat(60)}end`
    const cut = researchSummary(long)!
    expect([...cut].length).toBeLessThanOrEqual(240)
    expect(cut.endsWith("word…")).toBe(true)
  })

  test("generated session ids are 12 characters of a-z and 0-9", () => {
    const ids = Array.from({ length: 200 }, randomSessionId)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{12}$/)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("questions and answers", () => {
  const option = (label: string) => ({ label, description: `${label} described` })
  const question = (id: string, overrides: Partial<AskArgs["questions"][number]> = {}) => ({
    id,
    header: "Header",
    question: "Which one?",
    options: [option("A"), option("B")],
    ...overrides,
  })

  test("a call asks 1 to 3 questions of unique ids, with headers, questions, options, and feedback within their limits", () => {
    expect(questionProblems({ questions: [question("a")] })).toEqual([])
    expect(questionProblems({ questions: [question("a"), question("b"), question("c")], feedback: "f".repeat(2_000) })).toEqual([])
    expect(questionProblems({ questions: [] })).toEqual(["a call asks 1 to 3 questions, not 0"])
    expect(questionProblems({ questions: [question("a"), question("b"), question("c"), question("d")] })).toEqual(["a call asks 1 to 3 questions, not 4"])
    expect(questionProblems({ questions: [question("a"), question("a")] })).toEqual(["question 2 repeats the id a"])
    expect(questionProblems({ questions: [question("a", { header: "x".repeat(13) })] })).toEqual(["question 1's header holds 13 characters, not 1 to 12"])
    expect(questionProblems({ questions: [question("a", { question: "x".repeat(241) })] })).toEqual(["question 1's question holds 241 characters, not 1 to 240"])
    expect(questionProblems({ questions: [question("a", { options: [option("A")] })] })).toEqual(["question 1 has 1 options, not 2 to 3"])
    expect(questionProblems({ questions: [question("a", { options: [option("A"), option("B"), option("C"), option("D")] })] })).toEqual([
      "question 1 has 4 options, not 2 to 3",
    ])
    expect(questionProblems({ questions: [question("a", { options: [option("x".repeat(41)), option("B")] })] })[0]).toContain("label holds 41")
    expect(questionProblems({ questions: [question("a", { options: [{ label: "A", description: "d".repeat(121) }, option("B")] })] })[0]).toContain(
      "description holds 121",
    )
    expect(questionProblems({ questions: [question("a")], feedback: "f".repeat(2_001) })).toEqual(["feedback holds 2001 characters, not 1 to 2000"])
  })

  test("answers become answer entries; a skip has none; a note is 1 to 2,000 characters; unknown answers are refused", () => {
    const questions = [question("a"), question("b", { question: "Second?" }), question("c")]
    expect(answerEntries(questions, [{ id: "a", selection: "B", note: "n".repeat(2_000) }, { id: "b", note: "just a note" }, { id: "c" }])).toEqual({
      ok: true,
      entries: [
        { kind: "answer", fields: { Question: "Which one?", Selection: "B: B described", UserNote: "n".repeat(2_000) } },
        { kind: "answer", fields: { Question: "Second?", UserNote: "just a note" } },
      ],
      skipped: ["c"],
    })
    expect(answerEntries(questions, [])).toEqual({ ok: true, entries: [], skipped: ["a", "b", "c"] })
    expect(answerEntries(questions, [{ id: "a", note: "n".repeat(2_001) }])).toEqual({ ok: false, problem: "the note to question a holds 2001 characters, not 1 to 2000" })
    expect(answerEntries(questions, [{ id: "a", note: "" }])).toMatchObject({ ok: false })
    expect(answerEntries(questions, [{ id: "z" }])).toEqual({ ok: false, problem: "no question z in this set" })
    expect(answerEntries(questions, [{ id: "a", selection: "C" }])).toEqual({ ok: false, problem: "question a has no option C" })
    expect(answerEntries(questions, [{ id: "a" }, { id: "a" }])).toEqual({ ok: false, problem: "question a is answered twice" })
  })
})

describe("secondary timeline validation", () => {
  const stored = [entry(1, "open", { Text: "first" }, { trimmed: true }), entry(2, "decision", { Decision: "d", Rationale: "r" }, { trimmed: true }), entry(3, "open", { Text: "kept" })]
  const render = entryRenderer(stored)
  const file = (description: string | null, ...numbers: Array<number>) =>
    `${description === null ? "" : `---\ndescription: ${description}\n---\n\n`}${numbers.map((number) => `${render(stored[number - 1]!)}\n`).join("\n")}`
  const check = (draft: Array<{ name: string; text: string | null }>) => memoryViolations(draft, stored, render)

  test("a draft holding every trimmed entry verbatim, in order, once, under a description is accepted", () => {
    expect(check([{ name: "work.md", text: file("The work", 1, 2) }])).toEqual([])
    expect(check([{ name: "one.md", text: file("One", 1) }, { name: "two.md", text: file("Two", 2, 3) }])).toEqual([])
    expect(researchViolations([{ name: "notes.md", text: "---\ndescription: Notes\n---\nbody" }])).toEqual([])
  })

  test("a description is the frontmatter's YAML string on one line", () => {
    const problems = (text: string) => researchViolations([{ name: "notes.md", text }])
    expect(problems("\uFEFF---\r\ndescription: Notes # a comment\r\n---\r\nbody")).toEqual([])
    expect(problems('---\ndescription: "Quoted: notes"\n---\n')).toEqual([])
    expect(problems("---\ndescription: >-\n  Folded\n  notes\n---\n")).toEqual([])
    const none = ["`research/notes.md` has no `description:` frontmatter of 1 to 120 characters."]
    expect(problems("---\ndescription: |\n  Two\n  lines\n---\n")).toEqual(none)
    expect(problems("---\ndescription: [unclosed\n---\n")).toEqual(none)
    expect(problems("---\ndescription: 5\n---\n")).toEqual(none)
    expect(problems("---\ndescription: Notes\n")).toEqual(none)
    // The body starts after the closing fence, with or without a line break after it.
    expect(check([{ name: "work.md", text: `---\ndescription: The work\n---\n${render(stored[0]!)}\n\n${render(stored[1]!)}` }])).toEqual([])
    expect(check([{ name: "empty.md", text: "---\ndescription: Empty\n---" }, { name: "work.md", text: file("The work", 1, 2) }])).toEqual([])
  })

  test("an answer whose question and multi-line note end in line breaks files verbatim", () => {
    const questions = [{ id: "q", header: "H", question: "Which?\n", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }]
    const answered = answerEntries(questions, [{ id: "q", note: "Keep it local.\n\nAnd small.\n\n" }])
    if (!answered.ok) throw new Error(answered.problem)
    const answer = entry(1, "answer", answered.entries[0]!.fields, { trimmed: true })
    const renderAnswer = entryRenderer([answer])
    expect(renderAnswer(answer)).toBe("[ANSWER #1]\nQuestion: Which?\n\nUserNote: Keep it local.\n\nAnd small.")
    const text = `---\ndescription: Answers\n---\n\n${renderAnswer(answer)}\n`
    expect(memoryViolations([{ name: "answers.md", text }], [answer], renderAnswer)).toEqual([])
  })

  test("each violation is named: not Markdown, no description, stray text, unseparated, changed, out-of-order, missing, or repeated entries, a long path, too many files", () => {
    expect(check([{ name: "dir", text: null }, { name: "work.md", text: file("W", 1, 2) }])).toEqual([
      "`memory-draft/dir` is not a Markdown file directly inside `research/` or `memory-draft/`.",
    ])
    expect(check([{ name: "work.md", text: file(null, 1, 2) }])).toEqual(["`memory-draft/work.md` has no `description:` frontmatter of 1 to 120 characters."])
    expect(check([{ name: "work.md", text: file("W", 1, 2).replace("---\n\n", "---\nstray\n\n") }])).toEqual([
      "`memory-draft/work.md` holds text other than entries, at line 4.",
    ])
    expect(check([{ name: "work.md", text: `---\ndescription: W\n---\n${render(stored[0]!)}\n${render(stored[1]!)}\n` }])).toEqual([
      "`memory-draft/work.md`: no blank line separates entry #2 from the entry before it.",
    ])
    expect(check([{ name: "work.md", text: file("W", 1, 2).replace("first", "changed") }])).toEqual([
      "`memory-draft/work.md`: entry #1 differs from entry #1 as recorded.",
    ])
    expect(check([{ name: "work.md", text: file("W", 2, 1) }])).toEqual(["`memory-draft/work.md`: entry #1 comes after a later entry."])
    expect(check([{ name: "work.md", text: file("W", 1) }])).toEqual(["Entry #2 is in no secondary timeline."])
    expect(check([{ name: "a.md", text: file("A", 1, 2) }, { name: "b.md", text: file("B", 2) }])).toEqual([
      "Entry #2 is in `memory-draft/a.md` and `memory-draft/b.md`.",
    ])
    expect(check([{ name: `${"p".repeat(118)}.md`, text: file("W", 1, 2) }])).toEqual([`\`memory-draft/${"p".repeat(118)}.md\`: the path is over 120 characters.`])
    const many = Array.from({ length: 65 }, (_, index) => ({ name: `f${index}.md`, text: index === 0 ? file("W", 1, 2) : file("F") }))
    expect(check(many)).toEqual(["`memory-draft/` holds 65 files; at most 64 are allowed."])
    expect(researchViolations([{ name: "notes.md", text: "no frontmatter" }, { name: "image.png", text: null }])).toEqual([
      "`research/notes.md` has no `description:` frontmatter of 1 to 120 characters.",
      "`research/image.png` is not a Markdown file directly inside `research/` or `memory-draft/`.",
    ])
  })
})

describe("sizes", () => {
  test("the estimate is characters over four rounded up, each image 1,500 tokens, and the call counts tools", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("abcd")).toBe(1)
    expect(estimateTokens("abcde")).toBe(2)
    const image = result("c1", "")
    const picture = { type: "image" as const, path: "a.png", data: "AAAA", mimeType: "image/png" }
    const withImage = { ...image, content: [picture] } as Item
    const twoImages = { ...image, content: [picture, picture] } as Item
    // Each image adds its estimate and its text placeholder's few characters.
    expect(itemTokens(twoImages) - itemTokens(withImage)).toBeGreaterThanOrEqual(IMAGE_TOKENS)
    expect(itemTokens(twoImages) - itemTokens(withImage)).toBeLessThan(IMAGE_TOKENS + 10)
    const spec = { name: "t", description: "d".repeat(400), parameters: { type: "object" } }
    expect(estimateCall("", [], [spec]) - estimateCall("", [], [])).toBe(estimateTokens(JSON.stringify([spec])) - estimateTokens("[]"))
  })

  test("tool definitions are refused past 4,000 estimated tokens of names, descriptions, and schemas", () => {
    const specs = (length: number) => [{ name: "t", description: "d".repeat(length), parameters: { type: "object" } }]
    const overhead = JSON.stringify(specs(0)).length
    expect(toolDefinitionsIssue(specs(TOOL_DEFINITIONS_ALLOWANCE * 4 - overhead))).toBeNull()
    expect(toolDefinitionsIssue(specs(TOOL_DEFINITIONS_ALLOWANCE * 4 - overhead + 1))).toMatchObject({ tokens: TOOL_DEFINITIONS_ALLOWANCE + 1 })
  })

  test("chat boundary sizes leave out seed components and context turn items from the context turn component on", () => {
    const seed = item({ kind: "component", component: { type: "seed", name: "session_facts", heading: "Session Facts", text: "s".repeat(4_000), sources: {} } }, null)
    const ask = user("question")
    const normal = result("c1", "x".repeat(400))
    const before = result("c2", "y".repeat(400), "r2")
    const marker = item({ kind: "component", component: { type: "notification", name: "context_turn", heading: "Context Turn", text: "t".repeat(400), sources: {} } }, "r2")
    const after = result("c3", "z".repeat(4_000), "r2")
    const contextItem = (runId: string) => (runId === "r2" ? marker.position : null)
    expect(boundarySize([seed, ask, normal, before, marker, after], contextItem)).toBe(itemTokens(ask) + itemTokens(normal) + itemTokens(before))
    const cleared = { ...normal, cleared: true } as Item
    expect(itemTokens(cleared)).toBe(itemTokens(normal))
  })

  test("a chat boundary closes when its size reaches 60,000 tokens", () => {
    const ask = user("q")
    const sized = (tokens: number) => result("c9", "x".repeat(4 * (tokens - itemTokens(ask) - itemTokens(result("c9", "")))))
    const below = [ask, sized(59_999)]
    const at = [ask, sized(60_000)]
    expect(boundarySize(below, () => null)).toBe(59_999)
    expect(boundarySize(at, () => null)).toBe(60_000)
    expect(boundaryCloses(below, () => null)).toBe(false)
    expect(boundaryCloses(at, () => null)).toBe(true)
  })

  test("clearings free 25%, 50%, then all of the clearable tokens before the first, oldest results first", () => {
    const results = [100, 100, 100, 100].map((tokens, index) => result(`c${index}`, "x".repeat(tokens * 4))) as Array<Extract<Item, { kind: "result" }>>
    const tokens = results.map((entry) => estimateTokens(entry.content as string))
    const clearable = tokens.reduce((sum, value) => sum + value, 0)
    const first = clearingPlan(results, 1, clearable, 0)
    expect(first.positions).toEqual([results[0]!.position])
    const second = clearingPlan(results.slice(1), 2, clearable, first.freed)
    expect(second.positions).toEqual([results[1]!.position])
    const third = clearingPlan(results.slice(2), 3, clearable, first.freed + second.freed)
    expect(third.positions).toEqual([results[2]!.position, results[3]!.position])
    expect(first.freed + second.freed + third.freed).toBe(clearable)
  })

  test("the recent transcript holds whole items after the last user message, newest first within its allowance, and none after a bare user message", () => {
    const ask = user("do it")
    const call = reply("", ["c1"])
    const out = result("c1", "out")
    const final = reply("done")
    expect(recentTranscript([user("old"), reply("old reply"), ask, call, out, final])).toEqual([call, out, final])
    const note = item({ kind: "component", component: { type: "notification", name: "n", heading: "N", text: "# N", sources: {} } })
    expect(recentTranscript([reply("old"), ask, note])).toEqual([])
    expect(recentTranscript([ask])).toEqual([])
    const huge = result("c2", "h".repeat(RECENT_TRANSCRIPT_ALLOWANCE * 4))
    expect(recentTranscript([ask, call, huge, final])).toEqual([final])
  })

  test("handoff transcripts shorten oldest exchanges first: tool output cut, then left out, then user text only, else none", () => {
    const exchange = (text: string) => [user(text), reply("", [`${text}-call`]), result(`${text}-call`, "o".repeat(40_000)), reply(`${text} done`)]
    const items = [...exchange("first"), ...exchange("second")]
    const whole = handoffTranscript(items, 1_000_000)!
    expect(whole).toContain("o".repeat(40_000))
    const budget = estimateTokens(whole) - 1
    const cut = handoffTranscript(items, budget)!
    expect(cut).toContain("characters cut")
    expect(cut.indexOf("characters cut")).toBeLessThan(cut.indexOf("second"))
    expect(cut).toContain("o".repeat(40_000))
    const small = handoffTranscript(items, 2_000)!
    expect(small).toContain("[output left out]")
    expect(small).not.toContain("o".repeat(40_000))
    const userOnly = handoffTranscript(items, estimateTokens(handoffTranscript([user("first"), user("second")], 1_000_000)!) + 1)!
    expect(userOnly).not.toContain("tool_call")
    expect(handoffTranscript(items, 1)).toBeNull()
  })

  test("a checkpoint at exactly its section allowances fits its component allowance, with and without the trimmed open items line", () => {
    for (const trimmedOpen of [0, 1]) {
      const prefix = trimmedOpen === 0 ? [] : [entry(1, "open", { Text: "only in memory" }, { trimmed: true })]
      const overhead = timelinesOverhead("s1", [{ path: "memory/a.md", description: "A" }], trimmedOpen)
      const number = prefix.length + 1
      // An entry part is its rendering and a blank line; the header line is `[COMPACTION #n]` and a line break.
      const header = `[COMPACTION #${number}]\n`.length
      const text = "c".repeat((TIMELINES_ALLOWANCE - overhead) * 4 - header - 2)
      const entries = [...prefix, entry(number, "compaction", { Text: text })]
      const render = entryRenderer(entries)
      const timelines = [{ path: "memory/a.md", description: "A" }]
      expect(trimPlan("s1", entries, timelines, render)).toEqual([])
      const over = [...prefix, entry(number, "compaction", { Text: `${text}c` })]
      expect(trimPlan("s1", over, timelines, entryRenderer(over))).toEqual([number])
      const ask = user("go")
      const recent = reply("r".repeat((RECENT_TRANSCRIPT_ALLOWANCE - estimateTokens("## Recent Transcript\n\n") - 120) * 4))
      const transcript = recentTranscript([ask, recent])
      expect(transcript).toEqual([recent])
      const component = checkpointComponent({ sessionId: "s1", timelines, entries, render, transcript })
      expect(estimateTokens(component.text)).toBeLessThanOrEqual(CHECKPOINT_ALLOWANCE)
      expect(componentIssue(component)).toBeNull()
      expect(component.text.includes("open items are only in secondary timelines")).toBe(trimmedOpen === 1)
    }
  })
})

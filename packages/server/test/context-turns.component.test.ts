import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SessionEvent } from "@ashe-agent/protocol"
import { AIMessageChunk } from "@langchain/core/messages"
import { ModelCallError } from "../src/agent/model.ts"
import type { Component } from "../src/context/components.ts"
import { waitFor } from "./support/cli.ts"
import { callTools, configuredModel, failWith, gate, hold, messageText, say, type AgentHarness, type Reply } from "./support/agent.ts"
import { InstructionsUnreadable } from "../src/agents/setup.ts"
import { timelinesOverhead } from "../src/context/checkpoint.ts"
import { estimateTokens } from "../src/context/constants.ts"
import { entryRenderer, openItems } from "../src/context/entries.ts"
import { noAgents } from "../src/sessions/setup.ts"
import { contextHarness, filler, publishMemory, windowModel, type RoutedModel } from "./support/context.ts"

/** A checkpoint window of 120,000 tokens: a context turn starts past 80,000. */
const mid = windowModel("test/mid", 120_000)
/** A checkpoint window of 200,000 tokens: a context turn starts past 160,000. */
const large = windowModel("test/large", 200_000)

const bodies = (events: ReadonlyArray<SessionEvent>) => events.map((event) => event.event) as Array<any>
const ofType = (h: AgentHarness, id: string, type: string) => bodies(h.events(id)).filter((event) => event.type === type)
const runIds = (h: AgentHarness, id: string) => ofType(h, id, "RUN_STARTED").map((event) => event.runId as string)
const callText = (call: { messages: ReadonlyArray<any> }) => call.messages.map(messageText).join("\n")
const eventually = (h: AgentHarness, id: string, type: string, count = 1) =>
  waitFor(`${count} ${type}`, () => (ofType(h, id, type).length >= count ? true : undefined), 10_000)

/** Asserts that `parts` appear in `text` in this order. */
const expectInOrder = (text: string, parts: ReadonlyArray<string>) => {
  let at = -1
  for (const part of parts) {
    const next = text.indexOf(part, at + 1)
    expect({ part, found: next > at }).toEqual({ part, found: true })
    at = next
  }
}

const blob = (tokens: number, letter = "b") => callTools([{ name: "blob", args: { tokens, letter } }])
const append = (...entries: ReadonlyArray<Record<string, unknown>>) => callTools([{ name: "context_append", args: { entries } }])
/** A reply that runs `act` when its call arrives, then streams `then`. */
const doing =
  (act: () => void, then: Reply): Reply =>
  (call, signal) => {
    act()
    return then(call, signal)
  }

const note = (name: string, text: string): Component => ({ type: "notification", name, heading: name, text: `# ${name}\n\n${text}`, sources: {} })

/** Runs one turn of `text` in `id` on `replies`, waiting for it to end. */
const turn = async (h: AgentHarness, id: string, text: string, ...replies: Array<Reply>) => {
  const ended = ofType(h, id, "RUN_FINISHED").length + ofType(h, id, "RUN_ERROR").length
  h.model.next(...replies)
  h.input(id, text)
  await h.turnsEnded(id, ended + 1)
}

/** Fills most of a `mid` checkpoint window with a closed boundary and waits for its compaction entry. */
const fill = async (h: AgentHarness, id: string) => {
  await turn(h, id, "first", blob(76_000), say("first done"))
  await eventually(h, id, "TIMELINE_ENTRY")
}

const NO_DESCRIPTION = "---\ntitle: Notes\n---\n"
const KEEP = "---\ndescription: Kept notes\n---\n"
const memoryFiles = (h: AgentHarness, id: string) => {
  const dir = join(h.sessionDir(id), "memory")
  return Object.fromEntries(readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name), "utf8")]))
}
const draftPath = (h: AgentHarness, id: string, name: string) => join(h.sessionDir(id), "memory-draft", name)
const components = (h: AgentHarness, id: string, heading: string) =>
  ofType(h, id, "DEVELOPER_MESSAGE").flatMap((event) => event.components).filter((component: any) => component.heading === heading)

const windows = (h: AgentHarness, id: string) =>
  h.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM checkpoint_windows WHERE session_id = ?").get(id)!.n

const withContext = async (body: (h: AgentHarness, aux: RoutedModel) => Promise<void>, options: Parameters<typeof contextHarness>[0] = {}) => {
  const { h, aux } = contextHarness({ models: [mid, large], ...options })
  try {
    await body(h, aux)
  } finally {
    await h.cleanup()
  }
}

describe("context turns", () => {
  test("a context turn with less than the reserve left holds input, waits for a slow open-boundary compaction, and continues in a checkpoint window", async () => {
    await withContext(async (h, aux) => {
      const id = h.create({ model: mid.id })
      // A closed boundary fills most of the checkpoint window.
      h.model.next(blob(76_000), say("first done"))
      h.input(id, "first")
      await h.turnsEnded(id, 1)
      await eventually(h, id, "TIMELINE_ENTRY")
      const slow = gate()
      aux.next("compaction", hold(slow.promise, say("Requests:\n- the second request")))
      h.model.next(
        blob(5_000),
        doing(() => {
          h.input(id, "held message")
          h.hub.store.conversation.addWaiting(id, { kind: "notification", component: note("held_note", "a held notification") }, Date.now())
        }, append({ kind: "open", Text: "Finish the parser" }, { kind: "decision", Decision: "Use a table", Rationale: "simpler" })),
        say("Context in order."),
        say("Continuing."),
      )
      h.input(id, "second")
      await h.calls(5)
      expect(h.hub.isRunning(id)).toBe(true)
      expect(ofType(h, id, "CHECKPOINT_WINDOW_SEEDED")).toHaveLength(1)
      slow.open()
      await h.turnsEnded(id, 3)

      const [, second] = runIds(h, id)
      expect(ofType(h, id, "CONTEXT_TURN_STARTED")).toEqual([{ type: "CONTEXT_TURN_STARTED", runId: second, trigger: "threshold" }])
      expect(callText(h.model.calls[3]!.call)).toContain("# Context Turn")
      expect(ofType(h, id, "TIMELINE_ENTRY").map((event) => [event.entry.number, event.entry.kind])).toEqual([
        [1, "compaction"],
        [2, "open"],
        [3, "decision"],
        [4, "compaction"],
      ])
      const [closed, lone] = aux.calls("compaction").map(callText)
      expect(closed).toContain("<conversation>\n<user>first</user>\n</conversation>")
      expect(lone).toContain("[COMPACTION #1]")
      expect(lone).toContain("<conversation>\n<user>second</user>\n</conversation>")
      expect(ofType(h, id, "RUN_STARTED").map((event) => event.cause)).toEqual(["user", "user", "continuation"])
      expect(ofType(h, id, "CHECKPOINT_WINDOW_SEEDED").map((event) => event.runId)).toEqual([null, second])
      const types = h.types(id)
      expect(types.indexOf("CHECKPOINT_WINDOW_SEEDED", types.indexOf("CONTEXT_TURN_STARTED"))).toBeLessThan(
        bodies(h.events(id)).findIndex((event) => event.type === "INPUT_RECEIVED" && event.text === "held message"),
      )

      const continuation = callText(h.model.last())
      expectInOrder(continuation, [
        "# Session Facts",
        "# Session Checkpoint",
        "## Secondary Timelines",
        "## Primary Timeline",
        "[COMPACTION #1]",
        "[OPEN #2]\nText: Finish the parser",
        "[DECISION #3]",
        "[COMPACTION #4]\nRequests:\n- the second request",
        "## Recent Transcript",
        '<tool_call name="blob"',
        "# Continuation",
        "<user>\nheld message\n</user>",
        "a held notification",
      ])
      // The checkpoint and the continuation component form one developer message: no block closes between them.
      const seedToContinuation = continuation.slice(continuation.indexOf("# Session Checkpoint"), continuation.indexOf("# Continuation"))
      expect(seedToContinuation).not.toContain("</developer>")
      expect(continuation).not.toContain("# Context Turn")
      expect(continuation).not.toContain("Context in order.")
      expect(continuation).not.toContain("first done")
      expect(existsSync(join(h.sessionDir(id), "memory-draft"))).toBe(false)
      expect(h.hub.store.conversation.waiting(id)).toEqual([])
    })
  })

  test("a trim delivers a timelines trimmed component with the replaced entry, and filed entries reach the next checkpoint's secondary timelines", async () => {
    await withContext(async (h, aux) => {
      const id = h.create({ model: large.id })
      const replaced = `Requests:\n- ${filler(30_000, "t")}`
      aux.next("compaction", say("Requests:\n- the first request"), say("Requests:\n- the second request"), say(replaced), say(`Requests:\n- ${filler(31_000, "s")}`))
      await turn(h, id, "first", append({ kind: "open", Text: "Finish the parser" }), blob(61_000), blob(50_000), say("a done"))
      await eventually(h, id, "TIMELINE_ENTRY", 2)
      // A context turn in the first window gives the lone second message its entry; the continuation turn follows.
      await turn(h, id, "second", blob(50_000), say("in order"), say("continuing"))
      await h.turnsEnded(id, 3)
      expect(ofType(h, id, "CHECKPOINT_WINDOW_SEEDED")).toHaveLength(2)
      // The second boundary closes in the next window, replacing its entry's text.
      await turn(h, id, "third", blob(20_000), say("third done"))
      await eventually(h, id, "TIMELINE_ENTRY_REPLACED")
      expect(ofType(h, id, "TIMELINE_ENTRY_REPLACED")).toMatchObject([{ number: 3, text: replaced }])
      await turn(h, id, "fourth", blob(59_000), say("fourth done"))
      const file = () => {
        const entries = h.hub.store.timeline.entries(id)
        const render = entryRenderer(entries)
        const draft = join(h.sessionDir(id), "memory-draft")
        writeFileSync(join(draft, "work.md"), `---\ndescription: Parser work\n---\n\n${entries.filter((entry) => entry.trimmed).map(render).join("\n\n")}\n`)
      }
      // State the context turn records before its first idle survives the trim at that idle.
      await turn(h, id, "fifth", blob(80_000), append({ kind: "open", Text: "Recorded before the trim" }), say("in order"), doing(file, say("filed")), say("on"))
      await h.turnsEnded(id, 7)

      const trimmed = ofType(h, id, "DEVELOPER_MESSAGE").flatMap((event) => event.components).find((component: any) => component.heading === "Timelines Trimmed")
      expect(trimmed.text).toContain("trimmed entries #1 to #3")
      expect(trimmed.text).toContain(replaced)
      expect(trimmed.text).not.toContain("the first request")
      expect(ofType(h, id, "VALIDATION_FAILED")).toEqual([])
      expect(readFileSync(join(h.sessionDir(id), "memory", "work.md"), "utf8")).toContain("[OPEN #1]\nText: Finish the parser")
      const third = callText(h.model.last())
      expectInOrder(third, [
        "# Session Checkpoint",
        "- `memory/work.md`: Parser work",
        "1 open items are only in secondary timelines",
        "[COMPACTION #4]",
        "Text: Recorded before the trim",
        "# Continuation",
      ])
      expect(third).not.toContain("[COMPACTION #3]")
      expect(third).not.toContain("[OPEN #1]")
    })
  }, 60_000)

  test("held input starts a turn in the same checkpoint window after a context turn fails on compaction, research, or construction", async () => {
    const catalogs = { skills: null as string | null, codeMode: null as string | null }
    const cases = [
      { code: "compaction_failed", arrange: (aux: RoutedModel) => aux.next("compaction", failWith(new Error("down")), failWith(new Error("down"))), during: () => {} },
      { code: "research_failed", arrange: (aux: RoutedModel) => aux.next("research", failWith(new Error("down")), failWith(new Error("down"))), during: () => {} },
      { code: "checkpoint_window_failed", arrange: () => {}, during: () => (catalogs.skills = `- \`a\`: ${"s".repeat(20_000)}`) },
    ]
    for (const failure of cases) {
      catalogs.skills = null
      await withContext(
        async (h, aux) => {
          const id = h.create({ model: mid.id })
          await fill(h, id)
          failure.arrange(aux)
          const writeResearch = () => writeFileSync(join(h.sessionDir(id), "research", "notes.md"), "---\ndescription: Notes\n---\nA finding.\n")
          h.model.next(
            doing(writeResearch, blob(5_000)),
            doing(() => {
              h.input(id, "held")
              failure.during()
            }, say("in order")),
            // The window is still full, so the held input's turn is a context turn too.
            doing(() => (catalogs.skills = null), say("in order again")),
            say("continued"),
          )
          h.input(id, "second")
          await h.turnsEnded(id, 4)
          const [, second, after, continuation] = ofType(h, id, "RUN_STARTED")
          expect(ofType(h, id, "RUN_ERROR")).toMatchObject([{ runId: second.runId, code: failure.code }])
          expect(after).toMatchObject({ cause: "user" })
          expect(continuation).toMatchObject({ cause: "continuation" })
          expect(ofType(h, id, "INPUT_RECEIVED").map((event) => event.text)).toEqual(["first", "second", "held"])
          expect(callText(h.model.calls[4]!.call)).toContain("<user>\nheld\n</user>")
          // The failed context turn added no checkpoint window; the held input's context turn added the second.
          expect(ofType(h, id, "CHECKPOINT_WINDOW_SEEDED").map((event) => event.runId)).toEqual([null, after.runId])
          expect(windows(h, id)).toBe(2)
          if (failure.code === "compaction_failed") {
            const inputId = bodies(h.events(id)).find((event) => event.type === "INPUT_RECEIVED" && event.text === "second").inputId
            expect(ofType(h, id, "RUN_ERROR")[0].message).toBe(`the compaction call for the chat boundary from the user message ${inputId} failed twice`)
          }
          // Two failed calls in the failed context turn, then one in the held input's.
          if (failure.code === "research_failed") expect(aux.calls("research")).toHaveLength(3)
          if (failure.code === "checkpoint_window_failed") {
            expect(ofType(h, id, "CHECKPOINT_WINDOW_FAILED")).toMatchObject([{ runId: second.runId }])
            expect(ofType(h, id, "RUN_ERROR")[0].message).toMatch(/^the next checkpoint window cannot be built: the skill catalog component is \d+ estimated tokens, over its allowance of 4000$/)
          }
        },
        { setup: { ...noAgents, catalogs: () => catalogs } },
      )
    }
  })

  test("a restart during a context turn settles its draft and starts its held input once recovery ends", async () => {
    await withContext(async (h) => {
      const id = h.create({ model: mid.id })
      await fill(h, id)
      const draft = join(h.sessionDir(id), "memory-draft")
      h.model.next(
        blob(5_000),
        doing(() => {
          h.input(id, "held")
          writeFileSync(join(draft, "notes.md"), "---\ndescription: Notes\n---\n")
        }, hold(new Promise(() => {}))),
      )
      h.input(id, "second")
      await h.calls(4)
      // The window is still full, so the held input's turn is a context turn too.
      h.model.next(say("in order"), say("continued"))
      await h.restart()
      // The interrupted turn ends with neither a finished nor an error event.
      await h.turnsEnded(id, 3)
      expect(ofType(h, id, "RUN_INTERRUPTED")).toHaveLength(1)
      expect(ofType(h, id, "RUN_STARTED").map((event) => event.cause)).toEqual(["user", "user", "user", "continuation"])
      expect(callText(h.model.calls[4]!.call)).toContain("<user>\nheld\n</user>")
      expect(existsSync(draft)).toBe(false)
      expect(readFileSync(join(h.sessionDir(id), "memory", "notes.md"), "utf8")).toBe("---\ndescription: Notes\n---\n")
    })
  })

  test("a restart before or after the transaction taking a waiting input neither loses nor repeats it, and keeps arrival order", async () => {
    await withContext(async (h) => {
      const id = h.create({ model: mid.id })
      const sender = h.sender
      // Before: the input is stored waiting, and the server stops before a turn takes it.
      h.db.transaction(() => {
        h.hub.store.conversation.addWaiting(id, { kind: "user", inputId: "u1", text: "waiting", mode: "queue", sender }, Date.now())
        h.hub.store.appendEvent(id, { type: "INPUT_WAITING", inputId: "u1", text: "waiting", mode: "queue", sender }, Date.now())
        h.hub.store.conversation.addWaiting(id, { kind: "notification", component: note("later_note", "a later notification") }, Date.now())
      })()
      h.model.next(say("one"))
      await h.restart()
      await h.turnsEnded(id, 1)
      expect(ofType(h, id, "INPUT_RECEIVED").map((event) => event.text)).toEqual(["waiting"])
      expectInOrder(callText(h.model.last()), ["<user>\nwaiting\n</user>", "a later notification"])
      // After: a turn took the input, and the server stops before its model call answers.
      h.model.next(hold(new Promise(() => {})))
      h.input(id, "taken")
      await h.calls(2)
      await h.restart()
      expect(ofType(h, id, "RUN_INTERRUPTED")).toHaveLength(1)
      expect(h.hub.store.conversation.waiting(id)).toEqual([])
      h.model.next(say("three"))
      h.input(id, "next")
      await h.turnsEnded(id, 2)
      expect(ofType(h, id, "INPUT_RECEIVED").map((event) => event.text)).toEqual(["waiting", "taken", "next"])
      expect(ofType(h, id, "RUN_STARTED")).toHaveLength(3)
    })
  })
})

describe("validation", () => {
  test("failed checks continue the context turn, and the third falls back to the earlier memory with the trimmed entries unsorted", async () => {
    await withContext(async (h, aux) => {
      const id = h.create({ model: mid.id })
      publishMemory(h, id, { "keep.md": KEEP })
      const trimmedText = `Requests:\n- ${filler(16_000, "o")}`
      aux.next("compaction", say(trimmedText), say(`Requests:\n- ${filler(45_000, "n")}`))
      await fill(h, id)
      const spoil = () => {
        rmSync(draftPath(h, id, "keep.md"))
        writeFileSync(draftPath(h, id, "bad.md"), NO_DESCRIPTION)
      }
      h.model.next(blob(5_000), say("in order"), doing(spoil, say("checked")), say("again"), say("again"), say("continued"))
      h.input(id, "second")
      await h.turnsEnded(id, 3)
      expect(components(h, id, "Timelines Trimmed")).toHaveLength(1)
      expect(components(h, id, "Timelines Trimmed")[0].text).toContain(trimmedText)
      const failures = ofType(h, id, "VALIDATION_FAILED")
      expect(failures.map((event) => event.attempt)).toEqual([1, 2, 3])
      expect(failures[0].violations).toEqual([
        "`memory-draft/bad.md` has no `description:` frontmatter of 1 to 120 characters.",
        "Entry #1 is in no secondary timeline.",
      ])
      const checks = components(h, id, "Context Check Failed")
      expect(checks.map((component: any) => component.text.match(/failed check (\d) of 3/)[1])).toEqual(["1", "2"])
      expect(checks[0].text).toContain("- Entry #1 is in no secondary timeline.")
      const memory = memoryFiles(h, id)
      expect(Object.keys(memory)).toEqual(["keep.md", "unsorted-1-1.md"])
      expect(memory["keep.md"]).toBe(KEEP)
      expect(memory["unsorted-1-1.md"]).toStartWith('---\ndescription: "Entries #1 to #1, trimmed in one context turn and not yet sorted"\n---\n\n[COMPACTION #1]\n')
      expect(memory["unsorted-1-1.md"]).toContain(trimmedText)
      const continuation = callText(h.model.last())
      expect(continuation).toContain("with entries #1 to #1 added in `memory/unsorted-1-1.md`")
      expect(continuation).toContain("- `memory/unsorted-1-1.md`: Entries #1 to #1")
    })
  })

  test("a third failure with only research violations publishes the draft; without trimmed entries an invalid draft keeps the earlier memory", async () => {
    for (const broken of ["research", "memory"] as const) {
      await withContext(async (h) => {
        const id = h.create({ model: mid.id })
        publishMemory(h, id, { "keep.md": KEEP })
        await fill(h, id)
        const work = () => {
          writeFileSync(draftPath(h, id, "new.md"), broken === "memory" ? NO_DESCRIPTION : "---\ndescription: New notes\n---\n")
          if (broken === "research") writeFileSync(join(h.sessionDir(id), "research", "nodesc.md"), NO_DESCRIPTION)
        }
        h.model.next(blob(5_000), doing(work, say("checked")), say("again"), say("again"), say("continued"))
        h.input(id, "second")
        await h.turnsEnded(id, 3)
        expect(ofType(h, id, "VALIDATION_FAILED").map((event) => event.violations)).toEqual(
          Array(3).fill([
            broken === "research"
              ? "`research/nodesc.md` has no `description:` frontmatter of 1 to 120 characters."
              : "`memory-draft/new.md` has no `description:` frontmatter of 1 to 120 characters.",
          ]),
        )
        expect(memoryFiles(h, id)).toEqual(broken === "research" ? { "keep.md": KEEP, "new.md": "---\ndescription: New notes\n---\n" } : { "keep.md": KEEP })
        expect(callText(h.model.last())).not.toContain("unsorted")
        expect(existsSync(join(h.sessionDir(id), "memory-draft"))).toBe(false)
      })
    }
  })

  test("a fallback keeping memory with more secondary timelines than the draft trims further, so the next checkpoint's timelines fit", async () => {
    await withContext(async (h, aux) => {
      const id = h.create({ model: mid.id })
      const description = (index: number) => `${"Long notes on one part of the work ".repeat(3)}${index}`
      const files = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`f${String(index).padStart(2, "0")}.md`, `---\ndescription: ${description(index)}\n---\n`]))
      publishMemory(h, id, files)
      const full = Object.keys(files).map((name, index) => ({ path: `memory/${name}`, description: description(index) }))
      const small = timelinesOverhead(id, [{ path: "memory/bad.md", description: "" }], 0)
      expect(timelinesOverhead(id, full, 0) - small).toBeGreaterThan(1_500)
      // Both compaction entries fit beside the draft's one file, but not beside the 60 files memory keeps.
      aux.next("compaction", say(`Requests:\n- ${filler(20_000, "o")}`), say(`Requests:\n- ${filler(60_000 - small - 20_000 - 700, "n")}`))
      await fill(h, id)
      const spoil = () => {
        for (const name of Object.keys(files)) rmSync(draftPath(h, id, name))
        writeFileSync(draftPath(h, id, "bad.md"), NO_DESCRIPTION)
      }
      h.model.next(blob(5_000), doing(spoil, say("in order")), say("again"), say("again"), say("continued"))
      h.input(id, "second")
      await h.turnsEnded(id, 3)
      expect(components(h, id, "Timelines Trimmed")).toEqual([])
      expect(ofType(h, id, "VALIDATION_FAILED").map((event) => event.attempt)).toEqual([1, 2, 3])
      expect(Object.keys(memoryFiles(h, id))).toEqual([...Object.keys(files), "unsorted-1-1.md"])
      const continuation = callText(h.model.last())
      expect(continuation).toContain("- `memory/unsorted-1-1.md`: Entries #1 to #1")
      expect(continuation).not.toContain("[COMPACTION #1]")
      expect(continuation).toContain("[COMPACTION #2]")
    })
  })

  test("a canceled context turn publishes a valid draft and falls back with an invalid one", async () => {
    for (const valid of [true, false]) {
      await withContext(async (h) => {
        const id = h.create({ model: mid.id })
        publishMemory(h, id, { "keep.md": KEEP })
        await fill(h, id)
        const work = () => writeFileSync(draftPath(h, id, "new.md"), valid ? "---\ndescription: New notes\n---\n" : NO_DESCRIPTION)
        h.model.next(blob(5_000), doing(work, hold(new Promise(() => {}))))
        h.input(id, "second")
        await h.calls(4)
        h.input(id, "held")
        // The held message starts a turn as queued input does; the window is still full, so it is a context turn too.
        h.model.next(say("in order"), say("continued"))
        h.hub.cancel(id)
        await h.turnsEnded(id, 4)
        expect(ofType(h, id, "RUN_FINISHED")[1]).toMatchObject({ outcome: { type: "cancelled" } })
        expect(memoryFiles(h, id)).toEqual(valid ? { "keep.md": KEEP, "new.md": "---\ndescription: New notes\n---\n" } : { "keep.md": KEEP })
        expect(existsSync(join(h.sessionDir(id), "memory-draft"))).toBe(false)
        expect(ofType(h, id, "RUN_STARTED").map((event) => event.cause)).toEqual(["user", "user", "user", "continuation"])
        expect(callText(h.model.calls[4]!.call)).toContain("<user>\nheld\n</user>")
        expect(ofType(h, id, "CHECKPOINT_WINDOW_SEEDED")).toHaveLength(2)
      })
    }
  })

  test("a cancel while an idle waits for a slow compaction call ends the context turn at once, without a checkpoint window", async () => {
    await withContext(async (h, aux) => {
      const id = h.create({ model: mid.id })
      await fill(h, id)
      const slow = gate()
      aux.next("compaction", hold(slow.promise, say("Requests:\n- second")))
      aux.otherwise("compaction", say("Requests:\n- second and held"))
      h.model.next(blob(5_000), say("in order"))
      h.input(id, "second")
      // The idle after "in order" waits for the held open-boundary call.
      await waitFor("the idle", () => (ofType(h, id, "TEXT_MESSAGE_END").length >= 2 ? true : undefined))
      const [, canceled] = runIds(h, id)
      h.input(id, "held")
      h.model.next(say("in order"), say("continued"))
      h.hub.cancel(id)
      await waitFor("the cancel", () => (ofType(h, id, "RUN_FINISHED").length >= 2 ? true : undefined))
      expect(ofType(h, id, "RUN_FINISHED")[1]).toMatchObject({ runId: canceled, outcome: { type: "cancelled" } })
      slow.open()
      await h.turnsEnded(id, 4)
      expect(ofType(h, id, "CHECKPOINT_WINDOW_SEEDED").map((event) => event.runId)).not.toContain(canceled)
      expect(ofType(h, id, "RUN_STARTED").map((event) => event.cause)).toEqual(["user", "user", "user", "continuation"])
      expect(callText(h.model.calls[4]!.call)).toContain("<user>\nheld\n</user>")
    })
  })
})

describe("the context limit", () => {
  const overflow = () => failWith(new ModelCallError("context_length_exceeded", true))
  const toolNames = (call: { tools: ReadonlyArray<{ name: string }> }) => call.tools.map((tool) => tool.name)

  test("a turn at the estimated limit is cleared three times on its cleared tool set, refuses a withheld tool, and hands off", async () => {
    await withContext(async (h, aux) => {
      const id = h.create({ model: mid.id })
      aux.next("handoff", say("Task:\n- the handed-off task"))
      h.model.next(
        blob(50_000),
        blob(70_000),
        callTools([{ name: "blob", args: { tokens: 1 }, id: "withheld" }]),
        overflow(),
        overflow(),
        overflow(),
        say("continued"),
      )
      h.input(id, "go")
      await h.turnsEnded(id, 2)
      const [first] = runIds(h, id)
      expect(ofType(h, id, "CONTEXT_TURN_STARTED")).toEqual([{ type: "CONTEXT_TURN_STARTED", runId: first, trigger: "limit" }])
      const clearings = ofType(h, id, "TOOL_RESULTS_CLEARED")
      expect(clearings.map((event) => event.attempt)).toEqual([1, 2, 3])
      expect(clearings[0].tokensFreed).toBeGreaterThanOrEqual(50_000)
      expect(clearings[0].tokensFreed + clearings[1].tokensFreed).toBeGreaterThanOrEqual(120_000)
      expect(clearings[2].tokensFreed).toBe(0)
      const calls = h.model.calls.map(({ call }) => call)
      expect(toolNames(calls[1]!)).toContain("blob")
      for (const call of calls.slice(2, 6)) expect(toolNames(call)).toEqual(["context_append", "context_get_open_items"])
      expect(callText(calls[2]!)).toContain("This checkpoint window reached its limit")
      expect(callText(calls[2]!)).toContain("[Result cleared to free context. Run the call again if you need it.]")
      const refused = ofType(h, id, "TOOL_CALL_RESULT").find((event) => event.toolCallId === "withheld")
      expect(refused.content).toBe("`blob` is not offered in this request, so the call did not run.\nOffered tools: context_append, context_get_open_items.")
      const handoffs = ofType(h, id, "TIMELINE_ENTRY").filter((event) => event.entry.kind === "handoff")
      expect(handoffs).toMatchObject([{ runId: first, entry: { fields: { Text: "Task:\n- the handed-off task" } } }])
      const [handoff] = aux.calls("handoff")
      expect(handoff!.maxOutputTokens).toBe(8_000)
      expect(callText(handoff!)).toContain("<transcript>\n<user>\ngo\n</user>")
      expect(callText(handoff!)).toContain("[Result cleared to free context.")
      expect(callText(handoff!)).not.toContain("# Session Facts")
      expect(ofType(h, id, "CHECKPOINT_WINDOW_SEEDED").map((event) => event.runId)).toEqual([null, first])
      const continuation = callText(h.model.last())
      expect(continuation).toContain(`The previous checkpoint window filled up before its context turn finished; \`[HANDOFF #${handoffs[0].entry.number}]\` summarizes it.`)
      expect(continuation).toContain("Task:\n- the handed-off task")
      expect(ofType(h, id, "RUN_STARTED").map((event) => event.cause)).toEqual(["user", "continuation"])
    })
  })

  test("a provider context error makes a normal turn a context turn", async () => {
    await withContext(async (h) => {
      const id = h.create({ model: mid.id })
      h.model.next(say("small"))
      h.input(id, "hi")
      await h.turnsEnded(id, 1)
      h.model.next(overflow(), say("in order"), say("continued"))
      h.input(id, "go")
      await h.turnsEnded(id, 3)
      expect(ofType(h, id, "CONTEXT_TURN_STARTED")).toMatchObject([{ trigger: "limit" }])
      expect(ofType(h, id, "TOOL_RESULTS_CLEARED")).toMatchObject([{ attempt: 1, tokensFreed: 0 }])
      expect(ofType(h, id, "CHECKPOINT_WINDOW_SEEDED")).toHaveLength(2)
    })
  })

  test("a failed or truncated handoff ends the turn with an error, and the session takes input in its checkpoint window", async () => {
    const truncated: Reply = async function* () {
      yield new AIMessageChunk({ content: [{ type: "text", text: "Task:\n- cut", index: 0 }], response_metadata: { model_provider: "openai", status: "incomplete" } })
    }
    for (const handoff of [failWith(new Error("handoff model down")), truncated]) {
      await withContext(async (h, aux) => {
        const id = h.create({ model: mid.id })
        aux.next("handoff", handoff)
        h.model.next(
          blob(50_000),
          blob(70_000),
          doing(() => h.input(id, "held"), overflow()),
          overflow(),
          overflow(),
          say("after the failure"),
        )
        h.input(id, "go")
        await h.turnsEnded(id, 2)
        expect(ofType(h, id, "RUN_ERROR")).toMatchObject([{ code: "handoff_failed" }])
        expect(ofType(h, id, "RUN_ERROR")[0].message).toBe(
          handoff === truncated ? "the handoff call stopped at its output limit" : "the handoff call failed: handoff model down",
        )
        expect(ofType(h, id, "TIMELINE_ENTRY").filter((event) => event.entry.kind === "handoff")).toEqual([])
        expect(ofType(h, id, "RUN_STARTED").map((event) => event.cause)).toEqual(["user", "user"])
        expect(callText(h.model.last())).toContain("<user>\nheld\n</user>")
        expect(ofType(h, id, "CHECKPOINT_WINDOW_SEEDED")).toHaveLength(1)
      })
    }
  })
})

describe("compaction entries", () => {
  test("a closed boundary is summarized once on the compaction model from its messages in order, with markers for turns without a final message", async () => {
    await withContext(
      async (h, aux) => {
        const id = h.create({ model: mid.id })
        await turn(h, id, "one", callTools([{ name: "echo", args: { text: "step" } }]), say("reply one"))
        await turn(h, id, "two", callTools([{ name: "refuse", args: {} }]))
        h.model.next(hold(new Promise(() => {})))
        h.input(id, "three")
        await h.calls(4)
        h.hub.cancel(id)
        await h.turnsEnded(id, 3)
        await turn(h, id, "four", failWith(new Error("down")))
        h.model.next(hold(new Promise(() => {})))
        h.input(id, "five")
        await h.calls(6)
        await h.restart()
        await turn(h, id, "six", blob(61_000), say("six done"))
        await eventually(h, id, "TIMELINE_ENTRY")
        const calls = aux.calls("compaction")
        expect(calls).toHaveLength(1)
        expect(calls[0]!.model).toBe(large.id)
        expect(calls[0]!.maxOutputTokens).toBe(8_000)
        expect(callText(calls[0]!)).toBe(
          [
            "<primary_timeline>",
            "",
            "</primary_timeline>",
            "<conversation>",
            "<user>one</user>",
            "<agent>reply one</agent>",
            "<user>two</user>",
            '<no_reply reason="rejected"/>',
            "<user>three</user>",
            '<no_reply reason="canceled"/>',
            "<user>four</user>",
            '<no_reply reason="failed"/>',
            "<user>five</user>",
            '<no_reply reason="restarted"/>',
            "<user>six</user>",
            "</conversation>",
          ].join("\n"),
        )
        expect(ofType(h, id, "TIMELINE_ENTRY")).toMatchObject([{ entry: { number: 1, kind: "compaction", fields: { Text: "Requests:\n- the user's request" } } }])
        const [boundary] = h.hub.store.timeline.boundaries(id)
        expect(boundary!.closedThrough).not.toBeNull()
        // The next user message starts a new boundary.
        await turn(h, id, "seven", say("seven done"))
        expect(h.hub.store.timeline.boundaries(id)).toHaveLength(2)
        expect(h.hub.store.timeline.openBoundary(id)).not.toBeNull()
      },
      { auxiliaryModels: { compaction: large.id } },
    )
  })

  test("trimming the open boundary's entry closes the boundary, so the next user message starts another", async () => {
    await withContext(async (h, aux) => {
      const id = h.create({ model: mid.id })
      await fill(h, id)
      aux.next("compaction", say(`Requests:\n- ${filler(2_000, "q")}`))
      const held = gate()
      const file = () => {
        const entries = h.hub.store.timeline.entries(id)
        const render = entryRenderer(entries)
        writeFileSync(draftPath(h, id, "work.md"), `---\ndescription: Early work\n---\n\n${entries.filter((entry) => entry.trimmed).map(render).join("\n\n")}\n`)
      }
      h.model.next(blob(5_000), hold(held.promise, say("in order")), doing(file, say("filed")), say("continued"))
      h.input(id, "second")
      await eventually(h, id, "TIMELINE_ENTRY", 2)
      const [, second] = runIds(h, id)
      // A long entry after the open boundary's entry stands in for a long-running timeline.
      h.db.transaction(() => {
        h.hub.store.timeline.append(id, { runId: second!, windowPosition: 1 }, { kind: "handoff", fields: { Text: filler(58_500, "h") } }, null, Date.now())
      })()
      held.open()
      await h.turnsEnded(id, 3)
      expect(components(h, id, "Timelines Trimmed")[0].text).toContain("trimmed entries #1 to #2")
      const [boundary] = h.hub.store.timeline.boundaries(id).slice(-1)
      expect(boundary!.closedThrough).not.toBeNull()
      expect(h.hub.store.timeline.openBoundary(id)).toBeNull()
      await turn(h, id, "third", say("third done"))
      expect(h.hub.store.timeline.openBoundary(id)).not.toBeNull()
      expect(ofType(h, id, "TIMELINE_ENTRY_REPLACED")).toEqual([])
      expect(h.hub.store.timeline.entries(id).find((entry) => entry.number === 2)!.fields.Text).toBe(`Requests:\n- ${filler(2_000, "q")}`)
    })
  })

  test("a rewind reopens a partly removed boundary with its earlier entry text, and discards a running summary call", async () => {
    await withContext(async (h, aux) => {
      const id = h.create({ model: mid.id })
      await fill(h, id)
      aux.next("compaction", say("Requests:\n- the second request"), say("Requests:\n- second and third"))
      await turn(h, id, "second", blob(5_000), say("in order"), say("continuing"))
      await h.turnsEnded(id, 3)
      await turn(h, id, "third", blob(66_000), say("third done"))
      await eventually(h, id, "TIMELINE_ENTRY_REPLACED")
      const entry = () => h.hub.store.timeline.entries(id).find((candidate) => candidate.number === 2)!
      expect(entry().fields.Text).toBe("Requests:\n- second and third")
      const third = runIds(h, id)[3]!
      h.model.next(say("third again"))
      h.hub.rewind(id, third, undefined, h.sender)
      await h.turnsEnded(id, 4)
      expect(entry().fields.Text).toBe("Requests:\n- the second request")
      expect(h.hub.store.timeline.openBoundary(id)).toMatchObject({ closedThrough: null })
      expect(ofType(h, id, "TIMELINE_ENTRY").map((event) => event.entry.number)).toEqual([1, 2])

      // A boundary closing just before a rewind: its summary call's output is discarded.
      const slow = gate()
      aux.next("compaction", hold(slow.promise, say("Requests:\n- discarded")))
      await turn(h, id, "fourth", blob(61_000), say("fourth done"))
      const fourth = runIds(h, id).at(-1)!
      h.model.next(say("fourth again"))
      h.hub.rewind(id, fourth, "edited", h.sender)
      // The rewind removed the fourth turn's events, so its rerun is the fifth ended turn.
      await h.turnsEnded(id, 5)
      slow.open()
      await turn(h, id, "fifth", say("fifth done"))
      expect(aux.calls("compaction")).toHaveLength(4)
      expect(JSON.stringify(h.hub.store.timeline.entries(id))).not.toContain("discarded")
    })
  })
})

describe("history changes", () => {
  test("a rewind into an older checkpoint window reconciles every source against that window", async () => {
    const sources = { instructions: "V1", skills: "- `a`: one" }
    const setup = {
      ...noAgents,
      userInstructions: () => {
        const text = sources.instructions
        return { source: "global" as const, path: "/config/AGENTS.md", text, sha256: String(Bun.hash(text)), metadata: { dev: 0, ino: 0, size: text.length, mtimeMs: 0, ctimeMs: 0 } }
      },
      catalogs: () => ({ skills: sources.skills, codeMode: null }),
    }
    await withContext(
      async (h) => {
        const id = h.create({ model: mid.id })
        await turn(h, id, "first", blob(70_000), say("first done"))
        const change = () => {
          sources.instructions = "V2"
          sources.skills = "- `a`: two"
        }
        await turn(h, id, "second", blob(12_000), doing(change, say("in order")), say("continuing"))
        await h.turnsEnded(id, 3)
        expect(windows(h, id)).toBe(2)
        expect(callText(h.model.last())).toContain("V2")
        const second = runIds(h, id)[1]!
        h.model.next(say("rerun"))
        h.hub.rewind(id, second, undefined, h.sender)
        await h.turnsEnded(id, 2)
        expect(windows(h, id)).toBe(1)
        const rerun = callText(h.model.last())
        expectInOrder(rerun, ["V1", "first done", "# Rewind", "# User Instructions Changed", "+V2", "# Skill Catalog Changed", "- `a`: two", "<user>\nsecond\n</user>"])
        expect(rerun).not.toContain("# Session Checkpoint")
      },
      { setup },
    )
  })

  test("a rewind to a continuation turn holding user messages reruns them in its checkpoint window, and an edit replaces them", async () => {
    await withContext(async (h) => {
      const id = h.create({ model: mid.id })
      await fill(h, id)
      const hold2 = () => {
        h.input(id, "held one")
        h.input(id, "held two")
      }
      await turn(h, id, "second", blob(5_000), doing(hold2, say("in order")), say("continuation reply"))
      await h.turnsEnded(id, 3)
      const continuation = ofType(h, id, "RUN_STARTED")[2]
      expect(continuation).toMatchObject({ cause: "continuation" })
      expect(continuation.userMessageIds).toHaveLength(2)
      h.model.next(say("rerun reply"))
      h.hub.rewind(id, continuation.runId, undefined, h.sender)
      await h.turnsEnded(id, 3)
      expect(windows(h, id)).toBe(2)
      const rerunStart = ofType(h, id, "RUN_STARTED").at(-1)
      expect(rerunStart).toMatchObject({ cause: "continuation" })
      const types = h.types(id)
      const rewound = types.lastIndexOf("SESSION_REWOUND")
      const waiting = bodies(h.events(id)).slice(rewound).filter((event) => event.type === "INPUT_WAITING")
      expect(waiting.map((event) => event.text)).toEqual(["held one", "held two"])
      expect(rerunStart.userMessageIds).toEqual(waiting.map((event) => event.inputId))
      expectInOrder(callText(h.model.last()), ["# Session Checkpoint", "# Continuation", "# Rewind", "<user>\nheld one\n</user>", "<user>\nheld two\n</user>"])

      h.model.next(say("edited reply"))
      h.hub.rewind(id, rerunStart.runId, "edited", h.sender)
      await h.turnsEnded(id, 3)
      const edited = callText(h.model.last())
      expectInOrder(edited, ["# Continuation", "# Rewind", "<user>\nedited\n</user>"])
      expect(edited).not.toContain("held one")
      expect(ofType(h, id, "RUN_STARTED").at(-1)).toMatchObject({ cause: "continuation" })
    })
  })
})

describe("developer messages", () => {
  const sources = { instructions: "V1", mtimeMs: 0 }
  const setup = {
    ...noAgents,
    userInstructions: () => {
      const text = sources.instructions
      return {
        source: "global" as const,
        path: "/config/AGENTS.md",
        text,
        sha256: String(Bun.hash(text)),
        metadata: { dev: 0, ino: 0, size: text.length, mtimeMs: sources.mtimeMs, ctimeMs: 0 },
      }
    },
  }
  const echo = (text: string) => callTools([{ name: "echo", args: { text } }])
  const headingsOf = (h: AgentHarness, id: string, runId: string) =>
    ofType(h, id, "DEVELOPER_MESSAGE")
      .filter((event) => event.runId === runId)
      .map((event) => event.components.map((component: any) => component.heading))

  test("state components join a steered message or a notification at a step boundary, before the user message, in arrival order", async () => {
    sources.instructions = "V1"
    sources.mtimeMs = 0
    await withContext(
      async (h) => {
        const id = h.create({ model: mid.id })
        h.model.next(
          doing(() => (sources.instructions = "V2"), echo("a")),
          doing(() => h.input(id, "steered"), echo("b")),
          doing(() => {
            sources.instructions = "V3"
            h.hub.store.conversation.addWaiting(id, { kind: "notification", component: note("first_note", "the first notification") }, Date.now())
          }, echo("c")),
          doing(() => {
            sources.instructions = "V4"
            h.input(id, "late steered")
            h.hub.store.conversation.addWaiting(id, { kind: "notification", component: note("second_note", "the second notification") }, Date.now())
          }, echo("d")),
          doing(() => {
            sources.mtimeMs = 1
            h.input(id, "after a touch")
          }, echo("e")),
          say("done"),
        )
        h.input(id, "go")
        await h.turnsEnded(id, 1)
        const [run] = runIds(h, id)
        expect(headingsOf(h, id, run!)).toEqual([["User Instructions Changed"], ["first_note", "User Instructions Changed"], ["User Instructions Changed"], ["second_note"]])
        const last = callText(h.model.last())
        expectInOrder(last, [
          "echoed a",
          "echoed b",
          "+V2",
          "<user>\nsteered\n</user>",
          "the first notification",
          "+V3",
          "+V4",
          "<user>\nlate steered\n</user>",
          "the second notification",
          "<user>\nafter a touch\n</user>",
        ])
        // Nothing waited at the first step boundary, so the change to V2 arrived only with the steered message.
        expect(last.match(/# User Instructions Changed/g)).toHaveLength(3)
      },
      { setup },
    )
  })

  test("a context turn's own notifications carry no state components, and a held notification starts a turn after a cancel", async () => {
    sources.instructions = "V1"
    sources.mtimeMs = 0
    await withContext(
      async (h) => {
        const id = h.create({ model: mid.id })
        await fill(h, id)
        const during = () => {
          sources.instructions = "V2"
          writeFileSync(draftPath(h, id, "bad.md"), NO_DESCRIPTION)
          h.hub.store.conversation.addWaiting(id, { kind: "notification", component: note("held_note", "a held notification") }, Date.now())
        }
        h.model.next(blob(5_000), doing(during, say("in order")), hold(new Promise(() => {})))
        h.input(id, "second")
        await eventually(h, id, "VALIDATION_FAILED")
        await h.calls(5)
        const second = runIds(h, id)[1]!
        expect(headingsOf(h, id, second)).toEqual([["Context Turn"], ["Context Check Failed"]])
        h.model.next(say("in order again"), say("continued"))
        h.hub.cancel(id)
        await h.turnsEnded(id, 4)
        const [, , held] = ofType(h, id, "RUN_STARTED")
        expect(held).toMatchObject({ cause: "notification", userMessageIds: [] })
        expect(headingsOf(h, id, held.runId)[0]).toEqual(["held_note", "User Instructions Changed"])
      },
      { setup },
    )
  })
})

describe("questions", () => {
  const option = (label: string) => ({ label, description: `${label} described` })
  const questions = [
    { id: "store", header: "Storage", question: "Where should state live?", options: [option("SQLite (Recommended)"), option("Files")] },
    { id: "name", header: "Name", question: "What is it called?", options: [option("Ashe (Recommended)"), option("Other")] },
  ]
  const ask = (id: string, extra: Record<string, unknown> = {}) => callTools([{ name: "context_ask_question", args: { questions, ...extra }, id }])
  const result = (h: AgentHarness, id: string, toolCallId: string) => ofType(h, id, "TOOL_CALL_RESULT").find((event) => event.toolCallId === toolCallId)
  const asked = (h: AgentHarness, id: string, count: number) =>
    waitFor(`${count} QUESTIONS_ASKED`, () => ofType(h, id, "QUESTIONS_ASKED")[count - 1], 10_000)

  test("answers become answer entries the call returns, skips are named, a message ends the wait, and only the first answer counts", async () => {
    await withContext(async (h) => {
      const id = h.create({ model: mid.id })
      h.model.next(ask("early", { feedback: "Noted." }), ask("first"), ask("second", { feedback: "SQLite it is." }), say("after the message"), ask("third"))
      h.input(id, "go")
      const first = await asked(h, id, 1)
      expect(result(h, id, "early")).toMatchObject({ outcome: "failed" })
      expect(result(h, id, "early").content).toBe("`feedback` responds to earlier questions, and this session has asked none. Call again without it.")
      expect(first).toMatchObject({ toolCallId: "first", questions })
      h.hub.answerQuestion(id, first.questionSetId, [{ id: "store", selection: "SQLite (Recommended)", note: "Keep it local." }, { id: "name" }], h.sender)
      expect(() => h.hub.answerQuestion(id, first.questionSetId, [{ id: "store", selection: "Files" }], h.sender)).toThrow("already answered or ended")
      expect(ofType(h, id, "QUESTIONS_ANSWERED")).toHaveLength(1)
      const second = await asked(h, id, 2)
      expect(second.feedback).toBe("SQLite it is.")
      expect(result(h, id, "first").content).toBe(
        "[ANSWER #1]\nQuestion: Where should state live?\nSelection: SQLite (Recommended): SQLite (Recommended) described\nUserNote: Keep it local.\nSkipped: name",
      )
      expect(ofType(h, id, "TIMELINE_ENTRY")).toMatchObject([{ entry: { number: 1, kind: "answer" } }])
      // A queued message leaves the call waiting; a steered one ends it and joins at the next step boundary.
      h.input(id, "queued", "queue")
      expect(result(h, id, "second")).toBeUndefined()
      h.input(id, "steered")
      await h.calls(4)
      expect(result(h, id, "second").content).toBe("The user replied with a message instead of answering; it follows.")
      expect(() => h.hub.answerQuestion(id, second.questionSetId, [{ id: "store", selection: "Files" }], h.sender)).toThrow("already answered or ended")
      expectInOrder(callText(h.model.calls[3]!.call), ["The user replied with a message instead of answering", "<user>\nsteered\n</user>"])
      expect(callText(h.model.calls[3]!.call)).not.toContain("queued")
      // The queued message starts the next turn once this one ends, and a cancel ends its question without entries.
      await asked(h, id, 3)
      expect(ofType(h, id, "RUN_FINISHED")).toHaveLength(1)
      h.hub.cancel(id)
      await h.turnsEnded(id, 2)
      expect(ofType(h, id, "TIMELINE_ENTRY")).toHaveLength(1)
      expect(ofType(h, id, "INPUT_RECEIVED").map((event) => event.text)).toEqual(["go", "steered", "queued"])
    })
  })

  test("a context turn refuses questions, and an answer entry outlives the clearing of tool results", async () => {
    await withContext(async (h) => {
      const id = h.create({ model: mid.id })
      h.model.next(ask("answered"))
      h.input(id, "go")
      const set = await asked(h, id, 1)
      h.model.next(blob(50_000), blob(70_000), say("in order"), say("continued"))
      h.hub.answerQuestion(id, set.questionSetId, [{ id: "name", note: "Call it Ashe." }], h.sender)
      await h.turnsEnded(id, 2)
      expect(ofType(h, id, "TOOL_RESULTS_CLEARED")).toHaveLength(1)
      const [first] = runIds(h, id)
      const results = h.hub.store.conversation.turnItems(id, first!).filter((item) => item.kind === "result")
      expect(results.map((item) => [item.name, item.kind === "result" && item.cleared === true])).toEqual([
        ["context_ask_question", false],
        ["blob", true],
        ["blob", false],
      ])
      expect(callText(h.model.last())).toContain("[ANSWER #1]\nQuestion: What is it called?\nUserNote: Call it Ashe.")

      // A threshold context turn offers the tool, and refuses its call.
      await fill(h, id)
      h.model.next(blob(5_000), ask("refused"), say("in order"), say("continued"))
      h.input(id, "again")
      await h.turnsEnded(id, 5)
      expect(result(h, id, "refused")).toMatchObject({ outcome: "failed" })
      expect(result(h, id, "refused").content).toBe("`context_ask_question` is not available in a context turn. Finish the context turn first.")
      expect(ofType(h, id, "QUESTIONS_ASKED")).toHaveLength(1)
    })
  })
})

describe("open items", () => {
  // Long texts, so trimming them frees more than the line counting trimmed open items takes.
  const PARSER = `Write the parser for the configuration format, covering every section the schema names ${"and more".repeat(3)}`
  const BUILD = `The build fails on the generated schema step because the generator reads a stale cache ${"again".repeat(4)}`
  const DONE = `[DONE #8]\nText: Docs and build done\nResolves: #4 [OPEN] Publish the docs\nResolves: #2 [PROBLEM] ${BUILD}`
  const getOpen = (id = "open") => callTools([{ name: "context_get_open_items", args: {}, id }])
  const resultOf = (h: AgentHarness, id: string, toolCallId: string) => ofType(h, id, "TOOL_CALL_RESULT").find((event) => event.toolCallId === toolCallId).content

  test("an invalid entry appends none, a done entry restates an open and a trimmed problem entry, and open items carry their marks", async () => {
    await withContext(async (h) => {
      const id = h.create({ model: mid.id })
      await turn(
        h,
        id,
        "one",
        callTools([{ name: "context_append", args: { entries: [{ kind: "open", Text: "O1" }, { kind: "open", Text: "" }] }, id: "invalid" }]),
        append(
          { kind: "open", Text: PARSER },
          { kind: "problem", Text: BUILD },
          { kind: "decision", Decision: PARSER.replace("Write", "Use"), Rationale: BUILD.replace("fails", "passes") },
          { kind: "open", Text: "Publish the docs" },
        ),
        say("one done"),
      )
      expect(resultOf(h, id, "invalid")).toBe("No entry was appended: entry 2: Text holds 0 characters, not 1 to 120.")
      expect(ofType(h, id, "TIMELINE_ENTRY").map((event) => event.entry.number)).toEqual([1, 2, 3, 4])
      await fill(h, id)
      const held = gate()
      const file = () => {
        const entries = h.hub.store.timeline.entries(id)
        const render = entryRenderer(entries)
        writeFileSync(draftPath(h, id, "early.md"), `---\ndescription: Early work\n---\n\n${entries.filter((entry) => entry.trimmed).map(render).join("\n\n")}\n`)
      }
      h.model.next(
        blob(5_000),
        hold(held.promise, say("in order")),
        doing(file, callTools([{ name: "context_append", args: { entries: [{ kind: "done", Text: "Docs and build done", resolves: [4, 2] }] }, id: "done" }])),
        getOpen(),
        say("filed"),
        say("continued"),
      )
      h.input(id, "second")
      // The first boundary's entry #5 and the open boundary's #6 exist. A long entry #7 then makes the first idle
      // trim #1 to #3 and leaves room for the done entry #8.
      await eventually(h, id, "TIMELINE_ENTRY", 6)
      const second = runIds(h, id)[2]!
      const entries = h.hub.store.timeline.entries(id)
      const render = entryRenderer(entries)
      const part = (entry: (typeof entries)[number]) => estimateTokens(`${render(entry)}\n\n`)
      const kept = entries.slice(3).reduce((sum, entry) => sum + part(entry), 0)
      const done = estimateTokens(`${DONE}\n\n`)
      const tokens = 60_000 - timelinesOverhead(id, [{ path: "memory/early.md", description: "Early work" }], 1) - kept - done
      const header = `[HANDOFF #${entries.length + 1}]\n`.length
      h.db.transaction(() => {
        h.hub.store.timeline.append(id, { runId: second, windowPosition: 1 }, { kind: "handoff", fields: { Text: filler(tokens).slice(0, tokens * 4 - header - 2) } }, null, Date.now())
      })()
      held.open()
      await h.turnsEnded(id, 4)
      expect(components(h, id, "Timelines Trimmed").map((component: any) => component.text.match(/entries #\d+ to #\d+/)[0])).toEqual(["entries #1 to #3"])
      expect(resultOf(h, id, "done")).toBe(DONE)
      expect(resultOf(h, id, "open")).toBe(`[OPEN #1]\nText: ${PARSER}\n(trimmed)`)
      expect(callText(h.model.last())).toContain("1 open items are only in secondary timelines; `context_get_open_items` lists them.")
    })
  })

  test("a rewind removing a done entry reopens what it resolved", async () => {
    await withContext(async (h) => {
      const id = h.create({ model: mid.id })
      await turn(h, id, "one", append({ kind: "open", Text: "Write the parser" }), say("noted"))
      await turn(h, id, "two", callTools([{ name: "context_append", args: { entries: [{ kind: "done", Text: "Parser written", resolves: [1] }] } }]), getOpen("none"), say("done"))
      expect(resultOf(h, id, "none")).toBe("No open items.")
      h.model.next(getOpen("again"), say("rerun"))
      h.hub.rewind(id, runIds(h, id)[1]!, undefined, h.sender)
      await h.turnsEnded(id, 2)
      expect(openItems(h.hub.store.timeline.entries(id)).map((entry) => entry.number)).toEqual([1])
      expect(resultOf(h, id, "again")).toBe("[OPEN #1]\nText: Write the parser\n(in the primary timeline)")
    })
  })
})

describe("research entries", () => {
  const notes = (description: string, body: string) => `---\ndescription: ${description}\n---\n${body}\n`
  const LONG = `${"The file now explains the parser's table layout in detail ".repeat(6)}end`

  test("research calls start with the context turn, and idles append one entry per created or changed file in name order", async () => {
    await withContext(async (h, aux) => {
      const id = h.create({ model: mid.id })
      const research = (name: string) => join(h.sessionDir(id), "research", name)
      aux.otherwise("research", (call, signal) => {
        const text = callText(call)
        const name = /<file name="([^"]+)"/.exec(text)![1]!
        const summary = name === "old.md" && text.includes('change="changed"') ? LONG : name === "new.md" ? (text.includes("second version") ? "Second new." : "First new.") : `Created ${name}.`
        return say(summary)(call, signal)
      })
      const write = () => {
        writeFileSync(research("old.md"), notes("Old notes", "first version"))
        writeFileSync(research("gone.md"), notes("Gone notes", "soon gone"))
      }
      await turn(h, id, "one", doing(write, say("one done")))
      await fill(h, id)
      let started = 0
      h.model.next(blob(5_000), doing(() => (started = aux.calls("research").length), say("in order")), say("continued"))
      h.input(id, "second")
      await h.turnsEnded(id, 4)
      expect(started).toBe(2)
      const firstEntries = ofType(h, id, "TIMELINE_ENTRY").filter((event) => event.entry.kind === "research")
      expect(firstEntries.map((event) => event.entry.fields)).toEqual([
        { FileName: "gone.md", Change: "created", Summary: "Created gone.md." },
        { FileName: "old.md", Change: "created", Summary: "Created old.md." },
      ])
      const baseline = h.hub.store.conversation.baseline(id, 2)
      expect(baseline.map((file) => file.name)).toEqual(["gone.md", "old.md"])

      // In the next window: a change, a deletion, and a creation, then a file changed after its call.
      const change = () => {
        writeFileSync(research("old.md"), notes("Old notes", "changed version"))
        rmSync(research("gone.md"))
        writeFileSync(research("new.md"), notes("New notes", "first version"))
      }
      await turn(h, id, "third", doing(change, blob(65_000)), say("third done"))
      const before = aux.calls("research").length
      const during = () => {
        writeFileSync(research("new.md"), notes("New notes", "second version"))
        writeFileSync(draftPath(h, id, "bad.md"), NO_DESCRIPTION)
      }
      const long = () => {
        rmSync(draftPath(h, id, "bad.md"))
        const entries = h.hub.store.timeline.entries(id)
        // The long entry fits exactly beside the secondary timeline the agent files next, so every other entry is trimmed.
        const tokens = 60_000 - timelinesOverhead(id, [{ path: "memory/all.md", description: "Everything so far" }], 0)
        const header = `[HANDOFF #${entries.length + 1}]\n`.length
        const fourth = runIds(h, id).at(-1)!
        h.db.transaction(() => {
          h.hub.store.timeline.append(id, { runId: fourth, windowPosition: 2 }, { kind: "handoff", fields: { Text: filler(tokens).slice(0, tokens * 4 - header - 2) } }, null, Date.now())
        })()
      }
      const file = () => {
        const entries = h.hub.store.timeline.entries(id)
        const render = entryRenderer(entries)
        writeFileSync(draftPath(h, id, "all.md"), `---\ndescription: Everything so far\n---\n\n${entries.filter((entry) => entry.trimmed).map(render).join("\n\n")}\n`)
      }
      h.model.next(blob(10_000), doing(during, say("in order")), doing(long, say("fixed")), doing(file, say("filed")), say("continued"))
      h.input(id, "fourth")
      await h.turnsEnded(id, 7)
      const calls = aux.calls("research").slice(before).map(callText)
      expect(calls.map((text) => /<file name="([^"]+)" change="(\w+)"/.exec(text)!.slice(1))).toEqual([
        ["new.md", "created"],
        ["old.md", "changed"],
        ["new.md", "created"],
      ])
      expect(calls[0]).toContain("<deleted>gone.md</deleted>")
      expect(calls[1]).toContain("<created>new.md</created>")
      expect(calls[1]).toContain("<deleted>gone.md</deleted>")
      expect(calls[1]).toContain("-first version\n+changed version")
      const entries = ofType(h, id, "TIMELINE_ENTRY").filter((event) => event.entry.kind === "research").slice(2)
      expect(entries.map((event) => [event.entry.fields.FileName, event.entry.fields.Change])).toEqual([
        ["new.md", "created"],
        ["old.md", "changed"],
      ])
      expect(entries[0].entry.fields.Summary).toBe("Second new.")
      const cut = entries[1].entry.fields.Summary as string
      expect([...cut].length).toBeLessThanOrEqual(240)
      expect(cut).toEndWith("…")
      expect(LONG.startsWith(cut.slice(0, -1))).toBe(true)
      const trimmed = components(h, id, "Timelines Trimmed")[0].text as string
      expect(trimmed).toContain(`[RESEARCH #${entries[0].entry.number}]\nFileName: new.md`)
      expect(trimmed).toContain(`[RESEARCH #${entries[1].entry.number}]\nFileName: old.md`)
      expect(trimmed).not.toContain("FileName: gone.md")
      expect(h.hub.store.conversation.baseline(id, 3).map((file) => file.name)).toEqual(["new.md", "old.md"])

      // A rewind removing the fourth turn keeps the second window with its baseline as its construction recorded it.
      const fourth = runIds(h, id)[5]!
      h.model.next(say("rerun"))
      h.hub.rewind(id, fourth, undefined, h.sender)
      await h.turnsEnded(id, 6)
      expect(windows(h, id)).toBe(2)
      expect(h.hub.store.conversation.baseline(id, 2)).toEqual(baseline)
    })
  })
})

describe("auxiliary models", () => {
  test("an auxiliary call goes to its configured model with that model's effort, else to the latest turn's model with its effort", async () => {
    const thinker = configuredModel("test/thinker", { contextLimit: 400_000, efforts: ["low", "high"], settings: { checkpointWindowSize: 120_000 } })
    const helper = configuredModel("test/helper", { contextLimit: 400_000, efforts: ["minimal", "medium"], settings: { reasoningEffort: "medium" } })
    for (const configured of [true, false]) {
      await withContext(
        async (h, aux) => {
          const id = h.create({ model: thinker.id, reasoningEffort: "high" })
          await turn(h, id, "first", blob(61_000), say("first done"))
          await eventually(h, id, "TIMELINE_ENTRY")
          expect(h.model.last().reasoning).toEqual({ effort: "high", summary: "auto" })
          const [compaction] = aux.calls("compaction")
          expect(compaction).toMatchObject(
            configured ? { model: helper.id, reasoning: { effort: "medium", summary: "auto" } } : { model: thinker.id, reasoning: { effort: "high", summary: "auto" } },
          )
        },
        { models: [thinker, helper], ...(configured ? { auxiliaryModels: { compaction: helper.id } } : {}) },
      )
    }
  })
})

describe("later checkpoint windows", () => {
  test("a later seed renders changed instructions, catalogs, and facts in full, and keeps the known instructions over an unreadable file", async () => {
    let clock = Date.UTC(2026, 9, 1, 12)
    const sources = { instructions: "V1 instructions", readable: true, skills: "- `a`: one" }
    const setup = {
      ...noAgents,
      userInstructions: () => {
        if (!sources.readable) throw new InstructionsUnreadable("/config/AGENTS.md", "permission denied")
        const text = sources.instructions
        return { source: "global" as const, path: "/config/AGENTS.md", text, sha256: String(Bun.hash(text)), metadata: { dev: 0, ino: 0, size: text.length, mtimeMs: 0, ctimeMs: 0 } }
      },
      catalogs: () => ({ skills: sources.skills, codeMode: null }),
    }
    await withContext(
      async (h) => {
        const id = h.create({ model: mid.id })
        await fill(h, id)
        const change = () => {
          sources.instructions = "V2 instructions"
          sources.skills = "- `a`: two"
          clock += 3 * 86_400_000
        }
        await turn(h, id, "second", blob(5_000), doing(change, say("in order")), say("continued"))
        await h.turnsEnded(id, 3)
        const second = callText(h.model.last())
        expectInOrder(second, ["V2 instructions", "- `a`: two", "# Session Facts", "2026-10-04", "# Session Checkpoint", "# Continuation"])
        expect(second).not.toContain("V1 instructions")
        expect(second).not.toContain("Changed")

        // The second window starts with the recent transcript, so less fills it.
        await turn(h, id, "third", blob(65_000), say("third done"))
        await turn(h, id, "fourth", blob(12_000), doing(() => (sources.readable = false), say("in order")), say("continued"))
        await h.turnsEnded(id, 6)
        const fourth = runIds(h, id)[4]!
        // The construction reports the unreadable file, and so does the continuation turn's reconciliation.
        const errors = ofType(h, id, "SESSION_ERROR")
        expect(errors.map((event) => [event.code, event.runId])).toEqual([
          ["user_instructions_unreadable", fourth],
          ["user_instructions_unreadable", runIds(h, id)[5]],
        ])
        expect(errors[0].message).toBe("the user instructions file /config/AGENTS.md is refused: permission denied; the known user instructions stay")
        expect(ofType(h, id, "CHECKPOINT_WINDOW_SEEDED").map((event) => event.runId)).toEqual([null, runIds(h, id)[1], fourth])
        expect(callText(h.model.last())).toContain("V2 instructions")
      },
      { setup, now: () => clock },
    )
  })
})

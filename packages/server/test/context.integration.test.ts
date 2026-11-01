import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SessionEvent } from "@ashe-agent/protocol"
import { timelinesOverhead } from "../src/context/checkpoint.ts"
import { entryRenderer } from "../src/context/entries.ts"
import { waitFor } from "./support/cli.ts"
import { callTools, messageText, say, type AgentHarness, type Reply } from "./support/agent.ts"
import { contextHarness, filler, windowModel } from "./support/context.ts"

/** A checkpoint window of 120,000 tokens: a context turn starts past 80,000, and the limit is at 120,000. */
const mid = windowModel("test/mid", 120_000)

const bodies = (events: ReadonlyArray<SessionEvent>) => events.map((event) => event.event) as Array<any>
const ofType = (h: AgentHarness, id: string, type: string) => bodies(h.events(id)).filter((event) => event.type === type)
const runIds = (h: AgentHarness, id: string) => ofType(h, id, "RUN_STARTED").map((event) => event.runId as string)
const callText = (call: { messages: ReadonlyArray<any> }) => call.messages.map(messageText).join("\n")
const blob = (tokens: number, letter = "b") => callTools([{ name: "blob", args: { tokens, letter } }])
const doing =
  (act: () => void, then: Reply): Reply =>
  (call, signal) => {
    act()
    return then(call, signal)
  }

const turn = async (h: AgentHarness, id: string, text: string, ...replies: Array<Reply>) => {
  const ended = ofType(h, id, "RUN_FINISHED").length + ofType(h, id, "RUN_ERROR").length
  h.model.next(...replies)
  h.input(id, text)
  await h.turnsEnded(id, ended + 1)
}

/** Rows of `table` for the session, counted. */
const rows = (h: AgentHarness, id: string, table: string) =>
  h.db.query<{ n: number }, [string]>(`SELECT count(*) AS n FROM ${table} WHERE session_id = ?`).get(id)!.n

const withHarness = async (body: (h: AgentHarness, aux: ReturnType<typeof contextHarness>["aux"]) => Promise<void>) => {
  const { h, aux } = contextHarness({ models: [mid] })
  try {
    await body(h, aux)
  } finally {
    await h.cleanup()
  }
}

describe("conversation state rows on a real SQLite database", () => {
  test("a rewind past a context turn deletes its window, clearing, trim, and replaced text rows; a fork copies rows through its point", async () => {
    await withHarness(async (h, aux) => {
      const id = h.create({ model: mid.id })
      aux.next("compaction", say("Requests:\n- one and two"), say("Requests:\n- three"), say("Requests:\n- three to six"))
      await turn(h, id, "one", say("one done"))
      await turn(h, id, "two", blob(76_000), say("two done"))
      await waitFor("the first entry", () => (ofType(h, id, "TIMELINE_ENTRY").length >= 1 ? true : undefined))
      await turn(h, id, "three", blob(5_000), say("in order"), say("continuing"))
      await h.turnsEnded(id, 4)
      // A model step adds only its own items' rows, leaving every earlier row as it was.
      const snapshots: Array<Array<unknown>> = []
      const snapshot = () => snapshots.push(h.db.query("SELECT * FROM window_items WHERE session_id = ? ORDER BY position").all(id))
      await turn(h, id, "five", doing(snapshot, blob(40_000, "f")), doing(snapshot, say("five done")))
      const [before, after] = snapshots
      expect(after!.length - before!.length).toBe(2)
      expect(after!.slice(0, before!.length)).toEqual(before!)
      const file = () => {
        const entries = h.hub.store.timeline.entries(id)
        const render = entryRenderer(entries)
        writeFileSync(join(h.sessionDir(id), "memory-draft", "all.md"), `---\ndescription: Everything\n---\n\n${entries.filter((entry) => entry.trimmed).map(render).join("\n\n")}\n`)
      }
      const long = () => {
        const sixth = runIds(h, id).at(-1)!
        const entries = h.hub.store.timeline.entries(id)
        const tokens = 60_000 - timelinesOverhead(id, [{ path: "memory/all.md", description: "Everything" }], 0)
        const header = `[HANDOFF #${entries.length + 1}]\n`.length
        h.db.transaction(() => {
          h.hub.store.timeline.append(id, { runId: sixth, windowPosition: 2 }, { kind: "handoff", fields: { Text: filler(tokens).slice(0, tokens * 4 - header - 2) } }, null, Date.now())
        })()
      }
      // The sixth turn reaches the limit: its clearing clears the fifth turn's result, and its trim and replacement are its own.
      await turn(h, id, "six", blob(85_000), doing(long, say("in order")), doing(file, say("filed")), say("continued"))
      await h.turnsEnded(id, 7)
      await waitFor("the replaced entry", () => (ofType(h, id, "TIMELINE_ENTRY_REPLACED").length >= 1 ? true : undefined))
      expect(rows(h, id, "checkpoint_windows")).toBe(3)
      expect(rows(h, id, "tool_result_clearings")).toBeGreaterThan(0)
      expect(rows(h, id, "timeline_trims")).toBeGreaterThan(0)
      expect(rows(h, id, "compaction_texts")).toBe(3)

      // A fork through the third turn copies its rows and none of the later turns'.
      const [, , third, , , sixth] = runIds(h, id)
      const fork = h.hub.fork(id, third!).id
      expect(rows(h, fork, "checkpoint_windows")).toBe(2)
      expect(rows(h, fork, "tool_result_clearings")).toBe(0)
      expect(rows(h, fork, "timeline_trims")).toBe(0)
      expect(rows(h, fork, "compaction_texts")).toBe(2)
      expect(h.hub.store.timeline.entries(fork).map((entry) => [entry.number, entry.fields.Text])).toEqual([
        [1, "Requests:\n- one and two"],
        [2, "Requests:\n- three"],
      ])

      // A rewind past the sixth turn deletes its rows, and the rerun sees the fifth turn's result uncleared and the earlier text.
      h.model.next(say("rerun"))
      h.hub.rewind(id, sixth!, undefined, h.sender)
      await h.turnsEnded(id, 6)
      expect(rows(h, id, "checkpoint_windows")).toBe(2)
      expect(rows(h, id, "tool_result_clearings")).toBe(0)
      expect(rows(h, id, "timeline_trims")).toBe(0)
      expect(rows(h, id, "compaction_texts")).toBe(2)
      expect(h.hub.store.timeline.entries(id).map((entry) => entry.fields.Text)).toEqual(["Requests:\n- one and two", "Requests:\n- three"])
      const rerun = callText(h.model.last())
      expect(rerun).toContain(filler(40_000, "f"))
      expect(rerun).not.toContain("[Result cleared")
      expect(rerun).toContain("Requests:\n- three")
    })
  })

  test("a rewind at a continuation turn holding two held messages replaces their waiting events", async () => {
    await withHarness(async (h) => {
      const id = h.create({ model: mid.id })
      await turn(h, id, "first", blob(76_000), say("first done"))
      const hold2 = () => {
        h.input(id, "held one")
        h.input(id, "held two")
      }
      await turn(h, id, "second", blob(5_000), doing(hold2, say("in order")), say("continuation reply"))
      await h.turnsEnded(id, 3)
      const waitingTexts = () => ofType(h, id, "INPUT_WAITING").map((event) => event.text)
      const held = ofType(h, id, "INPUT_WAITING").filter((event) => event.text.startsWith("held"))
      const continuation = ofType(h, id, "RUN_STARTED")[2]
      expect(continuation.userMessageIds).toEqual(held.map((event) => event.inputId))

      h.model.next(say("rerun reply"))
      h.hub.rewind(id, continuation.runId, undefined, h.sender)
      await h.turnsEnded(id, 3)
      const types = h.types(id)
      const rewound = types.indexOf("SESSION_REWOUND")
      const after = bodies(h.events(id)).slice(rewound).filter((event) => event.type === "INPUT_WAITING")
      expect(after.map((event) => event.text)).toEqual(["held one", "held two"])
      expect(waitingTexts()).toEqual(["first", "second", "held one", "held two"])
      expect(after.map((event) => event.inputId)).not.toEqual(held.map((event) => event.inputId))
      const rerun = ofType(h, id, "RUN_STARTED")[2]
      expect(rerun.userMessageIds).toEqual(after.map((event) => event.inputId))
      expect(ofType(h, id, "INPUT_RECEIVED").slice(-2).map((event) => event.inputId)).toEqual(after.map((event) => event.inputId))

      h.model.next(say("edited reply"))
      h.hub.rewind(id, rerun.runId, "edited", h.sender)
      await h.turnsEnded(id, 3)
      const edited = bodies(h.events(id))
      const at = edited.findIndex((event) => event.type === "SESSION_REWOUND")
      expect(edited.slice(at).filter((event) => event.type === "INPUT_WAITING").map((event) => event.text)).toEqual(["edited"])
      expect(waitingTexts()).toEqual(["first", "second", "edited"])
    })
  })
})

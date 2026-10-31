import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionEvent } from "@ashe-agent/protocol"
import { SCRATCH_FORK_MAX_BYTES } from "../src/context/constants.ts"
import { removeTree, sha256 } from "../src/sessions/files.ts"
import { AgentHarness, hold, messageText, say, type Reply } from "./support/agent.ts"

const withHarness = async (body: (h: AgentHarness) => Promise<void>) => {
  const h = new AgentHarness()
  try {
    await body(h)
  } finally {
    await h.cleanup()
  }
}

const ofType = (events: ReadonlyArray<SessionEvent>, type: string) =>
  (events.map((event) => event.event) as Array<any>).filter((event) => event.type === type)
const runIds = (h: AgentHarness, id: string) => ofType(h.events(id), "RUN_STARTED").map((event) => event.runId as string)
const lastText = (h: AgentHarness) => h.model.last().messages.map(messageText).join("\n")

/** A reply that runs `act` when the model call arrives, as the turn's own tool work would, then says `text`. */
const doing =
  (act: () => void, text = "done"): Reply =>
  (call, signal) => {
    act()
    return say(text)(call, signal)
  }

/** Runs one turn of `text` in `id`, doing `act` during it. */
const turn = async (h: AgentHarness, id: string, text: string, act: () => void = () => {}) => {
  const ended = ofType(h.events(id), "RUN_FINISHED").length + ofType(h.events(id), "RUN_ERROR").length
  h.model.next(doing(act))
  h.input(id, text)
  await h.turnsEnded(id, ended + 1)
}

const research = (h: AgentHarness, id: string) => join(h.sessionDir(id), "research")
const readResearch = (h: AgentHarness, id: string) =>
  Object.fromEntries(readdirSync(research(h, id)).map((name) => [name, readFileSync(join(research(h, id), name), "utf8")]))
const roots = (h: AgentHarness) => [h.files.sessionsDir, h.files.memoryDir, h.files.scratchRoot]
const entries = (h: AgentHarness) => roots(h).map((root) => (existsSync(root) ? readdirSync(root).sort() : []))
const count = (h: AgentHarness, table: string) => h.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()!.n

/** Publishes `files` as the session's next memory generation, as a context turn's passed validation does. */
const publishMemory = (h: AgentHarness, id: string, files: Record<string, string>) => {
  const state = h.hub.store.files
  const stored = Object.entries(files).map(([name, text]) => {
    const data = Buffer.from(text)
    return { name, data, sha256: sha256(data) }
  })
  const next = state.generations(id).memory + 1
  const recorded = h.files.writeGeneration(id, next, stored)
  h.db.transaction(() => {
    state.putFiles(stored)
    state.recordGeneration(id, next, recorded, Date.now())
  })()
  h.files.pointMemory(id, next)
  h.files.removeOtherGenerations(id, next)
  return next
}

/**
 * Makes the session's memory directory a file, so writing a memory
 * generation fails; returns its repair.
 */
const breakMemoryDir = (h: AgentHarness, id: string) => {
  const dir = join(h.files.memoryDir, id)
  removeTree(dir)
  writeFileSync(dir, "not a directory")
  return () => {
    unlinkSync(dir)
    mkdirSync(dir, { mode: 0o700 })
  }
}

describe("snapshots and restores", () => {
  test("a rewind restores research, replacing a symlink without following it, publishes memory, and leaves scratch", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      const outside = mkdtempSync(join(tmpdir(), "ashe-agent-outside-"))
      try {
        await turn(h, id, "t1", () => writeFileSync(join(research(h, id), "a.md"), "A1"))
        publishMemory(h, id, { "timeline.md": "T1" })
        await turn(h, id, "t2", () => {
          writeFileSync(join(research(h, id), "a.md"), "A2")
          writeFileSync(join(research(h, id), "b.md"), "B2")
          writeFileSync(join(h.sessionDir(id), "scratch", "work.txt"), "kept")
        })
        publishMemory(h, id, { "timeline.md": "T2", "other.md": "O2" })
        unlinkSync(join(research(h, id), "a.md"))
        writeFileSync(join(outside, "target.md"), "OUTSIDE")
        symlinkSync(join(outside, "target.md"), join(research(h, id), "a.md"))
        const generation = h.hub.store.files.generations(id).memory

        let seen: Record<string, string> = {}
        h.model.next(doing(() => (seen = readResearch(h, id)), "again"))
        h.hub.rewind(id, runIds(h, id)[1]!, undefined, h.sender)
        await h.turnsEnded(id, 2)
        expect(seen).toEqual({ "a.md": "A1" })
        expect(lstatSync(join(research(h, id), "a.md")).isFile()).toBe(true)
        expect(readFileSync(join(outside, "target.md"), "utf8")).toBe("OUTSIDE")
        expect(readFileSync(join(h.sessionDir(id), "scratch", "work.txt"), "utf8")).toBe("kept")
        expect(h.hub.store.files.generations(id).memory).toBe(generation + 1)
        expect(readdirSync(join(h.sessionDir(id), "memory"))).toEqual(["timeline.md"])
        expect(readFileSync(join(h.sessionDir(id), "memory", "timeline.md"), "utf8")).toBe("T1")
        expect(readdirSync(join(h.files.memoryDir, id))).toEqual([String(generation + 1)])
        expect(h.hub.store.files.pendingRestore(id)).toBeNull()
        // Contents only the removed turn's snapshot and the replaced generation held are gone.
        expect(h.hub.store.conversation.contentBytes(sha256(Buffer.from("O2")))).toBeNull()
        expect(h.hub.store.conversation.contentBytes(sha256(Buffer.from("A1")))).not.toBeNull()
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })
  })

  test("hidden Markdown files are research files, and a restore whose publish fails after its commit stays pending", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      // Entries named like research files that are not regular files are skipped, not opened.
      const socket = Bun.listen({ unix: join(research(h, id), "socket.md"), socket: { data() {} } })
      mkdirSync(join(research(h, id), "locked.md"), { mode: 0o000 })
      try {
        await turn(h, id, "t0")
      } finally {
        socket.stop(true)
      }
      expect(ofType(h.events(id), "RUN_FINISHED")).toHaveLength(1)
      expect(h.hub.store.files.snapshot(id, runIds(h, id)[0]!)).toEqual([])
      removeTree(join(research(h, id), "locked.md"))
      rmSync(join(research(h, id), "socket.md"), { force: true })
      await turn(h, id, "t1", () => writeFileSync(join(research(h, id), ".notes.md"), "N1"))
      await turn(h, id, "t2", () => {
        writeFileSync(join(research(h, id), ".notes.md"), "N2")
        writeFileSync(join(research(h, id), ".later.md"), "L2")
      })
      // An unwritable session directory fails the `memory` rename after the generation is recorded.
      chmodSync(h.sessionDir(id), 0o500)
      try {
        h.hub.rewind(id, runIds(h, id)[2]!, undefined, h.sender)
        expect(ofType(h.events(id), "SESSION_ERROR").at(-1)).toMatchObject({ code: "restore_failed" })
        expect(h.hub.store.files.pendingRestore(id)).not.toBeNull()
      } finally {
        chmodSync(h.sessionDir(id), 0o700)
      }
      let seen: Record<string, string> = {}
      h.model.next(doing(() => (seen = readResearch(h, id)), "rerun"))
      h.input(id, "go on", "queue")
      await h.turnsEnded(id, 3)
      expect(seen).toEqual({ ".notes.md": "N1" })
      expect(h.hub.store.files.pendingRestore(id)).toBeNull()
      expect(readlinkSync(join(h.sessionDir(id), "memory"))).toBe(join(h.files.memoryDir, id, String(h.hub.store.files.generations(id).memory)))
    })
  })

  test("a fork writes its fork point's files, after a notification-started turn changed them, or the current files without one", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      await turn(h, id, "t1", () => writeFileSync(join(research(h, id), "a.md"), "A1"))
      publishMemory(h, id, { "timeline.md": "T1" })
      // A turn started by a notification alone changes research after the fork point.
      h.hub.store.conversation.addWaiting(
        id,
        { kind: "notification", component: { type: "notification", name: "test", heading: "Test", text: "# Test\n\nnote", sources: {} } },
        Date.now(),
      )
      h.model.next(doing(() => writeFileSync(join(research(h, id), "a.md"), "A-later")))
      h.hub.resumeWaiting()
      await h.turnsEnded(id, 2)
      publishMemory(h, id, { "timeline.md": "T-later" })

      const atPoint = h.hub.fork(id, runIds(h, id)[0]!).id
      expect(readResearch(h, atPoint)).toEqual({ "a.md": "A1" })
      expect(readFileSync(join(h.sessionDir(atPoint), "memory", "timeline.md"), "utf8")).toBe("T1")
      expect(readlinkSync(join(h.sessionDir(atPoint), "memory"))).toBe(join(h.files.memoryDir, atPoint, "1"))

      const whole = h.hub.fork(id, undefined).id
      expect(readResearch(h, whole)).toEqual({ "a.md": "A-later" })
      expect(readFileSync(join(h.sessionDir(whole), "memory", "timeline.md"), "utf8")).toBe("T-later")
      expect(readResearch(h, id)).toEqual({ "a.md": "A-later" })
    })
  })

  test("a failed restore stays pending, holding the rerun and an edit, refusing fork and rewind, until a request completes it", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      await turn(h, id, "t1", () => writeFileSync(join(research(h, id), "a.md"), "A1"))
      await turn(h, id, "t2", () => writeFileSync(join(research(h, id), "a.md"), "A2"))
      const repair = breakMemoryDir(h, id)
      h.hub.rewind(id, runIds(h, id)[1]!, "t2 edited", h.sender)
      expect(ofType(h.events(id), "SESSION_ERROR").at(-1)).toMatchObject({ code: "restore_failed" })
      expect(ofType(h.events(id), "SESSION_ERROR").at(-1).runId).toBeUndefined()
      h.input(id, "meanwhile", "queue")
      expect(h.hub.isRunning(id)).toBe(false)
      expect(h.hub.store.conversation.waiting(id).filter((entry) => entry.kind === "user").map((entry) => entry.kind === "user" && entry.text)).toEqual([
        "t2 edited",
        "meanwhile",
      ])
      expect(() => h.hub.fork(id, undefined)).toThrow("being restored")
      expect(() => h.hub.rewind(id, runIds(h, id)[0]!, undefined, h.sender)).toThrow("being restored")

      repair()
      let seen: Record<string, string> = {}
      h.model.next(doing(() => (seen = readResearch(h, id)), "rerun"), say("meanwhile"), say("later"))
      h.input(id, "later", "queue")
      await h.turnsEnded(id, 4)
      expect(seen).toEqual({ "a.md": "A1" })
      expect(ofType(h.events(id), "INPUT_RECEIVED").map((event) => event.text)).toEqual(["t1", "t2 edited", "meanwhile", "later"])
    })
  })

  test("a restore a crash interrupted completes at server start before its rerun turn starts", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      await turn(h, id, "t1", () => writeFileSync(join(research(h, id), "a.md"), "A1"))
      await turn(h, id, "t2", () => writeFileSync(join(research(h, id), "a.md"), "A2"))
      const repair = breakMemoryDir(h, id)
      h.hub.rewind(id, runIds(h, id)[1]!, undefined, h.sender)
      await h.hub.stop()
      repair()
      let seen: Record<string, string> = {}
      h.model.next(doing(() => (seen = readResearch(h, id)), "rerun"))
      await h.restart()
      await h.turnsEnded(id, 2)
      expect(seen).toEqual({ "a.md": "A1" })
      expect(h.hub.store.files.pendingRestore(id)).toBeNull()
    })
  })

  test("a restore failing at server start defers the memory check and turns until a later input completes it", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      await turn(h, id, "t1")
      await turn(h, id, "t2")
      const repair = breakMemoryDir(h, id)
      h.hub.rewind(id, runIds(h, id)[1]!, undefined, h.sender)
      const errors = ofType(h.events(id), "SESSION_ERROR").length
      await h.restart()
      expect(ofType(h.events(id), "SESSION_ERROR").slice(errors).map((event) => event.code)).toEqual(["memory_publish_failed", "restore_failed"])
      expect(h.hub.isRunning(id)).toBe(false)
      expect(h.hub.store.files.generations(id).memoryRestore).toBe(0)
      expect(h.hub.store.conversation.waiting(id).some((entry) => entry.kind === "user")).toBe(true)

      repair()
      h.model.next(say("rerun"), say("later"))
      h.input(id, "later", "queue")
      await h.turnsEnded(id, 3)
      expect(ofType(h.events(id), "INPUT_RECEIVED").map((event) => event.text)).toEqual(["t1", "t2", "later"])
      expect(h.model.calls.slice(-2).map(({ call }) => call.messages.map(messageText).join("\n")).join("\n")).not.toContain("Memory Restored")
      expect(h.hub.store.files.generations(id).memoryRestore).toBe(0)
    })
  })

  test("a server start settles a pending restore, interrupted results, and a memory mismatch before any turn starts", async () => {
    await withHarness(async (h) => {
      const restoring = h.create()
      await turn(h, restoring, "t1")
      await turn(h, restoring, "t2")
      const running = h.create()
      const mismatched = h.create()
      await turn(h, mismatched, "m1")
      publishMemory(h, mismatched, { "timeline.md": "T" })

      const repair = breakMemoryDir(h, restoring)
      h.hub.rewind(restoring, runIds(h, restoring)[1]!, undefined, h.sender)
      repair()
      h.model.next(hold(new Promise(() => {})))
      h.input(running, "long")
      expect(h.hub.isRunning(running)).toBe(true)
      h.input(running, "after restart", "queue")
      const generation = join(h.files.memoryDir, mismatched, String(h.hub.store.files.generations(mismatched).memory))
      chmodSync(generation, 0o755)
      writeFileSync(join(generation, "stray.md"), "stray")
      chmodSync(generation, 0o555)

      h.model.next(say("rerun"), say("after"), say("restored"))
      await h.restart()
      await h.turnsEnded(restoring, 2)
      await h.turnsEnded(running, 1)
      await h.turnsEnded(mismatched, 2)
      const types = h.types(running)
      expect(types.indexOf("RUN_STARTED", types.indexOf("RUN_INTERRUPTED"))).toBeGreaterThan(types.indexOf("RUN_INTERRUPTED"))
      expect(h.hub.store.files.pendingRestore(restoring)).toBeNull()
      const restored = h.model.calls.map(({ call }) => call.messages.map(messageText).join("\n")).find((text) => text.includes("# Memory Restored"))!
      expect(restored).toContain("These files in `memory/` changed outside a context turn: `memory/stray.md`.")
      expect(ofType(h.events(mismatched), "RUN_STARTED").at(-1)).toMatchObject({ cause: "notification", userMessageIds: [] })
      expect(readdirSync(join(h.sessionDir(mismatched), "memory"))).toEqual(["timeline.md"])
    })
  })
})

describe("memory generations", () => {
  test("memory is read-only, and a changed, added, or relinked file is republished with a memory restored component", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      publishMemory(h, id, { "a.md": "A", "b.md": "B" })
      const memory = join(h.sessionDir(id), "memory")
      expect(() => writeFileSync(join(memory, "new.md"), "x")).toThrow()
      expect(() => writeFileSync(join(memory, "a.md"), "x")).toThrow()
      expect(lstatSync(memory).isSymbolicLink()).toBe(true)

      const generation = () => join(h.files.memoryDir, id, String(h.hub.store.files.generations(id).memory))
      const restoredPaths = () => {
        const text = lastText(h)
        return text.slice(text.lastIndexOf("# Memory Restored")).split("\n")[2]
      }
      chmodSync(join(generation(), "a.md"), 0o644)
      writeFileSync(join(generation(), "a.md"), "changed")
      await turn(h, id, "t1")
      expect(restoredPaths()).toStartWith("These files in `memory/` changed outside a context turn: `memory/a.md`.")
      expect(readFileSync(join(memory, "a.md"), "utf8")).toBe("A")
      expect(lstatSync(join(memory, "a.md")).mode & 0o777).toBe(0o444)

      chmodSync(generation(), 0o755)
      writeFileSync(join(generation(), "added.md"), "added")
      chmodSync(generation(), 0o555)
      await turn(h, id, "t2")
      expect(restoredPaths()).toStartWith("These files in `memory/` changed outside a context turn: `memory/added.md`.")
      expect(readdirSync(memory).sort()).toEqual(["a.md", "b.md"])

      const elsewhere = mkdtempSync(join(tmpdir(), "ashe-agent-elsewhere-"))
      try {
        unlinkSync(memory)
        symlinkSync(elsewhere, memory)
        await turn(h, id, "t3")
        expect(restoredPaths()).toStartWith("These files in `memory/` changed outside a context turn: `memory`.")
        expect(readlinkSync(memory)).toBe(generation())
        expect(readdirSync(elsewhere)).toEqual([])
      } finally {
        rmSync(elsewhere, { recursive: true, force: true })
      }
      expect(h.hub.store.files.generations(id).memoryRestore).toBe(3)
      expect(readdirSync(join(h.files.memoryDir, id))).toHaveLength(1)
    })
  })

  test("a missing memory directory, an unlistable generation, and a directory at `memory` are republished, and a touch is not", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      publishMemory(h, id, { "a.md": "A" })
      const memory = join(h.sessionDir(id), "memory")
      const generation = () => join(h.files.memoryDir, id, String(h.hub.store.files.generations(id).memory))
      const restores = () => h.hub.store.files.generations(id).memoryRestore

      // The memory check at server start republishes into a recreated memory directory.
      removeTree(join(h.files.memoryDir, id))
      h.model.next(say("noted"))
      await h.restart()
      await h.turnsEnded(id, 1)
      expect(restores()).toBe(1)
      expect(readFileSync(join(memory, "a.md"), "utf8")).toBe("A")

      chmodSync(generation(), 0o000)
      await turn(h, id, "t1")
      expect(restores()).toBe(2)
      expect(lastText(h)).toContain("changed outside a context turn: `memory`.")

      unlinkSync(memory)
      mkdirSync(join(memory, "inner"), { recursive: true })
      await turn(h, id, "t2")
      expect(restores()).toBe(3)
      expect(lstatSync(memory).isSymbolicLink()).toBe(true)
      expect(readFileSync(join(memory, "a.md"), "utf8")).toBe("A")

      // Changed metadata with the recorded bytes is no mismatch.
      utimesSync(join(generation(), "a.md"), new Date(0), new Date(0))
      await turn(h, id, "t3")
      expect(restores()).toBe(3)
    })
  })

  test("a publish a crash interrupted is completed at server start, and a reader of the old generation reads it whole", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      publishMemory(h, id, { "a.md": "A".repeat(100_000) })
      const reader = openSync(join(h.sessionDir(id), "memory", "a.md"), "r")
      try {
        const state = h.hub.store.files
        const stored = [{ name: "a.md", data: Buffer.from("NEW"), sha256: sha256(Buffer.from("NEW")) }]
        const next = state.generations(id).memory + 1
        const recorded = h.files.writeGeneration(id, next, stored)
        h.db.transaction(() => {
          state.putFiles(stored)
          state.recordGeneration(id, next, recorded, Date.now())
        })()
        // The server stops before the symlink is renamed into place.
        await h.restart()
        expect(readlinkSync(join(h.sessionDir(id), "memory"))).toBe(join(h.files.memoryDir, id, String(next)))
        expect(readdirSync(join(h.files.memoryDir, id))).toEqual([String(next)])
        expect(readFileSync(join(h.sessionDir(id), "memory", "a.md"), "utf8")).toBe("NEW")
        expect(h.hub.store.conversation.waiting(id)).toEqual([])
        const buffer = Buffer.alloc(200_000)
        expect(buffer.subarray(0, readSync(reader, buffer)).toString()).toBe("A".repeat(100_000))
      } finally {
        closeSync(reader)
      }
    })
  })
})

describe("scratch", () => {
  test("scratch links to the run-owned scratch root, a fork copies it with symlinks and without a FIFO, and a lost target is recreated", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      const link = join(h.sessionDir(id), "scratch")
      expect(readlinkSync(link)).toBe(join(h.files.scratchRoot, id))
      expect(lstatSync(join(h.files.scratchRoot, id)).isDirectory()).toBe(true)
      mkdirSync(join(link, "dir"))
      writeFileSync(join(link, "dir", "file.txt"), "content")
      chmodSync(join(link, "dir"), 0o555)
      symlinkSync("dir/file.txt", join(link, "alias"))
      expect(Bun.spawnSync(["mkfifo", join(link, "pipe")]).exitCode).toBe(0)
      await turn(h, id, "t1")

      const fork = h.hub.fork(id, undefined).id
      const copied = join(h.files.scratchRoot, fork)
      expect(readFileSync(join(copied, "dir", "file.txt"), "utf8")).toBe("content")
      expect(lstatSync(join(copied, "dir")).mode & 0o777).toBe(0o555)
      expect(readlinkSync(join(copied, "alias"))).toBe("dir/file.txt")
      expect(existsSync(join(copied, "pipe"))).toBe(false)
      await turn(h, fork, "in fork")
      expect(lastText(h)).toContain("a copy of `scratch/`, without 1 sockets, FIFOs, and devices.")

      removeTree(join(h.files.scratchRoot, id))
      await turn(h, id, "t2")
      expect(lstatSync(join(h.files.scratchRoot, id)).isDirectory()).toBe(true)
      expect(lastText(h)).toContain("# Scratch Lost\n\nThe contents of `scratch/` were lost")
      expect(h.hub.store.files.generations(id).scratch).toBe(1)
    })
  })

  test("a fork over the scratch limit, a failed fork, and a failed create leave nothing behind", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      await turn(h, id, "t1", () => writeFileSync(join(research(h, id), "a.md"), "A1"))
      const before = entries(h)
      const rows = ["sessions", "checkpoint_windows", "window_items", "memory_generations", "contents"].map((table) => count(h, table))
      const big = join(h.files.scratchRoot, id, "big")
      writeFileSync(big, "")
      truncateSync(big, SCRATCH_FORK_MAX_BYTES + 1)
      expect(() => h.hub.fork(id, undefined)).toThrow(`holds ${SCRATCH_FORK_MAX_BYTES + 1} bytes, over the fork limit of ${SCRATCH_FORK_MAX_BYTES} bytes`)
      expect(entries(h)).toEqual(before)
      unlinkSync(big)

      h.db.run("CREATE TRIGGER fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'injected'); END")
      expect(() => h.hub.fork(id, undefined)).toThrow("injected")
      expect(() => h.create()).toThrow("injected")
      h.db.run("DROP TRIGGER fail_session")
      expect(entries(h)).toEqual(before)
      expect(["sessions", "checkpoint_windows", "window_items", "memory_generations", "contents"].map((table) => count(h, table))).toEqual(rows)
      expect(readResearch(h, id)).toEqual({ "a.md": "A1" })
    })
  })

  test("a server start removes the files of unrecorded sessions without following symlinks, and keeps every other entry", async () => {
    await withHarness(async (h) => {
      const id = h.create()
      const outside = mkdtempSync(join(tmpdir(), "ashe-agent-outside-"))
      try {
        writeFileSync(join(outside, "keep.txt"), "keep")
        // What a crashed create and a crashed fork left, without rows.
        for (const crashed of ["crashedcreat", "crashedfork1"]) {
          for (const root of roots(h)) {
            mkdirSync(join(root, crashed, "inner"), { recursive: true })
            symlinkSync(outside, join(root, crashed, "inner", "link"))
          }
          chmodSync(join(h.files.memoryDir, crashed, "inner"), 0o555)
        }
        mkdirSync(join(h.files.sessionsDir, "not-a-session"))
        await h.restart()
        for (const root of roots(h)) {
          expect(readdirSync(root).sort()).toEqual(root === h.files.sessionsDir ? [id, "not-a-session"].sort() : [id])
        }
        expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep")
        expect(readdirSync(h.sessionDir(id)).sort()).toEqual(["memory", "research", "scratch"])
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })
  })
})

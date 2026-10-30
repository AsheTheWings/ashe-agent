import { mkdirSync, realpathSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import type { SessionEvent } from "@ashe-agent/protocol"
import { ErrorCode } from "@ashe-agent/protocol"
import { ProtocolError } from "../src/server/websocket.ts"
import { waitFor } from "./support/cli.ts"
import { AgentHarness, callTools, messageText, say } from "./support/agent.ts"

const withHarness = async (options: ConstructorParameters<typeof AgentHarness>[0], body: (harness: AgentHarness) => Promise<void>) => {
  const harness = new AgentHarness(options)
  try {
    await body(harness)
  } finally {
    await harness.cleanup()
  }
}

const ofType = (events: ReadonlyArray<SessionEvent>, type: string) =>
  (events.map((event) => event.event) as Array<any>).filter((event) => event.type === type)
const requests = (h: AgentHarness, id: string) => ofType(h.events(id), "PERMISSION_REQUESTED")
const resolutions = (h: AgentHarness, id: string) => ofType(h.events(id), "PERMISSION_RESOLVED")
const results = (h: AgentHarness, id: string) => ofType(h.events(id), "TOOL_CALL_RESULT")
const waitRequests = (h: AgentHarness, id: string, count: number) =>
  waitFor(`${count} permission requests`, () => (requests(h, id).length >= count ? requests(h, id) : undefined), 10_000)
const lastRunId = (h: AgentHarness, id: string) => ofType(h.events(id), "RUN_STARTED").at(-1)!.runId as string

const expectProtocolError = (run: () => void, code: number) => {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError)
    expect((error as ProtocolError).error.code).toBe(code)
    return
  }
  throw new Error("expected a protocol error")
}

describe("permission paths", () => {
  test("relative, symlinked, `..` after a symlink, absent, and dangling paths are decided by their resolved paths", async () => {
    await withHarness({ permission: { edit: { "~/real/*": "deny", "~/outside/*": "deny" } } }, async (h) => {
      mkdirSync(join(h.dir, "real"))
      mkdirSync(join(h.dir, "work"))
      mkdirSync(join(h.dir, "outside", "inner"), { recursive: true })
      symlinkSync(join(h.dir, "real"), join(h.dir, "link"))
      symlinkSync(join(h.dir, "outside", "inner"), join(h.dir, "work", "deep"), "dir")
      symlinkSync("../real/target", join(h.dir, "work", "dangling"))
      const id = h.create()
      h.model.next(
        callTools([
          { name: "touch", args: { paths: ["real/a"] } },
          { name: "touch", args: { paths: [join(h.dir, "link", "a")] } },
          { name: "touch", args: { paths: ["link/new/deeper/file"] } },
          { name: "touch", args: { paths: ["other/../link/b"] } },
          { name: "touch", args: { paths: ["work/deep/../a"] } },
          { name: "touch", args: { paths: ["work/dangling"] } },
          { name: "touch", args: { paths: ["other/a"] } },
        ]),
        say("done"),
      )
      h.input(id, "go")
      await h.turnsEnded(id, 1)
      const contents = results(h, id).map((result) => result.content as string)
      expect(contents.slice(0, 6).every((content) => content.includes("denied by configuration"))).toBe(true)
      expect(contents[6]).toBe("touched other/a")
      expect(ofType(h.events(id), "TOOL_EXECUTION_STARTED")).toHaveLength(1)
      expect(realpathSync(join(h.dir, "link"))).toBe(join(realpathSync(h.dir), "real"))
    })
  })
})

describe("permission requests", () => {
  test("deny refuses a call; ask waits until once lets it run; a second answer is an error", async () => {
    await withHarness({ permission: { edit: { "*": "ask", "*secret*": "deny" } } }, async (h) => {
      const id = h.create()
      h.model.next(callTools([{ name: "touch", args: { paths: ["secret"] } }, { name: "touch", args: { paths: ["a", "b"] } }]), say("done"))
      h.input(id, "go")
      const [request] = await waitRequests(h, id, 1)
      const root = realpathSync(h.dir)
      expect(request).toMatchObject({ permission: "edit", subjects: [join(root, "a"), join(root, "b")], patterns: [join(root, "a"), join(root, "b")] })
      expect(results(h, id)).toHaveLength(1)
      expect(results(h, id)[0]).toMatchObject({ outcome: "failed", content: expect.stringContaining("denied by configuration") })
      expect(h.hub.isRunning(id)).toBe(true)
      expect(h.model.calls).toHaveLength(1)
      h.answer(id, request.requestId, "once")
      await h.turnsEnded(id, 1)
      expect(results(h, id)[1]).toMatchObject({ outcome: "success", content: "touched a b" })
      expect(resolutions(h, id)).toEqual([{ type: "PERMISSION_RESOLVED", requestId: request.requestId, answer: "once", sender: h.sender }])
      expect(h.hub.store.grants(id)).toEqual([])
      expectProtocolError(() => h.answer(id, request.requestId, "always"), ErrorCode.alreadyResolved)
      expectProtocolError(() => h.answer(id, crypto.randomUUID(), "once"), ErrorCode.notFound)
    })
  })

  test("always runs the call, adds a session grant, and approves the session's other asks it covers", async () => {
    await withHarness({ permission: { edit: "ask" } }, async (h) => {
      const id = h.create()
      h.model.next(callTools([{ name: "pair", args: { a: "x", b: "x" } }]), say("done"))
      h.input(id, "go")
      const [first, second] = await waitRequests(h, id, 2)
      h.answer(id, first.requestId, "always")
      await h.turnsEnded(id, 1)
      expect(results(h, id)[0]).toMatchObject({ outcome: "success", content: "x: allowed, x: allowed" })
      expect(resolutions(h, id)).toEqual([
        { type: "PERMISSION_RESOLVED", requestId: first.requestId, answer: "always", sender: h.sender },
        { type: "PERMISSION_RESOLVED", requestId: second.requestId, answer: "always" },
      ])
      expect(h.hub.store.grants(id)).toEqual([{ permission: "edit", pattern: "x" }])
      // The grant now allows `x` without an ask, while `y` still asks.
      h.model.next(callTools([{ name: "pair", args: { a: "x", b: "y" } }]), say("done"))
      h.input(id, "again")
      const asked = await waitRequests(h, id, 3)
      expect(asked[2]).toMatchObject({ subjects: ["y"] })
      h.answer(id, asked[2].requestId, "once")
      await h.turnsEnded(id, 2)
      expect(results(h, id)[1]).toMatchObject({ content: "x: allowed, y: allowed" })
    })
  })

  test("a plain reject declines the call and ends the turn; later model calls include the declined result", async () => {
    await withHarness({ permission: { edit: "ask" } }, async (h) => {
      const id = h.create()
      h.model.next(callTools([{ name: "touch", args: { paths: ["a"] } }, { name: "echo", args: { text: "later" } }]))
      h.input(id, "go")
      const [request] = await waitRequests(h, id, 1)
      h.answer(id, request.requestId, "reject")
      await h.turnsEnded(id, 1)
      expect(h.model.calls).toHaveLength(1)
      expect(results(h, id).map((result) => result.outcome)).toEqual(["declined", "canceled"])
      expect(ofType(h.events(id), "TOOL_EXECUTION_STARTED")).toHaveLength(0)
      expect(results(h, id)[1].content).toContain("before it started")
      expect(ofType(h.events(id), "RUN_FINISHED").at(-1)).toMatchObject({ outcome: { type: "success" } })
      h.model.next(say("ok"))
      h.input(id, "next")
      await h.turnsEnded(id, 2)
      expect(h.model.last().messages.map(messageText).join("\n")).toContain("The user declined this tool call.")
    })
  })

  test("a reject with a message fails the call with it, rejects the session's other asks, and the turn goes on", async () => {
    await withHarness({ permission: { edit: "ask" } }, async (h) => {
      const id = h.create()
      h.model.next(callTools([{ name: "pair", args: { a: "x", b: "y" } }, { name: "touch", args: { paths: ["a"] } }]), say("done"))
      h.input(id, "go")
      const [first, second] = await waitRequests(h, id, 2)
      h.answer(id, second.requestId, "reject", "use z")
      const [, , third] = await waitRequests(h, id, 3)
      expect(resolutions(h, id)).toEqual([
        { type: "PERMISSION_RESOLVED", requestId: second.requestId, answer: "reject", message: "use z", sender: h.sender },
        { type: "PERMISSION_RESOLVED", requestId: first.requestId, answer: "reject", message: "use z" },
      ])
      expect(results(h, id)[0]).toMatchObject({ content: "x: use z, y: use z" })
      h.answer(id, third.requestId, "reject", "not a")
      await h.turnsEnded(id, 1)
      expect(results(h, id)[1]).toMatchObject({ outcome: "failed", content: "The user rejected this tool call: not a" })
      // Only `pair` ran; the rejected `touch` never started.
      expect(ofType(h.events(id), "TOOL_EXECUTION_STARTED").map((event) => event.toolCallId)).toEqual([results(h, id)[0].toolCallId])
      expect(h.model.calls).toHaveLength(2)
    })
  })

  test("canceling a turn withdraws its ask", async () => {
    await withHarness({ permission: { edit: "ask" } }, async (h) => {
      const id = h.create()
      h.model.next(callTools([{ name: "touch", args: { paths: ["a"] } }]))
      h.input(id, "go")
      const [request] = await waitRequests(h, id, 1)
      h.hub.cancel(id)
      await h.turnsEnded(id, 1)
      expect(ofType(h.events(id), "PERMISSION_WITHDRAWN")).toEqual([{ type: "PERMISSION_WITHDRAWN", requestId: request.requestId, reason: "canceled" }])
      expectProtocolError(() => h.answer(id, request.requestId, "once"), ErrorCode.alreadyResolved)
    })
  })
})

describe("session grants", () => {
  test("grants survive a restart and a rewind, and a fork starts with its source's grants", async () => {
    await withHarness({ permission: { edit: "ask" } }, async (h) => {
      const id = h.create()
      h.model.next(callTools([{ name: "touch", args: { paths: ["a"] } }]), say("done"))
      h.input(id, "go")
      const [request] = await waitRequests(h, id, 1)
      h.answer(id, request.requestId, "always")
      await h.turnsEnded(id, 1)
      const grant = [{ permission: "edit", pattern: join(realpathSync(h.dir), "a") }]
      await h.restart()
      expect(h.hub.store.grants(id)).toEqual(grant)
      h.model.next(callTools([{ name: "touch", args: { paths: ["a"] } }]), say("done"))
      h.input(id, "second")
      await h.turnsEnded(id, 2)
      expect(requests(h, id)).toHaveLength(1)
      h.model.next(callTools([{ name: "touch", args: { paths: ["a"] } }]), say("done"))
      h.hub.rewind(id, lastRunId(h, id), "edited", h.sender)
      await waitFor("the rerun", () => (ofType(h.events(id), "RUN_FINISHED").length === 2 && !h.hub.isRunning(id) ? true : undefined))
      expect(h.hub.store.grants(id)).toEqual(grant)
      expect(requests(h, id)).toHaveLength(1)
      const fork = h.hub.fork(id, undefined).id
      expect(h.hub.store.grants(fork)).toEqual(grant)
      const [asked, finished] = [requests(h, fork).length, ofType(h.events(fork), "RUN_FINISHED").length]
      h.model.next(callTools([{ name: "touch", args: { paths: ["a"] } }]), say("done"))
      h.input(fork, "in the fork")
      await waitFor("the fork's turn", () => (ofType(h.events(fork), "RUN_FINISHED").length > finished && !h.hub.isRunning(fork) ? true : undefined))
      expect(requests(h, fork)).toHaveLength(asked)
      expect(results(h, fork).at(-1)).toMatchObject({ outcome: "success" })
    })
  })
})

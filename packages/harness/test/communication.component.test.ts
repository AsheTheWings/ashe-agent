import { describe, expect, test } from "bun:test"
import { toolPolicy } from "../src/agent/tools.ts"
import { AgentHarness, callTools, failWith, gate, hold, ManualClock, messageText, say } from "./support/agent.ts"
import { waitFor } from "./support/cli.ts"

const ofType = (h: AgentHarness, id: string, type: string) =>
  h.events(id).flatMap(({ event }) => (event.type === type ? [event as any] : []))

const toolRun = (h: AgentHarness, sessionId: string) => ({
  sessionId,
  runId: h.hub.store.turns(sessionId).at(-1)!.runId,
  agentTitle: "untitled",
  modelId: "test/alpha",
  reasoningEffort: null,
  toolCallId: "test",
  cwd: h.sessionDir(sessionId),
  imageInput: false,
  signal: new AbortController().signal,
  deadline: Number.POSITIVE_INFINITY,
  clock: h.hub.toolPolicy.clock,
  authorize: async () => {},
  started: () => {},
  onCancel: () => {},
  programCall: () => {},
  offered: () => true,
  note: () => undefined,
})

const retainedInput = (h: AgentHarness, draftId: string, text: string) => {
  const bytes = Buffer.from(text)
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  const made = h.hub.attachments.create("login:component", draftId, `${draftId}.txt`, "text/plain", bytes.byteLength, Date.now())
  h.hub.attachments.append("login:component", made.uploadId, 0, bytes.toString("base64"), Date.now())
  h.hub.attachments.finalize("login:component", made.uploadId, bytes.byteLength, digest, Date.now())
  const attachmentId = h.hub.store.db.query<{ attachment_id: string }, [string]>(
    "SELECT attachment_id FROM uploads WHERE owner_id = 'login:component' AND upload_id = ?",
  ).get(made.uploadId)!.attachment_id
  return {
    attachmentId,
    contentId: digest,
    representationId: digest,
    name: `${draftId}.txt`,
    mediaType: "text/plain",
    digest,
  }
}

describe("session communication tools", () => {
  test("a session tool steers a peer message with its AgentTurn as the sender", async () => {
    const h = new AgentHarness()
    const held = gate()
    try {
      const target = h.create()
      const sender = h.create()
      h.model.next(hold(held.promise))
      h.input(target, "current work")
      await h.calls(1)

      h.model.next(callTools([{ name: "session_message", args: { sessionId: target, text: "peer work" } }]), say("sent"))
      h.input(sender, "message the peer")
      await h.turnsEnded(sender, 1)
      expect(h.hub.store.conversation.waiting(target)).toMatchObject([
        {
          kind: "user",
          text: "peer work",
          mode: "steer",
          sender: { kind: "session", sessionId: sender, agentTitle: "untitled", modelId: "test/alpha" },
        },
      ])
      expect(ofType(h, sender, "TOOL_CALL_RESULT").at(-1)).toMatchObject({
        outcome: "success",
        content: expect.stringContaining(`"sessionId":"${target}"`),
      })

      h.model.next(say("received"))
      held.open()
      await h.turnsEnded(target, 2)
      expect(messageText(h.model.last().messages.at(-1)!)).toContain("peer work")
    } finally {
      held.open()
      await h.cleanup()
    }
  })

  test("self messages and subscriptions are rejected without queuing input", async () => {
    const h = new AgentHarness()
    try {
      const id = h.create()
      h.model.next(say("ready"))
      h.input(id, "ready")
      await h.turnsEnded(id, 1)
      const run = toolRun(h, id)
      const rejection = async (work: () => Promise<unknown>) => {
        try {
          await work()
          return null
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      }
      expect(await rejection(() => h.hub.message(run, { sessionId: id, text: "self" }))).toContain("cannot message itself")
      expect(await rejection(() => h.hub.subscription(run, { sourceSessionId: id, action: "subscribe" })))
        .toContain("cannot subscribe to itself")
      expect(h.hub.store.conversation.waiting(id)).toEqual([])
      expect(h.hub.communication.filter(id, id)).toBeNull()
    } finally {
      await h.cleanup()
    }
  })

  test("malformed session tool arguments fail their schemas without effects", async () => {
    const h = new AgentHarness()
    try {
      const source = h.create()
      const target = h.create()
      h.model.next(say("ready"))
      h.input(source, "ready")
      await h.turnsEnded(source, 1)
      const publications = h.hub.store.db.query<{ n: number }, []>(
        "SELECT count(*) AS n FROM subscription_publications",
      ).get()!.n
      const run = toolRun(h, source)
      const tools = (h.hub as any).sessionTools as ReadonlyArray<{
        spec: { name: string; parameters: Record<string, any> }
        run: (args: unknown, run: any) => Promise<{ outcome: string }>
      }>
      let started = 0
      const counting = { ...run, started: () => started++ }
      for (const [name, args] of [
        ["session_message", { sessionId: target, text: "bad filter", subscribe: { messages: [] } }],
        ["session_fork", { unexpected: true }],
        ["session_list", { unexpected: true }],
        ["session_subscription", { sourceSessionId: target, action: "subscribe", messages: [] }],
        ["session_subscription", { sourceSessionId: target, action: "subscribe", messages: ["user", "user"] }],
        ["session_wait", { timeout_ms: 10, unexpected: true }],
      ] as const) {
        const tool = tools.find((candidate) => candidate.spec.name === name)!
        expect((await tool.run(args, counting)).outcome).toBe("failed")
      }
      expect(started).toBe(0)
      expect(tools.find((tool) => tool.spec.name === "session_fork")!.spec.parameters.additionalProperties).toBe(false)
      expect(tools.find((tool) => tool.spec.name === "session_list")!.spec.parameters.additionalProperties).toBe(false)
      expect(tools.find((tool) => tool.spec.name === "session_subscription")!.spec.parameters.properties.messages)
        .toMatchObject({ minItems: 1, uniqueItems: true })
      expect(h.hub.list()).toHaveLength(2)
      expect(h.hub.store.turns(source)).toHaveLength(1)
      expect(h.hub.store.conversation.waiting(target)).toEqual([])
      expect(h.hub.store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM session_subscriptions").get()).toEqual({ n: 0 })
      expect(h.hub.store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM subscription_publications").get())
        .toEqual({ n: publications })
    } finally {
      await h.cleanup()
    }
  })

  test("a failed fresh-session message leaves no session or input behind", async () => {
    const h = new AgentHarness()
    try {
      const source = h.create()
      h.model.next(say("ready"))
      h.input(source, "ready")
      await h.turnsEnded(source, 1)
      const tool = ((h.hub as any).sessionTools as ReadonlyArray<any>)
        .find((candidate) => candidate.spec.name === "session_message")
      let failed = false
      try {
        await tool.run(
          {
            text: "must not remain",
            attachments: [
              {
                attachmentId: "missing-attachment",
                contentId: "missing-content",
                representationId: "missing-representation",
                name: "missing.txt",
                mediaType: "text/plain",
                digest: "missing-digest",
              },
            ],
          },
          toolRun(h, source),
        )
      } catch {
        failed = true
      }
      expect(failed).toBe(true)
      let hostFailed = false
      try {
        await h.hub.message(toolRun(h, source), { text: "invalid subscription", subscribe: { messages: [] } })
      } catch {
        hostFailed = true
      }
      expect(hostFailed).toBe(true)
      expect(h.hub.list().map((session) => session.id)).toEqual([source])
      expect(h.hub.store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM session_subscriptions").get()).toEqual({ n: 0 })
      expect(h.hub.store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM attachment_references").get()).toEqual({ n: 0 })
      expect(h.hub.store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM waiting_input").get()).toEqual({ n: 0 })
    } finally {
      await h.cleanup()
    }
  })

  test("message and subscription setup is committed before an immediate reply can publish", async () => {
    const h = new AgentHarness()
    try {
      const source = h.create()
      const target = h.create()
      h.model.next(say("ready"), say("immediate reply"), say("source observed"))
      h.input(source, "ready")
      await h.turnsEnded(source, 1)
      const sent = await h.hub.message(toolRun(h, source), {
        sessionId: target,
        text: "work now",
        subscribe: { messages: ["agent_final"] },
      })
      expect(sent.outcome).toBe("success")
      await h.turnsEnded(target, 1)
      await h.turnsEnded(source, 2)
      const observed = h.model.calls.map(({ call }) => call.messages.map(messageText).join("\n"))
        .find((text) => text.includes("Session Message"))
      expect(observed).toContain("immediate reply")
      expect(h.hub.communication.filter(source, target)).toEqual(["agent_final"])
    } finally {
      await h.cleanup()
    }
  })

  test("one deferred fork runs after the batch and continues the copied AgentTurn in its branch", async () => {
    const h = new AgentHarness()
    try {
      const source = h.create()
      h.hub.store.addGrants(source, "untitled", "edit", ["a"])
      const after = async function* (call: any, signal: AbortSignal) {
        const text = call.messages.map(messageText).join("\n")
        yield* say(text.includes("# Fork") ? "branch continued" : "source continued")(call, signal)
      }
      h.model.next(
        callTools([
          { name: "session_fork", args: {} },
          { name: "echo", args: { text: "a" } },
          { name: "missing", args: {} },
          { name: "session_fork", args: {} },
        ]),
        after,
        after,
      )
      h.input(source, "fork this session")
      await h.turnsEnded(source, 1)
      const branch = await waitFor("the fork branch", () =>
        h.hub.list().find((session) => session.id !== source)?.id,
      )
      await h.turnsEnded(branch, 1)
      const [sourceTurn] = h.hub.store.turns(source)
      const [branchTurn] = h.hub.store.turns(branch)
      expect(branchTurn).toMatchObject({
        runId: sourceTurn!.runId,
        userMessageIds: sourceTurn!.userMessageIds,
        status: "finished",
      })
      expect(h.hub.store.turns(branch)).toHaveLength(1)
      expect(h.hub.store.grants(branch, "untitled")).toEqual(h.hub.store.grants(source, "untitled"))
      h.hub.store.clearGrants(branch, "untitled")
      expect(h.hub.store.grants(source, "untitled")).toHaveLength(1)
      const results = h.events(source).flatMap(({ event }) => event.type === "TOOL_CALL_RESULT" ? [event.content] : [])
      expect(results.findIndex((content) => content.includes("echoed a"))).toBeLessThan(
        results.findIndex((content) => content.includes('"continued":true')),
      )
      expect(results.filter((content) => content.includes("Only the first agent fork request"))).toHaveLength(1)
      const sourceFork = h.events(source).find(
        ({ event }) => event.type === "TOOL_CALL_RESULT" && event.content.includes('"continued":true'),
      ) as any
      const branchFork = h.events(branch).find(
        ({ event }) => event.type === "TOOL_CALL_RESULT" && event.content.includes('"continued":true'),
      ) as any
      expect(sourceFork?.event).toMatchObject({ invocationId: branchFork?.event.invocationId })
      const branchText = h.events(branch).flatMap(({ event }) =>
        event.type === "TEXT_MESSAGE_CONTENT" ? [event.delta] : [],
      ).join("")
      expect(branchText).toContain("branch continued")
    } finally {
      await h.cleanup()
    }
  })

  test("a fork keeps the copied turn's effective settings and the branch's current selection", async () => {
    const h = new AgentHarness()
    try {
      const source = h.create()
      h.model.next(
        async function* (call: any, signal: AbortSignal) {
          h.hub.store.setSettings(source, {
            agentTitle: "future title",
            modelSettings: { modelId: "test/alpha", reasoningEffort: null },
          })
          yield* callTools([{ name: "session_fork", args: {} }])(call, signal)
        },
        say("source continuation"),
        say("branch continuation"),
      )
      h.input(source, "fork with future selection")
      await h.turnsEnded(source, 1)
      const fork = h.events(source).find(({ event }) =>
        event.type === "TOOL_CALL_RESULT" && event.content.includes('"continued":true'),
      )!.event as any
      const branch = JSON.parse(fork.content).sessionId as string
      await h.turnsEnded(branch, 1)
      expect(h.hub.store.turns(source)[0]).toMatchObject({ agentTitle: "untitled", model: "test/alpha", reasoningEffort: null })
      expect(h.hub.store.turns(branch).at(-1)).toMatchObject({ agentTitle: "untitled", model: "test/alpha", reasoningEffort: null })
      expect(h.hub.summary(branch).selection.agentTitle).toBe("future title")
    } finally {
      await h.cleanup()
    }
  })

  test("cancelling before the batch settles performs no deferred fork", async () => {
    const h = new AgentHarness()
    try {
      const source = h.create()
      h.model.next(callTools([{ name: "wait", args: {} }, { name: "session_fork", args: {} }]))
      h.input(source, "hold then fork")
      await waitFor("the wait call", () =>
        h.events(source).some(({ event }) => event.type === "TOOL_EXECUTION_STARTED") ? true : undefined,
      )
      h.hub.cancel(source)
      await h.turnsEnded(source, 1)
      expect(h.hub.list()).toHaveLength(1)
      expect(h.events(source).some(({ event }) =>
        event.type === "TOOL_CALL_RESULT" && event.content.includes('"continued":true'),
      )).toBe(false)
    } finally {
      await h.cleanup()
    }
  })

  test("a preparing fork intent recovers its branch without replaying source work", async () => {
    const h = new AgentHarness()
    try {
      const source = h.create()
      h.model.next(callTools([{ name: "echo", args: { text: "before fork" } }, { name: "session_fork", args: {} }]), say("source continuation"))
      h.input(source, "fork and recover")
      await h.turnsEnded(source, 1)
      const firstFork = h.events(source).find(({ event }) =>
        event.type === "TOOL_CALL_RESULT" && event.content.includes('"continued":true'),
      )!.event as any
      const firstBranch = JSON.parse(firstFork.content).sessionId as string
      const callsBeforeRecovery = h.model.calls.length
      const intent = h.hub.store.db.query<{
        intent_id: string
        source_invocation_id: string
        source_run_id: string
      }, []>("SELECT intent_id, source_invocation_id, source_run_id FROM agent_fork_intents").get()!
      const recoveredBranch = crypto.randomUUID()
      ;(h.hub as any).files.removeSession(firstBranch)
      h.hub.store.db.run("PRAGMA foreign_keys = OFF")
      for (const { name } of h.hub.store.db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()) {
        const columns = h.hub.store.db
          .query<{ name: string }, []>(`PRAGMA table_info("${name}")`)
          .all()
          .map((column) => column.name)
        for (const column of ["session_id", "receiver_session_id", "source_session_id"]) {
          if (columns.includes(column)) {
            h.hub.store.db.query(`DELETE FROM "${name}" WHERE "${column}" = ?`).run(firstBranch)
          }
        }
      }
      h.hub.store.db.query("DELETE FROM sessions WHERE id = ?").run(firstBranch)
      h.hub.store.db.run("PRAGMA foreign_keys = ON")
      h.hub.store.db.transaction(() => {
        h.hub.store.db.query(
          "UPDATE agent_fork_intents SET status = 'preparing', branch_session_id = ? WHERE intent_id = ?",
        ).run(recoveredBranch, intent.intent_id)
        h.hub.store.db.query(
          "UPDATE turns SET status = 'running', ended_at = NULL WHERE session_id = ? AND run_id = ?",
        ).run(source, intent.source_run_id)
        h.hub.store.db.query(
          "UPDATE agent_tools SET settled_at = NULL, outcome = NULL, result_ref = NULL WHERE session_id = ? AND entry_id = ?",
        ).run(source, intent.source_invocation_id)
      })()
      await h.restart()
      await waitFor("the recovered branch turn", () =>
        h.hub.store.turns(recoveredBranch)[0]?.status === "interrupted" ? true : undefined,
      )
      expect(h.hub.communication.pendingForkIntents()).toEqual([])
      expect(h.hub.store.turns(recoveredBranch)).toMatchObject([{ runId: intent.source_run_id, status: "interrupted" }])
      expect(h.hub.store.turns(source)[0]!.status).toBe("interrupted")
      expect(h.model.calls).toHaveLength(callsBeforeRecovery)
      expect(h.events(recoveredBranch).filter(({ event }) =>
        event.type === "TOOL_CALL_RESULT" && event.content === "echoed before fork",
      )).toHaveLength(1)
      expect(h.events(recoveredBranch).some(({ event }) =>
        event.type === "TOOL_CALL_RESULT" && event.content.includes('"continued":true'),
      )).toBe(true)
    } finally {
      await h.cleanup()
    }
  })

  test("a post-commit fork failure leaves matching source and branch receipts", async () => {
    const h = new AgentHarness()
    try {
      const source = h.create()
      const original = (h.hub as any).finalizeFork.bind(h.hub)
      let injected = false
      ;(h.hub as any).finalizeFork = (...args: Array<unknown>) => {
        const branch = original(...args)
        if (!injected) {
          injected = true
          throw new Error("injected after fork commit")
        }
        return branch
      }
      h.model.next(callTools([{ name: "session_fork", args: {} }]), say("source continued"), say("branch continued"))
      h.input(source, "fork without contradictory receipts")
      await h.turnsEnded(source, 1)
      const fork = h.events(source).find(({ event }) =>
        event.type === "TOOL_CALL_RESULT" && event.content.includes('"continued":true'),
      )!.event as any
      const branch = JSON.parse(fork.content).sessionId as string
      await h.turnsEnded(branch, 1)
      const sourceResult = h.events(source).find(({ event }) =>
        event.type === "TOOL_CALL_RESULT" && event.content === fork.content,
      )!.event as any
      const branchResult = h.events(branch).find(({ event }) =>
        event.type === "TOOL_CALL_RESULT" && event.content === fork.content,
      )!.event as any
      expect(sourceResult).toMatchObject({ outcome: "success", invocationId: branchResult.invocationId })
      expect(h.hub.communication.pendingForkIntents()).toEqual([])
      expect(h.hub.store.db.query<{ status: string }, []>("SELECT status FROM agent_fork_intents").all())
        .toEqual([{ status: "ready" }])
      await h.restart()
      expect(h.hub.store.turns(source)[0]!.status).toBe("finished")
      expect(h.hub.store.turns(branch)[0]!.status).toBe("finished")
      expect(h.events(source).filter(({ event }) =>
        event.type === "TOOL_CALL_RESULT" && event.content === fork.content,
      )).toHaveLength(1)
      expect(h.events(branch).filter(({ event }) =>
        event.type === "TOOL_CALL_RESULT" && event.content === fork.content,
      )).toHaveLength(1)
    } finally {
      await h.cleanup()
    }
  })

  test("title selection is denied through the standard session permission", async () => {
    const h = new AgentHarness({ permission: { session: { other: "deny" } } })
    try {
      const target = h.create()
      const sender = h.create()
      h.model.next(
        callTools([
          {
            name: "session_message",
            args: { sessionId: target, text: "must not arrive", selection: { agentTitle: "other" } },
          },
        ]),
        say("denied"),
      )
      h.input(sender, "try another title")
      await h.turnsEnded(sender, 1)
      expect(ofType(h, sender, "TOOL_CALL_RESULT")[0]).toMatchObject({
        outcome: "failed",
        content: expect.stringContaining("denied by configuration"),
      })
      expect(h.hub.store.conversation.waiting(target)).toEqual([])
      expect(h.model.calls).toHaveLength(2)
      expect(h.hub.summary(target).activity).toBe("idle")
    } finally {
      await h.cleanup()
    }
  })

  test("a plain rejection of a session tool cancels its AgentTurn", async () => {
    const h = new AgentHarness({ permission: { session: "ask" } })
    try {
      const target = h.create()
      const sender = h.create()
      h.model.next(callTools([{ name: "session_message", args: { sessionId: target, text: "never" } }]))
      h.input(sender, "try")
      const asked = await waitFor("the session permission request", () =>
        h.events(sender).find(({ event }) => event.type === "PERMISSION_REQUESTED")?.event as any,
      )
      h.answer(sender, asked.requestId, "reject")
      await h.turnsEnded(sender, 1)
      expect(h.hub.store.turns(sender)[0]!.status).toBe("cancelled")
      expect(h.hub.store.conversation.waiting(target)).toEqual([])
      expect(h.events(sender).some(({ event }) => event.type === "RUN_FINISHED" && event.outcome.type === "cancelled")).toBe(true)
    } finally {
      await h.cleanup()
    }
  })

  test("a message without a target creates a fresh session from the caller's effective selection", async () => {
    const h = new AgentHarness()
    try {
      const source = h.create()
      h.model.next(say("source"))
      h.input(source, "source work")
      await h.turnsEnded(source, 1)
      h.model.next(say("fresh"))
      const result = await h.hub.message(toolRun(h, source), { text: "fresh work" })
      const receipt = JSON.parse(String(result.content))
      expect(result.outcome).toBe("success")
      expect(receipt.created).toBe(true)
      await h.turnsEnded(receipt.sessionId, 1)
      expect(h.hub.summary(receipt.sessionId)).toMatchObject({
        identity: { agentTitle: "untitled", modelId: "test/alpha" },
        selection: { agentTitle: "untitled", modelSettings: { modelId: "test/alpha", reasoningEffort: null } },
      })
      expect(h.hub.store.turns(receipt.sessionId)).toHaveLength(1)
      expect(h.hub.store.conversation.items(receipt.sessionId, 1).some((item) => item.kind === "user")).toBe(true)
      expect(h.hub.communication.reactions(receipt.sessionId, h.hub.store.turns(receipt.sessionId)[0]!.runId)).toEqual([])
    } finally {
      await h.cleanup()
    }
  })

  test("explicit cross-session work starts a fresh causal chain", async () => {
    const h = new AgentHarness()
    try {
      const source = h.create()
      const target = h.create()
      h.model.next(say("source"), say("target"))
      h.input(source, "source work")
      await h.turnsEnded(source, 1)
      h.hub.communication.recordReaction(source, h.hub.store.turns(source)[0]!.runId, {
        publicationId: "automatic",
        rootId: "failure-root",
        visited: [source],
        automatic: true,
      })

      await h.hub.message(toolRun(h, source), { sessionId: target, text: "explicit work" })
      await h.turnsEnded(target, 1)
      expect(h.hub.communication.reactions(target, h.hub.store.turns(target)[0]!.runId)).toEqual([])
    } finally {
      await h.cleanup()
    }
  })

  test("a turn with two automatic roots publishes each root once", async () => {
    const h = new AgentHarness()
    const held = gate()
    try {
      const source = h.create()
      const observer = h.create()
      h.model.next(say("source ready"), say("observer ready"), hold(held.promise, failWith(new Error("mixed failure"))))
      h.input(source, "ready")
      await h.turnsEnded(source, 1)
      h.input(observer, "ready")
      await h.turnsEnded(observer, 1)
      h.hub.communication.subscribe(
        observer,
        source,
        ["agent_final"],
        observer,
        h.hub.store.turns(observer)[0]!.runId,
        Date.now(),
      )
      h.input(source, "fail")
      const runId = await waitFor("the failing turn", () => h.hub.store.turns(source)[1]?.runId)
      for (const rootId of ["root-a", "root-b"]) {
        h.hub.communication.recordReaction(source, runId, {
          publicationId: `notification-${rootId}`,
          rootId,
          visited: [source],
          automatic: true,
        })
      }
      held.open()
      await waitFor("both root publications", () => {
        const row = h.hub.store.db.query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM subscription_publications WHERE source_session_id = ? AND category = 'abnormal'",
        ).get(source)
        return row?.n === 2 ? true : undefined
      })
      expect(h.hub.communication.reactions(source, runId).map((reaction) => reaction.rootId).sort())
        .toEqual(["root-a", "root-b"])
    } finally {
      held.open()
      await h.cleanup()
    }
  })

  test("an agent-final subscription wakes an idle observer with attributed completed content", async () => {
    const h = new AgentHarness()
    try {
      const source = h.create()
      const observer = h.create()
      h.model.next(
        callTools([
          {
            name: "session_subscription",
            args: { sourceSessionId: source, action: "subscribe" },
          },
        ]),
        say("subscribed"),
        say("source reply"),
        say("observer saw it"),
      )
      h.input(observer, "subscribe")
      await h.turnsEnded(observer, 1)

      h.input(source, "publish")
      await h.turnsEnded(source, 1)
      await h.turnsEnded(observer, 2)
      const delivered = h.model.calls.at(-1)!.call.messages.map(messageText).join("\n")
      expect(delivered).toContain("A subscribed message from session")
      expect(delivered).toContain(`\`${source}\``)
      expect(delivered).toContain("source reply")
      expect(h.hub.store.conversation.waiting(observer)).toEqual([])
    } finally {
      await h.cleanup()
    }
  })

  test("an intermediate text committed with a tool call is published under its own category", async () => {
    const h = new AgentHarness()
    const held = gate()
    try {
      const source = h.create()
      const observer = h.create()
      h.model.next(
        callTools([{ name: "session_subscription", args: { sourceSessionId: source, action: "subscribe", messages: ["agent_intermediate"] } }]),
        say("subscribed"),
        hold(held.promise),
        async function* (call: any, signal: AbortSignal) {
          yield* say("working on it")(call, signal)
          yield* callTools([{ name: "echo", args: { text: "done" } }])(call, signal)
        },
        say("finished"),
        say("observer received"),
      )
      h.input(observer, "subscribe")
      await h.turnsEnded(observer, 1)
      h.input(observer, "hold")
      await h.calls(3)
      h.input(source, "work")
      await h.turnsEnded(source, 1)
      held.open()
      await waitFor("the intermediate delivery", () =>
        h.model.calls.some(({ call }) =>
          call.messages.map(messageText).join("\n").includes("Session Message"),
        ) ? true : undefined,
      )
      const delivered = h.model.calls
        .map(({ call }) => call.messages.map(messageText).join("\n"))
        .filter((text) => text.includes("Session Message"))
      expect(delivered).toHaveLength(1)
      expect(delivered[0]).toContain("working on it")
      expect(delivered[0]).not.toContain("finished")
    } finally {
      held.open()
      await h.cleanup()
    }
  })

  test("a user-category subscription delivers an admitted user message", async () => {
    const h = new AgentHarness()
    const held = gate()
    try {
      const source = h.create()
      const observer = h.create()
      h.model.next(
        callTools([{ name: "session_subscription", args: { sourceSessionId: source, action: "subscribe", messages: ["user"] } }]),
        say("subscribed"),
        hold(held.promise),
        say("source reply"),
        say("observer reply"),
      )
      h.input(observer, "subscribe")
      await h.turnsEnded(observer, 1)
      h.input(observer, "hold")
      await h.calls(3)
      h.input(source, "user publication")
      await h.turnsEnded(source, 1)
      held.open()
      const delivered = await waitFor("the user delivery", () =>
        h.model.calls.map(({ call }) => call.messages.map(messageText).join("\n"))
          .find((text) => text.includes("Session Message") && text.includes("user publication")),
      )
      expect(delivered).toContain("category `user`")
    } finally {
      held.open()
      await h.cleanup()
    }
  })

  test("a new subscription starts after its predecessor and receives only later publications", async () => {
    const h = new AgentHarness()
    try {
      const source = h.create()
      const observer = h.create()
      h.model.next(say("before subscription"))
      h.input(source, "before")
      await h.turnsEnded(source, 1)
      h.model.next(
        callTools([{ name: "session_subscription", args: { sourceSessionId: source, action: "subscribe" } }]),
        say("subscribed"),
      )
      h.input(observer, "subscribe")
      await h.turnsEnded(observer, 1)
      h.model.next(say("after subscription"), say("observer reply"))
      h.input(source, "after")
      await h.turnsEnded(source, 2)
      await h.turnsEnded(observer, 2)
      const delivered = h.model.calls.map(({ call }) => call.messages.map(messageText).join("\n"))
      expect(delivered.some((text) => text.includes("before subscription") && text.includes("Session Message"))).toBe(false)
      expect(delivered.some((text) => text.includes("after subscription") && text.includes("Session Message"))).toBe(true)
    } finally {
      await h.cleanup()
    }
  })

  test("silent success publishes nothing and a discarded response publishes no partial text", async () => {
    const h = new AgentHarness()
    try {
      const source = h.create()
      const observer = h.create()
      h.model.next(
        callTools([{ name: "session_subscription", args: { sourceSessionId: source, action: "subscribe" } }]),
        say("subscribed"),
        say(""),
      )
      h.input(observer, "subscribe")
      await h.turnsEnded(observer, 1)
      h.input(source, "stay silent")
      await h.turnsEnded(source, 1)
      expect(h.hub.store.db.query(
        "SELECT count(*) AS n FROM subscription_publications WHERE source_session_id = ? AND category = 'agent_final'",
      ).get(source)).toEqual({ n: 0 })
      h.model.next(
        async function* (call: any, signal: AbortSignal) {
          yield* say("partial output")(call, signal)
          throw new Error("discard this response")
        },
        say("observer noticed"),
      )
      h.input(source, "discard")
      await h.turnsEnded(source, 2)
      const text = h.hub.store.db
        .query<{ text: string }, [string]>("SELECT text FROM subscription_publications WHERE source_session_id = ?")
        .all(source).map((row) => row.text)
      expect(text.some((entry) => entry.includes("partial output"))).toBe(false)
      expect(text.some((entry) => entry.startsWith("failed"))).toBe(true)
    } finally {
      await h.cleanup()
    }
  })

  test("developer notifications are not republished as agent-authored messages", async () => {
    const h = new AgentHarness()
    try {
      const source = h.create()
      const observer = h.create()
      h.model.next(say("source ready"), say("observer ready"))
      h.input(source, "ready")
      await h.turnsEnded(source, 1)
      h.input(observer, "ready")
      await h.turnsEnded(observer, 1)
      h.hub.communication.subscribe(
        observer,
        source,
        ["agent_final"],
        observer,
        h.hub.store.turns(observer)[0]!.runId,
        Date.now(),
      )
      h.hub.communication.subscribe(
        source,
        observer,
        ["agent_final"],
        source,
        h.hub.store.turns(source)[0]!.runId,
        Date.now(),
      )
      h.model.next(say("source message"), say("observer reply"), say("source acknowledged"))
      h.input(source, "publish")
      await h.turnsEnded(source, 2)
      await h.turnsEnded(observer, 2)
      await h.turnsEnded(source, 3)
      const publications = h.hub.store.db.query<{ text: string }, []>(
        "SELECT text FROM subscription_publications WHERE category IN ('agent_intermediate', 'agent_final')",
      ).all().map((row) => row.text)
      expect(publications).toEqual(expect.arrayContaining(["source message", "observer reply", "source acknowledged"]))
      expect(publications.some((text) => text.includes("Session Message"))).toBe(false)
    } finally {
      await h.cleanup()
    }
  })

  test("a turn handoff to eligible work publishes the first reply as intermediate", async () => {
    const h = new AgentHarness()
    const held = gate()
    try {
      const source = h.create()
      const observer = h.create()
      h.model.next(
        callTools([{ name: "session_subscription", args: { sourceSessionId: source, action: "subscribe" } }]),
        say("subscribed"),
        hold(held.promise, say("first answer")),
        say("second answer"),
        say("observer final"),
      )
      h.input(observer, "subscribe")
      await h.turnsEnded(observer, 1)
      h.input(source, "first")
      await h.calls(3)
      h.input(source, "second", "steer")
      held.open()
      await h.turnsEnded(source, 1)
      await h.turnsEnded(observer, 2)
      const categories = h.hub.store.db
        .query<{ category: string, text: string }, [string]>(
          "SELECT category, text FROM subscription_publications WHERE source_session_id = ? AND category IN ('agent_intermediate', 'agent_final') ORDER BY created_at",
        ).all(source)
      expect(categories).toEqual([
        { category: "agent_intermediate", text: "first answer" },
        { category: "agent_final", text: "second answer" },
      ])
      const delivered = h.model.calls
        .map(({ call }) => call.messages.map(messageText).join("\n"))
        .filter((text) => text.includes("Session Message"))
      expect(delivered).toHaveLength(1)
      expect(delivered[0]).toContain("second answer")
      expect(delivered[0]).not.toContain("first answer")
      expect(h.hub.store.db.query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM subscription_publications WHERE source_session_id = ? AND category = 'abnormal'",
      ).get(source)).toEqual({ n: 0 })
    } finally {
      held.open()
      await h.cleanup()
    }
  })

  test("an abnormal idle notice is delivered independently of the optional message filter", async () => {
    const h = new AgentHarness()
    try {
      const source = h.create()
      const observer = h.create()
      h.model.next(
        callTools([
          {
            name: "session_subscription",
            args: { sourceSessionId: source, action: "subscribe", messages: ["agent_final"] },
          },
        ]),
        say("subscribed"),
        failWith(new Error("provider lost")),
        say("observer noticed"),
      )
      h.input(observer, "subscribe to final messages only")
      await h.turnsEnded(observer, 1)
      h.input(source, "fail")
      await h.turnsEnded(source, 1)
      await h.turnsEnded(observer, 2)
      const delivered = h.model.calls.at(-1)!.call.messages.map(messageText).join("\n")
      expect(delivered).toContain("reached idle after an abnormal outcome (`failed`)")
      expect(delivered).toContain("provider lost")
    } finally {
      await h.cleanup()
    }
  })

  test("automatic failure reactions suppress a return to a visited session", async () => {
    const h = new AgentHarness()
    try {
      const first = h.create()
      const second = h.create()
      h.model.next(say("first ready"), say("second ready"), failWith(new Error("first failed")), failWith(new Error("second failed")))
      h.input(first, "first ready")
      await h.turnsEnded(first, 1)
      h.input(second, "second ready")
      await h.turnsEnded(second, 1)
      await h.hub.subscription(toolRun(h, first), { sourceSessionId: second, action: "subscribe" })
      await h.hub.subscription(toolRun(h, second), { sourceSessionId: first, action: "subscribe" })

      h.input(first, "fail first")
      await h.turnsEnded(first, 2)
      await h.turnsEnded(second, 2)
      await Bun.sleep(50)
      expect(h.hub.store.turns(first)).toHaveLength(2)
      expect(h.model.calls).toHaveLength(4)
      const firstDeliveries = h.hub.communication.db
        .query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM subscription_deliveries WHERE receiver_session_id = ? AND root_id IS NOT NULL",
        )
        .get(first)!
      expect(firstDeliveries.n).toBe(0)
    } finally {
      await h.cleanup()
    }
  })

  test("wait wakes for steering without returning the message content", async () => {
    const h = new AgentHarness({ communicationWaitMinMs: 20, communicationWaitDefaultMs: 20, communicationWaitMaxMs: 1_000 })
    try {
      const id = h.create()
      h.model.next(callTools([{ name: "session_wait", args: {} }]), say("woke"), say("next"))
      h.input(id, "wait")
      await h.calls(1)
      h.input(id, "steering text", "steer")
      await h.turnsEnded(id, 2)
      const result = ofType(h, id, "TOOL_CALL_RESULT")[0]
      expect(JSON.parse(result.content)).toEqual({ outcome: "steering" })
      expect(result.content).not.toContain("steering text")
    } finally {
      await h.cleanup()
    }
  })

  test("wait observes input that arrives before its registration without consuming it", async () => {
    const h = new AgentHarness({ communicationWaitMinMs: 10, communicationWaitDefaultMs: 100, communicationWaitMaxMs: 1_000 })
    const held = gate()
    try {
      const id = h.create()
      h.model.next(hold(held.promise, callTools([{ name: "session_wait", args: {} }])), say("after wait"))
      h.input(id, "start")
      await h.calls(1)
      h.input(id, "pending", "queue")
      held.open()
      await h.turnsEnded(id, 2)
      expect(JSON.parse(ofType(h, id, "TOOL_CALL_RESULT")[0].content)).toEqual({ outcome: "activity" })
      expect(ofType(h, id, "TOOL_CALL_RESULT")[0].content).not.toContain("pending")
      expect(messageText(h.model.last().messages.at(-1)!)).toContain("pending")
    } finally {
      held.open()
      await h.cleanup()
    }
  })

  test("wait reports a bounded timeout and rejects a request over its maximum", async () => {
    const h = new AgentHarness({ communicationWaitMinMs: 10, communicationWaitDefaultMs: 10, communicationWaitMaxMs: 50 })
    try {
      const id = h.create()
      h.model.next(callTools([{ name: "session_wait", args: { timeout_ms: 1 } }]), say("timeout"))
      h.input(id, "wait")
      await h.turnsEnded(id, 1)
      expect(JSON.parse(ofType(h, id, "TOOL_CALL_RESULT")[0].content)).toEqual({ outcome: "timeout" })

      h.model.next(callTools([{ name: "session_wait", args: { timeout_ms: 51 } }]), say("refused"))
      h.input(id, "too long")
      await h.turnsEnded(id, 2)
      expect(ofType(h, id, "TOOL_CALL_RESULT").at(-1)).toMatchObject({
        outcome: "failed",
        content: expect.stringContaining("over the configured maximum 50 ms"),
      })
    } finally {
      await h.cleanup()
    }
  })

  test("wait budgets expire as failed tool calls and cancellation ends the turn", async () => {
    const clock = new ManualClock()
    const budgeted = new AgentHarness({
      communicationWaitMinMs: 10,
      communicationWaitDefaultMs: 100,
      communicationWaitMaxMs: 1_000,
      toolPolicy: toolPolicy(20, {}, clock),
    })
    try {
      const id = budgeted.create()
      budgeted.model.next(callTools([{ name: "session_wait", args: { timeout_ms: 1_000 } }]), say("continued"))
      budgeted.input(id, "wait")
      await waitFor("the wait start", () =>
        ofType(budgeted, id, "TOOL_EXECUTION_STARTED").length === 1 ? true : undefined,
      )
      await clock.advance(20)
      await budgeted.turnsEnded(id, 1)
      expect(ofType(budgeted, id, "TOOL_CALL_RESULT")[0]).toMatchObject({
        outcome: "failed",
        content: expect.stringContaining("timed out after 20 ms"),
      })
      expect(budgeted.model.calls).toHaveLength(2)
    } finally {
      await budgeted.cleanup()
    }
    const cancelled = new AgentHarness({
      communicationWaitMinMs: 10,
      communicationWaitDefaultMs: 100,
      communicationWaitMaxMs: 1_000,
    })
    try {
      const id = cancelled.create()
      cancelled.model.next(callTools([{ name: "session_wait", args: {} }]))
      cancelled.input(id, "wait")
      await waitFor("the wait start", () =>
        ofType(cancelled, id, "TOOL_EXECUTION_STARTED").length === 1 ? true : undefined,
      )
      cancelled.hub.cancel(id)
      await cancelled.turnsEnded(id, 1)
      expect(cancelled.hub.store.turns(id)[0]!.status).toBe("cancelled")
      expect(ofType(cancelled, id, "TOOL_CALL_RESULT")).toMatchObject([{ outcome: "canceled" }])
    } finally {
      await cancelled.cleanup()
    }
  })

  test("session list supplies selected and active settings plus read-only SQL guidance", async () => {
    const h = new AgentHarness()
    try {
      const id = h.create()
      h.model.next(callTools([{ name: "session_list", args: {} }]), say("listed"))
      h.input(id, "list")
      await h.turnsEnded(id, 1)
      const listed = JSON.parse(ofType(h, id, "TOOL_CALL_RESULT")[0].content)
      expect(listed.sessions.find((session: any) => session.id === id)).toMatchObject({
        identity: { sessionId: id, modelId: "test/alpha" },
        activity: "working",
        activeSelection: { agentTitle: "untitled", modelSettings: { modelId: "test/alpha" } },
      })
      expect(listed.database).toMatchObject({
        database: `${h.dir}/ashe-agent.db`,
        readOnly: true,
        sqlite3: "/usr/bin/sqlite3",
      })
      expect(listed.database.command).toContain(" -readonly ")
      expect(listed.database.guidance).toContain("waiting_input")
    } finally {
      await h.cleanup()
    }
  })

  test("an early readiness failure publishes one abnormal notice unless queued work continues", async () => {
    const h = new AgentHarness()
    const held = gate()
    try {
      const source = h.create()
      const observer = h.create()
      h.model.next(
        callTools([{ name: "session_subscription", args: { sourceSessionId: source, action: "subscribe" } }]),
        say("subscribed"),
        say("observer saw early failure"),
      )
      h.input(observer, "subscribe")
      await h.turnsEnded(observer, 1)
      h.hub.input(source, "invalid", "steer", h.sender, {
        selection: { modelSettings: { modelId: "test/missing" } },
      })
      await h.turnsEnded(source, 1)
      await h.turnsEnded(observer, 2)
      const seen = h.model.calls.map(({ call }) => messageText(call.messages.at(-1)!)).join("\n")
      expect(seen).toContain("Subscribed Session Stopped Abnormally")
      expect(seen).toContain("the model test/missing is not configured")
      expect(h.hub.store.db.query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM subscription_publications WHERE source_session_id = ? AND category = 'abnormal'",
      ).get(source)).toEqual({ n: 1 })

      h.model.next(hold(held.promise), say("valid queued work"))
      h.hub.input(source, "hold", "steer", h.sender, {
        selection: { modelSettings: { modelId: "test/alpha" } },
      })
      await waitFor("the held source", () => h.hub.isRunning(source) ? true : undefined)
      h.model.next(say("invalid while queued"))
      h.hub.input(source, "queued", "queue", h.sender)
      h.hub.input(source, "invalid steering", "steer", h.sender, {
        selection: { modelSettings: { modelId: "test/missing" } },
      })
      h.hub.cancel(source)
      await h.turnsEnded(source, 3)
      const abnormalBefore = h.hub.store.db.query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM subscription_publications WHERE source_session_id = ? AND category = 'abnormal'",
      ).get(source)!.n
      held.open()
      await h.turnsEnded(source, 4)
      expect(h.hub.store.db.query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM subscription_publications WHERE source_session_id = ? AND category = 'abnormal'",
      ).get(source)!.n).toBe(abnormalBefore)
    } finally {
      held.open()
      await h.cleanup()
    }
  })

  test("a final publication, delivery, and recipient input fail or commit together", async () => {
    const h = new AgentHarness()
    try {
      const source = h.create()
      const observer = h.create()
      h.model.next(
        callTools([{ name: "session_subscription", args: { sourceSessionId: source, action: "subscribe" } }]),
        say("subscribed"),
      )
      h.input(observer, "subscribe")
      await h.turnsEnded(observer, 1)
      const conversation = h.hub.store.conversation as any
      const addWaiting = conversation.addWaiting.bind(conversation)
      let failed = false
      conversation.addWaiting = (sessionId: string, entry: any, at: number) => {
        if (!failed && entry.kind === "notification") {
          failed = true
          throw new Error("injected recipient input failure")
        }
        return addWaiting(sessionId, entry, at)
      }
      h.model.next(say("must publish atomically"))
      h.input(source, "publish")
      await h.turnsEnded(source, 1)
      expect(failed).toBe(true)
      expect(h.hub.store.db.query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM subscription_publications WHERE source_session_id = ? AND category = 'agent_final'",
      ).get(source)).toEqual({ n: 0 })
      expect(h.hub.store.db.query<{ n: number }, [string]>(
        `SELECT count(*) AS n FROM subscription_deliveries d
          JOIN subscription_publications p ON p.publication_id = d.publication_id
          WHERE p.source_session_id = ? AND p.category = 'agent_final'`,
      ).get(source)).toEqual({ n: 0 })
      conversation.addWaiting = addWaiting
      await h.restart()
      expect(h.hub.store.db.query<{ n: number }, [string]>(
        `SELECT count(*) AS n FROM subscription_deliveries d
          JOIN subscription_publications p ON p.publication_id = d.publication_id
          WHERE p.source_session_id = ? AND p.category = 'agent_final' AND d.status = 'pending'`,
      ).get(source)).toEqual({ n: 0 })
    } finally {
      await h.cleanup()
    }
  })

  test("a same-root reaction unions every visited path before suppression", async () => {
    const h = new AgentHarness()
    try {
      const source = h.create()
      const b = h.create()
      const c = h.create()
      const d = h.create()
      const e = h.create()
      h.model.next(say("source"), say("b"), say("c"), say("d"), say("e"))
      for (const id of [source, b, c, d, e]) {
        h.input(id, "ready")
        await h.turnsEnded(id, 1)
      }
      const sourceRun = h.hub.store.turns(source)[0]!.runId
      for (const receiver of [b, c, d, e]) {
        h.hub.communication.subscribe(receiver, source, ["agent_final"], receiver, h.hub.store.turns(receiver)[0]!.runId, Date.now())
      }
      h.hub.communication.recordReaction(source, sourceRun, { rootId: "shared-root", visited: [source, b, d], automatic: true })
      h.hub.communication.recordReaction(source, sourceRun, { rootId: "shared-root", visited: [source, c, d], automatic: true })
      const [reaction] = h.hub.communication.reactions(source, sourceRun)
      expect(new Set(reaction!.visited)).toEqual(new Set([source, b, c, d]))
      const deliveries = h.hub.communication.publish({
        publicationId: crypto.randomUUID(),
        sourceSessionId: source,
        sourceMessageId: null,
        category: "abnormal",
        author: { sessionId: source, agentTitle: "untitled", modelId: "test/alpha" },
        text: "failed",
        attachments: [],
        rootId: "shared-root",
        rootVisited: reaction!.visited,
        createdAt: Date.now(),
      })
      expect(deliveries.map((delivery) => delivery.receiverSessionId)).toEqual([e])
    } finally {
      await h.cleanup()
    }
  })

  test("co-admitted notifications union visited sessions from two subscription paths", async () => {
    const h = new AgentHarness()
    try {
      const target = h.create()
      const b = h.create()
      const c = h.create()
      const d = h.create()
      const e = h.create()
      h.model.next(say("b"), say("c"), say("d"), say("e"), failWith(new Error("shared failure")), say("e noticed"))
      for (const id of [b, c, d, e]) {
        h.input(id, "ready")
        await h.turnsEnded(id, 1)
      }
      for (const receiver of [b, c, d, e]) {
        h.hub.communication.subscribe(receiver, target, ["agent_final"], receiver, h.hub.store.turns(receiver)[0]!.runId, Date.now())
      }
      h.hub.store.db.transaction(() => {
        for (const [id, visited] of [
          ["automatic-one", [target, b, d]],
          ["automatic-two", [target, c, d]],
        ] as const) {
          h.hub.store.conversation.addWaiting(target, {
            kind: "notification",
            inputId: id,
            component: { type: "notification", name: "cover", heading: "Automatic", text: id, sources: {} },
            trigger: "notification",
            reaction: {
              publicationId: "origin-failure",
              rootId: "shared-root",
              visited: [...visited],
              automatic: true,
            },
          }, Date.now())
          h.hub.store.appendEvent(target, { type: "INPUT_WAITING", inputId: id, text: id, mode: "steer", sender: h.sender }, Date.now())
        }
      })()
      ;(h.hub as any).startNext(target)
      await h.turnsEnded(target, 1)
      await h.turnsEnded(e, 2)
      const [reaction] = h.hub.communication.reactions(target, h.hub.store.turns(target)[0]!.runId)
      expect(new Set(reaction!.visited)).toEqual(new Set([target, b, c, d]))
      const deliveries = h.hub.store.db.query<{ receiver_session_id: string }, [string]>(
        `SELECT d.receiver_session_id FROM subscription_deliveries d
          JOIN subscription_publications p ON p.publication_id = d.publication_id
          WHERE p.source_session_id = ? AND p.category = 'abnormal'`,
      ).all(target)
      expect(deliveries).toEqual([{ receiver_session_id: e }])
    } finally {
      await h.cleanup()
    }
  })

  test("a subscription filter update removes pending deliveries it no longer selects", async () => {
    const h = new AgentHarness()
    const held = gate()
    try {
      const source = h.create()
      const observer = h.create()
      h.model.next(
        callTools([
          {
            name: "session_subscription",
            args: { sourceSessionId: source, action: "subscribe", messages: ["user"] },
          },
        ]),
        say("subscribed"),
      )
      h.input(observer, "subscribe")
      await h.turnsEnded(observer, 1)

      h.model.next(hold(held.promise), say("observer done"))
      h.input(observer, "hold")
      await h.calls(2)
      const observerRun = h.hub.store.turns(observer).at(-1)!.runId
      const attachment = retainedInput(h, "filter-pending", "filter pending")
      h.model.next(say("source final"))
      h.hub.input(source, "publish", "steer", h.sender, { attachments: [attachment] })
      await h.turnsEnded(source, 1)
      expect(h.hub.store.conversation.waiting(observer)).toHaveLength(1)
      const inputId = h.hub.store.conversation.waiting(observer)[0]!.inputId
      const references = () => h.hub.store.db.query<{ n: number }, [string, string]>(
        "SELECT count(*) AS n FROM attachment_references WHERE session_id = ? AND reference_id = ?",
      ).get(observer, inputId)!.n
      expect(references()).toBe(1)
      expect(h.hub.store.conversation.retainedContent(observer, attachment.contentId, inputId)).not.toBeNull()

      await h.hub.subscription(
        {
          sessionId: observer,
          runId: observerRun,
          toolCallId: "test",
          cwd: h.sessionDir(observer),
          imageInput: false,
          signal: new AbortController().signal,
          deadline: Number.POSITIVE_INFINITY,
          clock: h.hub.toolPolicy.clock,
          authorize: async () => {},
          started: () => {},
          onCancel: () => {},
          programCall: () => {},
          offered: () => true,
          note: () => undefined,
        },
        { sourceSessionId: source, action: "subscribe", messages: ["agent_final"] },
      )
      expect(h.hub.store.conversation.waiting(observer)).toEqual([])
      expect(references()).toBe(0)
      expect(h.hub.store.conversation.retainedContent(observer, attachment.contentId, inputId)).toBeNull()
      expect(h.hub.store.db.query<{ status: string }, [string, string]>(
        "SELECT status FROM subscription_deliveries WHERE receiver_session_id = ? AND input_id = ?",
      ).get(observer, inputId)).toEqual({ status: "removed" })
      expect(h.hub.store.db.query<{ n: number }, [string, string]>(
        "SELECT count(*) AS n FROM session_subscriptions WHERE receiver_session_id = ? AND source_session_id = ?",
      ).get(observer, source)).toEqual({ n: 1 })
      held.open()
      await h.turnsEnded(observer, 2)
      await h.restart()
      expect(references()).toBe(0)
    } finally {
      held.open()
      await h.cleanup()
    }
  })

  test("unsubscribe removes pending updates and preserves admitted history", async () => {
    const h = new AgentHarness()
    const held = gate()
    try {
      const source = h.create()
      const observer = h.create()
      h.model.next(
        callTools([{ name: "session_subscription", args: { sourceSessionId: source, action: "subscribe" } }]),
        say("subscribed"),
        say("first final"),
        say("observer saw first"),
        hold(held.promise),
        say("pending final"),
        say("after unsubscribe"),
      )
      h.input(observer, "subscribe")
      await h.turnsEnded(observer, 1)
      h.input(source, "first")
      await h.turnsEnded(source, 1)
      await h.turnsEnded(observer, 2)
      expect(h.events(observer).some(({ event }) =>
        event.type === "DEVELOPER_MESSAGE" && JSON.stringify(event.components).includes("first final"),
      )).toBe(true)
      await h.hub.subscription(toolRun(h, observer), {
        sourceSessionId: source,
        action: "subscribe",
        messages: ["user"],
      })
      h.input(observer, "hold")
      await waitFor("the held observer", () => h.hub.isRunning(observer) ? true : undefined)
      const attachment = retainedInput(h, "unsubscribe-pending", "unsubscribe pending")
      h.hub.input(source, "pending", "steer", h.sender, { attachments: [attachment] })
      await h.turnsEnded(source, 2)
      expect(h.hub.store.conversation.waiting(observer)).toHaveLength(1)
      const inputId = h.hub.store.conversation.waiting(observer)[0]!.inputId
      const references = () => h.hub.store.db.query<{ n: number }, [string, string]>(
        "SELECT count(*) AS n FROM attachment_references WHERE session_id = ? AND reference_id = ?",
      ).get(observer, inputId)!.n
      expect(references()).toBe(1)
      expect(h.hub.store.conversation.retainedContent(observer, attachment.contentId, inputId)).not.toBeNull()
      await h.hub.subscription(toolRun(h, observer), { sourceSessionId: source, action: "unsubscribe" })
      expect(h.hub.store.conversation.waiting(observer)).toEqual([])
      expect(references()).toBe(0)
      expect(h.hub.store.conversation.retainedContent(observer, attachment.contentId, inputId)).toBeNull()
      expect(h.hub.store.db.query<{ status: string }, [string, string]>(
        "SELECT status FROM subscription_deliveries WHERE receiver_session_id = ? AND input_id = ?",
      ).get(observer, inputId)).toEqual({ status: "removed" })
      expect(h.hub.communication.filter(observer, source)).toBeNull()
      h.input(source, "later")
      await h.turnsEnded(source, 3)
      expect(h.hub.store.conversation.waiting(observer)).toEqual([])
      expect(h.events(observer).some(({ event }) =>
        event.type === "DEVELOPER_MESSAGE" && JSON.stringify(event.components).includes("first final"),
      )).toBe(true)
      held.open()
      await h.turnsEnded(observer, 3)
      await h.restart()
      expect(references()).toBe(0)
    } finally {
      held.open()
      await h.cleanup()
    }
  })

  test("unsubscribe removes a pending abnormal notice without waking its former receiver", async () => {
    const h = new AgentHarness()
    const held = gate()
    try {
      const source = h.create()
      const observer = h.create()
      h.model.next(
        callTools([{ name: "session_subscription", args: { sourceSessionId: source, action: "subscribe" } }]),
        say("subscribed"),
        hold(held.promise),
        say("must stay absent"),
      )
      h.input(observer, "subscribe")
      await h.turnsEnded(observer, 1)
      h.input(observer, "hold")
      await h.calls(3)
      h.hub.input(source, "invalid", "steer", h.sender, {
        selection: { modelSettings: { modelId: "test/missing" } },
      })
      await h.turnsEnded(source, 1)
      const waiting = h.hub.store.conversation.waiting(observer)
      expect(waiting).toHaveLength(1)
      expect(waiting[0]).toMatchObject({ kind: "notification", trigger: "notification" })
      const inputId = waiting[0]!.inputId
      const delivery = h.hub.store.db.query<{ status: string }, [string, string]>(
        "SELECT status FROM subscription_deliveries WHERE receiver_session_id = ? AND input_id = ?",
      ).get(observer, inputId)
      expect(delivery).toEqual({ status: "pending" })
      await h.hub.subscription(toolRun(h, observer), { sourceSessionId: source, action: "unsubscribe" })
      expect(h.hub.store.conversation.waiting(observer)).toEqual([])
      expect(h.hub.store.db.query<{ status: string }, [string, string]>(
        "SELECT status FROM subscription_deliveries WHERE receiver_session_id = ? AND input_id = ?",
      ).get(observer, inputId)).toEqual({ status: "removed" })
      held.open()
      await h.turnsEnded(observer, 2)
      await h.restart()
      expect(h.hub.store.conversation.waiting(observer)).toEqual([])
      expect(h.model.calls.some(({ call }) => call.messages.map(messageText).join("\n").includes("Subscribed Session Stopped Abnormally")))
        .toBe(false)
    } finally {
      held.open()
      await h.cleanup()
    }
  })

  test("recipient rewind marks cleared deliveries removed before restart", async () => {
    const h = new AgentHarness()
    const held = gate()
    try {
      const source = h.create()
      const observer = h.create()
      h.model.next(
        callTools([{ name: "session_subscription", args: { sourceSessionId: source, action: "subscribe" } }]),
        say("subscribed"),
        hold(held.promise),
        say("rewound subscribe"),
        say("rewound hold"),
      )
      h.input(observer, "subscribe")
      await h.turnsEnded(observer, 1)
      h.input(observer, "hold")
      await h.calls(3)
      h.model.next(say("pending delivery"))
      h.input(source, "publish")
      await h.turnsEnded(source, 1)
      const delivery = h.hub.store.conversation.waiting(observer).find((entry) => entry.kind === "notification")!
      const status = () => h.hub.store.db.query<{ status: string }, [string, string]>(
        "SELECT status FROM subscription_deliveries WHERE receiver_session_id = ? AND input_id = ?",
      ).get(observer, delivery.inputId)!.status
      expect(status()).toBe("pending")
      const subscribeRun = h.hub.store.turns(observer)[0]!.runId
      await h.hub.rewind(observer, subscribeRun, undefined, h.sender)
      expect(h.hub.store.conversation.waiting(observer).some((entry) => entry.inputId === delivery.inputId)).toBe(false)
      expect(status()).toBe("removed")
      await h.restart()
      expect(status()).toBe("removed")
      expect(h.hub.store.conversation.waiting(observer).some((entry) => entry.inputId === delivery.inputId)).toBe(false)
    } finally {
      held.open()
      await h.cleanup()
    }
  })

  test("recipient rewind also removes an abnormal delivery", async () => {
    const h = new AgentHarness()
    const held = gate()
    try {
      const source = h.create()
      const observer = h.create()
      h.model.next(
        callTools([{ name: "session_subscription", args: { sourceSessionId: source, action: "subscribe" } }]),
        say("subscribed"),
        hold(held.promise),
        say("rerun subscribe"),
        say("rerun hold"),
      )
      h.input(observer, "subscribe")
      await h.turnsEnded(observer, 1)
      h.input(observer, "hold")
      await h.calls(3)
      h.hub.input(source, "invalid", "steer", h.sender, {
        selection: { modelSettings: { modelId: "test/missing" } },
      })
      await h.turnsEnded(source, 1)
      const notification = h.hub.store.conversation.waiting(observer).find((entry) => entry.kind === "notification")!
      const status = () => h.hub.store.db.query<{ status: string }, [string, string]>(
        "SELECT status FROM subscription_deliveries WHERE receiver_session_id = ? AND input_id = ?",
      ).get(observer, notification.inputId)!.status
      expect(status()).toBe("pending")
      const subscribeRun = h.hub.store.turns(observer)[0]!.runId
      await h.hub.rewind(observer, subscribeRun, undefined, h.sender)
      expect(status()).toBe("removed")
      expect(h.hub.store.conversation.waiting(observer).some((entry) => entry.inputId === notification.inputId)).toBe(false)
      await h.restart()
      expect(status()).toBe("removed")
    } finally {
      held.open()
      await h.cleanup()
    }
  })

  test("restart restores a subscription and delivers a pending publication once", async () => {
    const h = new AgentHarness()
    const held = gate()
    try {
      const source = h.create()
      const observer = h.create()
      h.model.next(
        callTools([{ name: "session_subscription", args: { sourceSessionId: source, action: "subscribe" } }]),
        say("subscribed"),
        hold(held.promise),
      )
      h.input(observer, "subscribe")
      await h.turnsEnded(observer, 1)
      h.input(observer, "hold")
      await h.calls(3)
      h.model.next(say("source final"))
      h.input(source, "publish")
      await h.turnsEnded(source, 1)
      expect(h.hub.store.conversation.waiting(observer)).toHaveLength(1)
      h.model.next(say("after restart"))
      await h.restart()
      await waitFor("the restored delivery", () =>
        h.model.calls.some((call) => call.call.messages.map(messageText).join("\n").includes("source final")) ? true : undefined,
      )
      expect(
        h.model.calls.filter((call) => call.call.messages.map(messageText).join("\n").includes("source final")),
      ).toHaveLength(1)
      const waiting = h.hub.store.conversation.waiting(observer)
      expect(waiting.filter((entry) => entry.kind === "notification" && entry.component.name === "session_message")).toEqual([])
    } finally {
      held.open()
      await h.cleanup()
    }
  })

  test("an interrupted turn publishes an abnormal notice when recovery leaves it idle", async () => {
    const h = new AgentHarness()
    const held = gate()
    try {
      const source = h.create()
      const observer = h.create()
      h.model.next(
        callTools([{ name: "session_subscription", args: { sourceSessionId: source, action: "subscribe" } }]),
        say("subscribed"),
        hold(held.promise),
      )
      h.input(observer, "subscribe")
      await h.turnsEnded(observer, 1)
      h.input(source, "interrupt me")
      await h.calls(3)
      h.model.next(say("observer noticed"))
      await h.restart()
      expect(h.hub.store.turns(source)[0]!.status).toBe("interrupted")
      const delivered = await waitFor("the interrupted notice", () =>
        h.model.calls.map(({ call }) => call.messages.map(messageText).join("\n"))
          .find((text) => text.includes("Subscribed Session Stopped Abnormally")),
      )
      expect(delivered).toContain("interrupted")
    } finally {
      held.open()
      await h.cleanup()
    }
  })

  test("recipient rewind reconciles subscription intent from retained operations", async () => {
    const h = new AgentHarness()
    const held = gate()
    try {
      const source = h.create()
      const observer = h.create()
      h.model.next(
        callTools([{ name: "session_subscription", args: { sourceSessionId: source, action: "subscribe" } }]),
        say("subscribed"),
        callTools([{ name: "session_subscription", args: { sourceSessionId: source, action: "unsubscribe" } }]),
        say("unsubscribed"),
      )
      h.input(observer, "subscribe")
      await h.turnsEnded(observer, 1)
      h.input(observer, "unsubscribe")
      await h.turnsEnded(observer, 2)
      expect(h.hub.communication.filter(observer, source)).toBeNull()
      const second = h.hub.store.turns(observer)[1]!.runId
      h.model.next(hold(held.promise))
      await h.hub.rewind(observer, second, undefined, h.sender)
      await h.calls(5)
      expect(h.hub.communication.filter(observer, source)).toEqual(["agent_final"])
      h.model.next(say("rerun"))
      held.open()
      await waitFor("the rerun to settle", () => !h.hub.isRunning(observer) ? true : undefined)
    } finally {
      held.open()
      await h.cleanup()
    }
  })
  test("mixed automatic and explicit origins survive fork and restart without a duplicate cause", async () => {
    const h = new AgentHarness()
    try {
      const origin = h.create()
      const target = h.create()
      const observer = h.create()
      h.model.next(say("origin ready"), say("target ready"), say("observer ready"))
      for (const id of [origin, target, observer]) {
        h.input(id, "ready")
        await h.turnsEnded(id, 1)
      }
      h.hub.communication.subscribe(
        observer,
        target,
        ["agent_final"],
        observer,
        h.hub.store.turns(observer)[0]!.runId,
        Date.now(),
      )
      const explicitId = "explicit-peer"
      const automaticId = "automatic-peer"
      h.db.transaction(() => {
        h.hub.store.conversation.addWaiting(target, {
          kind: "notification",
          inputId: automaticId,
          component: { type: "notification", name: "test", heading: "Automatic", text: "automatic work", sources: {} },
          trigger: "notification",
          reaction: { publicationId: "origin-failure", rootId: "root", visited: [origin, target], automatic: true },
        }, Date.now())
        h.hub.store.conversation.addWaiting(target, {
          kind: "user",
          inputId: explicitId,
          text: "explicit work",
          mode: "steer",
          sender: { kind: "session", sessionId: origin, agentTitle: "untitled", modelId: "test/alpha" },
        }, Date.now() + 1)
        h.hub.store.appendEvent(target, { type: "INPUT_WAITING", inputId: automaticId, text: "automatic work", mode: "steer", sender: h.sender }, Date.now())
        h.hub.store.appendEvent(target, { type: "INPUT_WAITING", inputId: explicitId, text: "explicit work", mode: "steer", sender: { kind: "session", sessionId: origin, agentTitle: "untitled", modelId: "test/alpha" } }, Date.now() + 1)
      })()
      const routed = async function* (call: any, signal: AbortSignal) {
        if (call.messages.map((message: any) => JSON.stringify(message)).join("\n").includes("# Fork")) {
          yield* say("branch survived")(call, signal)
        } else {
          yield* failWith(new Error("mixed failure"))(call, signal)
        }
      }
      h.model.next(callTools([{ name: "session_fork", args: {} }]), routed, routed, say("observer noticed"))
      ;(h.hub as any).startNext(target)
      await h.turnsEnded(target, 2)
      const fork = h.events(target).find(({ event }) => event.type === "TOOL_CALL_RESULT" && event.content.includes('"continued":true'))!.event as any
      const branch = JSON.parse(fork.content).sessionId as string
      await h.turnsEnded(branch, 1)
      expect(h.hub.store.turns(target)[1]!.userMessageIds).toEqual([explicitId])
      expect(h.hub.store.turns(branch).at(-1)!.userMessageIds).toEqual([explicitId])
      expect(h.hub.communication.reactions(target, h.hub.store.turns(target)[1]!.runId).map((reaction) => reaction.rootId)).toEqual(["root"])
      expect(h.hub.communication.reactions(branch, h.hub.store.turns(branch).at(-1)!.runId).map((reaction) => reaction.rootId)).toEqual(["root"])
      const before = h.hub.store.db.query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM subscription_publications WHERE source_session_id = ? AND category = 'abnormal'",
      ).get(target)!.n
      expect(before).toBe(1)
      await h.restart()
      expect(h.hub.store.db.query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM subscription_publications WHERE source_session_id = ? AND category = 'abnormal'",
      ).get(target)!.n).toBe(1)
      expect(h.hub.store.turns(branch).at(-1)!.userMessageIds).toEqual([explicitId])
    } finally {
      await h.cleanup()
    }
  }, 30_000)

})

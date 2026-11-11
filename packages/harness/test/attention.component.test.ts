import { describe, expect, test } from "bun:test"
import { PERMISSION_ACTION, type SessionEventBody } from "@ashe-agent/protocol"
import { ActionBroker } from "../src/sessions/actions.ts"
import type { Connection } from "../src/server/websocket.ts"
import { ManualClock } from "./support/agent.ts"

const principal = { kind: "login" as const, loginId: "owner" }

const connection = (id: string): Connection => ({ id, principal, authenticating: false, deadline: null })

const permissionArgs = {
  requestId: "request-1",
  permission: "shell",
  subjects: ["ls"],
  patterns: ["ls"],
}

describe("assignment-validated attention", () => {
  test("only the assigned connection reports and hints clear on withdrawal, settlement and disconnect", async () => {
    const observed: Array<SessionEventBody> = []
    const broker = new ActionBroker((_sessionId, body) => observed.push(body))
    const clock = new ManualClock()
    const assigned = connection("assigned")
    const foreign = connection("foreign")
    broker.register(assigned, principal, () => {})
    broker.register(foreign, principal, () => {})
    broker.setCapabilities(assigned, principal, [PERMISSION_ACTION], () => {})
    broker.setCapabilities(foreign, principal, [PERMISSION_ACTION], () => {})
    broker.subscribed(foreign, principal, "session-1", () => {})
    broker.subscribed(assigned, principal, "session-1", () => {})

    let actionId = ""
    const running = broker.run(PERMISSION_ACTION, permissionArgs, {
      sessionId: "session-1",
      runId: "turn-1",
      clock,
      onAssigned: (id) => (actionId = id),
    })
    expect(actionId).not.toBe("")

    broker.reportInteraction(assigned.id, actionId, true)
    expect(observed).toContainEqual({
      type: "ACTION_ATTENTION",
      actionId,
      name: PERMISSION_ACTION,
      runId: "turn-1",
      needsHumanInput: true,
    })
    expect(() => broker.reportInteraction(foreign.id, actionId, true)).toThrow()

    broker.reportInteraction(assigned.id, actionId, false)
    expect(observed.filter((body) => body.type === "ACTION_ATTENTION")).toEqual([
      { type: "ACTION_ATTENTION", actionId, name: PERMISSION_ACTION, runId: "turn-1", needsHumanInput: true },
      { type: "ACTION_ATTENTION", actionId, name: PERMISSION_ACTION, runId: "turn-1", needsHumanInput: false },
    ])

    broker.reportInteraction(assigned.id, actionId, true)
    broker.complete(assigned.id, "session-1", actionId, { answer: "once" })
    await running
    const attention = observed.filter((body) => body.type === "ACTION_ATTENTION")
    expect(attention.at(-1)).toMatchObject({ actionId, needsHumanInput: false })
    expect(observed.some((body) => body.type === "ACTION_SETTLED" && body.actionId === actionId)).toBe(true)

    const secondId = await new Promise<string>((resolve) => {
      void broker.run(PERMISSION_ACTION, permissionArgs, {
        sessionId: "session-1",
        runId: "turn-2",
        clock,
        onAssigned: resolve,
      }).catch(() => {})
    })
    broker.reportInteraction(assigned.id, secondId, true)
    broker.disconnect(assigned.id)
    expect(observed.filter((body) => body.type === "ACTION_ATTENTION" && body.actionId === secondId).at(-1))
      .toMatchObject({ needsHumanInput: false })
    expect(observed.some((body) => body.type === "ACTION_SETTLED" && body.actionId === secondId && body.outcome === "disconnected"))
      .toBe(true)
  })
})

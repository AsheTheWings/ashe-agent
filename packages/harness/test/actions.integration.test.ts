import { describe, expect, test } from "bun:test"
import { ErrorCode } from "@ashe-agent/protocol"
import { Client, waitFor } from "./support/cli.ts"
import { SessionView, TestServer } from "./support/server.ts"

interface ActionNotice {
  readonly actionId: string
  readonly sessionId: string
  readonly name: string
  readonly arguments: Record<string, any>
}

const withServer = async (body: (server: TestServer, token: string) => Promise<void>) => {
  const server = new TestServer()
  try {
    const token = server.token("actions")
    await server.start()
    await body(server, token)
  } finally {
    await server.cleanup()
  }
}

const connect = async (url: string, token: string) => {
  const client = await Client.connect(url)
  const auth = await client.request("auth.authenticate", { token, protocolVersion: 1 })
  if (auth.error !== undefined) throw new Error(auth.error.message)
  return client
}

const createSession = async (client: Client) => {
  const created = await client.request("session.create", {})
  if (created.error !== undefined) throw new Error(created.error.message)
  return created.result.session.id as string
}

const actionClient = async (url: string, token: string, sessionId: string, names = ["permission.decide"]) => {
  const client = await connect(url, token)
  expect((await client.request("client.setActions", { actions: names })).error).toBeUndefined()
  expect((await client.request("session.subscribe", { sessionId })).error).toBeUndefined()
  const actions: Array<ActionNotice> = []
  const cancelled: Array<{ actionId: string; reason: string }> = []
  client.onActionExecute = (notice) => actions.push(notice)
  client.onActionCancel = (notice) => cancelled.push(notice)
  return { client, actions, cancelled }
}

const nextAction = (actions: Array<ActionNotice>, count: number) =>
  waitFor(`action ${count}`, () => (actions.length >= count ? actions[count - 1] : undefined))

describe("exclusive client actions over WebSocket", () => {
  test("only capable current subscribers receive execution, ordered by their latest subscription", async () => {
    await withServer(async (server, token) => {
      const control = await connect(server.url, token)
      const id = await createSession(control)
      const first = await actionClient(server.url, token, id)
      const newest = await actionClient(server.url, token, id)
      const incapable = await actionClient(server.url, token, id, ["questions.answer"])
      await control.request("session.input", { sessionId: id, text: "ask ls first" })
      const action = await nextAction(newest.actions, 1)
      expect(action).toMatchObject({ sessionId: id, name: "permission.decide", arguments: { permission: "shell", subjects: ["ls first"] } })
      expect(first.actions).toEqual([])
      expect(incapable.actions).toEqual([])
      expect(await newest.client.request("action.complete", { sessionId: id, actionId: action.actionId, result: { answer: "once" } })).toMatchObject({ result: {} })
      server.script.release("ask ls first")

      // Re-subscribing moves a connection to the newest server-owned position.
      await first.client.request("session.subscribe", { sessionId: id })
      await control.request("session.input", { sessionId: id, text: "ask ls second" })
      const second = await nextAction(first.actions, 1)
      expect(newest.actions).toHaveLength(1)
      await first.client.request("action.complete", { sessionId: id, actionId: second.actionId, result: { answer: "once" } })
      server.script.release("ask ls second")
    })
  })

  test("an assignment survives unsubscribe and capability withdrawal, while disconnect fails it without reassignment", async () => {
    await withServer(async (server, token) => {
      const control = await connect(server.url, token)
      const id = await createSession(control)
      const observerView = await SessionView.open(server.url, token, id)
      const assigned = await actionClient(server.url, token, id)
      await control.request("session.input", { sessionId: id, text: "ask ls held" })
      const held = await nextAction(assigned.actions, 1)
      await assigned.client.request("session.unsubscribe", { sessionId: id })
      await assigned.client.request("client.setActions", { actions: [] })
      expect(await assigned.client.request("action.complete", { sessionId: id, actionId: held.actionId, result: { answer: "once" } })).toMatchObject({ result: {} })
      server.script.release("ask ls held")
      await observerView.waitFor("the resolved permission", (view) =>
        view.events.some((event) => event.event.type === "PERMISSION_RESOLVED"),
      )

      const reconnectTarget = await actionClient(server.url, token, id)
      await control.request("session.input", { sessionId: id, text: "ask ls dropped" })
      const dropped = await nextAction(reconnectTarget.actions, 1)
      reconnectTarget.client.close()
      await reconnectTarget.client.waitClosed()
      await observerView.waitFor("the disconnected action", (view) =>
        view.events.some(
          (event) =>
            event.event.type === "ACTION_SETTLED" &&
            event.event.actionId === dropped.actionId &&
            event.event.outcome === "disconnected",
        ),
      )
      expect(assigned.actions).toHaveLength(1)
      const reconnected = await actionClient(server.url, token, id)
      expect(
        (await reconnected.client.request("action.complete", { sessionId: id, actionId: dropped.actionId, result: { answer: "once" } }))
          .error.code,
      ).toBe(ErrorCode.alreadyResolved)
      server.script.release("ask ls dropped")
    })
  })

  test("unauthorized, cross-session, duplicate, and malformed results cannot settle another assignment", async () => {
    await withServer(async (server, token) => {
      const control = await connect(server.url, token)
      const id = await createSession(control)
      const view = await SessionView.open(server.url, token, id)
      const assigned = await actionClient(server.url, token, id)
      const other = await actionClient(server.url, token, id)
      await control.request("session.input", { sessionId: id, text: "ask ls guarded" })
      const action = await nextAction(other.actions, 1)
      expect(
        (await assigned.client.request("action.complete", { sessionId: id, actionId: action.actionId, result: { answer: "always" } }))
          .error.code,
      ).toBe(ErrorCode.conflict)
      expect(
        (
          await other.client.request("action.complete", {
            sessionId: "other-session",
            actionId: action.actionId,
            result: { answer: "always" },
          })
        ).error.code,
      ).toBe(ErrorCode.conflict)
      expect(view.events.some((event) => event.event.type === "PERMISSION_RESOLVED")).toBe(false)
      expect(
        (await other.client.request("action.complete", { sessionId: id, actionId: action.actionId, result: { answer: "maybe" } }))
          .error.code,
      ).toBe(ErrorCode.invalidParams)
      expect(
        (await other.client.request("action.complete", { sessionId: id, actionId: action.actionId, result: { answer: "once" } }))
          .error.code,
      ).toBe(ErrorCode.alreadyResolved)
      await view.waitFor("the failed collection", (current) =>
        current.events.some((event) => event.event.type === "PERMISSION_WITHDRAWN"),
      )
      expect(view.events.some((event) => event.event.type === "PERMISSION_RESOLVED")).toBe(false)
      server.script.release("ask ls guarded")
    })
  })

  test("subscription replay never dispatches an action", async () => {
    await withServer(async (server, token) => {
      const control = await connect(server.url, token)
      const id = await createSession(control)
      const assigned = await actionClient(server.url, token, id)
      await control.request("session.input", { sessionId: id, text: "ask ls replay" })
      const action = await nextAction(assigned.actions, 1)
      const replay = await SessionView.open(server.url, token, id)
      expect(replay.actionExecutions).toEqual([])
      expect(replay.actions.size).toBe(0)
      await assigned.client.request("action.complete", { sessionId: id, actionId: action.actionId, result: { answer: "once" } })
      server.script.release("ask ls replay")
    })
  })

  test("cancel settles first and a racing completion cannot authorize or mutate history", async () => {
    await withServer(async (server, token) => {
      const control = await connect(server.url, token)
      const id = await createSession(control)
      const observerView = await SessionView.open(server.url, token, id)
      const executor = await actionClient(server.url, token, id)
      await control.request("session.input", { sessionId: id, text: "ask ls race" })
      const action = await nextAction(executor.actions, 1)
      await control.request("session.cancel", { sessionId: id })
      await observerView.waitFor("the canceled action", (view) =>
        view.events.some(
          (event) =>
            event.event.type === "ACTION_SETTLED" &&
            event.event.actionId === action.actionId &&
            event.event.outcome === "canceled",
        ),
      )
      expect(
        (
          await executor.client.request("action.complete", {
            sessionId: id,
            actionId: action.actionId,
            result: { answer: "always" },
          })
        ).error.code,
      ).toBe(ErrorCode.alreadyResolved)
      expect(observerView.events.some((event) => event.event.type === "PERMISSION_RESOLVED")).toBe(false)
      expect(
        (await control.request("session.list")).result.sessions.find((session: any) => session.id === id).running,
      ).toBe(false)
      server.script.release("ask ls race")
    })
  })
})

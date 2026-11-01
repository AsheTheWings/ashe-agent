import type { SessionEvent } from "@ashe-agent/protocol"
import type { Connection, Handlers } from "../server/websocket.ts"
import type { SessionHub } from "./hub.ts"

/**
 * The session methods of the protocol over a hub, and the cleanup to run
 * when a connection closes. A connection holds at most one subscription
 * per session; subscribing again replaces it.
 */
export const sessionHandlers = (hub: SessionHub) => {
  const subscriptions = new Map<string, Map<string, () => void>>()
  const of = (connection: Connection) => {
    let map = subscriptions.get(connection.id)
    if (map === undefined) {
      map = new Map()
      subscriptions.set(connection.id, map)
    }
    return map
  }

  const handlers: Handlers = {
    "models.list": async () => {
      const { models, defaultModel } = hub.models()
      return { models: [...models], defaultModel }
    },
    "agents.list": async () => {
      const { agents, defaultAgent } = hub.agents()
      return { agents: [...agents], defaultAgent }
    },
    "session.list": async () => ({ sessions: [...hub.list()] }),
    "session.create": async (params) => ({ session: hub.create(params) }),
    "session.subscribe": async (params, context) => {
      const session = hub.summary(params.sessionId)
      const mine = of(context.connection)
      mine.get(params.sessionId)?.()
      mine.delete(params.sessionId)
      // Events go out only after the response; until then they are held in order.
      const held: Array<SessionEvent> = []
      let ready = false
      const deliver = (event: SessionEvent) => context.notify({ jsonrpc: "2.0", method: "session.event", params: event })
      const unsubscribe = hub.subscribe(params.sessionId, params.afterSeq ?? 0, (event) => {
        if (ready) deliver(event)
        else held.push(event)
      })
      mine.set(params.sessionId, unsubscribe)
      context.afterResponse(() => {
        for (const event of held) deliver(event)
        held.length = 0
        ready = true
      })
      return { session }
    },
    "session.unsubscribe": async (params, context) => {
      const mine = of(context.connection)
      mine.get(params.sessionId)?.()
      mine.delete(params.sessionId)
      return {}
    },
    "session.input": async (params, context) => ({
      inputId: hub.input(params.sessionId, params.text, params.mode, context.principal),
    }),
    "session.cancel": async (params) => {
      hub.cancel(params.sessionId)
      return {}
    },
    "session.setModel": async (params, context) => {
      hub.setModel(params.sessionId, params.model, params.reasoningEffort, context.principal)
      return {}
    },
    "session.fork": async (params) => ({ session: hub.fork(params.sessionId, params.runId) }),
    "session.rewind": async (params, context) => {
      hub.rewind(params.sessionId, params.runId, params.text, context.principal)
      return {}
    },
    "session.answerQuestion": async (params, context) => {
      hub.answerQuestion(params.sessionId, params.questionSetId, params.answers, context.principal)
      return {}
    },
    "permission.answer": async (params, context) => {
      hub.answer(params.sessionId, params.requestId, params.answer, params.message, context.principal)
      return {}
    },
  }

  const onClose = (connection: Connection) => {
    for (const unsubscribe of subscriptions.get(connection.id)?.values() ?? []) unsubscribe()
    subscriptions.delete(connection.id)
  }

  return { handlers, onClose }
}

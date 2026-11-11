import { ErrorCode, type SessionEvent } from "@ashe-agent/protocol"
import type { Connection, Handlers } from "../server/websocket.ts"
import { ProtocolError } from "../server/websocket.ts"
import { AttachmentError } from "../content/attachments.ts"
import type { SessionHub } from "./hub.ts"

/**
 * The session methods of the protocol over a hub, and the cleanup to run
 * when a connection closes. A connection holds at most one subscription
 * per session; subscribing again replaces it.
 */
export const sessionHandlers = (hub: SessionHub) => {
  const ownerId = (principal: { readonly kind: "token" | "login"; readonly tokenId?: string; readonly loginId?: string }) =>
    principal.kind === "token" ? `token:${principal.tokenId}` : `login:${principal.loginId}`
  const upload = <A>(action: () => A): A => {
    try {
      return action()
    } catch (error) {
      if (!(error instanceof AttachmentError)) throw error
      const code =
        error.code === "not_found" || error.code === "expired"
          ? ErrorCode.notFound
          : error.code === "conflict"
            ? ErrorCode.conflict
            : ErrorCode.invalidInput
      throw new ProtocolError({ code, message: error.message })
    }
  }
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
    "actions.list": async () => ({ actions: [...hub.actions.declarations()] }),
    "client.setActions": async (params, context) => {
      hub.actions.setCapabilities(context.connection, context.principal, params.actions, context.notify)
      return {}
    },
    "models.list": async () => {
      const { models, defaultModel } = hub.models()
      return { models: [...models], defaultModel }
    },
    "agents.list": async () => {
      const { agents, defaultAgent } = hub.agents()
      return { agents: [...agents], defaultAgent }
    },
    "upload.create": async (params, context) => ({
      upload: upload(() => hub.attachments.create(ownerId(context.principal), params.draftId, params.name, params.mediaType, params.size, Date.now())),
    }),
    "upload.status": async (params, context) => ({
      upload: upload(() => hub.attachments.statusOf(ownerId(context.principal), params.uploadId, Date.now())),
    }),
    "upload.append": async (params, context) => ({
      upload: upload(() => hub.attachments.append(ownerId(context.principal), params.uploadId, params.offset, params.data, Date.now())),
    }),
    "upload.finalize": async (params, context) => ({
      upload: upload(() =>
        hub.attachments.finalize(ownerId(context.principal), params.uploadId, params.size, params.digest, Date.now()),
      ),
    }),
    "session.list": async () => ({ sessions: [...hub.list()] }),
    "session.create": async (params) => ({
      session: hub.create({
        ...(params.selection?.agentTitle === undefined ? {} : { agent: params.selection.agentTitle }),
        ...(params.selection?.modelSettings?.modelId == null
          ? {}
          : { model: params.selection.modelSettings.modelId }),
        ...(params.selection?.modelSettings?.reasoningEffort == null
          ? {}
          : { reasoningEffort: params.selection.modelSettings.reasoningEffort }),
      }),
    }),
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
      hub.actions.subscribed(context.connection, context.principal, params.sessionId, context.notify)
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
      hub.actions.unsubscribed(context.connection, params.sessionId)
      return {}
    },
    "session.input": async (params, context) => ({
      inputId: upload(() =>
        hub.input(params.sessionId, params.text, params.mode, context.principal, {
          ...(params.selection === undefined ? {} : { selection: params.selection }),
          ...(params.attachments === undefined ? {} : { attachments: params.attachments }),
        }),
      ),
    }),
    "session.resume": async (params) => {
      hub.resume(params.sessionId)
      return {}
    },
    "action.complete": async (params, context) => {
      hub.actions.complete(context.connection.id, params.sessionId, params.actionId, params.result)
      return {}
    },
    "session.cancel": async (params) => {
      hub.cancel(params.sessionId)
      return {}
    },
    "session.grants.list": async (params) => ({ grants: [...hub.store.grantsForSession(params.sessionId)] }),
    "session.grants.clear": async (params) => ({
      cleared: hub.store.clearGrants(params.sessionId, params.agentTitle),
    }),
    "content.get": async (params) => {
      const content = hub.store.conversation.retainedContent(params.sessionId, params.contentId, params.referenceId)
      if (content === null) throw new ProtocolError({ code: ErrorCode.notFound, message: `no retained content ${params.contentId}` })
      return { content }
    },
    "session.fork": async (params) => ({ session: hub.fork(params.sessionId, params.runId) }),
    "session.rewind": async (params, context) => {
      await hub.rewind(params.sessionId, params.runId, params.text, context.principal)
      return {}
    },
  }

  const onClose = (connection: Connection) => {
    for (const unsubscribe of subscriptions.get(connection.id)?.values() ?? []) unsubscribe()
    subscriptions.delete(connection.id)
    hub.actions.disconnect(connection.id)
  }

  return { handlers, onClose }
}

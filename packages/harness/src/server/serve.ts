import { Context, Effect, Layer } from "effect"
import type { GithubSignInConfig } from "../auth/github.ts"
import type { PasswordSignInConfig } from "../auth/password.ts"
import { sessionHandlers } from "../sessions/handlers.ts"
import { Sessions } from "../sessions/hub.ts"
import { Store } from "../store/database.ts"
import { startWebSocketServer, type WebSocketServer } from "./websocket.ts"

export interface ServeOptions {
  readonly hostname: string
  readonly port: number
  readonly origins: ReadonlyArray<string>
  /** The GitHub OAuth app the owner signs in through; null removes the GitHub routes. */
  readonly github: GithubSignInConfig | null
  /** The development password the owner signs in with; null removes the password route. */
  readonly password: PasswordSignInConfig | null
  /** The owner's user ID, carried by every login either sign-in creates. */
  readonly ownerId: number
}

/** The listening protocol server over the session hub, stopped when its layer is released. */
export class ProtocolServer extends Context.Service<ProtocolServer, WebSocketServer>()(
  "ashe-agent/server/ProtocolServer",
) {
  static readonly layer = (options: ServeOptions) =>
    Layer.effect(
      ProtocolServer,
      Effect.gen(function* () {
        const { db } = yield* Store
        const hub = yield* Sessions
        const { handlers, onClose } = sessionHandlers(hub)
        return yield* Effect.acquireRelease(
          Effect.sync(() =>
            startWebSocketServer({
              db,
              ...options,
              handlers,
              onClose,
              retainedOriginal: (sessionId, contentId, referenceId) => {
                const content = hub.store.conversation.retainedContent(sessionId, contentId, referenceId)
                if (content === null) {
                  return { status: "missing", message: `no retained content ${contentId}` }
                }
                const representation = content.representations[0]
                if (!content.available || representation === undefined) {
                  return { status: "unavailable", message: `retained content ${contentId} has no representation` }
                }
                const bytes = hub.store.conversation.retainedContentBytes(sessionId, contentId, referenceId)
                if (bytes === null) {
                  return { status: "unavailable", message: `retained content ${contentId} has no bytes` }
                }
                return {
                  status: "ok",
                  bytes,
                  mediaType: representation.mediaType,
                  filename: representation.filename ?? representation.representationId,
                }
              },
            }),
          ),
          (server) => Effect.promise(() => server.stop()),
        )
      }),
    )
}

/**
 * Runs the server until interrupted: reports its URL through `onListening`,
 * then waits, releasing the server and the database on interruption.
 */
export const serveProgram = (onListening: (url: string) => void) =>
  Effect.gen(function* () {
    const server = yield* ProtocolServer
    onListening(server.url)
    return yield* Effect.never
  })
